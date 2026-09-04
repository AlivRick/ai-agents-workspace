//! Workspace list and window layout.
//!
//! ponytail: one JSON file, rewritten whole. The data is a few dozen folder
//! paths and a layout blob — a database would be ceremony. If per-command
//! history or cross-session search ever lands here, that is the point to move
//! to SQLite, not before.

use crate::util::{now_ms, write_atomic};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub path: String,
    pub name: String,
    pub added_at_ms: u64,
    #[serde(default)]
    pub favorite: bool,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Store {
    #[serde(default)]
    pub workspaces: Vec<Workspace>,
    #[serde(default)]
    pub layout: serde_json::Value,
    #[serde(default)]
    pub theme: String,
    /// Which machine's Claude Code the app reads and runs: "host" or
    /// "wsl:<distro>". Empty means "not chosen yet — go and probe".
    #[serde(default)]
    pub runtime: String,
}

fn basename(p: &str) -> String {
    Path::new(p)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| p.to_string())
}

impl Store {
    /// The workspace list starts empty and only ever grows because the user
    /// picked a folder. Claude Code's own project list is offered as an
    /// explicit import (see `claude_projects`), never adopted silently.
    pub fn load(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        write_atomic(path, &serde_json::to_vec_pretty(self)?)
    }

    pub fn add(&mut self, path: &str) {
        let path = PathBuf::from(path);
        let path = path.canonicalize().unwrap_or(path);
        let path = path.to_string_lossy().into_owned();
        let key = crate::util::norm_path(&path);
        if self.workspaces.iter().any(|w| crate::util::norm_path(&w.path) == key) {
            return;
        }
        self.workspaces.push(Workspace {
            id: format!("ws_{}_{}", now_ms(), self.workspaces.len()),
            name: basename(&path),
            path,
            added_at_ms: now_ms(),
            favorite: false,
        });
    }

    pub fn remove(&mut self, id: &str) {
        self.workspaces.retain(|w| w.id != id);
    }

    pub fn update(&mut self, id: &str, name: Option<String>, favorite: Option<bool>) {
        if let Some(w) = self.workspaces.iter_mut().find(|w| w.id == id) {
            if let Some(n) = name {
                if !n.trim().is_empty() {
                    w.name = n.trim().to_string();
                }
            }
            if let Some(f) = favorite {
                w.favorite = f;
            }
        }
    }
}

/// Folders Claude Code has a project record for, that still exist and are not
/// already in the workspace list. Offered to the user to pick from; adding is
/// always their action.
///
/// `distro` matters: a WSL install records POSIX paths like `/home/thuan/x`,
/// and Windows cannot stat those — every entry looked "gone" and the import
/// sheet came up empty. Each key is rewritten as the UNC share Windows can
/// actually open before it is checked, and that is the form stored, because it
/// is also what the folder picker produces.
pub fn claude_projects(known: &[Workspace], claude_json: &Path, distro: Option<&str>) -> Vec<String> {
    let Ok(raw) = std::fs::read_to_string(claude_json) else { return Vec::new() };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else { return Vec::new() };
    let Some(projects) = v.get("projects").and_then(|p| p.as_object()) else { return Vec::new() };
    let taken: std::collections::HashSet<String> =
        known.iter().map(|w| crate::util::norm_path(&w.path)).collect();
    let mut out: Vec<String> = projects
        .keys()
        .map(|p| match distro {
            Some(d) => crate::wsl::unc(d, p),
            None => PathBuf::from(p),
        })
        .filter(|p| p.is_dir())
        .map(|p| p.to_string_lossy().into_owned())
        .filter(|p| !taken.contains(&crate::util::norm_path(p)))
        .collect();
    out.sort();
    out.dedup();
    out
}

// ------------------------------------------------------------------ git status

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    pub path: String,
    pub is_repo: bool,
    pub branch: String,
    pub dirty: u32,
}

/// Branch + dirty-file count for many folders at once, fanned out so a slow
/// disk does not serialise the whole sidebar.
///
/// Asked in the *runtime's* git, not the host's: a workspace inside WSL is
/// stored as a POSIX path that Windows git cannot even open, so a host-side
/// `git -C /home/…` said "not a repo" about every Linux workspace — and with
/// it went the branch in the sidebar and the worktree option in the new-task
/// sheet.
pub fn git_info(paths: Vec<String>, runtime: &str) -> Vec<GitInfo> {
    let git = |p: &str, args: &[&str]| crate::worktree::git(runtime, p, args).ok();
    let workers = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(1, 8);
    let chunk = paths.len().div_ceil(workers).max(1);
    std::thread::scope(|scope| {
        let handles: Vec<_> = paths
            .chunks(chunk)
            .map(|c| {
                scope.spawn(move || {
                    c.iter()
                        .map(|p| {
                            let branch = git(p, &["rev-parse", "--abbrev-ref", "HEAD"]);
                            let dirty = git(p, &["status", "--porcelain"])
                                .map(|s| s.lines().filter(|l| !l.is_empty()).count() as u32)
                                .unwrap_or(0);
                            GitInfo {
                                path: p.clone(),
                                is_repo: branch.is_some(),
                                branch: branch.unwrap_or_default(),
                                dirty,
                            }
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        handles.into_iter().filter_map(|h| h.join().ok()).flatten().collect()
    })
}
