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

/// What the review sheet needs to know beyond the file list: how far the task
/// branch has drifted from its base, and which of the actions it offers are
/// possible at all.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub files: Vec<Change>,
    /// Commits on the task branch the base does not have yet.
    pub ahead: u32,
    /// Commits the base has gained since the task branched — what Update pulls in.
    pub behind: u32,
    /// Work in the worktree nobody has committed.
    pub dirty: bool,
    /// A pull request is offerable at all: the repo has a remote and `gh` runs.
    pub can_pr: bool,
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

/// `gh` in the worktree. Not folded into `git()`: gh has no `-C`, it reads the
/// working directory, and it is the one binary here that may not be installed.
fn gh(runtime: &str, dir: &str, args: &[&str]) -> Result<String, String> {
    let dir = rt_path(runtime, dir);
    let out = if let Some(distro) = crate::wsl::distro_of(runtime) {
        let mut a: Vec<&str> = vec!["-d", distro, "--cd", &dir, "--", "gh"];
        a.extend_from_slice(args);
        crate::wsl::exec(&a).map_err(|e| e.to_string())?
    } else {
        crate::util::quiet_command("gh")
            .current_dir(&dir)
            .args(args)
            .output()
            .map_err(|e| e.to_string())?
    };
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if out.status.success() {
        return Ok(stdout);
    }
    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
    // gh says the useful half on stderr, including "a pull request already
    // exists for this branch" and the URL of it.
    Err(if err.is_empty() { stdout } else { err })
}

/// How many commits are in a rev range, and 0 for a range git cannot resolve —
/// a missing base is a UI number, not an error worth failing the sheet over.
fn count(runtime: &str, dir: &str, range: &str) -> u32 {
    git(runtime, dir, &["rev-list", "--count", range])
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
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

/// Everything the review sheet reads in one round trip: the files, the drift,
/// and which buttons are worth showing.
pub fn review(runtime: &str, t: &Tree) -> Result<Review, String> {
    Ok(Review {
        files: changes(runtime, &t.path, &t.base)?,
        ahead: count(runtime, &t.path, &format!("{}..HEAD", t.base)),
        behind: count(runtime, &t.path, &format!("HEAD..{}", t.base)),
        dirty: !git(runtime, &t.path, &["status", "--porcelain"])?.is_empty(),
        can_pr: !git(runtime, &t.repo, &["remote"]).unwrap_or_default().is_empty()
            && gh(runtime, &t.path, &["--version"]).is_ok(),
    })
}

/// Commit what the agents left, and leave the task running.
///
/// Merge has always done this as its first step, which made every task exactly
/// one commit however long it ran — nothing to roll back to when the agent goes
/// wrong at hour two. Same two git calls, offered on their own.
pub fn commit(runtime: &str, t: &Tree, message: &str) -> Result<(), String> {
    if git(runtime, &t.path, &["status", "--porcelain"])?.is_empty() {
        return Err("Nothing to commit — the worktree is clean.".into());
    }
    git(runtime, &t.path, &["add", "-A"])?;
    git(runtime, &t.path, &["commit", "-m", message])?;
    Ok(())
}

/// Bring the base branch's new commits into the worktree.
///
/// Pulled this way round on purpose. Left alone, a task that ran while the base
/// moved on only discovers the collision at Merge, and the conflict then lands
/// in the user's own checkout mid-merge. Here it lands in the task's worktree,
/// where an agent is already standing and can be told to resolve it, and the
/// merge home afterwards is a fast-forward.
pub fn update(runtime: &str, t: &Tree) -> Result<String, String> {
    if !git(runtime, &t.path, &["status", "--porcelain"])?.is_empty() {
        return Err("Commit this task's changes first — merging on top of uncommitted work leaves nothing to go back to.".into());
    }
    git(runtime, &t.path, &["merge", "--no-edit", &t.base]).map_err(|e| {
        let stuck = git(runtime, &t.path, &["diff", "--name-only", "--diff-filter=U"]).unwrap_or_default();
        if stuck.is_empty() {
            e
        } else {
            format!(
                "Conflicts in {} — ask the agent in this task to resolve them, then Commit.",
                stuck.lines().collect::<Vec<_>>().join(", ")
            )
        }
    })
}

/// Push the task branch and open a pull request for it.
///
/// The body is the task's own commit subjects rather than `gh --fill`, which
/// wants to own the title too. `gh pr view --web` is the opener: gh is already
/// installed here by definition, so the app needs no browser plugin of its own,
/// and a failure to open only means the user clicks the URL we return.
pub fn pull_request(runtime: &str, t: &Tree, title: &str) -> Result<String, String> {
    let range = format!("{}..HEAD", t.base);
    if count(runtime, &t.path, &range) == 0 {
        return Err("Nothing to open a pull request for — Commit the task's work first.".into());
    }
    let body = git(runtime, &t.path, &["log", "--format=- %s", &range])?;
    git(runtime, &t.path, &["push", "-u", "origin", &t.branch])?;
    let out = gh(runtime, &t.path, &[
        "pr", "create", "--base", &t.base, "--head", &t.branch, "--title", title, "--body", &body,
    ])?;
    let _ = gh(runtime, &t.path, &["pr", "view", "--web"]);
    Ok(out.lines().next_back().unwrap_or_default().trim().to_string())
}

/// Commit whatever the agents left lying around, then merge the branch back.
///
/// The two refusals are the point: merging into a dirty checkout mixes the
/// task's work into the user's own half-finished edits with no way to tell them
/// apart afterwards, and merging while the repo sits on some other branch puts
/// the work somewhere nobody will look for it.
pub fn merge(runtime: &str, t: &Tree, message: &str) -> Result<String, String> {
    if !git(runtime, &t.path, &["status", "--porcelain"])?.is_empty() {
        commit(runtime, t, message)?;
    }
    if git(runtime, &t.path, &["rev-list", "--count", &format!("{}..HEAD", t.base)])? == "0" {
        return Err("Nothing to merge — this task changed nothing.".into());
    }
    // Naming the files matters: the repo is not the checkout the user has been
    // looking at all session, so "it has uncommitted changes" alone sends them
    // to a terminal to find out which.
    let theirs = git(runtime, &t.repo, &["status", "--porcelain"])?;
    if !theirs.is_empty() {
        let n = theirs.lines().count();
        let mut which: Vec<&str> = theirs.lines().take(3).map(|l| l[3..].trim()).collect();
        if n > which.len() {
            which.push("…");
        }
        return Err(format!(
            "The repo has {n} uncommitted change{} of its own ({}). Commit or stash {} there, then merge.",
            if n == 1 { "" } else { "s" },
            which.join(", "),
            if n == 1 { "it" } else { "them" },
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

        // Commit mid-task: the review empties of dirt but keeps the diff, and
        // the branch gains a commit instead of waiting for merge to make one.
        commit("host", &t, "checkpoint").unwrap();
        let rev = review("host", &t).unwrap();
        assert!(!rev.dirty, "still dirty after commit");
        assert_eq!(rev.files.len(), 2, "commit lost the diff against base");
        assert_eq!((rev.ahead, rev.behind), (2, 0));
        assert!(commit("host", &t, "again").is_err(), "committed a clean tree");

        // The base moves on under the task. Update pulls it in, and the merge
        // home afterwards is the fast-forward it should be.
        std::fs::write(repo.join("c.txt"), "base\n").unwrap();
        git("host", &r, &["add", "-A"]).unwrap();
        git("host", &r, &["commit", "-qm", "meanwhile"]).unwrap();
        assert_eq!(review("host", &t).unwrap().behind, 1);
        update("host", &t).unwrap();
        let rev = review("host", &t).unwrap();
        assert_eq!(rev.behind, 0, "update did not catch the base up");
        assert!(std::path::Path::new(&t.path).join("c.txt").exists(), "base commit missing from worktree");

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
