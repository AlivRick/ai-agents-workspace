import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { open as pickFolder } from "@tauri-apps/plugin-dialog";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import type { Terminal } from "@xterm/xterm";
import Pane, { BlockList, type Block as PaneBlock } from "./Pane";
import ImportSheet from "./ImportSheet";
import SettingsView from "./SettingsView";
import UsageView from "./UsageView";
import WorkspaceView, { TABS as WS_TABS, type Tab as WsTab } from "./WorkspaceView";
import TaskSheet, { AgentIcon, type TaskSpec } from "./TaskSheet";
import DiffSheet from "./DiffSheet";
import { agentOf, allBins, launchArgs, launchCommand, type Slot } from "./agents";
import { applyTheme, themeById } from "./themes";
import { reorder } from "./reorder";
import { loudest, type Status } from "./task";
import {
  ago, api, blockTokens, fmtTokens, fmtUsd, shortPath, until,
  type Block, type EngineStatus, type GitInfo, type Runtime, type Tree, type Workspace,
} from "./api";

type View = "code" | "workspace" | "usage" | "settings";
/** One entry of the todo list Claude keeps for itself, as TodoWrite writes it. */
type Todo = { content: string; activeForm?: string; status: string };
/** A unit of work inside a workspace: a name, the terminals doing it, and the
 *  git worktree they do it in.
 *
 *  The worktree is per *task*, not per pane: two agents on one job have to see
 *  each other's files, and a task with a single pane is already full per-agent
 *  isolation. Absent on folders that are not git checkouts — those run in the
 *  workspace itself, exactly as every task did before. */
type Task = { id: string; wsId: string; name: string; wt?: Tree };
type PaneInfo = {
  id: string; taskId: string; cwd: string; runtime: string; status: Status;
  /** Which CLI this terminal was opened for — why a Codex terminal does not
   *  pretend to report Claude's hook status. */
  agent: Slot;
  /** When the pane last changed status — what the inbox sorts and ages by. */
  since: number;
  /** A name you gave the pane. Two panes on one workspace are otherwise
   *  identical in the header, which is exactly when you have several. */
  name?: string;
  tool?: string; message?: string; sessionId?: string; blocks: PaneBlock[]; todos: Todo[];
};

const Icon = ({ d }: { d: string }) => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
);
const I: Record<View, string> = {
  code: "M8 9l3 3-3 3M13 15h3M4 4h16v16H4z",
  workspace: "M4 19V6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v11a2 2 0 01-2 2H6a2 2 0 01-2-2zM8 12h8M8 16h5",
  usage: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  settings: "M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-2.9 1.2V21a2 2 0 11-4 0v-.1A1.7 1.7 0 007.1 19.7l-.1.1a2 2 0 11-2.8-2.8l.1-.1A1.7 1.7 0 003.1 14H3a2 2 0 110-4h.1A1.7 1.7 0 004.3 7.1l-.1-.1a2 2 0 112.8-2.8l.1.1A1.7 1.7 0 0010 3.1V3a2 2 0 114 0v.1a1.7 1.7 0 002.9 1.2l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 001.2 2.9H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z",
};
const VIEW_NAME: Record<View, string> = {
  code: "Terminals", workspace: "Claude config", usage: "Usage", settings: "Settings",
};
const STATUS: Record<Status, [string, string]> = {
  idle: ["", "ready"], run: ["run", "working"], att: ["att", "waiting for you"], done: ["done", "done"],
};
const PIN = "M9 3h6l-1 6 4 3v2h-5v7l-1 1-1-1v-7H6v-2l4-3z";
/** Nút thu gọn. Cùng một icon ở cả hai trạng thái, đứng yên một chỗ — chevron
 *  đổi chiều mà logo lại nhảy theo là thứ làm thanh bên trông lệch lúc thu. */
const BURGER = "M4 7h16M4 12h16M4 17h16";

export default function App() {
  const [view, setView] = useState<View>("code");
  const [wsTab, setWsTab] = useState<WsTab>("prompt");
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const [runtimes, setRuntimes] = useState<Runtime[]>([]);
  const [runtime, setRuntime] = useState("host");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [git, setGit] = useState<Record<string, GitInfo>>({});
  const [wsId, setWsId] = useState<string | null>(null);
  const [wsQuery, setWsQuery] = useState("");
  const [sideOpen, setSideOpen] = useState(() => localStorage.getItem("side") !== "0");
  const [importable, setImportable] = useState<string[] | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [newTaskWs, setNewTaskWs] = useState<Workspace | null>(null);
  /** The task whose changes are open for review. */
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [panes, setPanes] = useState<PaneInfo[]>([]);
  const dragPane = useRef<string | null>(null);
  const [overPane, setOverPane] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [showBlocks, setShowBlocks] = useState<string | null>(null);
  const [showTodos, setShowTodos] = useState<string | null>(null);
  const [zoom, setZoom] = useState<string | null>(null);
  /** Column and row weights per task, so a terminal you widened stays wide.
   *  Keyed by task; a task whose terminal count changed falls back to equal. */
  const [sizes, setSizes] = useState<Record<string, { cols: number[]; rows: number[] }>>({});
  const grid = useRef<HTMLDivElement>(null);
  const [naming, setNaming] = useState<{ id: string; value: string } | null>(null);
  const [today, setToday] = useState({ costUsd: 0, output: 0 });
  const [block, setBlock] = useState<Block | null>(null);
  const [inbox, setInbox] = useState(false);
  const [notify, setNotify] = useState(() => localStorage.getItem("notify") !== "0");
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
  const task = tasks.find((t) => t.id === taskId) ?? null;

  // ---------------------------------------------------------------- theme
  // Layout effect, not a plain one: the tokens must land before the first
  // paint or a non-default theme flashes the default palette on every launch.
  useLayoutEffect(() => {
    applyTheme(theme);
    // Live terminals repaint in place rather than needing a restart.
    Object.values(terms.current).forEach((t) => { t.options.theme = theme.term; });
    localStorage.setItem("theme", theme.id);
  }, [theme]);

  // Escape closes whichever sheet is open, like every other dialog.
  useEffect(() => {
    if (!importable && !newTaskWs) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setImportable(null); setNewTaskWs(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [importable, newTaskWs]);

  const toggleSide = useCallback(() => {
    setSideOpen((o) => { localStorage.setItem("side", o ? "0" : "1"); return !o; });
  }, []);

  const pickNotify = useCallback((on: boolean) => {
    setNotify(on);
    localStorage.setItem("notify", on ? "1" : "0");
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
  // muộn của runtime cũ mà ghi đè thì số liệu nhảy về của máy sai.
  const rtRef = useRef(runtime);
  rtRef.current = runtime;
  const loadUsage = useCallback(() => {
    api.usageReport("today", runtime)
      .then((r) => { if (rtRef.current === runtime) setToday(r.total); })
      .catch(() => {});
    api.usageBlocks(runtime)
      .then((bs) => { if (rtRef.current === runtime) setBlock(bs.at(-1)?.active ? bs[bs.length - 1] : null); })
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
  // shell, and the usage scan — hundreds of megabytes of transcript on a busy
  // machine — starts after the first frame instead of competing with it.
  useEffect(() => {
    loadWorkspaces();
    api.getTheme().then((t) => { if (t) setThemeId(t); }).catch(() => {});
    api
      .loadLayout()
      .then(async (l) => {
        const saved: Task[] = Array.isArray(l?.tasks) ? l.tasks : [];
        if (l?.panes?.length) {
          // Bản layout cũ không có tác vụ: gom mọi pane đã lưu vào một tác vụ
          // của workspace đang mở, thay vì để chúng thành pane mồ côi.
          const legacy = saved.length ? null : { id: `t${Date.now().toString(36)}`, wsId: l.wsId ?? "", name: "Restored task" };
          const list: PaneInfo[] = l.panes.map((p: any) => ({
            runtime: "host", agent: "claude", taskId: legacy?.id ?? "", ...p,
            status: "idle", since: Date.now(), blocks: [], todos: [],
          }));
          if (legacy) saved.push(legacy);
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
        setTasks(saved);
        if (l?.sizes && typeof l.sizes === "object") setSizes(l.sizes);
        if (l?.wsId) setWsId(l.wsId);
        if (l?.taskId && saved.some((t) => t.id === l.taskId)) setTaskId(l.taskId);
        else setTaskId(saved[0]?.id ?? null);
      })
      .finally(() => setLayoutLoaded(true));
    // Deliberately once: a runtime change re-runs the pieces that depend on it
    // through their own effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Máy nào đang được đọc thì đọc số của máy đó. Vẫn lùi sau khung hình đầu:
  // transcript có thể vài trăm MB, quét ngay lúc mở làm cửa sổ đứng.
  useEffect(() => {
    loadEngine();
    const t = setTimeout(loadUsage, 250);
    return () => clearTimeout(t);
  }, [runtime, loadEngine, loadUsage]);

  // `panes` gets a new identity on every hook tick (a status changed), so
  // depending on it wrote state.json to disk twice a second. Save only when the
  // part that is actually persisted changes.
  const layoutKey = useMemo(
    () => JSON.stringify({
      wsId, taskId, tasks, sizes,
      panes: panes.map((p) => [p.id, p.taskId, p.cwd, p.runtime, p.sessionId ?? "", p.name ?? "", p.agent]),
    }),
    [wsId, taskId, tasks, sizes, panes],
  );
  useEffect(() => {
    if (!layoutLoaded) return;
    const l = JSON.parse(layoutKey);
    api.saveLayout({
      wsId: l.wsId,
      taskId: l.taskId,
      tasks: l.tasks,
      sizes: l.sizes,
      panes: l.panes.map(([id, tid, cwd, runtime, sessionId, name, agent]: string[]) => ({
        id, taskId: tid, cwd, runtime, agent, sessionId: sessionId || undefined, name: name || undefined,
      })),
    });
  }, [layoutLoaded, layoutKey]);

  // Whatever added the workspace — folder picker, import sheet, a removal that
  // orphaned the selection — land on something rather than on "chưa chọn".
  useEffect(() => {
    setWsId((cur) => (cur && workspaces.some((w) => w.id === cur) ? cur : workspaces[0]?.id ?? null));
  }, [workspaces]);

  // Layout cũ, hoặc một workspace biến mất khỏi danh sách, để lại tác vụ trỏ
  // vào wsId không còn ai — dời về workspace đầu tiên, không thì terminal vẫn
  // chạy mà không còn chỗ nào bấm vào được.
  useEffect(() => {
    if (!workspaces.length) return;
    const known = (id: string) => workspaces.some((w) => w.id === id);
    setTasks((all) => (all.every((t) => known(t.wsId)) ? all
      : all.map((t) => (known(t.wsId) ? t : { ...t, wsId: workspaces[0].id }))));
  }, [workspaces]);

  // Đổi workspace thì tác vụ đang xem phải thuộc workspace đó, không thì lưới
  // terminal trống trong khi sidebar lại tô sáng một tác vụ ở nơi khác.
  useEffect(() => {
    setTaskId((cur) => {
      const keep = tasks.find((t) => t.id === cur);
      if (keep && keep.wsId === wsId) return cur;
      return tasks.find((t) => t.wsId === wsId)?.id ?? null;
    });
  }, [wsId, tasks]);

  // Phóng to là trạng thái của một tác vụ. Mang nó sang tác vụ khác thì mọi
  // pane ở đó đều bị ẩn (không pane nào là pane được phóng), lưới trắng trơn.
  useEffect(() => { setZoom(null); }, [taskId]);

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
          const before = p.status;
          for (const e of mine) {
            if (e.session_id) n.sessionId = e.session_id;
            switch (e.hook_event_name) {
              case "SessionStart": n.status = "idle"; break;
              case "UserPromptSubmit": n.status = "run"; n.tool = undefined; n.message = undefined; break;
              case "PreToolUse": n.status = "run"; n.tool = e.tool_name; break;
              case "PostToolUse":
                n.status = "run";
                n.tool = undefined;
                // Claude keeps its own plan in TodoWrite; the hook hands us the
                // exact list it just wrote. Shape-checked rather than trusted:
                // an unfamiliar payload leaves the old list alone.
                if (e.tool_name === "TodoWrite" && Array.isArray(e.tool_input?.todos)) {
                  n.todos = e.tool_input.todos.filter(
                    (t: any) => t && typeof t.content === "string" && typeof t.status === "string",
                  );
                }
                break;
              case "Notification": n.status = "att"; n.message = e.message; break;
              case "Stop": n.status = "done"; n.tool = undefined; n.message = undefined; break;
              case "SessionEnd": n.status = "idle"; n.sessionId = undefined; n.todos = []; break;
            }
          }
          if (n.status !== before) n.since = Date.now();
          return n;
        }),
      );
    }, 500);
    return () => clearInterval(t);
  }, []);

  // -------------------------------------------------------- hộp thư & báo
  // A pane waiting for approval while you are in another window is the one
  // thing this app knows and the terminal cannot tell you. It only fires when
  // Agentspace is unfocused: on screen the pane's chip and the footer counter
  // already say it, and a toast over the window you are typing in is noise.
  const granted = useRef(false);
  useEffect(() => {
    isPermissionGranted()
      .then(async (ok) => { granted.current = ok || (await requestPermission()) === "granted"; })
      .catch(() => {});
  }, []);

  const seen = useRef<Record<string, Status>>({});
  useEffect(() => {
    for (const p of panes) {
      const was = seen.current[p.id];
      seen.current[p.id] = p.status;
      if (was === p.status || (p.status !== "att" && p.status !== "done")) continue;
      if (!notify || !granted.current || document.hasFocus()) continue;
      const name = p.name || shortPath(p.cwd).split(/[/\\]/).pop() || "pane";
      const title = `${name} · ${p.status === "att" ? "waiting for you" : "done"}`;
      const body = p.message ?? p.tool ?? STATUS[p.status][1];
      // Windows gets a toast that can be clicked back into the right pane; on
      // anything else that is not possible, so the plugin shows a plain one.
      api.toast(title, body, p.id)
        .then((clickable) => { if (!clickable) sendNotification({ title, body }); })
        .catch(() => sendNotification({ title, body }));
      void getCurrentWindow().requestUserAttention(UserAttentionType.Informational);
    }
  }, [panes, notify]);

  /** A task shows the agent it is actually running: the first non-shell one,
   *  because a Claude + two shells workbench is a Claude task. */
  const taskAgent = (list: PaneInfo[]): Slot =>
    list.find((p) => p.agent !== "terminal")?.agent ?? "terminal";

  const paneName = (p: PaneInfo) => p.name || shortPath(p.cwd).split(/[/\\]/).pop() || "pane";

  // Đọc trạng thái mới nhất mà không phải khai vào deps: `jump` là handler của
  // sự kiện toast, đăng ký một lần lúc mount.
  const now = useRef({ panes, tasks });
  now.current = { panes, tasks };
  const jump = useCallback((id: string) => {
    setInbox(false);
    setView("code");
    // Nhảy từ hộp thư hay từ toast có thể là terminal ở tác vụ khác — kéo cả
    // tác vụ và workspace của nó theo, không thì bấm xong màn hình y nguyên.
    const p = now.current.panes.find((x) => x.id === id);
    const t = p && now.current.tasks.find((x) => x.id === p.taskId);
    if (t) { setWsId(t.wsId); setTaskId(t.id); }
    setFocus(id);
    terms.current[id]?.focus();
  }, []);

  // Clicking the toast lands here: Rust has already raised the window, this
  // selects the pane that asked for you.
  useEffect(() => {
    const un = listen<string>("notify-click", (e) => jump(e.payload));
    return () => { void un.then((f) => f()); };
  }, [jump]);

  // ----------------------------------------------------------------- panes
  const addPane = useCallback((dir: string, tid: string, command?: string, rt = runtime, agent: Slot = "terminal") => {
    const id = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    if (command) queued.current[id] = command;
    setPanes((p) => [...p, { id, taskId: tid, cwd: dir, runtime: rt, agent, status: "idle", since: Date.now(), blocks: [], todos: [] }]);
    setFocus(id);
    setView("code");
    return id;
  }, [runtime]);

  const send = useCallback((id: string, text: string) => { void api.ptyWrite(id, text + "\r"); }, []);

  /** Which agent CLIs a runtime can actually run. The backend probes the
   *  runtime's own shell once and memoises, so asking per sheet open is one IPC
   *  round trip rather than a subprocess. */
  const installedBins = useCallback((runtime: string) => api.agentsAvailable(allBins(), runtime), []);

  /** The command that starts one agent. Claude goes through the backend so it
   *  gets the hook settings that make its status chip work; every other CLI is
   *  its own binary, so a new agent costs one row in the table and nothing here. */
  const agentCommand = useCallback(async (agent: Slot, runtime: string, prompt = "", cont = false) => {
    const a = agentOf(agent);
    if (!a || !a.bins.length) return "";
    if (agent === "claude")
      return api.claudeCommand(launchArgs(a, prompt, cont) || undefined, runtime);
    return launchCommand(agent, await installedBins(runtime), prompt, cont);
  }, [installedBins]);

  // ------------------------------------------------------------------ tasks
  const createTask = useCallback(async (w: Workspace, spec: TaskSpec) => {
    const id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    setTasks((all) => [...all, { id, wsId: w.id, name: spec.name }]);
    setWsId(w.id);
    setTaskId(id);
    setNewTaskWs(null);
    setView("code");
    // Cut the branch before the terminals open, so the agents start life inside
    // it — but only when you asked for one. A repo git refuses to branch keeps
    // the plain behaviour of working in the workspace itself rather than
    // failing to make a task at all.
    let wt: Tree | undefined;
    if (spec.worktree) {
      try {
        wt = await api.worktreeCreate(w.path, spec.name, id, spec.runtime);
        setTasks((all) => all.map((t) => (t.id === id ? { ...t, wt } : t)));
      } catch {
        wt = undefined;
      }
    }
    const dir = wt?.path ?? w.path;
    // One command per distinct agent, not per terminal: four Claudes in a swarm
    // should not be four round trips to the backend for the same string.
    const cmd = new Map<Slot, string>();
    for (const s of new Set(spec.slots))
      cmd.set(s, await agentCommand(s, spec.runtime, spec.prompt, spec.continueLast));
    spec.slots.forEach((s) => addPane(dir, id, cmd.get(s) || undefined, spec.runtime, s));
  }, [addPane, agentCommand]);

  const closeTask = useCallback((id: string) => {
    // A worktree outlives the task that made it on purpose: the terminals are
    // disposable, the branch is the work. Closing here only stops asking about
    // it — Review is where a branch actually gets merged or deleted.
    const wt = now.current.tasks.find((t) => t.id === id)?.wt;
    if (wt && !confirm(`Close this task? Its branch ${wt.branch} and worktree stay on disk — reopen a task there or clean them up with git.`))
      return;
    // Panes unmount with the task, and Pane's cleanup kills their PTYs — that
    // is the point: closing a task closes the terminals doing it.
    setPanes((all) => all.filter((p) => p.taskId !== id));
    setTasks((all) => all.filter((t) => t.id !== id));
  }, []);

  /** The branch landed or went in the bin; either way the checkout is gone, so
   *  the terminals still sitting in it have to go with it. */
  const endWorktree = useCallback((id: string) => {
    setReviewId(null);
    setPanes((all) => all.filter((p) => p.taskId !== id));
    setTasks((all) => all.filter((t) => t.id !== id));
  }, []);

  const commitTaskName = () => {
    if (!renaming) return;
    const { id, value } = renaming;
    setRenaming(null);
    const name = value.trim();
    if (name) setTasks((all) => all.map((t) => (t.id === id ? { ...t, name } : t)));
  };

  const commitName = () => {
    if (!naming) return;
    const { id, value } = naming;
    setNaming(null);
    setPanes((all) => all.map((x) => (x.id === id ? { ...x, name: value.trim() || undefined } : x)));
  };

  const closePane = (id: string) => {
    setPanes((p) => p.filter((x) => x.id !== id));
    setZoom((z) => (z === id ? null : z));
    delete terms.current[id];
  };

  // Thứ tự pane = thứ tự mảng `panes`, nên nó tự vào layout đã lưu. Nút ‹ › thì
  // phải đổi chỗ *trong cùng tác vụ*: hàng xóm trong mảng có thể thuộc tác vụ
  // khác và đang ẩn, đổi với nó thì lưới không nhúc nhích.
  const movePane = (id: string, to: string | number) => setPanes((all) => {
    if (typeof to === "string") return reorder(all, id, to);
    const mine = all.filter((p) => p.taskId === all.find((x) => x.id === id)?.taskId);
    const next = mine[mine.findIndex((p) => p.id === id) + to];
    return next ? reorder(all, id, next.id) : all;
  });

  // ------------------------------------------------------------ workspaces
  const addWorkspace = async () => {
    const dir = await pickFolder({ directory: true, multiple: false, title: "Choose a workspace folder" });
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

  const removeWorkspace = (w: Workspace) => {
    tasks.filter((t) => t.wsId === w.id).forEach((t) => closeTask(t.id));
    api.removeWorkspace(w.id).then(setWorkspaces);
  };

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

  /** Chỉ terminal của tác vụ đang mở mới hiện; các pane khác vẫn nằm trong DOM
   *  (ẩn đi) vì unmount là giết PTY. */
  const shown = panes.filter((p) => p.taskId === taskId);
  // ponytail: a fixed column count, not a draggable split tree. Covers 1–9
  // panes, which is what a screen holds; a resizable tree is the upgrade if
  // that stops being enough.
  const cols = shown.length <= 1 ? 1 : shown.length <= 2 ? 2 : shown.length <= 4 ? 2 : 3;
  const rows = Math.max(Math.ceil(shown.length / cols), 1);
  // A saved split only applies while the grid still has that shape; add or
  // close a terminal and the weights go back to equal rather than to garbage.
  const fit = (a: number[] | undefined, n: number) => (a?.length === n ? a : Array(n).fill(1));
  const colFr = fit(sizes[taskId ?? ""]?.cols, cols);
  const rowFr = fit(sizes[taskId ?? ""]?.rows, rows);

  /** Drag the gutter after column/row `i`. Weights move between the two cells
   *  that touch it, so the grid keeps its total size and nothing else shifts. */
  const startResize = (e: React.PointerEvent, axis: "x" | "y", i: number) => {
    const el = grid.current;
    if (!el || !taskId) return;
    e.preventDefault();
    e.stopPropagation();
    const vertical = axis === "y";
    const total = vertical ? el.clientHeight : el.clientWidth;
    const base = vertical ? rowFr : colFr;
    const sum = base.reduce((a, b) => a + b, 0);
    const px = base.map((f) => (f / sum) * total);
    const from = vertical ? e.clientY : e.clientX;
    const MIN = 140;
    const move = (ev: PointerEvent) => {
      const raw = (vertical ? ev.clientY : ev.clientX) - from;
      const d = Math.max(MIN - px[i], Math.min(px[i + 1] - MIN, raw));
      const next = px.slice();
      next[i] += d;
      next[i + 1] -= d;
      const fr = next.map((v) => (v / total) * sum);
      setSizes((all) => ({
        ...all,
        [taskId]: { cols: vertical ? colFr : fr, rows: vertical ? fr : rowFr },
      }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  /** Double-click a gutter: back to an even split. */
  const evenSplit = () => taskId && setSizes(({ [taskId]: _drop, ...rest }) => rest);
  const attention = panes.filter((p) => p.status === "att").length;
  const waiting = panes
    .filter((p) => p.status === "att" || p.status === "done")
    .sort((a, b) => (a.status === b.status ? b.since - a.since : a.status === "att" ? -1 : 1));

  const navBtn = (v: View) => (
    <button key={v} className={"nav-item" + (view === v ? " on" : "")} onClick={() => setView(v)}
            title={VIEW_NAME[v]}>
      <Icon d={I[v]} />
      {sideOpen && <span>{VIEW_NAME[v]}</span>}
    </button>
  );

  return (
    <div className="app">
      {engine?.problem && (
        <div className={"banner" + (engine.installed ? "" : " err")}>
          <span>{engine.problem}</span>
          <span style={{ flex: 1 }} />
          {engine.installed && !engine.signedIn && ws && (
            <button className="btn" onClick={() => setNewTaskWs(ws)}>Open a task to sign in</button>
          )}
          <button className="btn" onClick={loadEngine}>Check again</button>
        </div>
      )}

      <div className="body">
        <aside className={"side" + (sideOpen ? "" : " mini")}>
          <div className="brand">
            <button className="burger" onClick={toggleSide}
                    title={sideOpen ? "Collapse sidebar" : "Expand sidebar"}>
              <Icon d={BURGER} />
            </button>
            {sideOpen && (
              <>
                <img className="logo" src="/icon.png" alt="" />
                <b>Agentspace</b>
              </>
            )}
          </div>

          <nav className="nav">
            {navBtn("code")}
            {navBtn("workspace")}
            {/* Cấu hình workspace có bảy mục; giấu chúng sau một thanh tab bên
                trong nghĩa là không ai biết chúng tồn tại. Bung thẳng ra đây. */}
            {sideOpen && view === "workspace" && (
              <div className="nav-sub">
                {WS_TABS.map((t) => (
                  <button key={t.id} className={wsTab === t.id ? "on" : ""} title={t.note}
                          onClick={() => setWsTab(t.id)}>{t.name}</button>
                ))}
              </div>
            )}
            {navBtn("usage")}
            {navBtn("settings")}
          </nav>

          {sideOpen && (
            <div className="head">
              <h2>Workspace</h2>
              <span className="sp" />
              <button className="btn ghost" onClick={openImport} title="Import folders your agents have already worked in">Import…</button>
              <button className="btn ghost" onClick={addWorkspace} title="Pick a folder">+</button>
            </div>
          )}

          {sideOpen && workspaces.length > 6 && (
            <input className="search" placeholder="Filter…" value={wsQuery} onChange={(e) => setWsQuery(e.target.value)} />
          )}

          {/* Thu gọn: dải hẹp vẫn dùng được — chữ cái đầu của từng workspace để
              đổi qua lại mà không cần bung ra. */}
          {!sideOpen && (
            <div className="mini-list">
              <button className="mini-ws add" onClick={addWorkspace} title="Add a workspace (pick a folder)">+</button>
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
                <p>No workspaces yet.</p>
                <p className="s">Agentspace never adds folders on its own — you pick the ones you want.</p>
                <button className="btn primary" onClick={addWorkspace}>Pick a folder…</button>
                <button className="btn" onClick={openImport}>Import existing folders</button>
              </div>
            )}
            {visibleWs.map((w, i) => {
              const g = git[w.path];
              const mine = tasks.filter((t) => t.wsId === w.id);
              // Ghim = luôn bày tác vụ ra, kể cả khi bạn đang làm ở workspace
              // khác. Đó là điểm của việc ghim: hai ba dự án chạy song song thì
              // phải thấy được cả hai mà không phải bấm qua bấm lại.
              const open = w.id === wsId || w.favorite;
              return (
                <div key={w.id}>
                  {i === firstUnpinned && i > 0 && <div className="sep" />}
                  <div className={"ws" + (open ? " on" : "")} onClick={() => setWsId(w.id)} title={w.path}>
                    <button className={"pin" + (w.favorite ? " on" : "")} title={w.favorite ? "Unpin" : "Pin to top and keep its tasks listed"}
                            onClick={(e) => { e.stopPropagation(); togglePin(w); }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill={w.favorite ? "currentColor" : "none"}
                           stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"><path d={PIN} /></svg>
                    </button>
                    <span className="n">{label(w)}</span>
                    {g?.isRepo && <span className="b">{g.branch}{g.dirty ? `·${g.dirty}` : ""}</span>}
                    {mine.length > 0 && <span className="count">{mine.length}</span>}
                    <button className="x" title="New task in this workspace"
                            onClick={(e) => { e.stopPropagation(); setNewTaskWs(w); }}>+</button>
                    <button className="x" title="Remove from the list"
                            onClick={(e) => { e.stopPropagation(); removeWorkspace(w); }}>×</button>
                  </div>
                  {open && (
                    <div className="tasks">
                      {mine.map((t) => {
                        const its = panes.filter((p) => p.taskId === t.id);
                        const [cls] = STATUS[loudest(its.map((p) => p.status))];
                        return (
                          <div key={t.id} className={"task" + (t.id === taskId ? " on" : "")}
                               onClick={() => { setWsId(t.wsId); setTaskId(t.id); setView("code"); }}>
                            <span className={"dot " + cls} />
                            <AgentIcon agent={taskAgent(its)} />
                            {renaming?.id === t.id ? (
                              <input className="rename" autoFocus value={renaming.value}
                                     onClick={(e) => e.stopPropagation()}
                                     onFocus={(e) => e.currentTarget.select()}
                                     onChange={(e) => setRenaming({ id: t.id, value: e.target.value })}
                                     onBlur={commitTaskName}
                                     onKeyDown={(e) => {
                                       if (e.key === "Enter") commitTaskName();
                                       if (e.key === "Escape") setRenaming(null);
                                     }} />
                            ) : (
                              <span className="n" title="Double-click to rename"
                                    onDoubleClick={(e) => { e.stopPropagation(); setRenaming({ id: t.id, value: t.name }); }}>
                                {t.name}
                              </span>
                            )}
                            <span className="c">{its.length}</span>
                            <button className="x" title="Add a terminal to this task"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      const w = workspaces.find((x) => x.id === t.wsId);
                                      if (w) { setTaskId(t.id); addPane(t.wt?.path ?? w.path, t.id); }
                                    }}>+</button>
                            <button className="x" title="Close the task and all its terminals"
                                    onClick={(e) => { e.stopPropagation(); closeTask(t.id); }}>×</button>
                          </div>
                        );
                      })}
                      <button className="task add" onClick={() => setNewTaskWs(w)}>+ New task</button>
                    </div>
                  )}
                </div>
              );
            })}
            {workspaces.length > 0 && visibleWs.length === 0 && <div className="hint">Nothing matches the filter.</div>}
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
                <span className="title">{task ? task.name : ws ? label(ws) : "No workspace selected"}</span>
                <span className="path">{ws ? shortPath(ws.path) : ""}</span>
                {task?.wt && (
                  <>
                    <span className="branch" title={`Working in ${task.wt.path}, on a branch cut from ${task.wt.base}`}>
                      {task.wt.branch}
                    </span>
                    <button className="btn ghost" onClick={() => setReviewId(task.id)}
                            title="See what this task changed, then merge it or throw it away">
                      Review
                    </button>
                  </>
                )}
                <span className="sp" />
                {runtimes.length > 1 && (
                  <div className="seg" title="Where new terminals will run">
                    {runtimes.map((r) => (
                      <button key={r.id} className={runtime === r.id ? "on" : ""}
                              onClick={() => pickRuntime(r.id)}>
                        {r.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {shown.length === 0 && (
                <div className="empty-main">
                  <div>
                    {!ws ? (
                      <p>Add a workspace on the left to get started.</p>
                    ) : !task ? (
                      <>
                        <p>{label(ws)} has no tasks yet.</p>
                        <p className="s">A task is one thing you are working on — and the terminals doing it.</p>
                        <button className="btn primary" onClick={() => setNewTaskWs(ws)}>+ New task</button>
                      </>
                    ) : (
                      <>
                        <p>Task “{task.name}” has no terminals left.</p>
                        <button className="btn primary" onClick={() => addPane(task.wt?.path ?? cwd, task.id)}>+ Terminal</button>
                      </>
                    )}
                  </div>
                </div>
              )}
              {/* Lưới luôn nằm trong DOM, kể cả khi tác vụ đang mở không có
                  terminal nào. Trước đây nó bị tháo ra lúc rỗng — mà tháo là
                  chạy cleanup của Pane, tức là giết PTY của *mọi* tác vụ khác:
                  chuyển sang một workspace chưa có tác vụ là Claude chết sạch. */}
              <div className="grid" ref={grid}
                   style={{
                     gridTemplateColumns: zoom ? "minmax(0, 1fr)" : colFr.map((f) => `${f}fr`).join(" "),
                     gridTemplateRows: zoom ? "minmax(0, 1fr)" : rowFr.map((f) => `minmax(0, ${f}fr)`).join(" "),
                     display: shown.length === 0 ? "none" : undefined,
                   }}>
                  {panes.map((p) => {
                    const [cls, statusLabel] = STATUS[p.status];
                    const hidden = p.taskId !== taskId || (zoom !== null && zoom !== p.id);
                    const at = shown.findIndex((x) => x.id === p.id);
                    const col = at % cols;
                    const row = Math.floor(at / cols);
                    return (
                      <section key={p.id}
                               className={"pane" + (focus === p.id ? " focus" : "") + (overPane === p.id ? " over" : "")}
                               // Hidden, not unmounted: unmounting kills the PTY.
                               style={hidden ? { display: "none" } : undefined}
                               onMouseDown={() => setFocus(p.id)}>
                        <header className="ph" draggable
                                onDragStart={(e) => { dragPane.current = p.id; e.dataTransfer.effectAllowed = "move"; }}
                                onDragEnd={() => { dragPane.current = null; setOverPane(null); }}
                                onDragOver={(e) => {
                                  if (!dragPane.current || dragPane.current === p.id) return;
                                  e.preventDefault(); setOverPane(p.id);
                                }}
                                onDragLeave={() => setOverPane((o) => (o === p.id ? null : o))}
                                onDrop={(e) => {
                                  e.preventDefault();
                                  if (dragPane.current) movePane(dragPane.current, p.id);
                                  dragPane.current = null; setOverPane(null);
                                }}>
                          <AgentIcon agent={p.agent} />
                          {naming?.id === p.id ? (
                            <input className="rename" autoFocus value={naming.value}
                                   placeholder={shortPath(p.cwd).split(/[/\\]/).pop()}
                                   onFocus={(e) => e.currentTarget.select()}
                                   onChange={(e) => setNaming({ id: p.id, value: e.target.value })}
                                   onBlur={commitName}
                                   onKeyDown={(e) => {
                                     if (e.key === "Enter") commitName();
                                     if (e.key === "Escape") setNaming(null);
                                   }} />
                          ) : (
                            <span className="nm" title="Double-click to name this terminal"
                                  onDoubleClick={() => setNaming({ id: p.id, value: p.name ?? "" })}>
                              {p.name || shortPath(p.cwd).split(/[/\\]/).pop()}
                            </span>
                          )}
                          {p.runtime !== "host" && (
                            <span className="chip" title={p.runtime}>
                              {runtimes.find((r) => r.id === p.runtime)?.label ?? p.runtime}
                            </span>
                          )}
                          <span className={"chip " + cls}><span className="d" />{p.tool ?? p.message ?? statusLabel}</span>
                          <span className="sp" />
                          {shown.length > 1 && (
                            <>
                              <button className="btn ghost" style={{ padding: "1px 6px" }} title="Move earlier"
                                      disabled={shown[0].id === p.id} onClick={() => movePane(p.id, -1)}>‹</button>
                              <button className="btn ghost" style={{ padding: "1px 6px" }} title="Move later"
                                      disabled={shown[shown.length - 1].id === p.id} onClick={() => movePane(p.id, 1)}>›</button>
                            </>
                          )}
                          {p.todos.length > 0 && (
                            <button className="btn ghost" style={{ padding: "1px 6px" }}
                                    onClick={() => setShowTodos(showTodos === p.id ? null : p.id)}
                                    title="The plan the agent is keeping for itself">
                              ☑ {p.todos.filter((t) => t.status === "completed").length}/{p.todos.length}
                            </button>
                          )}
                          <button className="btn ghost" style={{ padding: "1px 6px" }}
                                  onClick={() => setShowBlocks(showBlocks === p.id ? null : p.id)}
                                  title="Commands run here">⌘ {p.blocks.length}</button>
                          <button className="btn ghost" style={{ padding: "1px 6px" }}
                                  onClick={() => setZoom(zoom === p.id ? null : p.id)}
                                  title={zoom === p.id ? "Back to the grid" : "Zoom this terminal"}>
                            {zoom === p.id ? "⤡" : "⤢"}
                          </button>
                          <button className="btn ghost" style={{ padding: "1px 6px" }}
                                  onClick={() => closePane(p.id)} title="Close terminal">×</button>
                        </header>
                        {showTodos === p.id && (
                          <div className="blocks todos">
                            {p.todos.map((t, i) => (
                              <div className="b" key={i}>
                                <span className="ec" style={{
                                  color: t.status === "completed" ? "var(--ok)"
                                    : t.status === "in_progress" ? "var(--accent)" : "var(--faint)",
                                }}>
                                  {t.status === "completed" ? "✓" : t.status === "in_progress" ? "▸" : "○"}
                                </span>
                                <code style={{ opacity: t.status === "completed" ? 0.55 : 1 }}>
                                  {t.status === "in_progress" ? t.activeForm || t.content : t.content}
                                </code>
                              </div>
                            ))}
                          </div>
                        )}
                        {showBlocks === p.id && (
                          <BlockList blocks={p.blocks} onJump={(b) => {
                            if (b.marker) terms.current[p.id]?.scrollToLine(Math.max(b.marker.line - 2, 0));
                            setShowBlocks(null);
                          }} />
                        )}
                        {!zoom && col < cols - 1 && (
                          <span className="rs x" title="Drag to resize · double-click to even out"
                                onPointerDown={(e) => startResize(e, "x", col)} onDoubleClick={evenSplit} />
                        )}
                        {!zoom && row < rows - 1 && (
                          <span className="rs y" title="Drag to resize · double-click to even out"
                                onPointerDown={(e) => startResize(e, "y", row)} onDoubleClick={evenSplit} />
                        )}
                        <Pane
                          id={p.id} cwd={p.cwd} runtime={p.runtime} focused={focus === p.id} palette={theme.term}
                          onFocus={() => setFocus(p.id)}
                          onCwd={(c) => setPanes((all) => all.map((x) => (x.id === p.id ? { ...x, cwd: c } : x)))}
                          onBlocks={(b: PaneBlock[]) => setPanes((all) => all.map((x) => (x.id === p.id ? { ...x, blocks: b } : x)))}
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
            </>
          </div>

          {view === "workspace" && (
            <WorkspaceView workspace={ws?.path ?? ""} name={ws ? label(ws) : ""} runtime={runtime} tab={wsTab} />
          )}
          {view === "usage" && <UsageView runtime={runtime} />}
          {view === "settings" && (
            <SettingsView current={theme.id} onPick={pickTheme} restore={restore} onRestore={pickRestore}
                          notify={notify} onNotify={pickNotify} />
          )}
        </main>
      </div>

      {importable && (
        <ImportSheet paths={importable} onCancel={() => setImportable(null)} onConfirm={confirmImport} />
      )}

      {newTaskWs && (
        <TaskSheet wsName={label(newTaskWs)} wsPath={newTaskWs.path} runtimes={runtimes} runtime={runtime}
                   branch={git[newTaskWs.path]?.isRepo ? git[newTaskWs.path].branch || "HEAD" : ""}
                   probe={installedBins} onCancel={() => setNewTaskWs(null)}
                   onCreate={(spec) => createTask(newTaskWs, spec)} />
      )}

      {(() => {
        const t = tasks.find((x) => x.id === reviewId);
        // The runtime a task's panes run in — git has to be asked from there,
        // not from the host, or a WSL worktree gets read by Windows git.
        const rt = panes.find((p) => p.taskId === reviewId)?.runtime ?? runtime;
        return t?.wt ? (
          <DiffSheet tree={t.wt} name={t.name} runtime={rt} onClose={() => setReviewId(null)}
                     onMerged={() => endWorktree(t.id)} onDiscarded={() => endWorktree(t.id)} />
        ) : null;
      })()}

      {inbox && (
        <>
          <div className="inbox-scrim" onClick={() => setInbox(false)} />
          <div className="inbox">
            <header>
              <b>Inbox</b>
              <span className="sp" />
              <span>{attention} waiting · {waiting.length - attention} done</span>
            </header>
            {waiting.length === 0 ? (
              <div className="hint">Nothing needs you right now.</div>
            ) : (
              waiting.map((p) => {
                const [cls, statusLabel] = STATUS[p.status];
                const t = tasks.find((x) => x.id === p.taskId);
                return (
                  <button key={p.id} className="inbox-row" onClick={() => jump(p.id)}>
                    <span className={"chip " + cls}><span className="d" />{statusLabel}</span>
                    <span className="n">{t ? `${t.name} · ` : ""}{paneName(p)}</span>
                    <span className="msg">{p.message ?? p.tool ?? shortPath(p.cwd)}</span>
                    <span className="t">{ago(p.since)}</span>
                  </button>
                );
              })
            )}
          </div>
        </>
      )}

      <footer className="status">
        {engine?.account ? (
          <>
            <span><b>{engine.account.email}</b></span>
            <span>{engine.account.plan || "—"}{engine.authSource === "api-key" ? " · API key" : ""}</span>
          </>
        ) : (
          <span>not signed in</span>
        )}
        <span>Claude Code {engine?.version?.split(" ")[0] ?? "?"}</span>
        <span className="sp" />
        <button className={"inbox-btn" + (attention > 0 ? " att" : "")} onClick={() => setInbox((o) => !o)}
                title="Terminals waiting for you, or just finished">
          Inbox{waiting.length > 0 ? ` ${waiting.length}` : ""}
          {attention > 0 && <span className="dot" />}
        </button>
        <span>{tasks.length} tasks · {panes.length} terminals</span>
        {block && (
          <span title={`5-hour window opened at ${new Date(block.startMs).toLocaleTimeString("en-GB")} — see the Usage tab`}>
            5h window <b>{fmtTokens(blockTokens(block))}</b> · {until(block.endMs)} left
          </span>
        )}
        <span>today <b>{fmtTokens(today.output)}</b> output tokens{today.costUsd > 0 ? ` · ${fmtUsd(today.costUsd)}` : ""}</span>
      </footer>
    </div>
  );
}
