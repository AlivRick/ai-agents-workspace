//! The Explorer view: browse a workspace, edit its files, and stage/commit
//! what changed — the few things you reach for VS Code to do while an agent
//! is working.
//!
//! Files are read with ordinary IO on the path the workspace was stored as
//! (on Windows a distro's folder is `\\wsl.localhost\…`, which IO follows);
//! git runs in the pane's runtime through `worktree::git`, like everywhere else.

use crate::worktree::git;
use serde::Serialize;
use std::path::{Component, Path, PathBuf};

/// Big enough for any source file, small enough that a stray log or dump does
/// not freeze a textarea.
const MAX_READ: u64 = 4 * 1024 * 1024;

fn lexical(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Every path the frontend hands over must sit inside the open workspace.
/// Lexical, like `ws::resolve`: `..` is folded away before the comparison.
fn inside(root: &str, path: &str) -> Result<PathBuf, String> {
    let r = lexical(Path::new(root));
    let p = lexical(Path::new(path));
    if r.as_os_str().is_empty() || !p.is_absolute() || !p.starts_with(&r) {
        return Err(format!("Refused: outside the workspace: {path}"));
    }
    Ok(p)
}

#[derive(Serialize)]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub dir: bool,
}

/// One directory level, folders first. The tree expands lazily, so a
/// `node_modules` is only read if you open it.
pub fn list(root: &str, dir: &str) -> Result<Vec<Entry>, String> {
    let d = inside(root, dir)?;
    let mut out: Vec<Entry> = std::fs::read_dir(&d)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name() != ".git")
        .map(|e| Entry {
            name: e.file_name().to_string_lossy().into_owned(),
            path: e.path().to_string_lossy().into_owned(),
            // Follows symlinks, so a linked folder expands like a folder.
            dir: e.path().is_dir(),
        })
        .collect();
    out.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

pub fn read(root: &str, path: &str) -> Result<String, String> {
    let p = inside(root, path)?;
    let len = std::fs::metadata(&p).map_err(|e| e.to_string())?.len();
    if len > MAX_READ {
        return Err(format!("Too large to open here ({} MB)", len / 1024 / 1024));
    }
    let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
    if bytes.contains(&0) {
        return Err("Binary file".into());
    }
    String::from_utf8(bytes).map_err(|_| "Not UTF-8 text".into())
}

/// ponytail: a plain `fs::write`, not `util::write_atomic` — that one renames a
/// `<name>.tmp` over the file, which would clobber a real `x.tmp` beside `x.ts`
/// and drop the executable bit. A crash mid-write can truncate the file; git
/// still has the last committed copy.
pub fn write(root: &str, path: &str, content: &str) -> Result<(), String> {
    let p = inside(root, path)?;
    std::fs::write(&p, content).map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct Item {
    /// Relative to the repo top, as git names it — what every git call takes.
    pub path: String,
    /// Where the file sits on disk, or empty when it is outside the workspace
    /// (the workspace is a subfolder of the repo) and cannot be opened.
    pub abs: String,
    /// M, A, D, R, U (untracked) …
    pub status: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub is_repo: bool,
    pub branch: String,
    pub staged: Vec<Item>,
    pub changes: Vec<Item>,
}

/// `git status --porcelain -z` split into the two lists VS Code shows. A file
/// staged and then edited again is in both, exactly as git sees it.
pub fn parse_status(raw: &str) -> (Vec<(String, String)>, Vec<(String, String)>) {
    let (mut staged, mut changes) = (Vec::new(), Vec::new());
    let mut it = raw.split('\0');
    while let Some(rec) = it.next() {
        if rec.len() < 4 {
            continue;
        }
        let (x, y, path) = (&rec[0..1], &rec[1..2], rec[3..].to_string());
        if x == "R" || x == "C" {
            it.next(); // the rename's source path
        }
        if x == "?" {
            changes.push(("U".into(), path));
            continue;
        }
        if x != " " {
            staged.push((x.into(), path.clone()));
        }
        if y != " " {
            changes.push((y.into(), path));
        }
    }
    (staged, changes)
}

pub fn status(runtime: &str, root: &str) -> Result<Status, String> {
    let Ok(prefix) = git(runtime, root, &["rev-parse", "--show-prefix"]) else {
        return Ok(Status { is_repo: false, branch: String::new(), staged: vec![], changes: vec![] });
    };
    let branch = git(runtime, root, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default();
    let raw = git(runtime, root, &["status", "--porcelain", "-z", "--untracked-files=all"])?;
    let (s, c) = parse_status(&raw);
    let item = |(status, path): (String, String)| {
        let abs = path
            .strip_prefix(prefix.as_str())
            .map(|rel| Path::new(root).join(rel).to_string_lossy().into_owned())
            .unwrap_or_default();
        Item { path, abs, status }
    };
    Ok(Status {
        is_repo: true,
        branch,
        staged: s.into_iter().map(item).collect(),
        changes: c.into_iter().map(item).collect(),
    })
}

/// `:(top)` because status names files from the repo top while `-C root`
/// would read them relative to the workspace.
fn top(files: &[String]) -> Vec<String> {
    files.iter().map(|f| format!(":(top){f}")).collect()
}

pub fn diff(runtime: &str, root: &str, file: &str, staged: bool) -> Result<String, String> {
    let spec = top(&[file.to_string()]);
    let mut a = vec!["diff", "--no-color"];
    if staged {
        a.push("--cached");
    }
    a.push("--");
    a.push(&spec[0]);
    git(runtime, root, &a)
}

/// ponytail: unstaging is `git restore --staged`, which needs a first commit
/// (git 2.23+). In a brand-new repo it errors; `git rm --cached` is the fallback.
pub fn stage(runtime: &str, root: &str, files: &[String], on: bool) -> Result<(), String> {
    let spec = top(files);
    let mut a: Vec<&str> = if on { vec!["add", "-A", "--"] } else { vec!["restore", "--staged", "--"] };
    a.extend(spec.iter().map(String::as_str));
    git(runtime, root, &a).map(|_| ())
}

pub fn commit(runtime: &str, root: &str, message: &str) -> Result<(), String> {
    if message.trim().is_empty() {
        return Err("Write a commit message first".into());
    }
    git(runtime, root, &["commit", "-m", message]).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_splits_into_staged_and_changes() {
        let raw = "M  a.ts\0 M b.ts\0MM c.ts\0?? new file.md\0R  to.ts\0from.ts\0 D gone.rs\0";
        let (s, c) = parse_status(raw);
        assert_eq!(s, vec![("M".into(), "a.ts".into()), ("M".into(), "c.ts".into()), ("R".into(), "to.ts".into())]);
        assert_eq!(
            c,
            vec![
                ("M".into(), "b.ts".into()),
                ("M".into(), "c.ts".into()),
                ("U".into(), "new file.md".into()),
                ("D".into(), "gone.rs".into()),
            ]
        );
    }

    #[test]
    fn paths_must_stay_in_the_workspace() {
        assert!(inside("/w/repo", "/w/repo/src/a.ts").is_ok());
        assert!(inside("/w/repo", "/w/repo/../other/a.ts").is_err());
        assert!(inside("/w/repo", "/w/repository/a.ts").is_err());
        assert!(inside("/w/repo", "src/a.ts").is_err());
    }
}
