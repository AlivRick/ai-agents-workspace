//! Real PTYs running the user's own shell, plus the two things that make those
//! PTYs legible to the app: OSC 133 shell integration (command blocks) and a
//! Claude Code hook drop-box (what the agent is doing inside the pane).

use crate::util::{home_dir, write_atomic};
use crate::wsl;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

pub struct Pane {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct Terminals(pub Mutex<HashMap<String, Pane>>);

// ------------------------------------------------------------ shell integration

/// OSC 133 marks where a prompt starts (A), where input begins (B), where the
/// command starts running (C) and where it ended with which status (D). OSC
/// 9;9 reports the cwd. Together they let the UI slice a scrollback into
/// command blocks instead of one undifferentiated wall of text.
pub fn write_shell_files(dir: &Path) -> std::io::Result<()> {
    let zsh = dir.join("zsh");
    std::fs::create_dir_all(&zsh)?;

    // zsh reads .zshenv/.zprofile/.zshrc from ZDOTDIR, so we point ZDOTDIR here
    // and chain to the user's real files. ZDOTDIR is handed back at the end of
    // .zshrc so anything the user runs later sees their own value.
    for (name, _) in [(".zshenv", ()), (".zprofile", ()), (".zlogin", ())] {
        std::fs::write(
            zsh.join(name),
            format!(
                "[ -f \"${{USER_ZDOTDIR:-$HOME}}/{name}\" ] && . \"${{USER_ZDOTDIR:-$HOME}}/{name}\"\n"
            ),
        )?;
    }
    std::fs::write(zsh.join(".zshrc"), ZSHRC)?;
    std::fs::write(dir.join("bash-init.sh"), BASH_INIT)?;
    std::fs::write(dir.join("pwsh-init.ps1"), PWSH_INIT)?;
    Ok(())
}

const ZSHRC: &str = r#"ZDOTDIR="${USER_ZDOTDIR:-$HOME}"
[ -f "$ZDOTDIR/.zshrc" ] && . "$ZDOTDIR/.zshrc"

if [[ -o interactive ]] && [[ -z "$AGENTSPACE_SI" ]]; then
  AGENTSPACE_SI=1
  autoload -Uz add-zsh-hook
  __as_emit() { printf '\e]%s\a' "$1" }
  __as_precmd() {
    local ec=$?
    if [[ -n "$__as_running" ]]; then __as_emit "133;D;$ec"; __as_running=; fi
    __as_emit "133;A"
    __as_emit "9;9;$PWD"
  }
  __as_preexec() { __as_emit "133;C"; __as_running=1 }
  add-zsh-hook precmd __as_precmd
  add-zsh-hook preexec __as_preexec
  PS1="$PS1"$'%{\e]133;B\a%}'
fi
"#;

const BASH_INIT: &str = r#"[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"

if [[ $- == *i* ]] && [ -z "$AGENTSPACE_SI" ]; then
  AGENTSPACE_SI=1
  __as_emit() { printf '\033]%s\a' "$1"; }
  __as_preexec() {
    [[ -n "$__as_in_prompt" || -n "$__as_running" || "$BASH_COMMAND" == *"__as_"* ]] && return
    __as_emit "133;C"; __as_running=1
  }
  __as_precmd() {
    local ec=$?
    __as_in_prompt=1
    if [[ -n "$__as_running" ]]; then __as_emit "133;D;$ec"; __as_running=; fi
    __as_emit "133;A"
    __as_emit "9;9;$PWD"
    __as_in_prompt=
  }
  trap '__as_preexec' DEBUG
  PROMPT_COMMAND="__as_precmd${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
  PS1="$PS1\[\033]133;B\a\]"
fi
"#;

/// PowerShell has no preexec hook, so the prompt function reports the previous
/// command's exit code (D) and the new prompt (A/B), and a PSReadLine Enter
/// handler reports the moment a command starts (C). Same four marks as the
/// POSIX shells, arrived at differently.
const PWSH_INIT: &str = r#"if ($env:AGENTSPACE_SI -eq $null) {
  $env:AGENTSPACE_SI = '1'
  $global:__asEsc = [char]27
  function global:__asEmit([string]$p) { Write-Host -NoNewline ("{0}]{1}{2}" -f $global:__asEsc, $p, [char]7) }
  $global:__asRunning = $false
  $global:__asPrompt = $function:prompt

  function global:prompt {
    $code = $LASTEXITCODE
    if ($null -eq $code) { $code = 0 }
    if ($global:__asRunning) { __asEmit ("133;D;{0}" -f $code); $global:__asRunning = $false }
    __asEmit '133;A'
    try { __asEmit ("9;9;{0}" -f (Get-Location).Path) } catch { }
    $text = try { & $global:__asPrompt } catch { "PS " + (Get-Location).Path + "> " }
    __asEmit '133;B'
    return $text
  }

  if (Get-Module -ListAvailable -Name PSReadLine) {
    Import-Module PSReadLine -ErrorAction SilentlyContinue
    Set-PSReadLineKeyHandler -Key Enter -ScriptBlock {
      __asEmit '133;C'
      $global:__asRunning = $true
      [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
    }
  }
}
"#;

// ------------------------------------------------------------------ hook inbox

/// A settings file passed to `claude --settings`. It only *adds* hooks for this
/// launch; the user's own ~/.claude/settings.json is never edited.
///
/// Each hook writes its stdin JSON to a temp name and renames it into place, so
/// the poller can never observe a half-written event.
pub fn write_hook_settings(dir: &Path) -> std::io::Result<PathBuf> {
    let inbox = dir.join("hook-events");
    std::fs::create_dir_all(&inbox)?;

    let cmd = r#"if [ -n "$AGENTSPACE_HOOK_DIR" ]; then f="$AGENTSPACE_HOOK_DIR/${AGENTSPACE_PANE:-x}.$(date +%s%N).$$"; cat > "$f.part" && mv "$f.part" "$f.json"; else cat > /dev/null; fi"#;
    let run = serde_json::json!([{ "type": "command", "command": cmd }]);
    let matched = serde_json::json!([{ "matcher": "*", "hooks": run }]);
    let plain = serde_json::json!([{ "hooks": run }]);

    let settings = serde_json::json!({
        "hooks": {
            "SessionStart": plain,
            "UserPromptSubmit": plain,
            "PreToolUse": matched,
            "PostToolUse": matched,
            "Notification": plain,
            "Stop": plain,
            "SessionEnd": plain,
        }
    });
    let path = dir.join("claude-hooks.json");
    write_atomic(&path, &serde_json::to_vec_pretty(&settings)?)?;
    Ok(path)
}

/// Read and remove every queued hook event. Called on a timer by the UI —
/// cheaper and less code than a filesystem watcher for a directory that is
/// empty almost all the time.
pub fn drain_hooks(dir: &Path) -> Vec<serde_json::Value> {
    let inbox = dir.join("hook-events");
    let Ok(rd) = std::fs::read_dir(&inbox) else { return Vec::new() };
    let mut files: Vec<PathBuf> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("json"))
        .collect();
    files.sort();
    files.truncate(500); // ponytail: a burst above this drains on the next tick.

    let mut out = Vec::new();
    for f in files {
        if let Ok(raw) = std::fs::read_to_string(&f) {
            if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&raw) {
                // The pane id is the filename prefix; the payload has no idea
                // which terminal it came from.
                if let Some(pane) = f.file_name().and_then(|n| n.to_str()).and_then(|n| n.split('.').next()) {
                    if let Some(obj) = v.as_object_mut() {
                        obj.insert("paneId".into(), serde_json::Value::String(pane.to_string()));
                    }
                }
                out.push(v);
            }
        }
        let _ = std::fs::remove_file(&f);
    }
    out
}

// ---------------------------------------------------------------------- panes

/// PowerShell rather than %COMSPEC% on Windows: cmd.exe refuses a UNC working
/// directory (so a WSL folder silently lands you in C:\Windows) and there is
/// nowhere to hang the OSC 133 marks. PowerShell handles both.
fn shell_program() -> String {
    if cfg!(windows) {
        return std::env::var("AGENTSPACE_SHELL").unwrap_or_else(|_| "powershell.exe".into());
    }
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into())
}

pub fn runtimes() -> Vec<wsl::Runtime> {
    let (label, kind) = if cfg!(windows) {
        ("Windows", "windows")
    } else if cfg!(target_os = "macos") {
        ("macOS", "macos")
    } else {
        ("Linux", "linux")
    };
    wsl::runtimes(label, kind, &shell_program())
}

pub fn open(
    app: AppHandle,
    terms: &Terminals,
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    data_dir: PathBuf,
    shell_integration: bool,
    runtime: String,
    // Login shell for a WSL runtime, resolved from the cached runtime list.
    // Probing it here would re-run `wsl.exe` on every pane you open.
    wsl_shell: Option<String>,
) -> Result<(), String> {
    let pty = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let shell_dir = data_dir.join("shell");
    let hook_dir = data_dir.join("hook-events");

    // --- a shell inside WSL ------------------------------------------------
    if let Some(distro) = wsl::distro_of(&runtime) {
        let shell = wsl_shell.unwrap_or_else(|| "/bin/bash".into());
        let mut cmd = CommandBuilder::new("wsl.exe");
        for a in wsl::spawn_args(distro, &shell, &cwd, &shell_dir.to_string_lossy(), shell_integration) {
            cmd.arg(a);
        }
        for (k, v) in std::env::vars() {
            cmd.env(k, v);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("AGENTSPACE_PANE", &id);
        cmd.env("AGENTSPACE_HOOK_DIR", &hook_dir);
        if shell_integration {
            cmd.env("ZDOTDIR", shell_dir.join("zsh"));
            // USER_ZDOTDIR is deliberately unset: inside the distro the user's
            // own rc files live under the Linux $HOME, not the Windows one.
        }
        // WSLENV is how a Windows-side variable reaches the distro; `/p` asks
        // WSL to rewrite it as a Linux path on the way in.
        cmd.env("WSLENV", "AGENTSPACE_PANE:AGENTSPACE_HOOK_DIR/p:ZDOTDIR/p");
        return finish(app, terms, id, pty, cmd);
    }

    // --- a shell on this machine -------------------------------------------
    let program = shell_program();
    let mut cmd = CommandBuilder::new(&program);
    // Inherit the real environment explicitly so the child sees the same PATH
    // the user's shell would, then layer ours on top.
    for (k, v) in std::env::vars() {
        cmd.env(k, v);
    }
    cmd.cwd(if Path::new(&cwd).is_dir() { cwd.clone() } else { home_dir().map(|h| h.to_string_lossy().into_owned()).unwrap_or_else(|| "/".into()) });
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("AGENTSPACE_HOOK_DIR", &hook_dir);
    cmd.env("AGENTSPACE_PANE", &id);

    if shell_integration {
        let base = program.rsplit('/').next().unwrap_or(&program).to_string();
        if base.contains("zsh") {
            let orig = std::env::var("ZDOTDIR")
                .ok()
                .filter(|s| !s.is_empty())
                .or_else(|| home_dir().map(|h| h.to_string_lossy().into_owned()))
                .unwrap_or_default();
            cmd.env("USER_ZDOTDIR", orig);
            cmd.env("ZDOTDIR", shell_dir.join("zsh"));
        } else if base.contains("bash") {
            cmd.arg("--init-file");
            cmd.arg(shell_dir.join("bash-init.sh"));
        } else if base.contains("powershell") || base.contains("pwsh") {
            let init = shell_dir.join("pwsh-init.ps1");
            cmd.arg("-NoLogo");
            cmd.arg("-NoExit");
            cmd.arg("-ExecutionPolicy");
            cmd.arg("Bypass");
            cmd.arg("-Command");
            cmd.arg(format!(". '{}'", init.to_string_lossy().replace('\'', "''")));
        }
        // Any other shell simply runs without command blocks.
    }

    finish(app, terms, id, pty, cmd)
}

/// Spawn, stream stdout to the UI, and register the pane. Shared by the host
/// and WSL paths so the two cannot drift apart.
fn finish(
    app: AppHandle,
    terms: &Terminals,
    id: String,
    pty: portable_pty::PtyPair,
    cmd: CommandBuilder,
) -> Result<(), String> {
    let child = pty.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let writer = pty.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pty.master.try_clone_reader().map_err(|e| e.to_string())?;

    let ev = format!("pty:{id}");
    let ev_exit = format!("pty-exit:{id}");
    std::thread::spawn(move || {
        let mut buf = [0u8; 32768];
        let mut carry: Vec<u8> = Vec::new();
        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            carry.extend_from_slice(&buf[..n]);
            // A read can split a multi-byte character; hold the tail back
            // rather than emitting a mangled one. Vietnamese text in the
            // scrollback depends on this.
            loop {
                match std::str::from_utf8(&carry) {
                    Ok(s) => {
                        if !s.is_empty() {
                            let _ = app.emit(&ev, s);
                        }
                        carry.clear();
                        break;
                    }
                    Err(e) => {
                        let good = e.valid_up_to();
                        if good > 0 {
                            let s = String::from_utf8_lossy(&carry[..good]).into_owned();
                            let _ = app.emit(&ev, &s);
                        }
                        match e.error_len() {
                            // Genuinely invalid bytes: drop them and keep going.
                            Some(bad) => {
                                carry.drain(..good + bad);
                                let _ = app.emit(&ev, "\u{fffd}");
                            }
                            // Truncated tail: wait for the next read.
                            None => {
                                carry.drain(..good);
                                break;
                            }
                        }
                    }
                }
            }
        }
        let _ = app.emit(&ev_exit, ());
    });

    terms.0.lock().unwrap().insert(id, Pane { master: pty.master, writer, child });
    Ok(())
}

pub fn write(terms: &Terminals, id: &str, data: &str) -> Result<(), String> {
    let mut map = terms.0.lock().unwrap();
    let p = map.get_mut(id).ok_or("terminal đã đóng")?;
    p.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    p.writer.flush().map_err(|e| e.to_string())
}

pub fn resize(terms: &Terminals, id: &str, cols: u16, rows: u16) -> Result<(), String> {
    let map = terms.0.lock().unwrap();
    let p = map.get(id).ok_or("terminal đã đóng")?;
    p.master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

pub fn close(terms: &Terminals, id: &str) {
    if let Some(mut p) = terms.0.lock().unwrap().remove(id) {
        let _ = p.child.kill();
        let _ = p.child.wait();
    }
}

pub fn close_all(terms: &Terminals) {
    let ids: Vec<String> = terms.0.lock().unwrap().keys().cloned().collect();
    for id in ids {
        close(terms, &id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn on_path(prog: &str) -> Option<PathBuf> {
        std::env::split_paths(&std::env::var_os("PATH")?)
            .map(|d| d.join(prog))
            .find(|p| p.is_file())
    }

    /// Drive a real interactive shell through a real PTY and check that our
    /// integration files make it emit OSC 133 with the right exit codes.
    ///
    /// `USER_ZDOTDIR`/`HOME` point at an empty directory, so the developer's own
    /// rc files never run and the assertion is about our code alone.
    fn run_shell(shell: &Path, dir: &Path, args: &[&std::ffi::OsStr]) -> String {
        let empty = dir.join("home");
        std::fs::create_dir_all(&empty).unwrap();
        let pty = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .unwrap();
        let mut cmd = CommandBuilder::new(shell);
        for a in args {
            cmd.arg(a);
        }
        cmd.env("HOME", &empty);
        cmd.env("USER_ZDOTDIR", &empty);
        cmd.env("ZDOTDIR", dir.join("shell").join("zsh"));
        cmd.env("TERM", "xterm-256color");
        cmd.env("PS1", "$ ");
        cmd.cwd(dir);
        let mut child = pty.slave.spawn_command(cmd).unwrap();
        drop(pty.slave);

        let mut w = pty.master.take_writer().unwrap();
        w.write_all(b"true\nfalse\nexit\n").unwrap();
        w.flush().unwrap();
        drop(w);

        let mut reader = pty.master.try_clone_reader().unwrap();
        let mut out = Vec::new();
        let _ = reader.read_to_end(&mut out);
        let _ = child.wait();
        String::from_utf8_lossy(&out).into_owned()
    }

    #[test]
    fn shell_integration_marks_commands_and_exit_codes() {
        let dir = std::env::temp_dir().join("agentspace-shell-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        write_shell_files(&dir.join("shell")).unwrap();

        let mut ran = 0;

        if let Some(zsh) = on_path("zsh") {
            let out = run_shell(&zsh, &dir, &[]);
            assert!(out.contains("\u{1b}]133;A"), "zsh: thiếu prompt-start\n{out}");
            assert!(out.contains("\u{1b}]133;C"), "zsh: thiếu command-start\n{out}");
            assert!(out.contains("\u{1b}]133;D;0"), "zsh: `true` phải báo exit 0\n{out}");
            assert!(out.contains("\u{1b}]133;D;1"), "zsh: `false` phải báo exit 1\n{out}");
            assert!(out.contains("\u{1b}]9;9;"), "zsh: thiếu báo cáo cwd\n{out}");
            ran += 1;
        }

        if let Some(bash) = on_path("bash") {
            let init = dir.join("shell").join("bash-init.sh");
            let out = run_shell(&bash, &dir, &["--init-file".as_ref(), init.as_os_str()]);
            assert!(out.contains("\u{1b}]133;D;0"), "bash: `true` phải báo exit 0\n{out}");
            assert!(out.contains("\u{1b}]133;D;1"), "bash: `false` phải báo exit 1\n{out}");
            ran += 1;
        }

        assert!(ran > 0, "không có zsh lẫn bash để kiểm tra");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn every_shell_gets_an_integration_file() {
        let dir = std::env::temp_dir().join("agentspace-shellfiles-test");
        let _ = std::fs::remove_dir_all(&dir);
        write_shell_files(&dir).unwrap();
        for f in ["zsh/.zshrc", "zsh/.zshenv", "zsh/.zprofile", "bash-init.sh", "pwsh-init.ps1"] {
            assert!(dir.join(f).is_file(), "thiếu {f}");
        }
        // Cả bốn mốc OSC 133 phải có trong từng bản, nếu không thì command
        // blocks im lặng hỏng ở shell đó.
        for (f, marks) in [
            ("zsh/.zshrc", ["133;A", "133;B", "133;C", "133;D"]),
            ("bash-init.sh", ["133;A", "133;B", "133;C", "133;D"]),
            ("pwsh-init.ps1", ["133;A", "133;B", "133;C", "133;D"]),
        ] {
            let text = std::fs::read_to_string(dir.join(f)).unwrap();
            for m in marks {
                assert!(text.contains(m), "{f} thiếu mốc {m}");
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn hook_settings_cover_the_agent_lifecycle() {
        let dir = std::env::temp_dir().join("agentspace-hook-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = write_hook_settings(&dir).unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let hooks = v.get("hooks").and_then(|h| h.as_object()).expect("có khối hooks");
        for event in ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop", "SessionEnd"] {
            assert!(hooks.contains_key(event), "thiếu hook {event}");
        }
        // PreToolUse/PostToolUse cần matcher, các sự kiện khác thì không.
        assert!(hooks["PreToolUse"][0].get("matcher").is_some());
        assert!(hooks["Stop"][0].get("matcher").is_none());
        // Ghi ra .part rồi mới rename: poller không bao giờ đọc file dở.
        let cmd = hooks["Stop"][0]["hooks"][0]["command"].as_str().unwrap();
        assert!(cmd.contains(".part") && cmd.contains("mv "), "hook phải ghi nguyên tử: {cmd}");

        // Và hộp thư trống thì drain trả về rỗng, không lỗi.
        assert!(drain_hooks(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
