import { invoke } from "@tauri-apps/api/core";

export type Account = {
  email: string; displayName: string; fullName: string; organization: string;
  organizationRole: string; plan: string; seatTier: string; billingType: string;
  rateLimitTier: string; hasExtraUsage: boolean;
};
export type EngineStatus = {
  installed: boolean; path: string | null; version: string | null;
  versionOk: boolean; minVersion: string; signedIn: boolean;
  authSource: "subscription" | "api-key" | "none";
  account: Account | null; problem: string | null;
};
export type Workspace = { id: string; path: string; name: string; addedAtMs: number; favorite: boolean };
export type GitInfo = { path: string; isRepo: boolean; branch: string; dirty: number };
export type ModelUsage = { model: string; input: number; output: number; cacheRead: number; cacheCreate: number; costUsd: number };
export type Session = {
  id: string; file: string; cwd: string; title: string; lastPrompt: string;
  gitBranch: string; cliVersion: string; messages: number; startedAtMs: number;
  updatedAtMs: number; sizeBytes: number; costUsd: number; hasCost: boolean;
  input: number; output: number; cacheRead: number; cacheCreate: number;
  linesAdded: number; linesRemoved: number; durationMs: number; models: ModelUsage[];
};
export type Bucket = {
  costUsd: number; costSessions: number; sessions: number; messages: number; input: number; output: number;
  cacheRead: number; cacheCreate: number; linesAdded: number; linesRemoved: number; durationMs: number;
};
export type Named = Bucket & { key: string };
export type UsageReport = { range: string; total: Bucket; byDay: Named[]; byWorkspace: Named[]; byModel: Named[] };
export type HookEvent = {
  paneId?: string; hook_event_name?: string; session_id?: string; cwd?: string;
  tool_name?: string; message?: string; prompt?: string; source?: string;
};

export type Doc = { path: string; scope: string; note: string; exists: boolean; bytes: number; updatedAtMs: number };
export type SkillInfo = {
  name: string; description: string; allowedTools: string; path: string; dir: string;
  scope: string; extraFiles: number; bytes: number; updatedAtMs: number;
};
export type MemoryInfo = {
  name: string; description: string; kind: string; path: string;
  isIndex: boolean; bytes: number; updatedAtMs: number;
};

export type Runtime = { id: string; label: string; kind: string; distro: string; shell: string };

export const api = {
  engineStatus: (runtime?: string) => invoke<EngineStatus>("engine_status", { runtime }),
  listRuntimes: () => invoke<Runtime[]>("list_runtimes"),
  defaultRuntime: () => invoke<string>("default_runtime"),
  setRuntime: (runtime: string) => invoke<void>("set_runtime", { runtime }),
  claudeCommand: (extra?: string, runtime?: string) => invoke<string>("claude_command", { extra, runtime }),
  listWorkspaces: () => invoke<Workspace[]>("list_workspaces"),
  addWorkspace: (path: string) => invoke<Workspace[]>("add_workspace", { path }),
  addWorkspaces: (paths: string[]) => invoke<Workspace[]>("add_workspaces", { paths }),
  claudeProjects: (runtime?: string) => invoke<string[]>("claude_projects", { runtime }),
  removeWorkspace: (id: string) => invoke<Workspace[]>("remove_workspace", { id }),
  updateWorkspace: (id: string, patch: { name?: string; favorite?: boolean }) =>
    invoke<Workspace[]>("update_workspace", { id, ...patch }),
  gitInfo: (paths: string[]) => invoke<GitInfo[]>("git_info", { paths }),
  saveLayout: (layout: unknown) => invoke<void>("save_layout", { layout }),
  loadLayout: () => invoke<any>("load_layout"),
  scanSessions: (runtime?: string) => invoke<Session[]>("scan_sessions", { runtime }),
  deleteSessions: (files: string[], runtime?: string) => invoke<number>("delete_sessions", { files, runtime }),
  renameSession: (file: string, title: string, runtime?: string) =>
    invoke<Session[]>("rename_session", { file, title, runtime }),
  claudeDocs: (workspace: string, runtime?: string) => invoke<Doc[]>("claude_docs", { workspace, runtime }),
  listSkills: (workspace: string, runtime?: string) => invoke<SkillInfo[]>("list_skills", { workspace, runtime }),
  listMemories: (workspace: string, runtime?: string) => invoke<MemoryInfo[]>("list_memories", { workspace, runtime }),
  readDoc: (path: string, workspace: string, runtime?: string) => invoke<string>("read_doc", { path, workspace, runtime }),
  writeDoc: (path: string, workspace: string, content: string, runtime?: string) =>
    invoke<void>("write_doc", { path, workspace, content, runtime }),
  deleteDoc: (path: string, workspace: string, withDir: boolean, runtime?: string) =>
    invoke<void>("delete_doc", { path, workspace, withDir, runtime }),
  getTheme: () => invoke<string>("get_theme"),
  setTheme: (theme: string) => invoke<void>("set_theme", { theme }),
  usageReport: (range: string, runtime?: string) =>
    invoke<UsageReport>("usage_report", { range, tzOffsetMin: new Date().getTimezoneOffset(), runtime }),
  ptyOpen: (id: string, cwd: string, cols: number, rows: number, runtime = "host", shellIntegration = true) =>
    invoke<void>("pty_open", { id, cwd, cols, rows, shellIntegration, runtime }),
  ptyWrite: (id: string, data: string) => invoke<void>("pty_write", { id, data }),
  ptyResize: (id: string, cols: number, rows: number) => invoke<void>("pty_resize", { id, cols, rows }),
  ptyClose: (id: string) => invoke<void>("pty_close", { id }),
  hookEvents: () => invoke<HookEvent[]>("hook_events"),
};

export const fmtUsd = (n: number) => (n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);
export const fmtBytes = (n: number) =>
  n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;
export const fmtInt = (n: number) => new Intl.NumberFormat("vi-VN").format(Math.round(n));
export const fmtTokens = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
export const fmtDur = (msIn: number) => {
  const s = Math.round(msIn / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}`;
};
export const ago = (ms: number) => {
  const d = Date.now() - ms;
  if (d < 60_000) return "vừa xong";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} phút`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} giờ`;
  const days = Math.floor(d / 86_400_000);
  return days < 30 ? `${days} ngày` : `${Math.floor(days / 30)} tháng`;
};
export const shortPath = (p: string) =>
  normPath(p).replace(/^\/home\/[^/]+/, "~").replace(/^\/Users\/[^/]+/, "~");

/**
 * The same folder, spelled the same way, whichever side named it.
 *
 * A workspace added on Windows is stored as
 * `\\?\UNC\wsl.localhost\Ubuntu\home\thuan\hutech`, while the sessions inside it
 * were written by Linux Claude Code as `/home/thuan/hutech`. Comparing those
 * raw is why "Workspace này" listed nothing. Mirrors `util::norm_path` in Rust.
 */
export function normPath(p: string): string {
  let s = p.replace(/\\/g, "/");
  if (s.startsWith("//?/UNC/")) s = "//" + s.slice(8);
  else if (s.startsWith("//?/")) s = s.slice(4);
  const wsl = /^\/\/(?:wsl\.localhost|wsl\$)\/[^/]+(\/.*)?$/.exec(s);
  if (wsl) s = wsl[1] ?? "/";
  else {
    const drive = /^([A-Za-z]):(\/.*)?$/.exec(s);
    if (drive) s = `/mnt/${drive[1].toLowerCase()}${drive[2] ?? "/"}`;
  }
  s = s.replace(/\/+$/, "");
  return s === "" ? "/" : s;
}
