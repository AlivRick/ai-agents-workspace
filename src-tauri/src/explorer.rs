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
    /// The branch has an upstream to push to; without one Push publishes it.
    pub upstream: bool,
    /// Commits to push / to pull, as of the last fetch.
    pub ahead: u32,
    pub behind: u32,
    /// Conflicted files — VS Code's "Merge Changes". Status `!`.
    pub merge: Vec<Item>,
    pub staged: Vec<Item>,
    pub changes: Vec<Item>,
}

type Pairs = Vec<(String, String)>;

#[derive(Default, Debug, PartialEq)]
pub struct Parsed {
    pub branch: String,
    pub upstream: bool,
    pub ahead: u32,
    pub behind: u32,
    pub merge: Pairs,
    pub staged: Pairs,
    pub changes: Pairs,
}

/// `git status --porcelain -b -z` split into the lists VS Code shows. A file
/// staged and then edited again is in both, exactly as git sees it.
pub fn parse_status(raw: &str) -> Parsed {
    let mut p = Parsed::default();
    let mut it = raw.split('\0');
    while let Some(rec) = it.next() {
        if let Some(head) = rec.strip_prefix("## ") {
            // "master...origin/master [ahead 1, behind 2]", "No commits yet on x",
            // "HEAD (no branch)", or a bare "x" with no upstream.
            let (names, counts) = head.split_once(" [").unwrap_or((head, ""));
            let names = names.strip_prefix("No commits yet on ").unwrap_or(names);
            let (b, up) = names.split_once("...").unwrap_or((names, ""));
            p.branch = b.to_string();
            p.upstream = !up.is_empty();
            for part in counts.trim_end_matches(']').split(", ") {
                let n = |k: &str| part.strip_prefix(k).and_then(|v| v.parse().ok());
                if let Some(v) = n("ahead ") { p.ahead = v; }
                if let Some(v) = n("behind ") { p.behind = v; }
            }
            continue;
        }
        if rec.len() < 4 {
            continue;
        }
        let (xy, x, y, path) = (&rec[0..2], &rec[0..1], &rec[1..2], rec[3..].to_string());
        if x == "R" || x == "C" {
            it.next(); // the rename's source path
        }
        if matches!(xy, "DD" | "AU" | "UD" | "UA" | "DU" | "AA" | "UU") {
            p.merge.push(("!".into(), path));
            continue;
        }
        if x == "?" {
            p.changes.push(("U".into(), path));
            continue;
        }
        if x != " " {
            p.staged.push((x.into(), path.clone()));
        }
        if y != " " {
            p.changes.push((y.into(), path));
        }
    }
    p
}

pub fn status(runtime: &str, root: &str) -> Result<Status, String> {
    let Ok(prefix) = git(runtime, root, &["rev-parse", "--show-prefix"]) else {
        return Ok(Status {
            is_repo: false, branch: String::new(), upstream: false, ahead: 0, behind: 0,
            merge: vec![], staged: vec![], changes: vec![],
        });
    };
    let raw = git(runtime, root, &["status", "--porcelain", "-b", "-z", "--untracked-files=all"])?;
    let p = parse_status(&raw);
    let items = |v: Pairs| -> Vec<Item> {
        v.into_iter()
            .map(|(status, path)| {
                let abs = path
                    .strip_prefix(prefix.as_str())
                    .map(|rel| Path::new(root).join(rel).to_string_lossy().into_owned())
                    .unwrap_or_default();
                Item { path, abs, status }
            })
            .collect()
    };
    Ok(Status {
        is_repo: true,
        branch: p.branch,
        upstream: p.upstream,
        ahead: p.ahead,
        behind: p.behind,
        merge: items(p.merge),
        staged: items(p.staged),
        changes: items(p.changes),
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

/// The file as HEAD has it, for the editor's change bars. `None` when HEAD has
/// no such file (new, untracked, ignored, or no commits yet) — the frontend
/// decides which of those means "all added".
///
/// ponytail: `git()` trims trailing whitespace, so a final newline is lost; the
/// editor puts it back when the working file has one.
pub fn original(runtime: &str, root: &str, file: &str) -> Option<String> {
    git(runtime, root, &["show", &format!("HEAD:{file}")]).ok()
}

/// ponytail: unstaging is `git restore --staged`, which needs a first commit
/// (git 2.23+). In a brand-new repo it errors; `git rm --cached` is the fallback.
pub fn stage(runtime: &str, root: &str, files: &[String], on: bool) -> Result<(), String> {
    let spec = top(files);
    let mut a: Vec<&str> = if on { vec!["add", "-A", "--"] } else { vec!["restore", "--staged", "--"] };
    a.extend(spec.iter().map(String::as_str));
    git(runtime, root, &a).map(|_| ())
}

/// `all`: nothing is staged, so commit every change — VS Code's "smart commit".
pub fn commit(runtime: &str, root: &str, message: &str, all: bool) -> Result<(), String> {
    if message.trim().is_empty() {
        return Err("Write a commit message first".into());
    }
    if all {
        git(runtime, root, &["add", "-A", "--", ":/"])?;
    }
    git(runtime, root, &["commit", "-m", message]).map(|_| ())
}

/// Throw away working-tree changes. Tracked files go back to what is staged
/// (or committed); untracked files are deleted. Irreversible — the frontend
/// asks first.
pub fn discard(runtime: &str, root: &str, tracked: &[String], untracked: &[String]) -> Result<(), String> {
    if !tracked.is_empty() {
        let spec = top(tracked);
        let mut a = vec!["restore", "--"];
        a.extend(spec.iter().map(String::as_str));
        git(runtime, root, &a)?;
    }
    if !untracked.is_empty() {
        let spec = top(untracked);
        let mut a = vec!["clean", "-f", "-q", "--"];
        a.extend(spec.iter().map(String::as_str));
        git(runtime, root, &a)?;
    }
    Ok(())
}

/// Push, or publish the branch when it has no upstream yet.
pub fn push(runtime: &str, root: &str, upstream: bool) -> Result<(), String> {
    let a: &[&str] = if upstream { &["push"] } else { &["push", "-u", "origin", "HEAD"] };
    git(runtime, root, a).map(|_| ())
}

/// Fetch, then fast-forward if the branch is behind. Never merges: a diverged
/// branch is reported, not resolved behind your back.
pub fn pull(runtime: &str, root: &str) -> Result<(), String> {
    git(runtime, root, &["pull", "--ff-only"]).map(|_| ())
}

pub fn fetch(runtime: &str, root: &str) -> Result<(), String> {
    git(runtime, root, &["fetch", "--quiet"]).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_splits_into_staged_and_changes() {
        let raw = "## master...origin/master [ahead 2, behind 1]\0M  a.ts\0 M b.ts\0MM c.ts\0?? new file.md\0R  to.ts\0from.ts\0 D gone.rs\0UU clash.ts\0";
        let p = parse_status(raw);
        let v = |a: &[(&str, &str)]| a.iter().map(|(x, y)| (x.to_string(), y.to_string())).collect::<Vec<_>>();
        assert_eq!(p.staged, v(&[("M", "a.ts"), ("M", "c.ts"), ("R", "to.ts")]));
        assert_eq!(p.changes, v(&[("M", "b.ts"), ("M", "c.ts"), ("U", "new file.md"), ("D", "gone.rs")]));
        assert_eq!(p.merge, v(&[("!", "clash.ts")]));
        assert_eq!((p.branch.as_str(), p.upstream, p.ahead, p.behind), ("master", true, 2, 1));
    }

    #[test]
    fn branch_header_without_upstream() {
        let p = parse_status("## feature\0");
        assert_eq!((p.branch.as_str(), p.upstream, p.ahead), ("feature", false, 0));
        let p = parse_status("## No commits yet on main\0");
        assert_eq!(p.branch, "main");
    }

    /// Discard really restores a tracked file and deletes an untracked one,
    /// and leaves everything else alone.
    #[test]
    fn discard_restores_and_deletes() {
        let d = std::env::temp_dir().join(format!("as-discard-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("sub")).unwrap();
        let r = d.to_string_lossy().to_string();
        for a in [&["init", "-q"][..], &["config", "user.email", "t@t"], &["config", "user.name", "t"]] {
            git("host", &r, a).unwrap();
        }
        std::fs::write(d.join("sub/a.txt"), "one\n").unwrap();
        std::fs::write(d.join("keep.txt"), "k\n").unwrap();
        git("host", &r, &["add", "-A"]).unwrap();
        git("host", &r, &["commit", "-qm", "first"]).unwrap();
        std::fs::write(d.join("sub/a.txt"), "changed\n").unwrap();
        std::fs::write(d.join("keep.txt"), "mine\n").unwrap();
        std::fs::write(d.join("sub/new file.txt"), "x").unwrap();

        discard("host", &r, &["sub/a.txt".into()], &["sub/new file.txt".into()]).unwrap();
        assert_eq!(std::fs::read_to_string(d.join("sub/a.txt")).unwrap(), "one\n");
        assert!(!d.join("sub/new file.txt").exists());
        assert_eq!(std::fs::read_to_string(d.join("keep.txt")).unwrap(), "mine\n");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn paths_must_stay_in_the_workspace() {
        assert!(inside("/w/repo", "/w/repo/src/a.ts").is_ok());
        assert!(inside("/w/repo", "/w/repo/../other/a.ts").is_err());
        assert!(inside("/w/repo", "/w/repository/a.ts").is_err());
        assert!(inside("/w/repo", "src/a.ts").is_err());
    }
}
