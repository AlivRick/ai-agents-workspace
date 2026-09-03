mod engine;
mod notify;
mod sessions;
mod store;
mod term;
mod util;
mod ws;
mod wsl;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{Manager, State};

pub struct App {
    data_dir: PathBuf,
    store: Mutex<store::Store>,
    sessions: Arc<Mutex<Vec<sessions::Session>>>,
    /// `$HOME` inside each distro, probed once. Resolving it costs a `wsl.exe`
    /// round-trip, which is far too slow to repeat on every read.
    wsl_homes: Mutex<HashMap<String, String>>,
    /// Probing the runtime list costs `1 + 2N` subprocesses. Doing it once per
    /// launch instead of once per caller is most of what made startup drag.
    runtimes: Mutex<Option<Vec<wsl::Runtime>>>,
}

impl App {
    fn store_path(&self) -> PathBuf {
        self.data_dir.join("state.json")
    }

    /// Where Claude Code keeps its data *for this runtime*. On Windows a
    /// distro's files are reachable over `\\wsl.localhost`, so the scanner can
    /// use ordinary file IO instead of piping everything through `wsl.exe`.
    ///
    /// This is what makes the session list, usage and workspace content show
    /// the distro's data when a WSL runtime is selected — reading the host's
    /// `~/.claude` there would show an empty app.
    fn claude_dir(&self, runtime: &str) -> PathBuf {
        match wsl::distro_of(runtime) {
            None => util::claude_home().unwrap_or_default(),
            Some(d) => match self.wsl_home(d) {
                Some(home) => wsl::unc(d, &format!("{home}/.claude")),
                None => util::claude_home().unwrap_or_default(),
            },
        }
    }

    fn claude_json(&self, runtime: &str) -> PathBuf {
        match wsl::distro_of(runtime) {
            None => util::home_dir().unwrap_or_default().join(".claude.json"),
            Some(d) => match self.wsl_home(d) {
                Some(home) => wsl::unc(d, &format!("{home}/.claude.json")),
                None => util::home_dir().unwrap_or_default().join(".claude.json"),
            },
        }
    }

    fn wsl_home(&self, distro: &str) -> Option<String> {
        if let Some(h) = self.wsl_homes.lock().unwrap().get(distro) {
            return Some(h.clone());
        }
        let home = wsl::home(distro)?;
        self.wsl_homes.lock().unwrap().insert(distro.to_string(), home.clone());
        Some(home)
    }

    /// One transcript cache per runtime; the host's and a distro's session
    /// files are different sets and must not share a memo.
    fn cache_path(&self, runtime: &str) -> PathBuf {
        match wsl::distro_of(runtime) {
            None => self.data_dir.join("scan-cache.json"),
            Some(d) => {
                let safe: String =
                    d.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
                self.data_dir.join(format!("scan-cache-{safe}.json"))
            }
        }
    }

    fn runtimes_cached(&self) -> Vec<wsl::Runtime> {
        if let Some(r) = self.runtimes.lock().unwrap().clone() {
            return r;
        }
        let found = term::runtimes();
        let homes: HashMap<String, String> = found
            .iter()
            .filter(|r| r.kind == "wsl")
            .filter_map(|r| wsl::home(&r.distro).map(|h| (r.distro.clone(), h)))
            .collect();
        self.wsl_homes.lock().unwrap().extend(homes);
        *self.runtimes.lock().unwrap() = Some(found.clone());
        found
    }

    fn persist(&self) {
        let path = self.store_path();
        if let Err(e) = self.store.lock().unwrap().save(&path) {
            eprintln!("agentspace: không ghi được state.json: {e}");
        }
    }
}

fn rt(runtime: Option<String>) -> String {
    runtime.unwrap_or_else(|| "host".into())
}

/// Run blocking work off the UI thread. Tauri drives non-async commands on the
/// main thread, so a 300 MB transcript scan or a `wsl.exe` probe there freezes
/// the window — which is exactly what made the app stutter on launch.
async fn blocking<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

// ------------------------------------------------------------------- engine

#[tauri::command]
async fn engine_status(runtime: Option<String>) -> Result<engine::EngineStatus, String> {
    let r = rt(runtime);
    blocking(move || engine::status(&r)).await
}

#[tauri::command]
async fn list_runtimes(app: State<'_, App>) -> Result<Vec<wsl::Runtime>, String> {
    if let Some(r) = app.runtimes.lock().unwrap().clone() {
        return Ok(r);
    }
    // First call only: probe off the UI thread, then everyone reads the cache.
    let found = blocking(term::runtimes).await?;
    let distros: Vec<String> =
        found.iter().filter(|r| r.kind == "wsl").map(|r| r.distro.clone()).collect();
    let homes = blocking(move || {
        distros.into_iter().filter_map(|d| wsl::home(&d).map(|h| (d, h))).collect::<HashMap<_, _>>()
    })
    .await?;
    app.wsl_homes.lock().unwrap().extend(homes);
    *app.runtimes.lock().unwrap() = Some(found.clone());
    Ok(found)
}

/// The exact line the app types into a pane to start Claude Code. `--settings`
/// layers our hook file on top of the user's config for this run only; it does
/// not modify ~/.claude/settings.json.
#[tauri::command]
fn claude_command(app: State<App>, extra: Option<String>, runtime: Option<String>) -> String {
    let settings = app.data_dir.join("claude-hooks.json");
    let runtime = rt(runtime);
    // Inside WSL the CLI is whatever the distro has on PATH, and the settings
    // file has to be named the way the distro sees it.
    let (cli, settings) = if wsl::distro_of(&runtime).is_some() {
        ("claude".to_string(), util::to_wsl_path(&settings.to_string_lossy()))
    } else {
        (
            engine::find_cli().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|| "claude".into()),
            settings.to_string_lossy().into_owned(),
        )
    };
    let extra = extra.unwrap_or_default();
    let extra = if extra.trim().is_empty() { String::new() } else { format!(" {}", extra.trim()) };
    format!("{} --settings {}{}", shell_quote(&cli), shell_quote(&settings), extra)
}

fn shell_quote(s: &str) -> String {
    if !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "/._-".contains(c)) {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', r"'\''"))
    }
}

// --------------------------------------------------------------- workspaces

#[tauri::command]
fn list_workspaces(app: State<App>) -> Vec<store::Workspace> {
    app.store.lock().unwrap().workspaces.clone()
}

#[tauri::command]
fn add_workspace(app: State<App>, path: String) -> Result<Vec<store::Workspace>, String> {
    if !std::path::Path::new(&path).is_dir() {
        return Err("Đường dẫn không phải thư mục".into());
    }
    app.store.lock().unwrap().add(&path);
    app.persist();
    Ok(app.store.lock().unwrap().workspaces.clone())
}

#[tauri::command]
fn add_workspaces(app: State<App>, paths: Vec<String>) -> Vec<store::Workspace> {
    {
        let mut store = app.store.lock().unwrap();
        for p in paths.iter().filter(|p| std::path::Path::new(p).is_dir()) {
            store.add(p);
        }
    }
    app.persist();
    app.store.lock().unwrap().workspaces.clone()
}

#[tauri::command]
fn remove_workspace(app: State<App>, id: String) -> Vec<store::Workspace> {
    app.store.lock().unwrap().remove(&id);
    app.persist();
    app.store.lock().unwrap().workspaces.clone()
}

#[tauri::command]
fn update_workspace(
    app: State<App>,
    id: String,
    name: Option<String>,
    favorite: Option<bool>,
) -> Vec<store::Workspace> {
    app.store.lock().unwrap().update(&id, name, favorite);
    app.persist();
    app.store.lock().unwrap().workspaces.clone()
}

#[tauri::command]
async fn git_info(paths: Vec<String>) -> Result<Vec<store::GitInfo>, String> {
    blocking(move || store::git_info(paths)).await
}

/// Folders Claude Code knows about that the user has not added yet — read from
/// the selected runtime, so picking WSL offers the distro's projects.
#[tauri::command]
async fn claude_projects(app: State<'_, App>, runtime: Option<String>) -> Result<Vec<String>, String> {
    let r = rt(runtime);
    let known = app.store.lock().unwrap().workspaces.clone();
    let json = app.claude_json(&r);
    let distro = wsl::distro_of(&r).map(str::to_string);
    blocking(move || store::claude_projects(&known, &json, distro.as_deref())).await
}

/// Which runtime to start on.
///
/// A remembered choice wins. Otherwise probe: on Windows the host often has no
/// Claude Code at all while the distro does, and defaulting to the host there
/// shows an app with no sessions and no usage even though the data exists one
/// runtime over.
#[tauri::command]
async fn default_runtime(app: State<'_, App>) -> Result<String, String> {
    let saved = app.store.lock().unwrap().runtime.clone();
    if !saved.is_empty() {
        return Ok(saved);
    }
    let list = app.runtimes_cached();
    // Both a Windows host and its distro are often signed in, so "signed in"
    // alone picks the wrong one. Prefer the runtime that actually holds the
    // transcripts; host wins ties.
    let dirs: Vec<(String, PathBuf)> = list.iter().map(|r| (r.id.clone(), self_dir(&app, &r.id))).collect();
    blocking(move || {
        dirs.iter()
            .filter(|(id, _)| engine::status(id).signed_in)
            .max_by_key(|(_, dir)| sessions::transcript_count(dir))
            .map(|(id, _)| id.clone())
            .unwrap_or_else(|| "host".into())
    })
    .await
}

/// `App::claude_dir` as a free function so it can be called while building the
/// list handed to a blocking task.
fn self_dir(app: &State<'_, App>, runtime: &str) -> PathBuf {
    app.claude_dir(runtime)
}

#[tauri::command]
fn set_runtime(app: State<App>, runtime: String) {
    app.store.lock().unwrap().runtime = runtime;
    app.persist();
}

#[tauri::command]
fn get_theme(app: State<App>) -> String {
    app.store.lock().unwrap().theme.clone()
}

#[tauri::command]
fn set_theme(app: State<App>, theme: String) {
    app.store.lock().unwrap().theme = theme;
    app.persist();
}

#[tauri::command]
fn save_layout(app: State<App>, layout: serde_json::Value) {
    app.store.lock().unwrap().layout = layout;
    app.persist();
}

#[tauri::command]
fn load_layout(app: State<App>) -> serde_json::Value {
    app.store.lock().unwrap().layout.clone()
}

// ----------------------------------------------------------------- sessions

/// The session list without its per-hour buckets. The UI never reads them and
/// they are the bulk of the payload on a machine with hundreds of transcripts.
fn slim(mut list: Vec<sessions::Session>) -> Vec<sessions::Session> {
    for s in &mut list {
        s.hours = Vec::new();
    }
    list
}

#[tauri::command]
async fn scan_sessions(app: State<'_, App>, runtime: Option<String>) -> Result<Vec<sessions::Session>, String> {
    let r = rt(runtime);
    let (dir, cache, store) = (app.claude_dir(&r), app.cache_path(&r), app.sessions.clone());
    let found = blocking(move || sessions::scan(&dir, &cache)).await?;
    *store.lock().unwrap() = found.clone();
    Ok(slim(found))
}

#[tauri::command]
async fn usage_report(
    app: State<'_, App>,
    range: String,
    tz_offset_min: i32,
    runtime: Option<String>,
) -> Result<sessions::UsageReport, String> {
    let r = rt(runtime);
    let cached = app.sessions.lock().unwrap().clone();
    let (dir, cache) = (app.claude_dir(&r), app.cache_path(&r));
    blocking(move || {
        let list = if cached.is_empty() { sessions::scan(&dir, &cache) } else { cached };
        sessions::usage(&list, &range, tz_offset_min)
    })
    .await
}

/// The rolling five-hour windows Claude Code meters a subscription in. Reads
/// the same cached scan the dashboard uses, so it costs nothing extra.
#[tauri::command]
async fn usage_blocks(app: State<'_, App>, runtime: Option<String>) -> Result<Vec<sessions::Block>, String> {
    let r = rt(runtime);
    let cached = app.sessions.lock().unwrap().clone();
    let (dir, cache) = (app.claude_dir(&r), app.cache_path(&r));
    blocking(move || {
        let list = if cached.is_empty() { sessions::scan(&dir, &cache) } else { cached };
        sessions::blocks(&list, 48)
    })
    .await
}

/// What `/usage` says — the real percentages and reset times, which only the
/// server knows. Blocking: one `claude -p /usage` subprocess, a few seconds.
/// Returns the raw text; the UI parses the three lines it cares about.
#[tauri::command]
async fn usage_limits(runtime: Option<String>) -> Result<String, String> {
    let r = rt(runtime);
    blocking(move || engine::usage_text(&r))
        .await?
        .ok_or_else(|| "Không đọc được /usage từ CLI".to_string())
}

/// Grep the bodies of every transcript. The metadata search in the UI only
/// sees titles and paths; this is what answers "where did I ask about X".
#[tauri::command]
async fn search_sessions(
    app: State<'_, App>,
    query: String,
    runtime: Option<String>,
) -> Result<Vec<sessions::Hit>, String> {
    let dir = app.claude_dir(&rt(runtime));
    blocking(move || sessions::search(&dir, &query, 3)).await
}

/// Permanently deletes transcripts. The UI confirms first; the guard in
/// `sessions::delete` is what makes a bad path impossible rather than unlikely.
#[tauri::command]
async fn delete_sessions(
    app: State<'_, App>,
    files: Vec<String>,
    runtime: Option<String>,
) -> Result<usize, String> {
    let r = rt(runtime);
    let (dir, cache, store) = (app.claude_dir(&r), app.cache_path(&r), app.sessions.clone());
    let (removed, fresh) = blocking(move || {
        let n = sessions::delete(&dir, &files)?;
        Ok::<_, String>((n, sessions::scan(&dir, &cache)))
    })
    .await??;
    *store.lock().unwrap() = fresh;
    Ok(removed)
}

#[tauri::command]
async fn rename_session(
    app: State<'_, App>,
    file: String,
    title: String,
    runtime: Option<String>,
) -> Result<Vec<sessions::Session>, String> {
    let r = rt(runtime);
    let (dir, cache, store) = (app.claude_dir(&r), app.cache_path(&r), app.sessions.clone());
    let fresh = blocking(move || {
        sessions::rename(&dir, &file, &title)?;
        Ok::<_, String>(sessions::scan(&dir, &cache))
    })
    .await??;
    *store.lock().unwrap() = fresh.clone();
    Ok(slim(fresh))
}

// ------------------------------------------------- nội dung của workspace

#[tauri::command]
async fn claude_docs(app: State<'_, App>, workspace: String, runtime: Option<String>) -> Result<Vec<ws::Doc>, String> {
    let dir = app.claude_dir(&rt(runtime));
    blocking(move || ws::claude_docs(&workspace, &dir)).await
}

#[tauri::command]
async fn list_skills(app: State<'_, App>, workspace: String, runtime: Option<String>) -> Result<Vec<ws::SkillInfo>, String> {
    let dir = app.claude_dir(&rt(runtime));
    blocking(move || ws::skills(&workspace, &dir)).await
}

#[tauri::command]
async fn list_memories(app: State<'_, App>, workspace: String, runtime: Option<String>) -> Result<Vec<ws::MemoryInfo>, String> {
    let dir = app.claude_dir(&rt(runtime));
    blocking(move || ws::memories(&workspace, &dir)).await
}

#[tauri::command]
async fn list_agents(app: State<'_, App>, workspace: String, runtime: Option<String>) -> Result<Vec<ws::SkillInfo>, String> {
    let dir = app.claude_dir(&rt(runtime));
    blocking(move || ws::agents(&workspace, &dir)).await
}

#[tauri::command]
async fn list_commands(app: State<'_, App>, workspace: String, runtime: Option<String>) -> Result<Vec<ws::SkillInfo>, String> {
    let dir = app.claude_dir(&rt(runtime));
    blocking(move || ws::commands(&workspace, &dir)).await
}

#[tauri::command]
async fn list_mcp(app: State<'_, App>, workspace: String, runtime: Option<String>) -> Result<Vec<ws::McpServer>, String> {
    let r = rt(runtime);
    let (dir, json) = (app.claude_dir(&r), app.claude_json(&r));
    blocking(move || ws::mcp_servers(&workspace, &dir, &json)).await
}

#[tauri::command]
async fn list_plugins(app: State<'_, App>, runtime: Option<String>) -> Result<ws::PluginReport, String> {
    let dir = app.claude_dir(&rt(runtime));
    blocking(move || ws::plugins(&dir)).await
}

#[tauri::command]
async fn read_doc(app: State<'_, App>, path: String, workspace: String, runtime: Option<String>) -> Result<String, String> {
    let dir = app.claude_dir(&rt(runtime));
    blocking(move || ws::read(&path, &workspace, &dir)).await?
}

#[tauri::command]
async fn write_doc(
    app: State<'_, App>,
    path: String,
    workspace: String,
    content: String,
    runtime: Option<String>,
) -> Result<(), String> {
    let dir = app.claude_dir(&rt(runtime));
    blocking(move || ws::write(&path, &workspace, &dir, &content)).await?
}

#[tauri::command]
async fn delete_doc(
    app: State<'_, App>,
    path: String,
    workspace: String,
    with_dir: bool,
    runtime: Option<String>,
) -> Result<(), String> {
    let dir = app.claude_dir(&rt(runtime));
    blocking(move || ws::delete(&path, &workspace, &dir, with_dir)).await?
}

// ---------------------------------------------------------------- terminals

#[tauri::command]
fn pty_open(
    window: tauri::AppHandle,
    app: State<App>,
    terms: State<term::Terminals>,
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    shell_integration: bool,
    runtime: Option<String>,
) -> Result<(), String> {
    let runtime = rt(runtime);
    let wsl_shell = wsl::distro_of(&runtime)
        .and_then(|_| app.runtimes_cached().into_iter().find(|r| r.id == runtime).map(|r| r.shell));
    term::open(
        window, &terms, id, cwd, cols, rows, app.data_dir.clone(), shell_integration, runtime,
        wsl_shell,
    )
}

#[tauri::command]
fn pty_write(terms: State<term::Terminals>, id: String, data: String) -> Result<(), String> {
    term::write(&terms, &id, &data)
}

#[tauri::command]
fn pty_resize(terms: State<term::Terminals>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    term::resize(&terms, &id, cols, rows)
}

#[tauri::command]
fn pty_close(terms: State<term::Terminals>, id: String) {
    term::close(&terms, &id)
}

/// Show a toast whose click raises the window and selects `pane`. False means
/// the platform has no clickable path and the UI should use the plugin.
#[tauri::command]
fn toast(app: tauri::AppHandle, title: String, body: String, pane: String) -> bool {
    notify::show(&app, &title, &body, &pane)
}

#[tauri::command]
fn hook_events(app: State<App>) -> Vec<serde_json::Value> {
    term::drain_hooks(&app.data_dir)
}

// --------------------------------------------------------------------- run

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(term::Terminals::default())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            term::write_shell_files(&data_dir.join("shell"))?;
            term::write_hook_settings(&data_dir)?;

            let store = store::Store::load(&data_dir.join("state.json"));
            app.manage(App {
                data_dir,
                store: Mutex::new(store),
                sessions: Arc::new(Mutex::new(Vec::new())),
                wsl_homes: Mutex::new(HashMap::new()),
                runtimes: Mutex::new(None),
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(terms) = window.try_state::<term::Terminals>() {
                    term::close_all(&terms);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            engine_status,
            list_runtimes,
            claude_command,
            list_workspaces,
            add_workspace,
            add_workspaces,
            remove_workspace,
            update_workspace,
            git_info,
            claude_projects,
            default_runtime,
            set_runtime,
            get_theme,
            set_theme,
            save_layout,
            load_layout,
            scan_sessions,
            usage_report,
            usage_blocks,
            search_sessions,
            usage_limits,
            delete_sessions,
            rename_session,
            claude_docs,
            list_skills,
            list_memories,
            list_agents,
            list_commands,
            list_mcp,
            list_plugins,
            read_doc,
            write_doc,
            delete_doc,
            pty_open,
            pty_write,
            pty_resize,
            pty_close,
            hook_events,
            toast,
        ])
        .run(tauri::generate_context!())
        .expect("Agentspace không khởi động được");
}
