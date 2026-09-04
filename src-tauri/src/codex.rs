//! Usage read from the OpenAI Codex CLI's own rollout files.
//!
//! Codex writes one JSONL per session under `~/.codex/sessions/YYYY/MM/DD/`.
//! Every line is `{"timestamp": …, "type": …, "payload": {…}}`; the interesting
//! payloads are `session_meta` (id, cwd, model) and the `token_count` events,
//! whose `total_token_usage` is cumulative for the session.
//!
//! ponytail: parsed leniently — by *key*, not by matching Codex's exact enum
//! shapes. Codex's rollout schema is not a stable public contract, so a version
//! that renames a wrapper still yields its numbers, and a version that changes
//! them beyond recognition yields an empty report rather than wrong one. The
//! upgrade path, if this ever drifts, is to pin the real structs with serde.
//!
//! There is no cost here on purpose: Codex records no dollars, and inventing a
//! price per token would be a number the app made up.

use crate::sessions::{iso_to_ms, Session};
use crate::util::ms;
use std::path::{Path, PathBuf};

/// Deep search for the first string under `key`.
fn find_str(v: &serde_json::Value, key: &str) -> Option<String> {
    match v {
        serde_json::Value::Object(m) => {
            if let Some(s) = m.get(key).and_then(|x| x.as_str()) {
                return Some(s.to_string());
            }
            m.values().find_map(|x| find_str(x, key))
        }
        serde_json::Value::Array(a) => a.iter().find_map(|x| find_str(x, key)),
        _ => None,
    }
}

/// Deep search for the object under `key`, read as (input, cached, output).
fn find_tokens(v: &serde_json::Value, key: &str) -> Option<(u64, u64, u64)> {
    match v {
        serde_json::Value::Object(m) => {
            if let Some(t) = m.get(key).and_then(|x| x.as_object()) {
                let n = |k: &str| t.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
                // An object that carries neither is not a usage record.
                if t.contains_key("input_tokens") || t.contains_key("output_tokens") {
                    return Some((n("input_tokens"), n("cached_input_tokens"), n("output_tokens")));
                }
            }
            m.values().find_map(|x| find_tokens(x, key))
        }
        serde_json::Value::Array(a) => a.iter().find_map(|x| find_tokens(x, key)),
        _ => None,
    }
}

fn parse_file(path: &Path, size: u64, mtime_ms: u64) -> Option<Session> {
    let text = std::fs::read_to_string(path).ok()?;
    let mut s = Session {
        file: path.to_string_lossy().into_owned(),
        size_bytes: size,
        updated_at_ms: mtime_ms,
        cli_version: String::new(),
        ..Default::default()
    };
    // `total_token_usage` is cumulative, so the largest one seen is the total —
    // that also survives a truncated tail. `last_token_usage` is per turn, and
    // is only summed when no cumulative record exists at all.
    let (mut cum, mut per_turn) = ((0u64, 0u64, 0u64), (0u64, 0u64, 0u64));
    let mut last_ms = 0u64;

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };

        if let Some(t) = v.get("timestamp").and_then(|x| x.as_str()).and_then(iso_to_ms) {
            if s.started_at_ms == 0 {
                s.started_at_ms = t;
            }
            last_ms = t;
        }
        if s.id.is_empty() {
            if let Some(id) = find_str(&v, "id") {
                s.id = id;
            }
        }
        if s.cwd.is_empty() {
            if let Some(c) = find_str(&v, "cwd") {
                s.cwd = crate::util::norm_path(&c);
            }
        }
        if s.title.is_empty() {
            if let Some(m) = find_str(&v, "model") {
                s.title = m;
            }
        }
        if find_str(&v, "role").as_deref() == Some("assistant") {
            s.messages += 1;
        }
        if let Some(t) = find_tokens(&v, "total_token_usage") {
            if t.0 + t.2 > cum.0 + cum.2 {
                cum = t;
            }
        } else if let Some(t) = find_tokens(&v, "last_token_usage") {
            per_turn = (per_turn.0 + t.0, per_turn.1 + t.1, per_turn.2 + t.2);
        }
    }

    let (input, cached, output) = if cum.0 + cum.2 > 0 { cum } else { per_turn };
    if s.started_at_ms == 0 {
        s.started_at_ms = mtime_ms;
    }
    if last_ms > s.started_at_ms {
        s.updated_at_ms = last_ms;
        s.duration_ms = last_ms - s.started_at_ms;
    }
    // Codex reports cached input inside the input total; splitting it out keeps
    // the two columns from double-counting the same tokens.
    s.input = input.saturating_sub(cached);
    s.cache_read = cached;
    s.output = output;
    s.models = vec![crate::sessions::ModelUsage {
        model: if s.title.is_empty() { "codex".into() } else { s.title.clone() },
        input: s.input,
        output: s.output,
        cache_read: s.cache_read,
        cache_create: 0,
        cost_usd: 0.0,
    }];
    // A rollout with neither tokens nor a reply is a session that never ran.
    if s.output == 0 && s.input == 0 && s.messages == 0 {
        return None;
    }
    Some(s)
}

fn jsonl_files(root: &Path, out: &mut Vec<(PathBuf, u64, u64)>, depth: u32) {
    let Ok(rd) = std::fs::read_dir(root) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let Ok(md) = e.metadata() else { continue };
        if md.is_dir() {
            // Codex nests year/month/day; a few extra levels cost nothing and
            // survive a layout change.
            if depth < 6 {
                jsonl_files(&p, out, depth + 1);
            }
        } else if p.extension().and_then(|x| x.to_str()) == Some("jsonl") {
            out.push((p, md.len(), md.modified().map(ms).unwrap_or(0)));
        }
    }
}

/// Every Codex session this machine has on disk. No cache: a rollout tree is
/// far smaller than a Claude transcript tree, and this only runs when you open
/// the Codex tab.
pub fn scan(codex_dir: &Path) -> Vec<Session> {
    let mut files = Vec::new();
    jsonl_files(&codex_dir.join("sessions"), &mut files, 0);
    let mut out: Vec<Session> =
        files.into_iter().filter_map(|(p, size, mtime)| parse_file(&p, size, mtime)).collect();
    out.sort_by(|a, b| b.updated_at_ms.cmp(&a.updated_at_ms));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// One rollout in the shape Codex documents, so a drift in our reading of
    /// it fails here rather than silently showing zeros.
    #[test]
    fn reads_a_rollout_the_way_codex_writes_one() {
        let dir = std::env::temp_dir().join(format!("agentspace-codex-{}", std::process::id()));
        let day = dir.join("sessions").join("2026").join("09").join("04");
        std::fs::create_dir_all(&day).unwrap();
        let mut f = std::fs::File::create(day.join("rollout-2026-09-04T01-00-00-abc.jsonl")).unwrap();
        for line in [
            r#"{"timestamp":"2026-09-04T01:00:00.000Z","type":"session_meta","payload":{"id":"abc","timestamp":"2026-09-04T01:00:00.000Z","cwd":"/home/x/proj","cli_version":"0.9.0"}}"#,
            r#"{"timestamp":"2026-09-04T01:00:05.000Z","type":"turn_context","payload":{"model":"gpt-5-codex","cwd":"/home/x/proj"}}"#,
            r#"{"timestamp":"2026-09-04T01:00:09.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}]}}"#,
            r#"{"timestamp":"2026-09-04T01:00:10.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"cached_input_tokens":400,"output_tokens":50,"total_tokens":1050},"last_token_usage":{"input_tokens":1000,"cached_input_tokens":400,"output_tokens":50}}}}"#,
            r#"{"timestamp":"2026-09-04T01:02:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":3000,"cached_input_tokens":1200,"output_tokens":220,"total_tokens":3220},"last_token_usage":{"input_tokens":2000,"cached_input_tokens":800,"output_tokens":170}}}}"#,
            "not json at all",
        ] {
            writeln!(f, "{line}").unwrap();
        }
        drop(f);

        let all = scan(&dir);
        assert_eq!(all.len(), 1, "one rollout, one session");
        let s = &all[0];
        assert_eq!(s.cwd, "/home/x/proj");
        assert_eq!(s.title, "gpt-5-codex");
        assert_eq!(s.messages, 1, "one assistant reply");
        // Cumulative wins over the per-turn sum, and cached is split out of input.
        assert_eq!((s.input, s.cache_read, s.output), (1800, 1200, 220));
        assert_eq!(s.duration_ms, 120_000, "first to last timestamp");
        assert_eq!(s.cost_usd, 0.0, "Codex records no dollars");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_empty_tree_is_an_empty_report_not_a_panic() {
        assert!(scan(Path::new("/definitely/not/here")).is_empty());
    }
}
