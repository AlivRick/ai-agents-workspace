//! One git worktree per task.
//!
//! Every pane in a task runs in the same worktree, so two agents on one job
//! still see each other's files, while two tasks never touch. That is the level
//! Conductor, Crystal, Vibe Kanban and Claude Squad all settled on; a task with
//! a single pane gets per-agent isolation as a special case of it.
//!
//! Everything here runs git in the *pane's own runtime*. `git worktree add`
//! writes an absolute `gitdir:` path into the new checkout, so a worktree cut by
//! Windows git names `\\wsl.localhost\…`, which Linux cannot follow — the pane
//! would land in a checkout whose every git call fails.

use serde::{Deserialize, Serialize};

/// Where a task works, and where its result goes back to.
#[derive(Serialize, Deserialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Tree {
    /// The repo the worktree was cut from, in the path flavour the workspace
    /// is stored in — UNC on Windows-over-WSL, POSIX everywhere else.
    pub repo: String,
    /// Where the panes actually run, same flavour.
    pub path: String,
    pub branch: String,
    /// The branch it was cut from, and the one Merge puts it back into.
    pub base: String,
}

/// One file an agent touched, committed or not.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub path: String,
    /// Git's own letter: `A` added, `M` modified, `D` deleted, `R` renamed.
    pub status: String,
    pub added: u32,
    pub removed: u32,
    /// Binary files have no line counts to show.
    pub binary: bool,
}

// ------------------------------------------------------------------- plumbing

/// A path as the runtime's own git will read it.
fn rt_path(runtime: &str, p: &str) -> String {
    if crate::wsl::distro_of(runtime).is_some() {
        crate::util::to_wsl_path(p)
    } else {
        p.to_string()
    }
}

/// `git -C <dir> <args>` inside the runtime, with no shell in the way.
///
/// Deliberately not `wsl::run`: that asks an *interactive* shell because it
/// needs the user's PATH, and rc-file chatter lands on stdout in the middle of
/// whatever it printed. A diff parsed out of that is a diff with someone's
/// motd in it. `git` is on the default PATH of every distro that has it.
pub fn git(runtime: &str, dir: &str, args: &[&str]) -> Result<String, String> {
    let dir = rt_path(runtime, dir);
    let out = if let Some(distro) = crate::wsl::distro_of(runtime) {
        let mut a: Vec<&str> = vec!["-d", distro, "--", "git", "-C", &dir];
        a.extend_from_slice(args);
        crate::wsl::exec(&a).map_err(|e| e.to_string())?
    } else {
        crate::util::quiet_command("git")
            .arg("-C")
            .arg(&dir)
            .args(args)
            .output()
            .map_err(|e| e.to_string())?
    };
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    if out.status.success() {
        return Ok(stdout.trim_end().to_string());
    }
    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(if err.is_empty() { format!("git {} failed", args.join(" ")) } else { err })
}

/// The separator this path is already written with. A worktree path built with
/// the wrong one still opens on Windows, but it reads as a foreign string in
/// the UI and compares unequal to everything else we store.
fn sep(p: &str) -> char {
    if p.contains('\\') && !p.starts_with('/') { '\\' } else { '/' }
}

/// A branch-safe, folder-safe form of a task name.
pub fn slug(name: &str) -> String {
    let mut s = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            s.push(c.to_ascii_lowercase());
        } else if !s.ends_with('-') {
            s.push('-');
        }
    }
    let s = s.trim_matches('-');
    let s: String = s.chars().take(32).collect();
    let s = s.trim_end_matches('-').to_string();
    if s.is_empty() { "task".into() } else { s }
}

/// Sibling of the repo, never inside it: a worktree under the repo would show
/// up in the repo's own `git status`, in every file watcher and in every
/// `npm run build` glob. Same parent keeps it on the same filesystem, which is
/// what makes `git worktree` and the `node_modules` link work at all.
pub fn dir_for(repo: &str, folder: &str) -> String {
    let s = sep(repo);
    let base = repo.trim_end_matches(['/', '\\']);
    format!("{base}.agentspace{s}{folder}")
}

// -------------------------------------------------------------------- actions

/// The branch `dir` is on, or `None` when it is not a git checkout at all.
pub fn branch_of(runtime: &str, dir: &str) -> Option<String> {
    git(runtime, dir, &["rev-parse", "--abbrev-ref", "HEAD"]).ok().filter(|b| !b.is_empty())
}

/// Cut a worktree for one task. `id` only has to make the name unique among
/// this repo's tasks, which is why a short slice of the task id is enough.
pub fn create(runtime: &str, repo: &str, name: &str, id: &str, prefix: &str) -> Result<Tree, String> {
    let base = branch_of(runtime, repo).ok_or("Not a git repository")?;
    if base == "HEAD" {
        return Err("This repo is on a detached HEAD — check out a branch first.".into());
    }
    let short: String = id.chars().skip(id.chars().count().saturating_sub(4)).collect();
    let folder = format!("{short}-{}", slug(name));
    let branch = format!("{prefix}{folder}");
    let path = dir_for(repo, &folder);
    git(runtime, repo, &["worktree", "add", "-b", &branch, &rt_path(runtime, &path), &base])?;
    link_deps(runtime, repo, &path);
    Ok(Tree { repo: repo.to_string(), path, branch, base })
}

/// A fresh worktree has no `node_modules`, so the first thing any agent runs in
/// it fails. Conductor and Vibe Kanban answer this with a setup script the user
/// writes; a symlink back to the repo's own is free and covers the common case.
///
/// ponytail: the link is *shared* — an `npm install` inside one worktree edits
/// the tree every other worktree and the repo itself are reading. Fine while
/// tasks only build and test; the upgrade path is a per-task setup command
/// (`npm ci`) in Settings, which is also the answer for repos that need one.
fn link_deps(runtime: &str, repo: &str, tree: &str) {
    let s = sep(repo);
    for dep in ["node_modules", ".venv"] {
        let src = format!("{}{s}{dep}", repo.trim_end_matches(['/', '\\']));
        let dst = format!("{}{s}{dep}", tree.trim_end_matches(['/', '\\']));
        if let Some(distro) = crate::wsl::distro_of(runtime) {
            let (src, dst) = (rt_path(runtime, &src), rt_path(runtime, &dst));
            let _ = crate::wsl::exec(&["-d", distro, "--", "sh", "-c",
                &format!("[ -e {q}{src}{q} ] && ln -s {q}{src}{q} {q}{dst}{q}", q = '"')]);
        } else if std::path::Path::new(&src).exists() {
            // Windows needs elevation or developer mode to make a symlink, so
            // the host branch there does nothing and the agent installs its own.
            #[cfg(unix)]
            let _ = std::os::unix::fs::symlink(&src, &dst);
            #[cfg(windows)]
            let _ = &dst;
        }
    }
}

/// Every file the task changed against its base — committed or still dirty.
///
/// `add --intent-to-add` is what folds untracked files in: it records the paths
/// without staging any content, so a brand-new file shows up in `git diff` as
/// an addition instead of needing its own listing and its own diff path.
pub fn changes(runtime: &str, tree: &str, base: &str) -> Result<Vec<Change>, String> {
    let _ = git(runtime, tree, &["add", "--intent-to-add", "."]);
    let stat = git(runtime, tree, &["diff", "--no-renames", "--numstat", base])?;
    let names = git(runtime, tree, &["diff", "--no-renames", "--name-status", base])?;
    let status: std::collections::HashMap<&str, &str> = names
        .lines()
        .filter_map(|l| {
            let mut it = l.split('\t');
            let s = it.next()?;
            let p = it.next_back()?;
            Some((p, &s[..1]))
        })
        .collect();
    Ok(stat
        .lines()
        .filter_map(|l| {
            let mut it = l.split('\t');
            let (a, r, p) = (it.next()?, it.next()?, it.next_back()?);
            Some(Change {
                status: status.get(p).copied().unwrap_or("M").to_string(),
                path: p.to_string(),
                added: a.parse().unwrap_or(0),
                removed: r.parse().unwrap_or(0),
                binary: a == "-",
            })
        })
        .collect())
}

/// The unified diff of one file, as git prints it.
pub fn file_diff(runtime: &str, tree: &str, base: &str, file: &str) -> Result<String, String> {
    git(runtime, tree, &["diff", "--no-color", "--no-renames", base, "--", file])
}

/// Commit whatever the agents left lying around, then merge the branch back.
///
/// The two refusals are the point: merging into a dirty checkout mixes the
/// task's work into the user's own half-finished edits with no way to tell them
/// apart afterwards, and merging while the repo sits on some other branch puts
/// the work somewhere nobody will look for it.
pub fn merge(runtime: &str, t: &Tree, message: &str) -> Result<String, String> {
    if !git(runtime, &t.path, &["status", "--porcelain"])?.is_empty() {
        git(runtime, &t.path, &["add", "-A"])?;
        git(runtime, &t.path, &["commit", "-m", message])?;
    }
    if git(runtime, &t.path, &["rev-list", "--count", &format!("{}..HEAD", t.base)])? == "0" {
        return Err("Nothing to merge — this task changed nothing.".into());
    }
    if !git(runtime, &t.repo, &["status", "--porcelain"])?.is_empty() {
        return Err(format!(
            "{} has uncommitted changes of its own. Commit or stash them, then merge.",
            t.repo
        ));
    }
    let head = branch_of(runtime, &t.repo).unwrap_or_default();
    if head != t.base {
        return Err(format!("The repo is on {head}, but this task branched off {}.", t.base));
    }
    git(runtime, &t.repo, &["merge", "--no-ff", &t.branch, "-m", &format!("Merge {}", t.branch)])
}

/// Drop the checkout. The branch survives unless asked for, because a worktree
/// you closed by accident is recoverable and a branch you deleted is not.
pub fn remove(runtime: &str, t: &Tree, delete_branch: bool) -> Result<(), String> {
    git(runtime, &t.repo, &["worktree", "remove", "--force", &rt_path(runtime, &t.path)])?;
    if delete_branch {
        let _ = git(runtime, &t.repo, &["branch", "-D", &t.branch]);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_are_branch_safe() {
        assert_eq!(slug("Sửa trang hoá đơn"), "s-a-trang-ho-n");
        assert_eq!(slug("fix: login  bug!"), "fix-login-bug");
        assert_eq!(slug("  "), "task");
        assert_eq!(slug(&"x".repeat(80)).len(), 32);
    }

    /// The one check that fails if any of the git plumbing is wrong: a real
    /// repo, a real worktree, a real uncommitted edit, a real merge.
    #[test]
    fn a_task_can_branch_off_change_things_and_come_back() {
        let root = std::env::temp_dir().join(format!("as-wt-{}", std::process::id()));
        let repo = root.join("repo");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&repo).unwrap();
        let r = repo.to_string_lossy().to_string();
        for a in [
            vec!["init", "-q", "-b", "main"],
            vec!["config", "user.email", "t@example.com"],
            vec!["config", "user.name", "t"],
        ] {
            git("host", &r, &a).unwrap();
        }
        std::fs::write(repo.join("a.txt"), "one\n").unwrap();
        git("host", &r, &["add", "-A"]).unwrap();
        git("host", &r, &["commit", "-qm", "first"]).unwrap();

        let t = create("host", &r, "Fix the thing", "task-ab12", "as/").unwrap();
        assert_eq!(t.base, "main");
        assert_eq!(t.branch, "as/ab12-fix-the-thing");
        assert!(std::path::Path::new(&t.path).is_dir(), "worktree not on disk");

        // One edit committed, one left dirty, one file never added — the three
        // states an agent actually leaves behind.
        std::fs::write(format!("{}/a.txt", t.path), "one\ntwo\n").unwrap();
        git("host", &t.path, &["commit", "-qam", "second"]).unwrap();
        std::fs::write(format!("{}/a.txt", t.path), "one\ntwo\nthree\n").unwrap();
        std::fs::write(format!("{}/b.txt", t.path), "new\n").unwrap();

        let c = changes("host", &t.path, &t.base).unwrap();
        let names: Vec<_> = c.iter().map(|x| x.path.as_str()).collect();
        assert_eq!(names, ["a.txt", "b.txt"], "untracked file missing from review");
        assert_eq!((c[0].status.as_str(), c[0].added), ("M", 2));
        assert_eq!(c[1].status, "A");
        assert!(file_diff("host", &t.path, &t.base, "b.txt").unwrap().contains("+new"));

        merge("host", &t, "task work").unwrap();
        assert_eq!(std::fs::read_to_string(repo.join("b.txt")).unwrap(), "new\n");

        remove("host", &t, true).unwrap();
        assert!(!std::path::Path::new(&t.path).exists(), "worktree left behind");
        assert!(git("host", &r, &["rev-parse", "--verify", &t.branch]).is_err(), "branch left behind");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn worktrees_sit_beside_the_repo_in_its_own_path_flavour() {
        assert_eq!(dir_for("/home/t/bill", "ab12-fix"), "/home/t/bill.agentspace/ab12-fix");
        assert_eq!(dir_for("/home/t/bill/", "ab12-fix"), "/home/t/bill.agentspace/ab12-fix");
        assert_eq!(
            dir_for("\\\\?\\UNC\\wsl.localhost\\Ubuntu\\home\\t\\bill", "ab12-fix"),
            "\\\\?\\UNC\\wsl.localhost\\Ubuntu\\home\\t\\bill.agentspace\\ab12-fix"
        );
    }
}
