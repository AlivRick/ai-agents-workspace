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
        return Err("Path must be absolute".into());
    }
    if p.extension().and_then(|x| x.to_str()) != Some("md") {
        return Err("Only .md files can be edited here".into());
    }
    let roots = allowed_roots(ws, claude_dir);
    if roots.is_empty() {
        return Err("Could not determine the allowed folder".into());
    }
    if !roots.iter().any(|r| p.starts_with(r)) {
        return Err(format!("Refused: outside the workspace and ~/.claude: {path}"));
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
        (root.join("CLAUDE.md"), "Project", "Applies to every session opened in this folder. Commit it."),
        (root.join("CLAUDE.local.md"), "Personal", "Your machine only. Usually gitignored."),
        (root.join(".claude").join("CLAUDE.md"), "Project (.claude)", "Alternative location for the project prompt."),
    ];
    out.push((claude_dir.join("CLAUDE.md"), "Global", "Applies to every project on this machine."));
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
    /// One extra line the view labels itself: an agent's model, a command's
    /// argument hint. Cheaper than a struct per kind of markdown file.
    pub meta: String,
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
        meta: String::new(),
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
        (claude_dir.join("skills"), "Global"),
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
                    "Index — one line per memory".into()
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


// ------------------------------------------------------- agents & commands

/// Markdown files under a directory, `depth` levels deep, named by their path
/// relative to it — `commands/db/seed.md` is the command `/db:seed`, which is
/// how Claude Code namespaces them.
fn md_files(dir: &Path, depth: u32, prefix: &str, out: &mut Vec<(PathBuf, String)>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let Some(stem) = p.file_stem().map(|x| x.to_string_lossy().into_owned()) else { continue };
        if p.is_dir() {
            if depth > 0 && !stem.starts_with('.') {
                md_files(&p, depth - 1, &format!("{prefix}{stem}:"), out);
            }
        } else if p.extension().and_then(|x| x.to_str()) == Some("md") {
            out.push((p, format!("{prefix}{stem}")));
        }
    }
}

fn md_entries(roots: &[(PathBuf, &str)], depth: u32, meta_key: &str, name_prefix: &str) -> Vec<SkillInfo> {
    let mut out = Vec::new();
    for (dir, scope) in roots {
        let mut files = Vec::new();
        md_files(dir, depth, "", &mut files);
        for (path, rel) in files {
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            let fm = frontmatter(&text);
            let (bytes, updated_at_ms) = stat(&path);
            let tools = field(&fm, "allowed-tools");
            out.push(SkillInfo {
                name: format!("{name_prefix}{rel}"),
                description: Some(field(&fm, "description"))
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| first_heading(&text)),
                allowed_tools: if tools.is_empty() { field(&fm, "tools") } else { tools },
                meta: field(&fm, meta_key),
                path: path.to_string_lossy().into_owned(),
                dir: dir.to_string_lossy().into_owned(),
                scope: (*scope).into(),
                extra_files: 0,
                bytes,
                updated_at_ms,
            });
        }
    }
    out.sort_by(|a, b| (a.scope.clone(), a.name.to_lowercase()).cmp(&(b.scope.clone(), b.name.to_lowercase())));
    out
}

/// Subagents Claude Code can delegate to inside this workspace.
pub fn agents(ws: &str, claude_dir: &Path) -> Vec<SkillInfo> {
    md_entries(
        &[
            (PathBuf::from(ws).join(".claude").join("agents"), "Workspace"),
            (claude_dir.join("agents"), "Global"),
        ],
        0,
        "model",
        "",
    )
}

/// Slash commands. One level of nesting, because that is the level Claude Code
/// turns into a `:` namespace.
pub fn commands(ws: &str, claude_dir: &Path) -> Vec<SkillInfo> {
    md_entries(
        &[
            (PathBuf::from(ws).join(".claude").join("commands"), "Workspace"),
            (claude_dir.join("commands"), "Global"),
        ],
        1,
        "argument-hint",
        "/",
    )
}

// -------------------------------------------------------------- MCP servers

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub name: String,
    pub scope: String,
    pub transport: String,
    pub target: String,
    pub args: Vec<String>,
    /// Names only. See `redact`.
    pub env_keys: Vec<String>,
    pub source: String,
}

/// MCP config is where credentials live — a Postgres URL with the password in
/// it, a Telegram session string. This app displays that config, so the values
/// never leave Rust: env is reduced to its keys, and the userinfo of any URL is
/// masked. A dashboard that paints a live connection string on screen is a leak
/// nothing else in the app can cause.
fn redact(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find("://") {
        let (head, tail) = rest.split_at(i + 3);
        out.push_str(head);
        let stop = tail.find(['/', ' ', '"']).unwrap_or(tail.len());
        match tail[..stop].find('@') {
            Some(at) => {
                out.push_str("***@");
                rest = &tail[at + 1..];
            }
            None => {
                out.push_str(&tail[..stop]);
                rest = &tail[stop..];
            }
        }
    }
    out.push_str(rest);
    if out.chars().count() > 120 {
        out = out.chars().take(120).collect::<String>() + "…";
    }
    out
}

fn read_json(path: &Path) -> Option<serde_json::Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

fn mcp_from(value: Option<&serde_json::Value>, scope: &str, source: &Path, out: &mut Vec<McpServer>) {
    let Some(map) = value.and_then(|v| v.as_object()) else { return };
    for (name, cfg) in map {
        let str_of = |k: &str| cfg.get(k).and_then(|x| x.as_str()).unwrap_or_default().to_string();
        let url = str_of("url");
        let command = str_of("command");
        let transport = match str_of("type").as_str() {
            "" if url.is_empty() => "stdio".to_string(),
            "" => "http".to_string(),
            t => t.to_string(),
        };
        out.push(McpServer {
            name: name.clone(),
            scope: scope.into(),
            transport,
            target: redact(if url.is_empty() { &command } else { &url }),
            args: cfg
                .get("args")
                .and_then(|a| a.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str()).map(redact).collect())
                .unwrap_or_default(),
            env_keys: cfg
                .get("env")
                .and_then(|e| e.as_object())
                .map(|e| e.keys().cloned().collect())
                .unwrap_or_default(),
            source: source.to_string_lossy().into_owned(),
        });
    }
}

/// Every MCP server that applies in this workspace, from all the places Claude
/// Code reads them, labelled with which file each came from.
pub fn mcp_servers(ws: &str, claude_dir: &Path, claude_json: &Path) -> Vec<McpServer> {
    let root = PathBuf::from(ws);
    let mut out = Vec::new();
    let files: [(PathBuf, &str); 5] = [
        (root.join(".mcp.json"), "Project · .mcp.json"),
        (root.join(".claude").join("settings.json"), "Project · settings"),
        (root.join(".claude").join("settings.local.json"), "Project · settings.local"),
        (claude_dir.join("settings.json"), "Global · settings"),
        (claude_dir.join("settings.local.json"), "Global · settings.local"),
    ];
    for (path, scope) in &files {
        if let Some(v) = read_json(path) {
            mcp_from(v.get("mcpServers"), scope, path, &mut out);
        }
    }
    if let Some(v) = read_json(claude_json) {
        mcp_from(v.get("mcpServers"), "Global · .claude.json", claude_json, &mut out);
        // Per-project entries are keyed by the path Claude Code was started in.
        let key = crate::util::norm_path(ws);
        if let Some(p) = v.get("projects").and_then(|p| p.get(&key).or_else(|| p.get(ws))) {
            mcp_from(p.get("mcpServers"), "Project · .claude.json", claude_json, &mut out);
        }
    }
    out.sort_by(|a, b| (a.name.to_lowercase(), a.scope.clone()).cmp(&(b.name.to_lowercase(), b.scope.clone())));
    out.dedup_by(|a, b| a.name == b.name && a.scope == b.scope);
    out
}

// ------------------------------------------------------------------ plugins

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub name: String,
    pub marketplace: String,
    pub description: String,
    pub scope: String,
    pub version: String,
    pub install_path: String,
    /// What the bundle actually ships: skills, agents, commands, hooks, MCP.
    pub parts: Vec<String>,
    pub installed_at_ms: u64,
    pub updated_at_ms: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Marketplace {
    pub name: String,
    pub source: String,
    pub path: String,
    pub updated_at_ms: u64,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct PluginReport {
    pub plugins: Vec<PluginInfo>,
    pub marketplaces: Vec<Marketplace>,
}

fn plugin_parts(dir: &Path) -> Vec<String> {
    let count = |sub: &str| std::fs::read_dir(dir.join(sub)).map(|d| d.flatten().count()).unwrap_or(0);
    let mut parts = Vec::new();
    for (sub, label) in [("skills", "skill"), ("agents", "agent"), ("commands", "command"), ("hooks", "hook")] {
        let n = count(sub);
        if n > 0 {
            parts.push(format!("{n} {label}"));
        }
    }
    if dir.join(".mcp.json").is_file() {
        parts.push("MCP".into());
    }
    parts
}

/// Installed plugins and the marketplaces they came from, read from the files
/// Claude Code maintains under ~/.claude/plugins. Read-only: installing one is
/// `/plugin` inside a session, and this app does not reach into that.
pub fn plugins(claude_dir: &Path) -> PluginReport {
    let root = claude_dir.join("plugins");
    let mut report = PluginReport::default();

    if let Some(v) = read_json(&root.join("installed_plugins.json")) {
        if let Some(map) = v.get("plugins").and_then(|p| p.as_object()) {
            for (key, installs) in map {
                let (name, marketplace) = key.split_once('@').unwrap_or((key.as_str(), ""));
                for inst in installs.as_array().map(Vec::as_slice).unwrap_or_default() {
                    let s = |k: &str| inst.get(k).and_then(|x| x.as_str()).unwrap_or_default().to_string();
                    let dir = PathBuf::from(s("installPath"));
                    let description = read_json(&dir.join(".claude-plugin").join("plugin.json"))
                        .and_then(|m| m.get("description").and_then(|d| d.as_str()).map(str::to_string))
                        .unwrap_or_default();
                    report.plugins.push(PluginInfo {
                        name: name.to_string(),
                        marketplace: marketplace.to_string(),
                        description,
                        scope: s("scope"),
                        version: s("version"),
                        parts: plugin_parts(&dir),
                        install_path: dir.to_string_lossy().into_owned(),
                        installed_at_ms: crate::sessions::iso_to_ms(&s("installedAt")).unwrap_or(0),
                        updated_at_ms: crate::sessions::iso_to_ms(&s("lastUpdated")).unwrap_or(0),
                    });
                }
            }
        }
    }
    report.plugins.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    if let Some(v) = read_json(&root.join("known_marketplaces.json")) {
        if let Some(map) = v.as_object() {
            for (name, m) in map {
                report.marketplaces.push(Marketplace {
                    name: name.clone(),
                    source: m
                        .get("source")
                        .and_then(|s| s.get("repo").or_else(|| s.get("url")).or_else(|| s.get("path")))
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string(),
                    path: m.get("installLocation").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                    updated_at_ms: m
                        .get("lastUpdated")
                        .and_then(|x| x.as_str())
                        .and_then(crate::sessions::iso_to_ms)
                        .unwrap_or(0),
                });
            }
        }
    }
    report.marketplaces.sort_by(|a, b| a.name.cmp(&b.name));
    report
}

// -------------------------------------------------------------------- edits

pub fn read(path: &str, ws: &str, claude_dir: &Path) -> Result<String, String> {
    let p = resolve(path, ws, claude_dir)?;
    std::fs::read_to_string(&p).map_err(|e| format!("Could not read {path}: {e}"))
}

pub fn write(path: &str, ws: &str, claude_dir: &Path, content: &str) -> Result<(), String> {
    let p = resolve(path, ws, claude_dir)?;
    write_atomic(&p, content.as_bytes()).map_err(|e| format!("Could not write {path}: {e}"))
}

/// Removes a skill's whole directory when it has one, otherwise the single
/// file. `remove_dir_all` is scoped to a path that already passed `resolve`.
pub fn delete(path: &str, ws: &str, claude_dir: &Path, with_dir: bool) -> Result<(), String> {
    let p = resolve(path, ws, claude_dir)?;
    if with_dir {
        if let Some(dir) = p.parent().filter(|d| d.join("SKILL.md") == p) {
            return std::fs::remove_dir_all(dir).map_err(|e| format!("Delete failed: {e}"));
        }
    }
    std::fs::remove_file(&p).map_err(|e| format!("Delete failed: {e}"))
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

    #[test]
    fn mcp_never_shows_a_credential() {
        // Hai dạng thật trên máy này: URL Postgres có mật khẩu trong args, và
        // env chứa session token.
        let cfg = serde_json::json!({
            "mcpServers": {
                "db": {
                    "command": "npx",
                    "args": ["-y", "server-postgres", "postgresql://postgres:hunter2@10.0.0.1:5432/app"],
                },
                "tele": { "command": "node", "env": { "API_HASH": "bcf7b14f", "SESSION": "1BQANOTE…" } },
                "remote": { "type": "http", "url": "https://mcp.example.com/sse" }
            }
        });
        let mut out = Vec::new();
        mcp_from(cfg.get("mcpServers"), "test", Path::new("/tmp/x.json"), &mut out);
        out.sort_by(|a, b| a.name.cmp(&b.name));
        assert_eq!(out.len(), 3);

        let db = &out[0];
        assert_eq!(db.transport, "stdio");
        assert!(db.args.iter().any(|a| a.contains("***@10.0.0.1")), "phải che userinfo: {:?}", db.args);
        assert!(!out.iter().any(|s| format!("{:?}", s.args).contains("hunter2")));

        let tele = &out[2];
        assert_eq!(tele.env_keys.len(), 2, "chỉ tên biến");
        assert!(!format!("{tele:?}").contains("bcf7b14f"), "giá trị env không được ra khỏi Rust");

        // URL không có userinfo thì giữ nguyên.
        assert_eq!(out[1].target, "https://mcp.example.com/sse");
        assert_eq!(out[1].transport, "http");
    }

    #[test]
    fn commands_are_named_the_way_claude_code_calls_them() {
        let root = std::env::temp_dir().join("agentspace-cmd-test");
        let dir = root.join(".claude").join("commands").join("db");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("seed.md"), "---\ndescription: Nạp dữ liệu mẫu\nargument-hint: <bảng>\n---\n").unwrap();
        std::fs::write(dir.parent().unwrap().join("ship.md"), "# Đẩy bản build\n").unwrap();

        let cd = std::env::temp_dir().join("agentspace-cmd-test-claude");
        let list = commands(&root.to_string_lossy(), &cd);
        let names: Vec<&str> = list.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"/db:seed"), "thư mục con thành namespace: {names:?}");
        assert!(names.contains(&"/ship"));
        let seed = list.iter().find(|c| c.name == "/db:seed").unwrap();
        assert_eq!(seed.description, "Nạp dữ liệu mẫu");
        assert_eq!(seed.meta, "<bảng>");
        // Không frontmatter thì mô tả rơi về heading đầu.
        assert_eq!(list.iter().find(|c| c.name == "/ship").unwrap().description, "Đẩy bản build");
        std::fs::remove_dir_all(&root).ok();
    }
}
