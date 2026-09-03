//! Running the shell inside WSL instead of on the Windows host.
//!
//! A workspace can live on either side. If it is a Linux folder, a Windows
//! shell is the wrong tool: cmd refuses a UNC working directory, `claude` is
//! installed in the distro rather than on Windows, and the POSIX shell
//! integration never loads. So a pane names a *runtime*, and a WSL runtime
//! spawns `wsl.exe -d <distro>` with the paths translated for the Linux side.
//!
//! Everything here degrades to nothing on a Linux host: `wsl.exe` is simply not
//! found, so `distros()` returns empty and only the host runtime is offered.

use crate::util::to_wsl_path;
use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Runtime {
    pub id: String,
    pub label: String,
    /// The host's OS ("windows" | "linux" | "macos") or "wsl".
    pub kind: String,
    pub distro: String,
    /// Login shell reported by the runtime, e.g. /bin/zsh.
    pub shell: String,
}

/// `wsl.exe --list --quiet` answers in UTF-16LE. Decode it without pulling in
/// an encoding crate, and drop the BOM and blank lines.
pub fn decode_utf16le(bytes: &[u8]) -> String {
    let body = bytes.strip_prefix(&[0xFF, 0xFE][..]).unwrap_or(bytes);
    let units: Vec<u16> = body.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
    String::from_utf16_lossy(&units)
}

pub fn parse_distro_list(text: &str) -> Vec<String> {
    text.lines()
        .map(|l| l.trim().trim_end_matches(" (Default)").trim())
        .filter(|l| !l.is_empty() && !l.starts_with("Windows Subsystem"))
        .map(str::to_string)
        .collect()
}

fn wsl(args: &[&str]) -> Option<Vec<u8>> {
    let out = crate::util::quiet_command("wsl.exe").args(args).output().ok()?;
    out.status.success().then_some(out.stdout)
}

pub fn distros() -> Vec<String> {
    // Only a Windows host can reach into a distro's files over
    // \\wsl.localhost, and only there does the switch mean anything — a Linux
    // build is already on the right side of the fence.
    if !cfg!(windows) {
        return Vec::new();
    }
    wsl(&["--list", "--quiet"])
        .map(|b| parse_distro_list(&decode_utf16le(&b)))
        .unwrap_or_default()
}

/// The distro user's home, e.g. `/home/thuan`.
pub fn home(distro: &str) -> Option<String> {
    wsl(&["-d", distro, "--", "sh", "-lc", "printf %s \"$HOME\""])
        .map(|b| String::from_utf8_lossy(&b).trim().to_string())
        .filter(|s| s.starts_with('/'))
}

/// A Linux path as Windows can open it. Windows serves a running distro's
/// filesystem over this UNC share, so sessions, skills and memory can be read
/// with ordinary file IO instead of piping everything through `wsl.exe`.
pub fn unc(distro: &str, linux_path: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(format!("\\\\wsl.localhost\\{distro}{}", linux_path.replace('/', "\\")))
}

/// The distro's login shell. `sh -lc` so a shell set in the user's profile is
/// what we get, not whatever `wsl.exe` happens to default to.
fn login_shell(distro: &str) -> String {
    wsl(&["-d", distro, "--", "sh", "-lc", "printf %s \"${SHELL:-/bin/bash}\""])
        .map(|b| String::from_utf8_lossy(&b).trim().to_string())
        .filter(|s| s.starts_with('/'))
        .unwrap_or_else(|| "/bin/bash".into())
}

/// Read a file from inside the distro. Used for the account record, which lives
/// in the distro's home rather than the Windows one.
pub fn read_file(distro: &str, path: &str) -> Option<String> {
    wsl(&["-d", distro, "--", "sh", "-lc", &format!("cat {path} 2>/dev/null")])
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .filter(|s| !s.trim().is_empty())
}

pub fn file_exists(distro: &str, path: &str) -> bool {
    wsl(&["-d", distro, "--", "sh", "-lc", &format!("test -e {path} && echo y")])
        .map(|b| String::from_utf8_lossy(&b).trim() == "y")
        .unwrap_or(false)
}

/// One login-shell command inside the distro, stdout as bytes.
pub fn run(distro: &str, cmd: &str) -> Option<Vec<u8>> {
    wsl(&["-d", distro, "--", "sh", "-lc", cmd])
}

/// `claude --version` as the distro sees it — a Windows install of the CLI says
/// nothing about whether the Linux side has one.
pub fn claude_version(distro: &str) -> Option<String> {
    wsl(&["-d", distro, "--", "sh", "-lc", "command -v claude >/dev/null && claude --version"])
        .map(|b| String::from_utf8_lossy(&b).trim().to_string())
        .filter(|s| !s.is_empty())
}

pub fn runtimes(host_label: &str, host_kind: &str, host_shell: &str) -> Vec<Runtime> {
    let mut out = vec![Runtime {
        id: "host".into(),
        label: host_label.into(),
        kind: host_kind.into(),
        distro: String::new(),
        shell: host_shell.into(),
    }];
    for d in distros() {
        out.push(Runtime {
            id: format!("wsl:{d}"),
            label: format!("WSL · {d}"),
            kind: "wsl".into(),
            distro: d.clone(),
            shell: login_shell(&d),
        });
    }
    out
}

pub fn distro_of(runtime: &str) -> Option<&str> {
    runtime.strip_prefix("wsl:").filter(|d| !d.is_empty())
}

/// Argv for `wsl.exe` that lands an interactive login shell in `cwd`, with the
/// shell-integration file wired up the way that shell expects it.
pub fn spawn_args(distro: &str, shell: &str, cwd: &str, integration_dir: &str, with_integration: bool) -> Vec<String> {
    let base = shell.rsplit('/').next().unwrap_or(shell);
    let mut args: Vec<String> = vec![
        "-d".into(), distro.into(),
        "--cd".into(), to_wsl_path(cwd),
        "--".into(),
        shell.into(),
    ];
    // bash takes its init file as an argument, so that path has to be
    // translated here; zsh reads ZDOTDIR from the environment, which WSLENV
    // translates for us.
    if with_integration && base.contains("bash") {
        args.push("--init-file".into());
        args.push(to_wsl_path(&format!("{integration_dir}/bash-init.sh")));
    }
    args.push("-i".into());
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distro_list_decodes_and_cleans_up() {
        // Đúng dạng wsl.exe --list --quiet trả về: UTF-16LE, có BOM, có CR.
        let text = "Ubuntu\r\ndocker-desktop\r\n\r\n";
        let mut bytes = vec![0xFF, 0xFE];
        for u in text.encode_utf16() {
            bytes.extend_from_slice(&u.to_le_bytes());
        }
        assert_eq!(decode_utf16le(&bytes), text);
        assert_eq!(parse_distro_list(&decode_utf16le(&bytes)), vec!["Ubuntu", "docker-desktop"]);
        assert_eq!(parse_distro_list("Ubuntu (Default)\n"), vec!["Ubuntu"]);
    }

    #[test]
    fn unc_names_a_linux_path_the_way_windows_opens_it() {
        assert_eq!(
            unc("Ubuntu", "/home/thuan/.claude").to_string_lossy(),
            r"\\wsl.localhost\Ubuntu\home\thuan\.claude"
        );
    }

    #[test]
    fn spawn_args_translate_paths_per_shell() {
        let a = spawn_args("Ubuntu", "/bin/zsh", r"\\wsl.localhost\Ubuntu\home\thuan\x", r"C:\d\shell", true);
        assert_eq!(a, vec!["-d", "Ubuntu", "--cd", "/home/thuan/x", "--", "/bin/zsh", "-i"]);

        let b = spawn_args("Ubuntu", "/bin/bash", r"C:\code", r"C:\d\shell", true);
        assert_eq!(
            b,
            vec!["-d", "Ubuntu", "--cd", "/mnt/c/code", "--", "/bin/bash", "--init-file", "/mnt/c/d/shell/bash-init.sh", "-i"]
        );

        // Tắt shell integration thì không truyền --init-file.
        let c = spawn_args("Ubuntu", "/bin/bash", "/home/x", r"C:\d\shell", false);
        assert!(!c.iter().any(|s| s == "--init-file"));

        assert_eq!(distro_of("wsl:Ubuntu"), Some("Ubuntu"));
        assert_eq!(distro_of("host"), None);
    }
}
