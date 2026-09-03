//! Reads Claude Code's own session transcripts (~/.claude/projects/**/*.jsonl)
//! and turns them into a session list and a usage report.
//!
//! The transcripts already carry everything a dashboard needs — Claude Code
//! writes `ai-title`, `last-prompt` and a `cost-state` record with per-model
//! token counts, dollar cost, lines added/removed and wall-clock duration — so
//! nothing here instruments or wraps the CLI. We are a reader of files the user
//! already has.

use crate::util::{ms, now_ms, write_atomic};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub model: String,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_create: u64,
    pub cost_usd: f64,
}

/// Tokens attributed to one wall-clock hour.
///
/// A session's totals cannot answer "how much have I burned in the last five
/// hours" — a session that ran from morning to evening would land entirely in
/// whichever block it started in. Hour resolution is what the quota window
/// needs, and it costs one small vector per transcript in the cache.
#[derive(Serialize, Deserialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HourBucket {
    /// Hours since the epoch.
    pub hour: u64,
    /// Exact ms of the first activity inside this hour. The quota window opens
    /// on a message, not on the top of the hour, so the gauge needs the minute.
    #[serde(default)]
    pub first_ms: u64,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_create: u64,
    pub messages: u32,
}

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Session {
    pub id: String,
    pub file: String,
    pub cwd: String,
    pub title: String,
    pub last_prompt: String,
    pub git_branch: String,
    pub cli_version: String,
    pub messages: u32,
    pub started_at_ms: u64,
    pub updated_at_ms: u64,
    pub size_bytes: u64,
    pub cost_usd: f64,
    /// Whether Claude Code wrote a `cost-state` record for this session. Only
    /// newer sessions have one, so dollars are a partial signal while tokens
    /// (counted per message below) cover everything.
    pub has_cost: bool,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_create: u64,
    pub lines_added: u64,
    pub lines_removed: u64,
    pub duration_ms: u64,
    pub models: Vec<ModelUsage>,
    /// Only the block gauge reads these. They are kept in the on-disk cache —
    /// skipping them there would leave every cached session with no hours, so
    /// the gauge would only ever see transcripts that changed since the last
    /// scan — but stripped before the list is handed to the UI (`slim`).
    #[serde(default)]
    pub hours: Vec<HourBucket>,
}

// ---------------------------------------------------------------- line typing

/// Top-level event type of a transcript line, found without parsing the line.
/// Assistant records nest `"type":"message"` / `"text"` / `"tool_use"` inside
/// `message`, so matching the exact top-level values is what keeps this honest.
///
/// ponytail: a transcript line whose *text* quotes one of these needles verbatim
/// is mistyped. It costs at most one miscounted message; the alternative is
/// serde-parsing every assistant record, which is ~20x slower on 800 KB files.
fn line_type(line: &str) -> Option<&'static str> {
    const NEEDLES: [(&str, &str); 5] = [
        (r#""type":"assistant""#, "assistant"),
        (r#""type":"user""#, "user"),
        (r#""type":"ai-title""#, "ai-title"),
        (r#""type":"cost-state""#, "cost-state"),
        (r#""type":"last-prompt""#, "last-prompt"),
    ];
    NEEDLES.iter().find(|(n, _)| line.contains(n)).map(|(_, t)| *t)
}

/// Claude Code injects framing blocks as user turns (command stdout, caveats,
/// system reminders). They make terrible titles, so skip them.
fn is_noise(text: &str) -> bool {
    let t = text.trim_start();
    t.is_empty()
        || t.starts_with("Caveat:")
        || t.starts_with('<')
        || t.starts_with("[Request interrupted")
        || t.starts_with("This session is being continued")
}

fn message_text(msg: &serde_json::Value) -> String {
    match msg.get("content") {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Array(parts)) => parts
            .iter()
            .filter(|p| p.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// First integer value of `"<key>":` at or after `from`. The quote before the
/// key is what keeps `"input_tokens":` from matching
/// `"cache_creation_input_tokens":`, and the colon keeps `"output_tokens":`
/// from matching `"output_tokens_details":`.
fn num_after(line: &str, from: usize, key: &str) -> u64 {
    let needle = format!("\"{key}\":");
    let Some(i) = line[from..].find(&needle) else { return 0 };
    let rest = &line[from + i + needle.len()..];
    let end = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
    rest[..end].parse().unwrap_or(0)
}

fn str_after(line: &str, from: usize, key: &str) -> Option<String> {
    let needle = format!("\"{key}\":\"");
    let i = line[from..].find(&needle)?;
    let rest = &line[from + i + needle.len()..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

/// (model, input, cache_create, cache_read, output) for one assistant record.
///
/// ponytail: substring scanning, not a JSON parse — full serde on every
/// assistant record turns a 345 MB cold scan into a minute-long one. The
/// top-level `usage` fields precede the nested `iterations` array, so the first
/// match after `"usage":{` is the one we want.
fn message_usage(line: &str) -> Option<(String, u64, u64, u64, u64)> {
    let u = line.find(r#""usage":{"#)?;
    let model = str_after(line, 0, "model").unwrap_or_else(|| "unknown".into());
    Some((
        model,
        num_after(line, u, "input_tokens"),
        num_after(line, u, "cache_creation_input_tokens"),
        num_after(line, u, "cache_read_input_tokens"),
        num_after(line, u, "output_tokens"),
    ))
}

fn truncate(s: &str, n: usize) -> String {
    let one_line = s.split('\n').find(|l| !l.trim().is_empty()).unwrap_or(s).trim();
    if one_line.chars().count() <= n {
        return one_line.to_string();
    }
    let cut: String = one_line.chars().take(n).collect();
    format!("{}…", cut.trim_end())
}

// ------------------------------------------------------------------ ISO dates

/// Days since 1970-01-01 for a proleptic-Gregorian date (Howard Hinnant).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `2026-09-03T01:04:12.345Z` -> epoch ms. Transcript timestamps are always
/// UTC-suffixed ISO-8601; anything else yields None rather than a wrong number.
pub fn iso_to_ms(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' {
        return None;
    }
    let num = |a: usize, z: usize| s.get(a..z)?.parse::<i64>().ok();
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, sec) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    let millis = s
        .get(20..23)
        .filter(|_| b.get(19) == Some(&b'.'))
        .and_then(|x| x.parse::<i64>().ok())
        .unwrap_or(0);
    let secs = days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + sec;
    u64::try_from(secs * 1000 + millis).ok()
}

/// Local calendar day (YYYY-MM-DD) for an instant, given the browser's
/// `getTimezoneOffset()` (minutes to add to local time to reach UTC).
pub fn local_day(epoch_ms: u64, tz_offset_min: i32) -> String {
    let local = epoch_ms as i64 - (tz_offset_min as i64) * 60_000;
    let (y, m, d) = civil_from_days(local.div_euclid(86_400_000));
    format!("{y:04}-{m:02}-{d:02}")
}

// -------------------------------------------------------------------- parsing

/// The bucket for the hour containing `ts`, created with its own hour number —
/// `or_default()` here would leave `hour` at 0 and silently move the work to
/// 1970.
fn bucket(hours: &mut HashMap<u64, HourBucket>, ts: u64) -> &mut HourBucket {
    let hour = ts / 3_600_000;
    let h = hours.entry(hour).or_insert(HourBucket { hour, first_ms: ts, ..Default::default() });
    h.first_ms = h.first_ms.min(ts);
    h
}

fn parse_file(path: &Path, size: u64, mtime_ms: u64) -> Option<Session> {
    let raw = std::fs::read_to_string(path).ok()?;
    let mut s = Session {
        id: path.file_stem()?.to_string_lossy().into_owned(),
        file: path.to_string_lossy().into_owned(),
        size_bytes: size,
        updated_at_ms: mtime_ms,
        ..Default::default()
    };
    let mut first_ts: Option<u64> = None;
    let mut fallback_title = String::new();
    let mut per_model: HashMap<String, ModelUsage> = HashMap::new();
    let mut hours: HashMap<u64, HourBucket> = HashMap::new();
    // Records before the first timestamped one cannot be placed in an hour, so
    // they are counted in the session totals but not in the block gauge.
    let mut last_ts = 0u64;

    for line in raw.lines() {
        let Some(kind) = line_type(line) else { continue };
        // ponytail: first `"timestamp":"` in the line. Claude Code writes it at
        // the top level of every user and assistant record; a quoted one inside
        // a message would misplace at most one record by an hour.
        if matches!(kind, "assistant" | "user") {
            if let Some(t) = str_after(line, 0, "timestamp").as_deref().and_then(iso_to_ms) {
                last_ts = t;
            }
            if last_ts > 0 {
                bucket(&mut hours, last_ts).messages += 1;
            }
        }
        match kind {
            "assistant" => {
                s.messages += 1;
                if let Some((model, inp, cc, cr, out)) = message_usage(line) {
                    if last_ts > 0 {
                        let h = bucket(&mut hours, last_ts);
                        h.input += inp;
                        h.cache_create += cc;
                        h.cache_read += cr;
                        h.output += out;
                    }
                    let m = per_model.entry(model.clone()).or_insert_with(|| ModelUsage {
                        model,
                        ..Default::default()
                    });
                    m.input += inp;
                    m.cache_create += cc;
                    m.cache_read += cr;
                    m.output += out;
                }
            }
            "user" => {
                s.messages += 1;
                // Only the opening turns are parsed in full; they carry cwd,
                // branch, CLI version and the text we fall back to for a title.
                if s.cwd.is_empty() || fallback_title.is_empty() {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                        let get = |k: &str| {
                            v.get(k).and_then(|x| x.as_str()).unwrap_or_default().to_string()
                        };
                        if s.cwd.is_empty() {
                            s.cwd = get("cwd");
                            s.git_branch = get("gitBranch");
                            s.cli_version = get("version");
                        }
                        if first_ts.is_none() {
                            first_ts = iso_to_ms(&get("timestamp"));
                        }
                        if fallback_title.is_empty() {
                            if let Some(m) = v.get("message") {
                                let t = message_text(m);
                                if !is_noise(&t) {
                                    fallback_title = truncate(&t, 80);
                                }
                            }
                        }
                    }
                }
            }
            "ai-title" => {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                    if let Some(t) = v.get("aiTitle").and_then(|x| x.as_str()) {
                        s.title = t.to_string();
                    }
                }
            }
            "last-prompt" => {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                    if let Some(t) = v.get("lastPrompt").and_then(|x| x.as_str()) {
                        s.last_prompt = truncate(t, 120);
                    }
                }
            }
            "cost-state" => {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                    let f = |k: &str| v.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0);
                    s.cost_usd = f("totalCostUSD");
                    s.has_cost = true;
                    s.lines_added = f("totalLinesAdded") as u64;
                    s.lines_removed = f("totalLinesRemoved") as u64;
                    s.duration_ms = f("totalDuration") as u64;
                    let start = f("startTime") as u64;
                    if start > 0 {
                        s.started_at_ms = start;
                    }
                    if let Some(map) = v.get("modelUsage").and_then(|x| x.as_object()) {
                        for (model, u) in map {
                            let cost = u.get("costUSD").and_then(|x| x.as_f64()).unwrap_or(0.0);
                            per_model
                                .entry(model.clone())
                                .or_insert_with(|| ModelUsage { model: model.clone(), ..Default::default() })
                                .cost_usd = cost;
                        }
                    }
                }
            }
            _ => {}
        }
    }

    s.hours = hours.into_values().collect();
    s.hours.sort_by_key(|h| h.hour);

    s.models = per_model.into_values().collect();
    s.models.sort_by(|a, b| (b.output, b.input).cmp(&(a.output, a.input)));
    for m in &s.models {
        s.input += m.input;
        s.output += m.output;
        s.cache_read += m.cache_read;
        s.cache_create += m.cache_create;
    }

    if s.started_at_ms == 0 {
        s.started_at_ms = first_ts.unwrap_or(mtime_ms);
    }
    if s.title.is_empty() {
        s.title = if fallback_title.is_empty() { "(không tiêu đề)".into() } else { fallback_title };
    }
    Some(s)
}

// --------------------------------------------------------------------- scanning

/// Bump whenever `parse_file` starts producing different numbers. Without
/// this, a schema change silently keeps serving stale rows: the mtime is
/// unchanged, so nothing is re-read, and fields added since are left at their
/// defaults. That is exactly how the first cut reported 334k tokens in a chart
/// while the per-model table added up to 1.2M.
const CACHE_VERSION: u32 = 4;

#[derive(Serialize, Deserialize, Default)]
struct CacheEntry {
    mtime_ms: u64,
    size: u64,
    session: Session,
}

#[derive(Serialize, Deserialize, Default)]
struct Cache {
    version: u32,
    entries: HashMap<String, CacheEntry>,
}

/// Full scan of every transcript, memoised on (mtime, size). A cold scan of a
/// few hundred megabytes of JSONL is the slow path; every later one is a stat
/// per file.
///
/// ponytail: parallelism is a fixed thread-per-chunk fan-out, not a pool. Fine
/// for a few thousand files; swap in rayon if that stops holding.
pub fn scan(claude_dir: &Path, cache_path: &Path) -> Vec<Session> {
    let root = claude_dir.join("projects");
    let mut cache: HashMap<String, CacheEntry> = std::fs::read_to_string(cache_path)
        .ok()
        .and_then(|s| serde_json::from_str::<Cache>(&s).ok())
        .filter(|c| c.version == CACHE_VERSION)
        .map(|c| c.entries)
        .unwrap_or_default();

    let mut files: Vec<(PathBuf, u64, u64)> = Vec::new();
    let Ok(projects) = std::fs::read_dir(&root) else { return Vec::new() };
    for project in projects.flatten() {
        let Ok(entries) = std::fs::read_dir(project.path()) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("jsonl") {
                continue;
            }
            let Ok(md) = e.metadata() else { continue };
            let mtime = md.modified().map(ms).unwrap_or(0);
            files.push((p, md.len(), mtime));
        }
    }

    let stale: Vec<(PathBuf, u64, u64)> = files
        .iter()
        .filter(|(p, size, mtime)| {
            cache
                .get(&p.to_string_lossy().into_owned())
                .is_none_or(|c| c.size != *size || c.mtime_ms != *mtime)
        })
        .cloned()
        .collect();

    if !stale.is_empty() {
        let workers = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(1, 8);
        let chunk = stale.len().div_ceil(workers);
        let fresh: Vec<Session> = std::thread::scope(|scope| {
            let handles: Vec<_> = stale
                .chunks(chunk)
                .map(|c| scope.spawn(move || c.iter().filter_map(|(p, s, m)| parse_file(p, *s, *m)).collect::<Vec<_>>()))
                .collect();
            handles.into_iter().filter_map(|h| h.join().ok()).flatten().collect()
        });
        for s in fresh {
            cache.insert(
                s.file.clone(),
                CacheEntry { mtime_ms: s.updated_at_ms, size: s.size_bytes, session: s },
            );
        }
    }

    // Drop transcripts the user deleted, then persist.
    let live: std::collections::HashSet<String> =
        files.iter().map(|(p, _, _)| p.to_string_lossy().into_owned()).collect();
    cache.retain(|k, _| live.contains(k));
    let cache = Cache { version: CACHE_VERSION, entries: cache };
    if let Ok(json) = serde_json::to_vec(&cache) {
        let _ = write_atomic(cache_path, &json);
    }

    let mut out: Vec<Session> = cache.entries.into_values().map(|c| c.session).collect();
    out.sort_by(|a, b| b.updated_at_ms.cmp(&a.updated_at_ms));
    out
}

/// How many transcripts a runtime has, counted by stat alone — no parsing.
/// Used to answer "which machine is this person actually working on?", because
/// being signed in on both says nothing about where the work lives.
pub fn transcript_count(claude_dir: &Path) -> usize {
    let Ok(projects) = std::fs::read_dir(claude_dir.join("projects")) else { return 0 };
    projects
        .flatten()
        .filter_map(|p| std::fs::read_dir(p.path()).ok())
        .map(|d| {
            d.flatten()
                .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("jsonl"))
                .count()
        })
        .sum()
}

// -------------------------------------------------------------------- delete

/// Permanently remove transcripts.
///
/// Not lazy here: this destroys the user's own conversation history, so every
/// path is canonicalised and checked to be a `.jsonl` strictly inside
/// ~/.claude/projects before anything is unlinked, and one bad path aborts the
/// whole call rather than deleting a prefix of it.
pub fn delete(claude_dir: &Path, files: &[String]) -> Result<usize, String> {
    let root = claude_dir
        .join("projects")
        .canonicalize()
        .map_err(|e| format!("Không mở được thư mục transcript: {e}"))?;

    let mut targets = Vec::with_capacity(files.len());
    for f in files {
        let path = std::path::Path::new(f)
            .canonicalize()
            .map_err(|e| format!("Không tìm thấy {f}: {e}"))?;
        if !path.starts_with(&root) || path.extension().and_then(|x| x.to_str()) != Some("jsonl") {
            return Err(format!("Từ chối xoá tệp ngoài thư mục transcript: {f}"));
        }
        targets.push(path);
    }

    let mut removed = 0;
    for path in targets {
        std::fs::remove_file(&path).map_err(|e| format!("Xoá thất bại {}: {e}", path.display()))?;
        removed += 1;
        // Tidy the project folder if this was its last transcript. remove_dir
        // refuses a non-empty directory, so this cannot take anything with it.
        if let Some(dir) = path.parent() {
            let _ = std::fs::remove_dir(dir);
        }
    }
    Ok(removed)
}

/// Rename a session.
///
/// Claude Code stores the title as `ai-title` records in the transcript and
/// reads the last one, so appending one is the native rename — the new name
/// also shows up in `claude --resume`. A single small append under O_APPEND is
/// atomic, so this cannot tear a transcript even if the session is live.
pub fn rename(claude_dir: &Path, file: &str, title: &str) -> Result<(), String> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > 200 {
        return Err("Tên phiên phải từ 1 đến 200 ký tự".into());
    }
    let root = claude_dir.join("projects").canonicalize().map_err(|e| e.to_string())?;
    let path = std::path::Path::new(file).canonicalize().map_err(|e| format!("Không tìm thấy {file}: {e}"))?;
    if !path.starts_with(&root) || path.extension().and_then(|x| x.to_str()) != Some("jsonl") {
        return Err(format!("Từ chối sửa tệp ngoài thư mục transcript: {file}"));
    }
    let session_id = path.file_stem().unwrap_or_default().to_string_lossy().into_owned();
    let line = serde_json::json!({ "type": "ai-title", "aiTitle": title, "sessionId": session_id });
    let mut bytes = serde_json::to_vec(&line).map_err(|e| e.to_string())?;
    bytes.push(b'\n');

    use std::io::Write;
    std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .and_then(|mut f| f.write_all(&bytes))
        .map_err(|e| format!("Không ghi được tiêu đề: {e}"))
}

// ---------------------------------------------------------------------- usage

#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Bucket {
    pub cost_usd: f64,
    /// How many of `sessions` actually carried a cost record — the UI says so
    /// rather than presenting a partial sum as a complete one.
    pub cost_sessions: u32,
    pub sessions: u32,
    pub messages: u32,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_create: u64,
    pub lines_added: u64,
    pub lines_removed: u64,
    pub duration_ms: u64,
}

impl Bucket {
    fn add(&mut self, s: &Session) {
        self.cost_usd += s.cost_usd;
        self.cost_sessions += u32::from(s.has_cost);
        self.sessions += 1;
        self.messages += s.messages;
        self.lines_added += s.lines_added;
        self.lines_removed += s.lines_removed;
        self.duration_ms += s.duration_ms;
        self.input += s.input;
        self.output += s.output;
        self.cache_read += s.cache_read;
        self.cache_create += s.cache_create;
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Named {
    pub key: String,
    #[serde(flatten)]
    pub bucket: Bucket,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    pub range: String,
    pub total: Bucket,
    pub by_day: Vec<Named>,
    pub by_workspace: Vec<Named>,
    pub by_model: Vec<Named>,
}

fn sorted(map: HashMap<String, Bucket>, by_key: bool) -> Vec<Named> {
    let mut v: Vec<Named> = map.into_iter().map(|(key, bucket)| Named { key, bucket }).collect();
    if by_key {
        v.sort_by(|a, b| a.key.cmp(&b.key));
    } else {
        // Rank by output tokens: every session has them, only some have dollars.
        v.sort_by(|a, b| b.bucket.output.cmp(&a.bucket.output));
    }
    v
}

pub fn usage(sessions: &[Session], range: &str, tz_offset_min: i32) -> UsageReport {
    let now = now_ms();
    let today = local_day(now, tz_offset_min);
    let window_ms: u64 = match range {
        "7d" => 7 * 86_400_000,
        "30d" => 30 * 86_400_000,
        _ => 0,
    };

    let mut total = Bucket::default();
    let (mut day, mut ws, mut model) = (HashMap::new(), HashMap::new(), HashMap::new());

    for s in sessions {
        let d = local_day(s.started_at_ms, tz_offset_min);
        let keep = match range {
            "today" => d == today,
            "all" => true,
            _ => s.started_at_ms + window_ms >= now,
        };
        if !keep {
            continue;
        }
        total.add(s);
        day.entry(d).or_insert_with(Bucket::default).add(s);
        let key = if s.cwd.is_empty() { "(không rõ)".to_string() } else { s.cwd.clone() };
        ws.entry(key).or_insert_with(Bucket::default).add(s);
        for m in &s.models {
            let b: &mut Bucket = model.entry(m.model.clone()).or_insert_with(Bucket::default);
            b.cost_usd += m.cost_usd;
            b.input += m.input;
            b.output += m.output;
            b.cache_read += m.cache_read;
            b.cache_create += m.cache_create;
            b.sessions += 1;
            b.cost_sessions += u32::from(m.cost_usd > 0.0);
        }
    }

    UsageReport {
        range: range.to_string(),
        total,
        by_day: sorted(day, true),
        by_workspace: sorted(ws, false),
        by_model: sorted(model, false),
    }
}

// ------------------------------------------------------------ quota windows

/// Claude Code meters a subscription in rolling windows that open with your
/// first message and last five hours. The dashboard answers "how much have I
/// used"; this answers "when am I cut off", which is the question you actually
/// have at 3pm.
pub const BLOCK_HOURS: u64 = 5;
const HOUR_MS: u64 = 3_600_000;

#[derive(Serialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Block {
    pub start_ms: u64,
    pub end_ms: u64,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_create: u64,
    pub messages: u32,
    /// Estimated: Claude Code records a dollar total per session, not per
    /// message, so a session's cost is split across its hours in proportion to
    /// output tokens. Tokens are exact; this is not.
    pub cost_usd: f64,
    /// The window that is still open. At most one, and only the last.
    pub active: bool,
}

/// Every window that has held work, oldest first, capped at `limit`.
///
/// A window opens at the exact minute of the first activity after the previous
/// one closed — the same rule Claude Code's own `/usage` resets on — so an idle
/// gap longer than five hours starts a new one by construction.
///
/// ponytail: tokens are bucketed per hour, so an hour straddling a window
/// boundary lands whole in the window its *first* message opened; at most one
/// hour of work sits on the wrong side. Per-message buckets would fix it at the
/// cost of keeping every timestamp in the cache.
pub fn blocks(sessions: &[Session], limit: usize) -> Vec<Block> {
    let mut by_hour: HashMap<u64, (HourBucket, f64)> = HashMap::new();
    for s in sessions {
        let session_out: u64 = s.hours.iter().map(|h| h.output).sum();
        for h in &s.hours {
            let e = by_hour.entry(h.hour).or_default();
            // Cached sessions from before `first_ms` existed report 0; the top
            // of the hour is the honest fallback for them.
            let first = if h.first_ms > 0 { h.first_ms } else { h.hour * HOUR_MS };
            e.0.first_ms = if e.0.first_ms == 0 { first } else { e.0.first_ms.min(first) };
            e.0.input += h.input;
            e.0.output += h.output;
            e.0.cache_read += h.cache_read;
            e.0.cache_create += h.cache_create;
            e.0.messages += h.messages;
            if session_out > 0 {
                e.1 += s.cost_usd * (h.output as f64 / session_out as f64);
            }
        }
    }

    let mut hours: Vec<u64> = by_hour.keys().copied().collect();
    hours.sort_unstable();

    let mut out: Vec<Block> = Vec::new();
    for h in hours {
        let start = by_hour[&h].0.first_ms;
        if !out.last().is_some_and(|b| start < b.end_ms) {
            out.push(Block { start_ms: start, end_ms: start + BLOCK_HOURS * HOUR_MS, ..Default::default() });
        }
        let (hb, cost) = &by_hour[&h];
        let b = out.last_mut().expect("just pushed");
        b.input += hb.input;
        b.output += hb.output;
        b.cache_read += hb.cache_read;
        b.cache_create += hb.cache_create;
        b.messages += hb.messages;
        b.cost_usd += cost;
    }

    let now = now_ms();
    if let Some(b) = out.last_mut() {
        b.active = now < b.end_ms;
    }
    if out.len() > limit {
        out.drain(..out.len() - limit);
    }
    out
}

// ------------------------------------------------------------- full-text

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub file: String,
    /// Every line that matched, capped — the point is to recognise the session,
    /// not to read it here.
    pub snippets: Vec<String>,
    pub total: u32,
}

/// A readable fragment of a transcript line, centred on `at`.
///
/// The line is JSON, so the raw text is full of `{"type":"assistant",...}`.
/// When the record parses and carries a message we show the message text;
/// otherwise we fall back to a window of the raw line, which is still enough
/// to recognise a hit. Slicing is by char boundary — a transcript is Unicode
/// and byte slicing would panic on Vietnamese text.
fn snippet(line: &str, at: usize, needle_len: usize) -> String {
    let text = serde_json::from_str::<serde_json::Value>(line)
        .ok()
        .and_then(|v| v.get("message").map(message_text))
        .filter(|t| !t.trim().is_empty());

    let (source, at) = match &text {
        // Re-find inside the extracted text; the byte offset from the raw line
        // means nothing there.
        Some(t) => match t.to_lowercase().find(&line[at..at + needle_len].to_lowercase()) {
            Some(i) => (t.as_str(), i),
            None => (t.as_str(), 0),
        },
        None => (line, at),
    };

    let start = source[..at].char_indices().rev().nth(60).map(|(i, _)| i).unwrap_or(0);
    let end = source[at..]
        .char_indices()
        .nth(140)
        .map(|(i, _)| at + i)
        .unwrap_or(source.len());
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.push_str(source[start..end].trim());
    if end < source.len() {
        out.push('…');
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Grep every transcript for `query`.
///
/// The session list only knows titles, last prompts and paths, so "where did I
/// ask Claude about X last week" was unanswerable. This reads the bodies.
///
/// ponytail: a full read of every transcript per search, parallel the same way
/// the scan is, with no index. On a few hundred megabytes that is well under a
/// second on warm cache; an inverted index is the upgrade if that stops being
/// true.
pub fn search(claude_dir: &Path, query: &str, per_file: usize) -> Vec<Hit> {
    let needle = query.trim().to_lowercase();
    if needle.len() < 2 {
        return Vec::new();
    }

    let root = claude_dir.join("projects");
    let mut files: Vec<PathBuf> = Vec::new();
    let Ok(projects) = std::fs::read_dir(&root) else { return Vec::new() };
    for project in projects.flatten() {
        let Ok(entries) = std::fs::read_dir(project.path()) else { continue };
        files.extend(
            entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("jsonl")),
        );
    }

    let hit_of = |path: &PathBuf| -> Option<Hit> {
        let raw = std::fs::read_to_string(path).ok()?;
        let lower = raw.to_lowercase();
        if !lower.contains(&needle) {
            return None;
        }
        let mut snippets = Vec::new();
        let mut total = 0u32;
        for (line, low) in raw.lines().zip(lower.lines()) {
            let Some(at) = low.find(&needle) else { continue };
            total += 1;
            if snippets.len() < per_file {
                let s = snippet(line, at, needle.len());
                if !s.is_empty() {
                    snippets.push(s);
                }
            }
        }
        (total > 0).then(|| Hit { file: path.to_string_lossy().into_owned(), snippets, total })
    };

    let workers = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(1, 8);
    let chunk = files.len().div_ceil(workers).max(1);
    std::thread::scope(|scope| {
        let handles: Vec<_> = files
            .chunks(chunk)
            .map(|c| scope.spawn(|| c.iter().filter_map(&hit_of).collect::<Vec<_>>()))
            .collect();
        handles.into_iter().filter_map(|h| h.join().ok()).flatten().collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delete_refuses_paths_outside_the_transcript_root() {
        let root = crate::util::claude_home().unwrap_or_else(|| std::env::temp_dir().join(".claude"));
        std::fs::create_dir_all(root.join("projects")).ok();
        let stray = std::env::temp_dir().join("agentspace-not-a-transcript.jsonl");
        std::fs::write(&stray, "{}").unwrap();
        let err = delete(&root, &[stray.to_string_lossy().into_owned()]).unwrap_err();
        assert!(err.contains("Từ chối xoá"), "phải từ chối, nhận: {err}");
        assert!(stray.exists(), "tệp ngoài phạm vi phải còn nguyên");
        std::fs::remove_file(&stray).ok();

        // Một đường dẫn không tồn tại cũng không được âm thầm bỏ qua.
        assert!(delete(&root, &["/khong/ton/tai.jsonl".into()]).is_err());
    }

    #[test]
    fn iso_and_day_roundtrip() {
        // 2026-09-03T01:04:12.345Z
        let t = iso_to_ms("2026-09-03T01:04:12.345Z").expect("parses");
        assert_eq!(t, 1_788_397_452_345);
        assert_eq!(local_day(t, 0), "2026-09-03");
        // UTC+7 (getTimezoneOffset() == -420): 01:04Z is still the 3rd locally.
        assert_eq!(local_day(t, -420), "2026-09-03");
        // UTC-8 (offset 480): 01:04Z is the previous day locally.
        assert_eq!(local_day(t, 480), "2026-09-02");
        assert!(iso_to_ms("nonsense").is_none());
    }

    #[test]
    fn typing_ignores_nested_types() {
        let assistant = r#"{"parentUuid":null,"message":{"type":"message","content":[{"type":"text","text":"hi"}]},"type":"assistant"}"#;
        assert_eq!(line_type(assistant), Some("assistant"));
        let user = r#"{"type":"user","userType":"external","message":{"content":"hello"}}"#;
        assert_eq!(line_type(user), Some("user"));
        assert_eq!(line_type(r#"{"type":"attachment"}"#), None);
    }

    /// End-to-end over a real file: the totals a chart reads must equal the
    /// per-model breakdown a table reads. Those two disagreeing is the exact
    /// bug CACHE_VERSION exists to prevent.
    #[test]
    fn parse_file_totals_match_model_breakdown() {
        let dir = std::env::temp_dir().join("agentspace-parse-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("11111111-2222-3333-4444-555555555555.jsonl");
        let content = [
            r#"{"type":"user","cwd":"/tmp/proj","gitBranch":"main","version":"2.1.259","timestamp":"2026-09-03T01:00:00.000Z","message":{"content":"làm giúp tôi X"}}"#,
            r#"{"message":{"model":"claude-opus-5","usage":{"input_tokens":10,"cache_creation_input_tokens":100,"cache_read_input_tokens":1000,"output_tokens":50}},"type":"assistant"}"#,
            r#"{"message":{"model":"claude-sonnet-5","usage":{"input_tokens":5,"cache_creation_input_tokens":0,"cache_read_input_tokens":1100,"output_tokens":70}},"type":"assistant"}"#,
            r#"{"type":"ai-title","aiTitle":"Việc X","sessionId":"x"}"#,
            r#"{"type":"last-prompt","lastPrompt":"tiếp tục đi"}"#,
            r#"{"type":"cost-state","totalCostUSD":1.25,"totalLinesAdded":9,"totalLinesRemoved":2,"totalDuration":60000,"startTime":1788397200000,"modelUsage":{"claude-opus-5":{"costUSD":1.0},"claude-sonnet-5":{"costUSD":0.25}}}"#,
        ]
        .join("\n");
        std::fs::write(&path, &content).unwrap();

        let s = parse_file(&path, content.len() as u64, 1_788_397_300_000).expect("parses");
        assert_eq!(s.title, "Việc X");
        assert_eq!(s.last_prompt, "tiếp tục đi");
        assert_eq!(s.cwd, "/tmp/proj");
        assert_eq!(s.git_branch, "main");
        assert_eq!(s.messages, 3);
        assert!(s.has_cost);
        assert_eq!(s.started_at_ms, 1_788_397_200_000);
        assert_eq!((s.input, s.cache_create, s.cache_read, s.output), (15, 100, 2100, 120));
        // The invariant a stale cache silently broke.
        assert_eq!(s.output, s.models.iter().map(|m| m.output).sum::<u64>());
        assert_eq!(s.input, s.models.iter().map(|m| m.input).sum::<u64>());
        assert_eq!(s.cost_usd, 1.25);
        assert_eq!(s.models.len(), 2);

        // And a bucket built from it agrees with the session.
        let report = usage(std::slice::from_ref(&s), "all", 0);
        assert_eq!(report.total.output, s.output);
        assert_eq!(report.by_model.iter().map(|m| m.bucket.output).sum::<u64>(), s.output);
        assert_eq!(report.by_day.len(), 1);

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn usage_reads_top_level_fields_not_nested_ones() {
        // Shape copied from a real transcript: cache_creation_input_tokens must
        // not be mistaken for input_tokens, output_tokens_details must not be
        // mistaken for output_tokens, and the iterations echo must not win.
        let line = r#"{"message":{"model":"claude-sonnet-5","usage":{"input_tokens":2,"cache_creation_input_tokens":21260,"cache_read_input_tokens":31587,"output_tokens":1301,"output_tokens_details":{"thinking_tokens":666},"iterations":[{"input_tokens":9999,"output_tokens":8888}]}},"type":"assistant"}"#;
        let (model, inp, cc, cr, out) = message_usage(line).expect("has usage");
        assert_eq!(model, "claude-sonnet-5");
        assert_eq!((inp, cc, cr, out), (2, 21260, 31587, 1301));
        assert!(message_usage(r#"{"type":"user"}"#).is_none());
    }

    #[test]
    fn titles_skip_framing_blocks() {
        assert!(is_noise("<command-name>/model</command-name>"));
        assert!(is_noise("Caveat: The messages below were generated"));
        assert!(!is_noise("làm giúp tôi phần render 3D"));
        assert_eq!(truncate("  dòng đầu\ndòng hai", 80), "dòng đầu");
    }

    #[test]
    fn blocks_close_after_five_hours_and_after_a_gap() {
        let h = |hour: u64, out: u64| HourBucket {
            hour,
            first_ms: hour * 3_600_000 + 9 * 60_000, // hh:09, như một phiên thật
            output: out,
            messages: 1,
            ..Default::default()
        };
        // A day far in the past so `active` cannot depend on the wall clock.
        let base = 400_000u64;
        let s = Session {
            cost_usd: 10.0,
            hours: vec![h(base, 100), h(base + 1, 300), h(base + 4, 600), h(base + 9, 500)],
            ..Default::default()
        };
        let bs = blocks(std::slice::from_ref(&s), 60);
        assert_eq!(bs.len(), 2, "giờ +9 rơi ngoài cửa sổ 5 giờ đầu");
        assert_eq!(bs[0].output, 1000);
        assert_eq!(bs[0].messages, 3);
        // Cửa sổ mở đúng phút có tin nhắn đầu, không làm tròn về đầu giờ —
        // đây là điều /usage của Claude Code hiển thị ("Resets 9:09am").
        assert_eq!(bs[0].start_ms, base * 3_600_000 + 9 * 60_000);
        assert_eq!(bs[0].end_ms, (base + 5) * 3_600_000 + 9 * 60_000);
        assert_eq!(bs[1].start_ms, (base + 9) * 3_600_000 + 9 * 60_000);
        assert_eq!(bs[1].output, 500);
        // Hour +4 sits inside the first window, so it must not open a new one.
        assert!(bs[1].start_ms >= bs[0].end_ms);
        // Cost is split by output share, and the parts still add up.
        assert!((bs[0].cost_usd - 10.0 * 1000.0 / 1500.0).abs() < 1e-9);
        assert!((bs.iter().map(|b| b.cost_usd).sum::<f64>() - 10.0).abs() < 1e-9);
        assert!(!bs[1].active, "cửa sổ của quá khứ không còn mở");

        // A live window is flagged, and only the last one.
        let now_h = now_ms() / 3_600_000;
        let live = Session { hours: vec![h(now_h, 7)], ..Default::default() };
        let bs = blocks(&[s, live], 60);
        assert!(bs.last().unwrap().active);
        assert!(bs[..bs.len() - 1].iter().all(|b| !b.active));
    }

    #[test]
    fn hours_follow_message_timestamps_not_the_session_start() {
        let dir = std::env::temp_dir().join("agentspace-hours-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("22222222-2222-3333-4444-555555555555.jsonl");
        // Một phiên kéo dài qua hai giờ: token phải nằm đúng giờ của nó.
        let content = [
            r#"{"type":"user","cwd":"/tmp/p","timestamp":"2026-09-03T01:00:00.000Z","message":{"content":"chào"}}"#,
            r#"{"type":"assistant","timestamp":"2026-09-03T01:30:00.000Z","message":{"model":"claude-opus-5","usage":{"input_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":40}}}"#,
            r#"{"type":"assistant","timestamp":"2026-09-03T03:10:00.000Z","message":{"model":"claude-opus-5","usage":{"input_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":60}}}"#,
        ]
        .join("\n");
        std::fs::write(&path, &content).unwrap();
        let s = parse_file(&path, content.len() as u64, 0).expect("parses");
        assert_eq!(s.hours.len(), 2);
        assert_eq!(s.hours[0].output, 40);
        assert_eq!(s.hours[1].output, 60);
        assert_eq!(s.hours[1].hour - s.hours[0].hour, 2);
        // Không đánh rơi token nào so với tổng của phiên.
        assert_eq!(s.hours.iter().map(|h| h.output).sum::<u64>(), s.output);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn search_finds_bodies_the_metadata_never_sees() {
        let dir = std::env::temp_dir().join("agentspace-search-test").join("projects").join("p");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("33333333-2222-3333-4444-555555555555.jsonl");
        let content = [
            r#"{"type":"user","cwd":"/tmp/p","timestamp":"2026-09-03T01:00:00.000Z","message":{"content":"sửa giúp tôi lỗi WebView2 trên Windows"}}"#,
            r#"{"type":"assistant","timestamp":"2026-09-03T01:01:00.000Z","message":{"content":[{"type":"text","text":"Lỗi WebView2 thường do thiếu runtime."}]}}"#,
            r#"{"type":"ai-title","aiTitle":"Một tiêu đề chẳng liên quan","sessionId":"x"}"#,
        ]
        .join("\n");
        std::fs::write(&path, content).unwrap();
        let root = std::env::temp_dir().join("agentspace-search-test");

        let hits = search(&root, "webview2", 5);
        assert_eq!(hits.len(), 1, "phải tìm ra dù tiêu đề không chứa từ khoá");
        assert_eq!(hits[0].total, 2, "cả câu hỏi lẫn câu trả lời");
        // Trích ra chữ người đọc được, không phải JSON thô.
        assert!(hits[0].snippets.iter().any(|s| s.contains("thiếu runtime")), "{:?}", hits[0].snippets);
        assert!(!hits[0].snippets.iter().any(|s| s.contains("\"type\"")), "{:?}", hits[0].snippets);

        // Không khớp thì không trả về gì, và query quá ngắn bị từ chối.
        assert!(search(&root, "khongcotutnay", 5).is_empty());
        assert!(search(&root, "a", 5).is_empty());

        // Tiếng Việt có dấu: cắt theo ký tự, không panic ở biên byte.
        let hits = search(&root, "sửa giúp", 5);
        assert_eq!(hits.len(), 1);

        std::fs::remove_dir_all(&root).ok();
    }
}
