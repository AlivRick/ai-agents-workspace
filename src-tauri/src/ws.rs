//! The three things that shape how Claude behaves inside a workspace:
//! CLAUDE.md (the root prompt), skills, and memory.
//!
//! All three are plain files that Claude Code already reads. This module lists
//! them, parses just enough frontmatter to describe them, and edits them —
//! never inventing a parallel store the CLI would not see.

use crate::util::{escape_project_path, ms, write_atomic};
use serde::Serialize;
use std::path::{Component, Path, PathBuf};

/// Resolve `.` and `..` textually, without following symlinks.
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

fn allowed_roots(ws: &str, claude_dir: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for p in [PathBuf::from(ws), claude_dir.to_path_buf()] {
        if p.as_os_str().is_empty() {
            continue;
        }
        roots.push(lexical(&p));
        if let Ok(c) = p.canonicalize() {
            roots.push(c);
        }
    }
    roots
}

/// Every read, write and delete goes through here: the path must sit inside the
/// open workspace or ~/.claude, and must be a `.md`.
///
/// The check is *lexical* on purpose. Canonicalising first looked stricter but
/// was wrong: a skill symlinked into ~/.claude/skills (a normal thing to do —
/// this machine links one to a Windows drive) resolved outside every root and
/// was refused. Traversal is still blocked, because `..` is folded away before
/// the comparison; what is allowed is a link the user themselves put in their
/// own config directory.
fn resolve(path: &str, ws: &str, claude_dir: &Path) -> Result<PathBuf, String> {
    let p = lexical(Path::new(path));
    if !p.is_absolute() {
        return Err("Đường dẫn phải là tuyệt đối".into());
    }
    if p.extension().and_then(|x| x.to_str()) != Some("md") {
        return Err("Chỉ thao tác được trên tệp .md".into());
    }
    let roots = allowed_roots(ws, claude_dir);
    if roots.is_empty() {
        return Err("Không xác định được thư mục cho phép".into());
    }
    if !roots.iter().any(|r| p.starts_with(r)) {
        return Err(format!("Từ chối thao tác ngoài workspace và ~/.claude: {path}"));
    }
    Ok(p)
}

// ------------------------------------------------------------- frontmatter

/// Enough YAML for `name:`, `description:` and a nested `type:` — the only
/// keys these files carry that we display. Anything richer stays in the body,
/// which the editor shows verbatim.
fn frontmatter(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return out;
    }
    for line in lines {
        let t = line.trim_end();
        if t.trim() == "---" {
            break;
        }
        let indented = line.starts_with(' ') || line.starts_with('\t');
        let Some((k, v)) = t.split_once(':') else { continue };
        let key = k.trim().to_string();
        let val = v.trim().trim_matches(|c| c == '"' || c == '\'').to_string();
        if !key.is_empty() && (!indented || !val.is_empty()) {
            out.push((key, val));
        }
    }
    out
}

fn field(fm: &[(String, String)], key: &str) -> String {
    fm.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone()).unwrap_or_default()
}

fn first_heading(text: &str) -> String {
    text.lines()
        .find(|l| l.starts_with("# "))
        .map(|l| l.trim_start_matches("# ").trim().to_string())
        .unwrap_or_default()
}

fn stat(path: &Path) -> (u64, u64) {
    std::fs::metadata(path)
        .map(|m| (m.len(), m.modified().map(ms).unwrap_or(0)))
        .unwrap_or((0, 0))
}

// ---------------------------------------------------------------- CLAUDE.md

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Doc {
    pub path: String,
    pub scope: String,
    pub note: String,
    pub exists: bool,
    pub bytes: u64,
    pub updated_at_ms: u64,
}

/// Every CLAUDE.md that applies to this workspace, in the order Claude Code
/// layers them, including ones that do not exist yet so the UI can offer to
/// create them.
pub fn claude_docs(ws: &str, claude_dir: &Path) -> Vec<Doc> {
    let root = PathBuf::from(ws);
    let mut out = vec![
        (root.join("CLAUDE.md"), "Dự án", "Áp cho mọi phiên mở trong thư mục này. Nên commit."),
        (root.join("CLAUDE.local.md"), "Cá nhân", "Chỉ máy bạn. Thường bị .gitignore."),
        (root.join(".claude").join("CLAUDE.md"), "Dự án (.claude)", "Vị trí thay thế cho prompt dự án."),
    ];
    out.push((claude_dir.join("CLAUDE.md"), "Toàn cục", "Áp cho tất cả dự án trên máy này."));
    out.into_iter()
        .map(|(path, scope, note)| {
            let exists = path.is_file();
            let (bytes, updated_at_ms) = if exists { stat(&path) } else { (0, 0) };
            Doc {
                path: path.to_string_lossy().into_owned(),
                scope: scope.into(),
                note: note.into(),
                exists,
                bytes,
                updated_at_ms,
            }
        })
        .collect()
}

// ------------------------------------------------------------------- skills

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
    pub allowed_tools: String,
    pub path: String,
    pub dir: String,
    pub scope: String,
    pub extra_files: u32,
    pub bytes: u64,
    pub updated_at_ms: u64,
}

fn read_skill(entry: &Path, scope: &str) -> Option<SkillInfo> {
    // A skill is either <name>/SKILL.md with optional companion files, or a
    // bare <name>.md. Both shapes exist on real machines.
    let md = std::fs::metadata(entry).ok()?;
    let (file, dir, extra) = if md.is_dir() {
        let f = entry.join("SKILL.md");
        if !f.is_file() {
            return None;
        }
        let extra = std::fs::read_dir(entry).map(|d| d.flatten().count().saturating_sub(1) as u32).unwrap_or(0);
        (f, entry.to_path_buf(), extra)
    } else if entry.extension().and_then(|x| x.to_str()) == Some("md") {
        (entry.to_path_buf(), entry.parent()?.to_path_buf(), 0)
    } else {
        return None;
    };

    let text = std::fs::read_to_string(&file).ok()?;
    let fm = frontmatter(&text);
    let fallback = entry.file_stem()?.to_string_lossy().into_owned();
    let (bytes, updated_at_ms) = stat(&file);
    Some(SkillInfo {
        name: Some(field(&fm, "name")).filter(|s| !s.is_empty()).unwrap_or(fallback),
        description: Some(field(&fm, "description"))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| first_heading(&text)),
        allowed_tools: field(&fm, "allowed-tools"),
        path: file.to_string_lossy().into_owned(),
        dir: dir.to_string_lossy().into_owned(),
        scope: scope.into(),
        extra_files: extra,
        bytes,
        updated_at_ms,
    })
}

pub fn skills(ws: &str, claude_dir: &Path) -> Vec<SkillInfo> {
    let roots: Vec<(PathBuf, &str)> = vec![
        (PathBuf::from(ws).join(".claude").join("skills"), "Workspace"),
        (claude_dir.join("skills"), "Toàn cục"),
    ];
    let mut out = Vec::new();
    for (dir, scope) in roots {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            if let Some(s) = read_skill(&e.path(), scope) {
                out.push(s);
            }
        }
    }
    out.sort_by(|a, b| (a.scope.clone(), a.name.to_lowercase()).cmp(&(b.scope.clone(), b.name.to_lowercase())));
    out
}

// ------------------------------------------------------------------- memory

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MemoryInfo {
    pub name: String,
    pub description: String,
    pub kind: String,
    pub path: String,
    pub is_index: bool,
    pub bytes: u64,
    pub updated_at_ms: u64,
}

/// Claude Code files a workspace's memories under
/// ~/.claude/projects/<escaped cwd>/memory. They are the notes it keeps about
/// your habits and this project's rules, so they belong beside the workspace
/// rather than buried in a hidden folder.
pub fn memory_dir(ws: &str, claude_dir: &Path) -> PathBuf {
    claude_dir
        .join("projects")
        .join(escape_project_path(ws))
        .join("memory")
}

pub fn memories(ws: &str, claude_dir: &Path) -> Vec<MemoryInfo> {
    let dir = memory_dir(ws, claude_dir);
    let Ok(rd) = std::fs::read_dir(&dir) else { return Vec::new() };
    let mut out: Vec<MemoryInfo> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("md"))
        .filter_map(|p| {
            let text = std::fs::read_to_string(&p).ok()?;
            let fm = frontmatter(&text);
            let is_index = p.file_name().and_then(|n| n.to_str()) == Some("MEMORY.md");
            let (bytes, updated_at_ms) = stat(&p);
            Some(MemoryInfo {
                name: Some(field(&fm, "name"))
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| p.file_stem().unwrap_or_default().to_string_lossy().into_owned()),
                description: if is_index {
                    "Mục lục — một dòng cho mỗi ghi nhớ".into()
                } else {
                    field(&fm, "description")
                },
                kind: field(&fm, "type"),
                path: p.to_string_lossy().into_owned(),
                is_index,
                bytes,
                updated_at_ms,
            })
        })
        .collect();
    out.sort_by(|a, b| (b.is_index, b.updated_at_ms).cmp(&(a.is_index, a.updated_at_ms)));
    out
}

// -------------------------------------------------------------------- edits

pub fn read(path: &str, ws: &str, claude_dir: &Path) -> Result<String, String> {
    let p = resolve(path, ws, claude_dir)?;
    std::fs::read_to_string(&p).map_err(|e| format!("Không đọc được {path}: {e}"))
}

pub fn write(path: &str, ws: &str, claude_dir: &Path, content: &str) -> Result<(), String> {
    let p = resolve(path, ws, claude_dir)?;
    write_atomic(&p, content.as_bytes()).map_err(|e| format!("Không ghi được {path}: {e}"))
}

/// Removes a skill's whole directory when it has one, otherwise the single
/// file. `remove_dir_all` is scoped to a path that already passed `resolve`.
pub fn delete(path: &str, ws: &str, claude_dir: &Path, with_dir: bool) -> Result<(), String> {
    let p = resolve(path, ws, claude_dir)?;
    if with_dir {
        if let Some(dir) = p.parent().filter(|d| d.join("SKILL.md") == p) {
            return std::fs::remove_dir_all(dir).map_err(|e| format!("Xoá thất bại: {e}"));
        }
    }
    std::fs::remove_file(&p).map_err(|e| format!("Xoá thất bại: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_rejects_escapes_and_non_markdown() {
        let ws = std::env::temp_dir().join("agentspace-ws-test");
        std::fs::create_dir_all(&ws).unwrap();
        let ws_s = ws.to_string_lossy().into_owned();
        let cd = crate::util::claude_home().unwrap_or_else(|| std::env::temp_dir().join(".claude"));

        // Inside the workspace, .md, does not exist yet -> allowed (create).
        assert!(resolve(&ws.join("CLAUDE.md").to_string_lossy(), &ws_s, &cd).is_ok());
        // Wrong extension.
        assert!(resolve(&ws.join("notes.txt").to_string_lossy(), &ws_s, &cd).is_err());
        // Outside both roots.
        assert!(resolve("/etc/hosts.md", &ws_s, &cd).is_err());
        // Classic traversal, folded away before the comparison.
        let escape = ws.join("..").join("..").join("etc").join("passwd.md");
        assert!(resolve(&escape.to_string_lossy(), &ws_s, &cd).is_err());
        // Relative paths never resolve.
        assert!(resolve("CLAUDE.md", &ws_s, &cd).is_err());

        // A symlink the user put inside ~/.claude stays usable: the check is
        // lexical, so it is not dragged outside the root by its target.
        #[cfg(unix)]
        {
            {
                let home = cd.clone();
                let link = home.join("skills").join("agentspace-symlink-test");
                let target = ws.join("linked");
                std::fs::create_dir_all(&target).ok();
                std::fs::create_dir_all(home.join("skills")).ok();
                let _ = std::fs::remove_file(&link);
                if std::os::unix::fs::symlink(&target, &link).is_ok() {
                    assert!(resolve(&link.join("SKILL.md").to_string_lossy(), &ws_s, &cd).is_ok());
                    let _ = std::fs::remove_file(&link);
                }
            }
        }

        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn frontmatter_reads_the_keys_we_show() {
        let text = "---\nname: ts-context\ndescription: \"Lưu context sau mỗi đợt\"\nallowed-tools: Read, Write\nmetadata:\n  type: project\n---\n\n# Tiêu đề\n";
        let fm = frontmatter(text);
        assert_eq!(field(&fm, "name"), "ts-context");
        assert_eq!(field(&fm, "description"), "Lưu context sau mỗi đợt");
        assert_eq!(field(&fm, "allowed-tools"), "Read, Write");
        assert_eq!(field(&fm, "type"), "project");
        // Không có frontmatter thì rơi về heading đầu tiên.
        assert!(frontmatter("# Chỉ có heading\n").is_empty());
        assert_eq!(first_heading("# Chỉ có heading\n"), "Chỉ có heading");
    }
}
