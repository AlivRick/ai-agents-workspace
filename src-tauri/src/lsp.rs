//! Language servers for the Explorer's editor: Go to Definition, Find
//! References, Rename Symbol, Format Document, hover, completion.
//!
//! The server is whatever the user already installed (typescript-language-server,
//! rust-analyzer, …), run in the workspace's runtime the way a pane runs things
//! — in WSL through the user's interactive shell, so nvm and friends are on
//! PATH. This module only moves JSON-RPC: stdin gets `Content-Length` framed
//! messages, stdout is split back into messages and emitted to the webview as
//! `lsp` events. The editor side (`@codemirror/lsp-client`) does the protocol.

use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

/// The only programs this runs. The webview names a server, never a command.
pub fn command(server: &str) -> Option<&'static str> {
    Some(match server {
        "typescript" => "typescript-language-server --stdio",
        "rust" => "rust-analyzer",
        "python" => "pyright-langserver --stdio",
        "go" => "gopls",
        "css" => "vscode-css-language-server --stdio",
        "json" => "vscode-json-language-server --stdio",
        "html" => "vscode-html-language-server --stdio",
        _ => return None,
    })
}

struct Server {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Default)]
pub struct Servers {
    map: Mutex<HashMap<u32, Server>>,
    next: AtomicU32,
}

#[derive(Serialize, Clone)]
struct Msg {
    id: u32,
    msg: Option<String>,
}

/// Pull whole messages out of `buf`. Anything before a `Content-Length`
/// header is skipped: an interactive shell's rc files may print before `exec`.
pub fn frames(buf: &mut Vec<u8>) -> Vec<String> {
    let mut out = Vec::new();
    loop {
        let Some(h) = find(buf, b"Content-Length:") else { break };
        let Some(end) = find(&buf[h..], b"\r\n\r\n").map(|e| h + e + 4) else { break };
        let head = String::from_utf8_lossy(&buf[h..end]).to_string();
        let len: usize = head
            .lines()
            .find_map(|l| l.strip_prefix("Content-Length:"))
            .and_then(|v| v.trim().parse().ok())
            .unwrap_or(0);
        if buf.len() < end + len {
            break;
        }
        out.push(String::from_utf8_lossy(&buf[end..end + len]).into_owned());
        buf.drain(..end + len);
    }
    out
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// Start `server` for the folder `root` (as the app stores it). Returns the id
/// and the root as the server sees it, which the editor builds file URIs from.
pub fn start(app: &AppHandle, servers: &Servers, runtime: &str, shell: Option<String>, root: &str, server: &str)
    -> Result<(u32, String), String> {
    let cmd = command(server).ok_or_else(|| format!("No language server for {server}"))?;
    let (mut c, seen_root) = if let Some(distro) = crate::wsl::distro_of(runtime) {
        let dir = crate::util::to_wsl_path(root);
        let shell = shell.unwrap_or_else(|| "/bin/bash".into());
        let mut c = crate::util::quiet_command("wsl.exe");
        c.args(["-d", distro, "--cd", &dir, "--exec", &shell, "-ic", &format!("exec {cmd}")]);
        (c, dir)
    } else if cfg!(windows) {
        // npm installs these as .cmd shims, which only cmd.exe runs.
        let mut c = crate::util::quiet_command("cmd");
        c.args(["/C", cmd]).current_dir(root);
        (c, root.to_string())
    } else {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        let mut c = crate::util::quiet_command(&shell);
        c.args(["-ic", &format!("exec {cmd}")]).current_dir(root);
        (c, root.to_string())
    };
    let mut child = c
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Could not start {cmd}: {e}"))?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let mut stdout = child.stdout.take().ok_or("no stdout")?;
    let id = servers.next.fetch_add(1, Ordering::Relaxed) + 1;
    servers.map.lock().unwrap().insert(id, Server { child, stdin });

    let app = app.clone();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 16384];
        while let Ok(n @ 1..) = stdout.read(&mut chunk) {
            buf.extend_from_slice(&chunk[..n]);
            for m in frames(&mut buf) {
                let _ = app.emit("lsp", Msg { id, msg: Some(m) });
            }
        }
        // `msg: None` tells the editor the server is gone (or never started).
        let _ = app.emit("lsp", Msg { id, msg: None });
    });
    Ok((id, seen_root))
}

pub fn send(servers: &Servers, id: u32, msg: &str) -> Result<(), String> {
    let mut map = servers.map.lock().unwrap();
    let s = map.get_mut(&id).ok_or("language server stopped")?;
    write!(s.stdin, "Content-Length: {}\r\n\r\n{msg}", msg.len()).and_then(|_| s.stdin.flush()).map_err(|e| e.to_string())
}

pub fn stop(servers: &Servers, id: u32) {
    if let Some(mut s) = servers.map.lock().unwrap().remove(&id) {
        let _ = s.child.kill();
        let _ = s.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_split_and_skip_rc_chatter() {
        let a = r#"{"id":1}"#;
        let b = r#"{"id":2,"x":"é"}"#;
        let mut buf = format!("welcome to zsh\nContent-Length: {}\r\n\r\n{a}Content-Length: {}\r\n\r\n{b}Content-Len", a.len(), b.len()).into_bytes();
        assert_eq!(frames(&mut buf), vec![a.to_string(), b.to_string()]);
        assert_eq!(buf, b"Content-Len", "a partial header waits for more");
        assert!(command("rm -rf /").is_none(), "only known servers run");
    }
}
