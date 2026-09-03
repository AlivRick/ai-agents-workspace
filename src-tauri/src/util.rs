use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let key = "USERPROFILE";
    #[cfg(not(windows))]
    let key = "HOME";
    std::env::var_os(key).map(PathBuf::from).filter(|p| !p.as_os_str().is_empty())
}

pub fn claude_home() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        return Some(PathBuf::from(d));
    }
    home_dir().map(|h| h.join(".claude"))
}

pub fn ms(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn now_ms() -> u64 {
    ms(SystemTime::now())
}

/// Claude Code's on-disk name for a project directory: every character that is
/// not alphanumeric becomes `-`. Verified against ~/.claude/projects on disk.
pub fn escape_project_path(path: &str) -> String {
    path.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

/// Rewrite a Windows path the way the Linux side of WSL sees it.
///
/// Needed because a Windows host can drive a shell that lives inside WSL: the
/// working directory, the hook drop-box and the shell-integration files all
/// have to be named the way that shell will resolve them. Handles the three
/// UNC spellings Explorer and the folder picker actually produce.
pub fn to_wsl_path(p: &str) -> String {
    let slashed = p.replace('\\', "/");
    // `\\?\UNC\host\share` is the same place as `\\host\share`, so put the
    // double slash back after stripping the prefix or the host check misses.
    let stripped = slashed
        .strip_prefix("//?/UNC/")
        .map(|r| format!("//{r}"))
        .or_else(|| slashed.strip_prefix("//?/").map(str::to_string))
        .unwrap_or_else(|| slashed.clone());
    let stripped = stripped.as_str();
    for prefix in ["//wsl.localhost/", "//wsl$/"] {
        if let Some(rest) = stripped.strip_prefix(prefix) {
            return match rest.split_once('/') {
                Some((_distro, tail)) => format!("/{tail}"),
                None => "/".to_string(),
            };
        }
    }
    let b = stripped.as_bytes();
    if b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
        let drive = (b[0] as char).to_ascii_lowercase();
        let tail = stripped[2..].trim_start_matches('/');
        return format!("/mnt/{drive}/{tail}");
    }
    stripped.to_string()
}

/// Normalise a path so the same folder compares equal however it was spelled:
/// a Windows drive path, a `\\wsl.localhost` UNC share, or the POSIX path that
/// Claude Code records. The folder picker hands back `\\?\UNC\...` while
/// `wsl::unc` builds `\\wsl.localhost\...` — without this they look different
/// and the same workspace gets offered for import twice.
pub fn norm_path(p: &str) -> String {
    let s = to_wsl_path(p);
    let s = s.trim_end_matches('/');
    if s.is_empty() { "/".to_string() } else { s.to_string() }
}

/// A `Command` that does not flash a console window.
///
/// On Windows every `wsl.exe`, `claude --version` and `git` call spawns a
/// console subsystem process, and each one pops a black window for a few
/// frames. At startup the app makes a dozen of them — which is exactly the
/// "giật giật, mở terminal gì đó" people see. CREATE_NO_WINDOW suppresses it.
pub fn quiet_command(program: &str) -> std::process::Command {
    // `mut` is only used under cfg(windows); the flag does not exist elsewhere.
    #[allow(unused_mut)]
    let mut c = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

/// Write via a temp file + rename so a crash mid-write cannot truncate the
/// previous good copy.
pub fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_same_folder_compares_equal_however_it_is_spelled() {
        let want = "/home/thuan/hutech";
        assert_eq!(norm_path(r"\\?\UNC\wsl.localhost\Ubuntu\home\thuan\hutech"), want);
        assert_eq!(norm_path(r"\\wsl.localhost\Ubuntu\home\thuan\hutech"), want);
        assert_eq!(norm_path("/home/thuan/hutech/"), want);
        assert_ne!(norm_path("/home/thuan/hutech-bill"), want);
    }

    #[test]
    fn wsl_paths_cover_the_shapes_windows_actually_hands_us() {
        assert_eq!(to_wsl_path(r"C:\Users\thuan\code"), "/mnt/c/Users/thuan/code");
        assert_eq!(to_wsl_path(r"D:\data"), "/mnt/d/data");
        // Cả ba dạng UNC mà Explorer và hộp thoại chọn thư mục sinh ra.
        assert_eq!(to_wsl_path(r"\\wsl.localhost\Ubuntu\home\thuan\hutech"), "/home/thuan/hutech");
        assert_eq!(to_wsl_path(r"\\wsl$\Ubuntu\home\thuan"), "/home/thuan");
        assert_eq!(to_wsl_path(r"\\?\UNC\wsl.localhost\Ubuntu\home\thuan\hutech"), "/home/thuan/hutech");
        // Đường dẫn POSIX giữ nguyên.
        assert_eq!(to_wsl_path("/home/thuan/x"), "/home/thuan/x");
    }
}
