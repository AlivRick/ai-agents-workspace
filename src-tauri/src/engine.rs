//! Detects the locally installed Claude Code CLI and reports whether the user
//! is signed in.
//!
//! Compliance boundary, deliberate and load-bearing: this module reads only
//! *metadata* that Claude Code writes about the account (email, org, plan) and
//! checks whether a credential file *exists*. It never opens the credential
//! file, never extracts a token, and never talks to api.anthropic.com. All
//! model work goes through the user's own `claude` binary, on their own
//! subscription, exactly as if they had typed it in a terminal.

use crate::util::{claude_home, home_dir};
use crate::wsl;
use serde::Serialize;
use std::path::PathBuf;

/// Oldest CLI we can drive: `--include-partial-messages` and the stream-json
/// shapes we parse landed well before this, but hooks + `--settings` merging
/// behave consistently from 2.x on.
const MIN_VERSION: (u32, u32, u32) = (2, 0, 0);

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub email: String,
    pub display_name: String,
    pub full_name: String,
    pub organization: String,
    pub organization_role: String,
    /// Human label for the plan ("Max 5x", "Pro"). Derived, because the raw
    /// fields disagree: seatTier is often null while the rate-limit tier and
    /// organizationType carry the real answer.
    pub plan: String,
    pub seat_tier: String,
    pub billing_type: String,
    pub rate_limit_tier: String,
    pub has_extra_usage: bool,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub installed: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub version_ok: bool,
    pub min_version: String,
    pub signed_in: bool,
    /// "subscription" | "api-key" | "none"
    pub auth_source: String,
    pub account: Option<Account>,
    /// Actionable next step when something is missing. Mirrors what the CLI
    /// itself would tell the user; we never try to fix auth on their behalf.
    pub problem: Option<String>,
}

fn exe_name() -> &'static str {
    if cfg!(windows) {
        "claude.exe"
    } else {
        "claude"
    }
}

fn is_executable(p: &PathBuf) -> bool {
    let Ok(md) = std::fs::metadata(p) else { return false };
    if !md.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return md.permissions().mode() & 0o111 != 0;
    }
    #[cfg(not(unix))]
    true
}

/// A GUI process launched from a desktop entry inherits a minimal PATH, so the
/// binary is regularly missing from it even though the user's shell finds it.
/// Search PATH first, then the install locations Claude Code actually uses.
pub fn find_cli() -> Option<PathBuf> {
    let mut seen: Vec<PathBuf> = Vec::new();
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            seen.push(dir.join(exe_name()));
        }
    }
    if let Some(h) = home_dir() {
        for rel in [
            ".local/bin/claude",
            ".claude/local/claude",
            ".bun/bin/claude",
            ".volta/bin/claude",
            ".npm-global/bin/claude",
            "node_modules/.bin/claude",
        ] {
            seen.push(h.join(rel));
        }
    }
    for p in ["/usr/local/bin/claude", "/opt/homebrew/bin/claude"] {
        seen.push(PathBuf::from(p));
    }
    seen.into_iter().find(is_executable)
}

fn parse_semver(s: &str) -> Option<(u32, u32, u32)> {
    let head = s.trim().split_whitespace().next()?;
    let mut it = head.split('.');
    let a = it.next()?.parse().ok()?;
    let b = it.next()?.parse().ok()?;
    let c: u32 = it
        .next()
        .map(|x| x.trim_matches(|ch: char| !ch.is_ascii_digit()).parse().unwrap_or(0))
        .unwrap_or(0);
    Some((a, b, c))
}

/// `default_claude_max_5x` -> `Max 5x`; falls back to organizationType, then
/// the raw billing string.
fn plan_label(a: &serde_json::Value) -> String {
    let s = |k: &str| a.get(k).and_then(|x| x.as_str()).unwrap_or_default();
    let tier = [s("userRateLimitTier"), s("organizationRateLimitTier")]
        .into_iter()
        .find(|t| !t.is_empty())
        .unwrap_or_default();
    let trimmed = tier.trim_start_matches("default_").trim_start_matches("claude_");
    if !trimmed.is_empty() {
        return trimmed
            .split('_')
            .map(|w| {
                let mut c = w.chars();
                match c.next() {
                    Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                    None => String::new(),
                }
            })
            .collect::<Vec<_>>()
            .join(" ");
    }
    match s("organizationType").trim_start_matches("claude_") {
        "" => s("billingType").to_string(),
        other => {
            let mut c = other.chars();
            c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
        }
    }
}

fn read_account() -> Option<Account> {
    let path = home_dir()?.join(".claude.json");
    account_from_json(&std::fs::read_to_string(path).ok()?)
}

fn account_from_json(raw: &str) -> Option<Account> {
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    let a = v.get("oauthAccount")?;
    let s = |k: &str| a.get(k).and_then(|x| x.as_str()).unwrap_or_default().to_string();
    let email = s("emailAddress");
    if email.is_empty() {
        return None;
    }
    Some(Account {
        email,
        display_name: s("displayName"),
        full_name: s("fullName"),
        organization: s("organizationName"),
        organization_role: s("organizationRole"),
        plan: plan_label(a),
        seat_tier: s("seatTier"),
        billing_type: s("billingType"),
        rate_limit_tier: s("userRateLimitTier"),
        has_extra_usage: a.get("hasExtraUsageEnabled").and_then(|x| x.as_bool()).unwrap_or(false),
    })
}

/// Existence check only — the file is never opened. On macOS the token lives in
/// the Keychain instead, so the account record is the only signal available and
/// we accept it there.
fn has_credential() -> bool {
    if let Some(dir) = claude_home() {
        if std::fs::metadata(dir.join(".credentials.json")).is_ok() {
            return true;
        }
    }
    cfg!(target_os = "macos")
}

/// The real quota numbers, straight from the CLI.
///
/// `claude -p /usage` prints the same lines the `/usage` dialog shows, and they
/// come from the server — the only thing that knows the actual limit. This is
/// still the user's own binary on their own subscription; we never call the API.
///
/// ponytail: one subprocess per call, no timeout — a print-mode run always
/// exits on its own. Costs no model tokens: the slash command answers before a
/// turn starts. Upgrade path if it ever hangs: spawn + wait with a deadline.
pub fn usage_text(runtime: &str) -> Option<String> {
    // Một print-run vẫn để lại transcript như mọi phiên khác. Chạy trong thư
    // mục riêng để đống rác đó nằm gọn một chỗ, rồi xoá — nếu không, hỏi hạn
    // mức 5 phút một lần sẽ đẻ ra hàng trăm "phiên" giả trong chính thống kê
    // mà thẻ này đang vẽ.
    const PROBE: &str = "agentspace-usage-probe";
    let out = if let Some(distro) = wsl::distro_of(runtime) {
        // Không một dấu nháy kép nào trong lệnh này: `wsl.exe` được gọi qua
        // dòng lệnh Windows, dấu nháy bị nuốt trên đường đi và `$d` về rỗng —
        // đúng lỗi đã làm app bản Windows luôn rơi về số ước lượng. Mọi đường
        // dẫn ở đây không có khoảng trắng nên không cần nháy.
        wsl::run(
            distro,
            &format!(
                "mkdir -p /tmp/{PROBE} && cd /tmp/{PROBE} && claude -p /usage </dev/null; \
                 rm -rf $HOME/.claude/projects/*-{PROBE}"
            ),
        )
        .map(|b| String::from_utf8_lossy(&b).into_owned())
    } else {
        let dir = std::env::temp_dir().join(PROBE);
        std::fs::create_dir_all(&dir).ok()?;
        let out = std::process::Command::new(find_cli()?)
            .args(["-p", "/usage"])
            .current_dir(&dir)
            // Không có stdin thì CLI đứng chờ 3 giây rồi mới chạy tiếp.
            .stdin(std::process::Stdio::null())
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned());
        clean_probe(&dir, PROBE);
        out
    }?;
    // Not signed in, or an older CLI: the percentage lines simply are not there.
    out.contains("% used").then_some(out)
}

/// Xoá thư mục transcript mà probe vừa tạo. Chỉ xoá đúng thư mục mang tên
/// probe — tên do chính mình dựng, nên không có đường nào chạm vào phiên thật.
fn clean_probe(dir: &std::path::Path, probe: &str) {
    let name = crate::util::escape_project_path(&dir.to_string_lossy());
    if !name.ends_with(probe) {
        return;
    }
    if let Some(home) = claude_home() {
        std::fs::remove_dir_all(home.join("projects").join(name)).ok();
    }
}

/// Status of the CLI *for a given runtime*. A Windows install of Claude Code
/// says nothing about whether the WSL distro has one, and vice versa — the pane
/// that will run it is the thing that has to be checked.
pub fn status(runtime: &str) -> EngineStatus {
    let min = format!("{}.{}.{}", MIN_VERSION.0, MIN_VERSION.1, MIN_VERSION.2);

    if let Some(distro) = wsl::distro_of(runtime) {
        let version = wsl::claude_version(distro);
        let parsed = version.as_deref().and_then(parse_semver);
        let version_ok = parsed.map(|v| v >= MIN_VERSION).unwrap_or(false);
        let account = wsl::read_file(distro, "\"$HOME/.claude.json\"").as_deref().and_then(account_from_json);
        let signed_in = account.is_some() && wsl::file_exists(distro, "\"$HOME/.claude/.credentials.json\"");
        let problem = if version.is_none() {
            Some(format!("WSL · {distro} has no Claude Code. Open a WSL terminal and run `npm install -g @anthropic-ai/claude-code`."))
        } else if !version_ok {
            Some(format!("Claude Code in WSL · {distro} is too old. Run `claude update` to reach {min} or newer."))
        } else if !signed_in {
            Some(format!("Claude Code in WSL · {distro} is not signed in. Open a WSL terminal, run `claude`, sign in, then try again."))
        } else {
            None
        };
        return EngineStatus {
            installed: version.is_some(),
            path: Some(format!("wsl:{distro}")),
            version,
            version_ok,
            min_version: min,
            signed_in,
            auth_source: if signed_in { "subscription".into() } else { "none".into() },
            account,
            problem,
        };
    }

    let Some(path) = find_cli() else {
        return EngineStatus {
            min_version: min,
            auth_source: "none".into(),
            problem: Some(
                "Claude Code not found. Install it with `npm install -g @anthropic-ai/claude-code`, then reopen Agentspace.".into(),
            ),
            ..Default::default()
        };
    };

    let version = crate::util::quiet_command(&path.to_string_lossy())
        .arg("--version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    let parsed = version.as_deref().and_then(parse_semver);
    let version_ok = parsed.map(|v| v >= MIN_VERSION).unwrap_or(false);

    let account = read_account();
    let api_key = std::env::var("ANTHROPIC_API_KEY").is_ok_and(|k| !k.is_empty());
    let subscription = account.is_some() && has_credential();

    let (signed_in, auth_source) = if subscription {
        (true, "subscription")
    } else if api_key {
        (true, "api-key")
    } else {
        (false, "none")
    };

    let problem = if !version_ok {
        Some(format!(
            "Claude Code {} is too old. Run `claude update` to reach {} or newer.",
            version.clone().unwrap_or_else(|| "?".into()),
            min
        ))
    } else if !signed_in {
        Some("Claude Code is not signed in on this machine. Open a terminal, run `claude`, sign in, then try again.".into())
    } else {
        None
    };

    EngineStatus {
        installed: true,
        path: Some(path.to_string_lossy().into_owned()),
        version,
        version_ok,
        min_version: min,
        signed_in,
        auth_source: auth_source.into(),
        account,
        problem,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_cleanup_only_ever_touches_the_probe_folder() {
        // Tên thư mục transcript phải khớp cách Claude Code đặt tên, nếu không
        // rác không bao giờ bị xoá.
        assert_eq!(
            crate::util::escape_project_path("/tmp/agentspace-usage-probe"),
            "-tmp-agentspace-usage-probe"
        );
        // Và một thư mục không phải probe thì không được đụng tới: dựng một
        // "phiên thật" giả rồi gọi hàm dọn với đường dẫn đó.
        let home = claude_home().unwrap_or_else(|| std::env::temp_dir().join(".claude"));
        let fake = std::env::temp_dir().join("agentspace-not-a-probe");
        let dir = home.join("projects").join(crate::util::escape_project_path(&fake.to_string_lossy()));
        std::fs::create_dir_all(&dir).unwrap();
        clean_probe(&fake, "agentspace-usage-probe");
        assert!(dir.exists(), "thư mục không phải probe phải còn nguyên");
        std::fs::remove_dir_all(&dir).ok();
    }
    use serde_json::json;

    #[test]
    fn plan_label_prefers_the_field_that_is_actually_populated() {
        // The real shape on a Max seat: seatTier and userRateLimitTier are null,
        // billingType is the unhelpful "stripe_subscription".
        let max = json!({
            "seatTier": null, "userRateLimitTier": null,
            "organizationRateLimitTier": "default_claude_max_5x",
            "organizationType": "claude_max", "billingType": "stripe_subscription"
        });
        assert_eq!(plan_label(&max), "Max 5x");

        // A per-user tier wins over the org one.
        let user_tier = json!({
            "userRateLimitTier": "default_claude_pro",
            "organizationRateLimitTier": "default_claude_max_20x"
        });
        assert_eq!(plan_label(&user_tier), "Pro");

        // No tier at all: fall back to the org type, then to billing.
        assert_eq!(plan_label(&json!({"organizationType": "claude_max"})), "Max");
        assert_eq!(plan_label(&json!({"billingType": "stripe_subscription"})), "stripe_subscription");
        assert_eq!(plan_label(&json!({})), "");
    }

    #[test]
    fn version_parsing_tolerates_the_cli_suffix() {
        assert_eq!(parse_semver("2.1.259 (Claude Code)"), Some((2, 1, 259)));
        assert_eq!(parse_semver("2.1"), Some((2, 1, 0)));
        assert_eq!(parse_semver("1.0.0-beta.3"), Some((1, 0, 0)));
        assert_eq!(parse_semver("không phải số"), None);
        assert!(parse_semver("2.1.259 (Claude Code)").unwrap() >= MIN_VERSION);
    }
}
