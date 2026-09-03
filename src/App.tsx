import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { open as pickFolder } from "@tauri-apps/plugin-dialog";
import type { Terminal } from "@xterm/xterm";
import Pane, { BlockList, type Block } from "./Pane";
import ImportSheet from "./ImportSheet";
import SessionsView from "./SessionsView";
import SettingsView from "./SettingsView";
import UsageView from "./UsageView";
import WorkspaceView from "./WorkspaceView";
import { applyTheme, themeById } from "./themes";
import { api, fmtTokens, fmtUsd, normPath, shortPath, type EngineStatus, type GitInfo, type Runtime, type Session, type Workspace } from "./api";

type View = "code" | "workspace" | "sessions" | "usage" | "settings";
type Status = "idle" | "run" | "att" | "done";
type PaneInfo = {
  id: string; cwd: string; runtime: string; status: Status;
  tool?: string; message?: string; sessionId?: string; blocks: Block[];
};

const Icon = ({ d }: { d: string }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
);
const I: Record<View, string> = {
  code: "M8 9l3 3-3 3M13 15h3M4 4h16v16H4z",
  workspace: "M4 19V6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v11a2 2 0 01-2 2H6a2 2 0 01-2-2zM8 12h8M8 16h5",
  sessions: "M4 6h16M4 12h16M4 18h10",
  usage: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  settings: "M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-2.9 1.2V21a2 2 0 11-4 0v-.1A1.7 1.7 0 007.1 19.7l-.1.1a2 2 0 11-2.8-2.8l.1-.1A1.7 1.7 0 003.1 14H3a2 2 0 110-4h.1A1.7 1.7 0 004.3 7.1l-.1-.1a2 2 0 112.8-2.8l.1.1A1.7 1.7 0 0010 3.1V3a2 2 0 114 0v.1a1.7 1.7 0 002.9 1.2l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 001.2 2.9H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z",
};
const VIEW_NAME: Record<View, string> = {
  code: "Code", workspace: "Nội dung workspace", sessions: "Phiên", usage: "Mức dùng", settings: "Cài đặt",
};
const STATUS: Record<Status, [string, string]> = {
  idle: ["", "sẵn sàng"], run: ["run", "đang chạy"], att: ["att", "chờ bạn duyệt"], done: ["done", "xong"],
};
const PIN = "M9 3h6l-1 6 4 3v2h-5v7l-1 1-1-1v-7H6v-2l4-3z";
const CHEV = { open: "M15 6l-6 6 6 6", closed: "M9 6l6 6-6 6" };

export default function App() {
  const [view, setView] = useState<View>("code");
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const [runtimes, setRuntimes] = useState<Runtime[]>([]);
  const [runtime, setRuntime] = useState("host");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [git, setGit] = useState<Record<string, GitInfo>>({});
  const [wsId, setWsId] = useState<string | null>(null);
  const [wsQuery, setWsQuery] = useState("");
  const [sideOpen, setSideOpen] = useState(() => localStorage.getItem("side") !== "0");
  const [importable, setImportable] = useState<string[] | null>(null);
  const [panes, setPanes] = useState<PaneInfo[]>([]);
  const [focus, setFocus] = useState<string | null>(null);
  const [showBlocks, setShowBlocks] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [scanning, setScanning] = useState(false);
  const [today, setToday] = useState({ costUsd: 0, output: 0 });
  // Mở lại app thì PTY cũ đã chết; thứ khôi phục được là *phiên Claude* trong
  // pane đó — `claude --resume <id>`. Mặc định bật vì đó là lý do có tuỳ chọn.
  const [restore, setRestore] = useState(() => localStorage.getItem("restore") !== "0");
  const [themeId, setThemeId] = useState(() => localStorage.getItem("theme") ?? "agentspace");
  // Guards the save-on-change effect: without it, the first render writes an
  // empty layout before load_layout has answered, and the restored panes are
  // gone. It only survived by invoke ordering, which is not a guarantee.
  const [layoutLoaded, setLayoutLoaded] = useState(false);
  const terms = useRef<Record<string, Terminal>>({});
  const queued = useRef<Record<string, string>>({});

  const theme = themeById(themeId);
  const ws = workspaces.find((w) => w.id === wsId) ?? null;
  const cwd = ws?.path ?? "";

  // ---------------------------------------------------------------- theme
  // Layout effect, not a plain one: the tokens must land before the first
  // paint or a non-default theme flashes the default palette on every launch.
  useLayoutEffect(() => {
    applyTheme(theme);
    // Live terminals repaint in place rather than needing a restart.
    Object.values(terms.current).forEach((t) => { t.options.theme = theme.term; });
    localStorage.setItem("theme", theme.id);
  }, [theme]);

  // Escape closes the import sheet, like every other dialog on the platform.
  useEffect(() => {
    if (!importable) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setImportable(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [importable]);

  const toggleSide = useCallback(() => {
    setSideOpen((o) => { localStorage.setItem("side", o ? "0" : "1"); return !o; });
  }, []);

  const pickRestore = useCallback((on: boolean) => {
    setRestore(on);
    localStorage.setItem("restore", on ? "1" : "0");
  }, []);

  const pickTheme = useCallback((id: string) => {
    setThemeId(id);
    void api.setTheme(id);
  }, []);

  // ---------------------------------------------------------------- loading
  const loadEngine = useCallback(() => { api.engineStatus(runtime).then(setEngine); }, [runtime]);
  const loadWorkspaces = useCallback(async () => {
    const list = await api.listWorkspaces();
    setWorkspaces(list);
    setWsId((cur) => (cur && list.some((w) => w.id === cur) ? cur : list[0]?.id ?? null));
    if (list.length) {
      const info = await api.gitInfo(list.map((w) => w.path));
      setGit(Object.fromEntries(info.map((g) => [g.path, g])));
    }
  }, []);
  // Runtime hiện tại, đọc được từ trong một promise đang bay. Bản quét trả về
  // muộn của runtime cũ mà ghi đè thì danh sách phiên rỗng lại — đúng triệu
  // chứng "mở app không thấy phiên, bấm Quét lại mới có".
  const rtRef = useRef(runtime);
  rtRef.current = runtime;
  const loadSessions = useCallback(async () => {
    setScanning(true);
    try {
      const list = await api.scanSessions(runtime);
      if (rtRef.current === runtime) setSessions(list);
    } finally { setScanning(false); }
    api.usageReport("today", runtime)
      .then((r) => { if (rtRef.current === runtime) setToday(r.total); })
      .catch(() => {});
  }, [runtime]);

  useEffect(() => {
    api.listRuntimes().then(setRuntimes).catch(() => {});
    // Which machine's Claude Code to read. Remembered across launches; on a
    // first run it is whichever runtime is actually signed in, so a Windows
    // user whose Claude lives in WSL does not open to an empty app.
    api.defaultRuntime().then(setRuntime).catch(() => {});
  }, []);

  const pickRuntime = useCallback((id: string) => {
    setRuntime(id);
    void api.setRuntime(id);
  }, []);

  // Startup order matters for how the window feels: the cheap reads paint the
  // shell, and the transcript scan — hundreds of megabytes on a busy machine —
  // starts after the first frame instead of competing with it.
  useEffect(() => {
    loadWorkspaces();
    api.getTheme().then((t) => { if (t) setThemeId(t); }).catch(() => {});
    api
      .loadLayout()
      .then(async (l) => {
        if (l?.panes?.length) {
          const list: PaneInfo[] = l.panes.map((p: any) => ({ runtime: "host", ...p, status: "idle", blocks: [] }));
          // Xếp lệnh resume vào hàng đợi *trước* khi pane tồn tại, nên onReady
          // của terminal chắc chắn thấy nó — giải xong sau đó thì đã lỡ.
          if (localStorage.getItem("restore") !== "0")
            await Promise.all(
              list.map(async (p) => {
                if (!p.sessionId) return;
                queued.current[p.id] = await api.claudeCommand(`--resume ${p.sessionId}`, p.runtime);
              }),
            );
          setPanes(list);
        }
        if (l?.wsId) setWsId(l.wsId);
      })
      .finally(() => setLayoutLoaded(true));
    // Deliberately once: a runtime change re-runs the pieces that depend on it
    // through their own effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Máy nào đang được đọc thì quét máy đó — chạy cả lần đầu, nên không cần
  // hẹn giờ riêng lúc mount nữa (bản hẹn giờ đó giữ `runtime` cũ trong closure
  // và quét nhầm host). Vẫn lùi sau khung hình đầu: transcript có thể vài trăm
  // MB, quét ngay lúc mở làm cửa sổ đứng.
  useEffect(() => {
    loadEngine();
    const t = setTimeout(loadSessions, 250);
    return () => clearTimeout(t);
  }, [runtime, loadEngine, loadSessions]);

  // `panes` gets a new identity on every hook tick (a status changed), so
  // depending on it wrote state.json to disk twice a second. Save only when the
  // part that is actually persisted changes.
  const layoutKey = useMemo(
    () => JSON.stringify({ wsId, panes: panes.map((p) => [p.id, p.cwd, p.runtime, p.sessionId ?? ""]) }),
    [wsId, panes],
  );
  useEffect(() => {
    if (!layoutLoaded) return;
    const l = JSON.parse(layoutKey);
    api.saveLayout({
      wsId: l.wsId,
      panes: l.panes.map(([id, cwd, runtime, sessionId]: string[]) => ({ id, cwd, runtime, sessionId: sessionId || undefined })),
    });
  }, [layoutLoaded, layoutKey]);

  // Whatever added the workspace — folder picker, import sheet, a removal that
  // orphaned the selection — land on something rather than on "chưa chọn".
  useEffect(() => {
    setWsId((cur) => (cur && workspaces.some((w) => w.id === cur) ? cur : workspaces[0]?.id ?? null));
  }, [workspaces]);

  // Hook events tell us what the agent inside each pane is doing.
  useEffect(() => {
    const t = setInterval(async () => {
      const events = await api.hookEvents().catch(() => []);
      if (!events.length) return;
      setPanes((prev) =>
        prev.map((p) => {
          const mine = events.filter((e) => e.paneId === p.id);
          if (!mine.length) return p;
          const n = { ...p };
          for (const e of mine) {
            if (e.session_id) n.sessionId = e.session_id;
            switch (e.hook_event_name) {
              case "SessionStart": n.status = "idle"; break;
              case "UserPromptSubmit": n.status = "run"; n.tool = undefined; n.message = undefined; break;
              case "PreToolUse": n.status = "run"; n.tool = e.tool_name; break;
              case "PostToolUse": n.status = "run"; n.tool = undefined; break;
              case "Notification": n.status = "att"; n.message = e.message; break;
              case "Stop": n.status = "done"; n.tool = undefined; n.message = undefined; break;
              case "SessionEnd": n.status = "idle"; n.sessionId = undefined; break;
            }
          }
          return n;
        }),
      );
    }, 500);
    return () => clearInterval(t);
  }, []);

  // ----------------------------------------------------------------- panes
  const addPane = useCallback((dir: string, command?: string, rt = runtime) => {
    const id = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    if (command) queued.current[id] = command;
    setPanes((p) => [...p, { id, cwd: dir, runtime: rt, status: "idle", blocks: [] }]);
    setFocus(id);
    setView("code");
    return id;
  }, [runtime]);

  const send = useCallback((id: string, text: string) => { void api.ptyWrite(id, text + "\r"); }, []);

  const runClaude = useCallback(async (ids: string[], extra?: string) => {
    for (const id of ids) {
      const rt = panes.find((p) => p.id === id)?.runtime ?? "host";
      send(id, await api.claudeCommand(extra, rt));
    }
  }, [panes, send]);

  const resume = useCallback(async (s: Session, fork: boolean) => {
    const extra = `--resume ${s.id}` + (fork ? " --fork-session" : "");
    const existing = panes.find((p) => normPath(p.cwd) === normPath(s.cwd));
    if (existing) {
      setView("code"); setFocus(existing.id);
      send(existing.id, await api.claudeCommand(extra, existing.runtime));
    } else {
      addPane(s.cwd, await api.claudeCommand(extra, runtime));
    }
  }, [panes, addPane, send, runtime]);

  const closePane = (id: string) => {
    setPanes((p) => p.filter((x) => x.id !== id));
    delete terms.current[id];
  };

  const deleteSessions = useCallback(async (files: string[]) => {
    await api.deleteSessions(files, runtime);
    await loadSessions();
  }, [loadSessions, runtime]);

  const renameSession = useCallback(async (file: string, title: string) => {
    setSessions(await api.renameSession(file, title, runtime));
  }, [runtime]);

  // ------------------------------------------------------------ workspaces
  const addWorkspace = async () => {
    const dir = await pickFolder({ directory: true, multiple: false, title: "Chọn thư mục workspace" });
    if (typeof dir === "string") {
      const list = await api.addWorkspace(dir);
      setWorkspaces(list);
      setWsId(list.find((w) => w.path === dir)?.id ?? wsId);
      const info = await api.gitInfo([dir]);
      setGit((g) => ({ ...g, [dir]: info[0] }));
    }
  };

  const openImport = async () => setImportable(await api.claudeProjects(runtime));
  const confirmImport = async (paths: string[]) => {
    setImportable(null);
    if (!paths.length) return;
    setWorkspaces(await api.addWorkspaces(paths));
    const info = await api.gitInfo(paths);
    setGit((g) => ({ ...g, ...Object.fromEntries(info.map((x) => [x.path, x])) }));
  };

  const togglePin = (w: Workspace) => api.updateWorkspace(w.id, { favorite: !w.favorite }).then(setWorkspaces);

  // Basenames collide often (two ai-agents, two customshine); show the parent
  // segment only for the ones that actually clash.
  const label = useMemo(() => {
    const seen = new Map<string, number>();
    workspaces.forEach((w) => seen.set(w.name, (seen.get(w.name) ?? 0) + 1));
    return (w: Workspace) =>
      (seen.get(w.name) ?? 0) > 1 ? shortPath(w.path).split("/").slice(-2).join("/") : w.name;
  }, [workspaces]);

  const visibleWs = useMemo(() => {
    const q = wsQuery.trim().toLowerCase();
    const list = q ? workspaces.filter((w) => (w.name + w.path).toLowerCase().includes(q)) : workspaces;
    return [...list].sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name));
  }, [workspaces, wsQuery]);
  const firstUnpinned = visibleWs.findIndex((w) => !w.favorite);

  // ponytail: a fixed column count, not a draggable split tree. Covers 1–9
  // panes, which is what a screen holds; a resizable tree is the upgrade if
  // that stops being enough.
  const cols = panes.length <= 1 ? 1 : panes.length <= 2 ? 2 : panes.length <= 4 ? 2 : 3;
  const attention = panes.filter((p) => p.status === "att").length;
  const focused = panes.find((p) => p.id === focus) ?? null;

  return (
    <div className="app">
      {engine?.problem && (
        <div className={"banner" + (engine.installed ? "" : " err")}>
          <span>{engine.problem}</span>
          <span style={{ flex: 1 }} />
          {engine.installed && !engine.signedIn && (
            <button className="btn" onClick={() => { const id = addPane(cwd || "."); queued.current[id] = "claude"; }}>
              Mở pane để đăng nhập
            </button>
          )}
          <button className="btn" onClick={loadEngine}>Kiểm tra lại</button>
        </div>
      )}

      <div className="body">
        <nav className="rail">
          <img className="logo" src="/icon.png" alt="" />
          {(["code", "workspace", "sessions", "usage", "settings"] as View[]).map((v) => (
            <button key={v} className={view === v ? "on" : ""} onClick={() => setView(v)} title={VIEW_NAME[v]}>
              <Icon d={I[v]} />
            </button>
          ))}
          <span className="spacer" />
        </nav>

        <aside className={"side" + (sideOpen ? "" : " mini")}>
          <div className="head">
            {sideOpen && (
              <>
                <h2>Workspace</h2>
                <button className="btn ghost" onClick={openImport} title="Nhập từ danh sách project của Claude Code">Nhập…</button>
                <button className="btn ghost" onClick={addWorkspace} title="Chọn thư mục">+</button>
              </>
            )}
            <button className="btn ghost chev" onClick={toggleSide}
                    title={sideOpen ? "Thu gọn danh sách workspace" : "Mở rộng danh sách workspace"}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d={sideOpen ? CHEV.open : CHEV.closed} />
              </svg>
            </button>
          </div>
          {sideOpen && workspaces.length > 6 && (
            <input className="search" placeholder="Lọc…" value={wsQuery} onChange={(e) => setWsQuery(e.target.value)} />
          )}
          {/* Thu gọn: dải 44px vẫn dùng được — nút thêm workspace và chữ cái
              đầu của từng workspace để đổi qua lại mà không cần bung ra. */}
          {!sideOpen && (
            <div className="mini-list">
              <button className="mini-ws add" onClick={addWorkspace} title="Thêm workspace (chọn thư mục)">+</button>
              {visibleWs.map((w) => (
                <button key={w.id} className={"mini-ws" + (w.id === wsId ? " on" : "")}
                        onClick={() => setWsId(w.id)} title={`${label(w)} — ${shortPath(w.path)}`}>
                  {label(w).split(/[/\\]/).pop()!.slice(0, 2).toUpperCase()}
                </button>
              ))}
            </div>
          )}
          <div className="list" style={{ display: sideOpen ? "block" : "none" }}>
            {workspaces.length === 0 && (
              <div className="ws-empty">
                <p>Chưa có workspace nào.</p>
                <p className="s">Agentspace không tự thêm thư mục — bạn chọn cái mình muốn.</p>
                <button className="btn primary" onClick={addWorkspace}>Chọn thư mục…</button>
                <button className="btn" onClick={openImport}>Nhập từ Claude Code</button>
              </div>
            )}
            {visibleWs.map((w, i) => {
              const g = git[w.path];
              return (
                <div key={w.id}>
                  {i === firstUnpinned && i > 0 && <div className="sep" />}
                  <div className={"ws" + (w.id === wsId ? " on" : "")} onClick={() => setWsId(w.id)} title={w.path}>
                    <button className={"pin" + (w.favorite ? " on" : "")} title={w.favorite ? "Bỏ ghim" : "Ghim lên đầu"}
                            onClick={(e) => { e.stopPropagation(); togglePin(w); }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill={w.favorite ? "currentColor" : "none"}
                           stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"><path d={PIN} /></svg>
                    </button>
                    <span className="n">{label(w)}</span>
                    {g?.isRepo && <span className="b">{g.branch}{g.dirty ? `·${g.dirty}` : ""}</span>}
                    <button className="x" title="Bỏ khỏi danh sách"
                            onClick={(e) => { e.stopPropagation(); api.removeWorkspace(w.id).then(setWorkspaces); }}>×</button>
                  </div>
                </div>
              );
            })}
            {workspaces.length > 0 && visibleWs.length === 0 && <div className="hint">Không khớp bộ lọc.</div>}
          </div>
        </aside>

        <main className="main">
          {/* The Code view stays mounted when another tab is shown. Unmounting
              it ran Pane's cleanup, which killed every PTY — switching to
              Usage and back used to lose all your running sessions. Panes now
              close only when you close them or quit. */}
          <div className="view" style={{ display: view === "code" ? "flex" : "none" }}>
            <>
              <div className="toolbar">
                <span className="title">{ws ? label(ws) : "Chưa chọn workspace"}</span>
                <span className="path">{ws ? shortPath(ws.path) : ""}</span>
                <span className="sp" />
                {runtimes.length > 1 && (
                  <div className="seg" title="Pane mới sẽ chạy shell ở đâu">
                    {runtimes.map((r) => (
                      <button key={r.id} className={runtime === r.id ? "on" : ""}
                              onClick={() => pickRuntime(r.id)}>
                        {r.label}
                      </button>
                    ))}
                  </div>
                )}
                {focused && (
                  <button className="btn primary" onClick={() => runClaude([focused.id])}
                          disabled={!engine?.signedIn}>Chạy Claude</button>
                )}
                {panes.length > 1 && (
                  <button className="btn" onClick={() => runClaude(panes.map((p) => p.id))}
                          disabled={!engine?.signedIn}>Chạy tất cả</button>
                )}
                <button className="btn" onClick={() => cwd && addPane(cwd)} disabled={!cwd}>+ Pane</button>
              </div>

              {panes.length === 0 ? (
                <div className="empty-main">
                  <div>
                    <p>{ws ? "Chưa có pane nào." : "Thêm một workspace bên trái để bắt đầu."}</p>
                    {ws && (
                      <button className="btn primary" onClick={() => addPane(cwd)}>
                        Mở terminal trong {label(ws)}
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
                  {panes.map((p) => {
                    const [cls, statusLabel] = STATUS[p.status];
                    return (
                      <section key={p.id} className={"pane" + (focus === p.id ? " focus" : "")}
                               onMouseDown={() => setFocus(p.id)}>
                        <header className="ph">
                          <span className="nm">{shortPath(p.cwd).split(/[/\\]/).pop()}</span>
                          {p.runtime !== "host" && (
                            <span className="chip" title={p.runtime}>
                              {runtimes.find((r) => r.id === p.runtime)?.label ?? p.runtime}
                            </span>
                          )}
                          <span className={"chip " + cls}><span className="d" />{p.tool ?? p.message ?? statusLabel}</span>
                          <span className="sp" />
                          <button className="btn ghost" style={{ padding: "1px 6px" }}
                                  onClick={() => setShowBlocks(showBlocks === p.id ? null : p.id)}
                                  title="Lệnh đã chạy">⌘ {p.blocks.length}</button>
                          <button className="btn ghost" style={{ padding: "1px 6px" }}
                                  onClick={() => runClaude([p.id])} title="Chạy Claude ở pane này">▶</button>
                          <button className="btn ghost" style={{ padding: "1px 6px" }}
                                  onClick={() => closePane(p.id)} title="Đóng pane">×</button>
                        </header>
                        {showBlocks === p.id && (
                          <BlockList blocks={p.blocks} onJump={(b) => {
                            if (b.marker) terms.current[p.id]?.scrollToLine(Math.max(b.marker.line - 2, 0));
                            setShowBlocks(null);
                          }} />
                        )}
                        <Pane
                          id={p.id} cwd={p.cwd} runtime={p.runtime} focused={focus === p.id} palette={theme.term}
                          onFocus={() => setFocus(p.id)}
                          onCwd={(c) => setPanes((all) => all.map((x) => (x.id === p.id ? { ...x, cwd: c } : x)))}
                          onBlocks={(b) => setPanes((all) => all.map((x) => (x.id === p.id ? { ...x, blocks: b } : x)))}
                          onReady={(t) => {
                            terms.current[p.id] = t;
                            const q = queued.current[p.id];
                            if (q) { delete queued.current[p.id]; send(p.id, q); }
                          }}
                        />
                      </section>
                    );
                  })}
                </div>
              )}
            </>
          </div>

          {view === "workspace" && (
            <WorkspaceView workspace={ws?.path ?? ""} name={ws ? label(ws) : ""} runtime={runtime} />
          )}
          {view === "sessions" && (
            <SessionsView sessions={sessions} busy={scanning} scopePath={ws?.path ?? null}
                          onRefresh={loadSessions} onResume={resume} onDelete={deleteSessions}
                          onRename={renameSession} />
          )}
          {view === "usage" && <UsageView runtime={runtime} />}
          {view === "settings" && (
            <SettingsView current={theme.id} onPick={pickTheme} restore={restore} onRestore={pickRestore} />
          )}
        </main>
      </div>

      {importable && (
        <ImportSheet paths={importable} onCancel={() => setImportable(null)} onConfirm={confirmImport} />
      )}

      <footer className="status">
        {engine?.account ? (
          <>
            <span><b>{engine.account.email}</b></span>
            <span>{engine.account.plan || "—"}{engine.authSource === "api-key" ? " · API key" : ""}</span>
          </>
        ) : (
          <span>chưa đăng nhập</span>
        )}
        <span>Claude Code {engine?.version?.split(" ")[0] ?? "?"}</span>
        <span className="sp" />
        {attention > 0 && <span style={{ color: "var(--warn)" }}>{attention} pane chờ duyệt</span>}
        <span>{panes.length} pane</span>
        <span>hôm nay <b>{fmtTokens(today.output)}</b> token ra{today.costUsd > 0 ? ` · ${fmtUsd(today.costUsd)}` : ""}</span>
      </footer>
    </div>
  );
}
