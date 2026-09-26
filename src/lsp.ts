import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LSPClient, LSPPlugin, Workspace, languageServerExtensions, languageServerSupport, type Transport, type WorkspaceFile } from "@codemirror/lsp-client";
import type { ChangeSet, Extension, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { uriMap } from "./lspuri.ts";

/** File extension → [server (see lsp.rs), LSP language id]. */
const LANGS: Record<string, [string, string]> = {
  ts: ["typescript", "typescript"], mts: ["typescript", "typescript"], cts: ["typescript", "typescript"],
  tsx: ["typescript", "typescriptreact"], js: ["typescript", "javascript"], mjs: ["typescript", "javascript"],
  cjs: ["typescript", "javascript"], jsx: ["typescript", "javascriptreact"],
  rs: ["rust", "rust"], py: ["python", "python"], go: ["go", "go"],
  css: ["css", "css"], scss: ["css", "scss"], less: ["css", "less"], json: ["json", "json"], html: ["html", "html"],
};
/** What to install when a server is missing, shown to the user. */
export const INSTALL: Record<string, string> = {
  typescript: "npm i -g typescript-language-server typescript",
  rust: "rustup component add rust-analyzer",
  python: "npm i -g pyright",
  go: "go install golang.org/x/tools/gopls@latest",
  css: "npm i -g vscode-langservers-extracted",
  json: "npm i -g vscode-langservers-extracted",
  html: "npm i -g vscode-langservers-extracted",
};
export const langOf = (file: string) => LANGS[file.split(".").pop()?.toLowerCase() ?? ""] ?? null;

// ------------------------------------------------------------------ transport
const handlers = new Map<number, (msg: string | null) => void>();
void listen<{ id: number; msg: string | null }>("lsp", (e) => handlers.get(e.payload.id)?.(e.payload.msg));

/** The files open in editors, one view each (the Explorer shows one at a time). */
class Space extends Workspace {
  files: (WorkspaceFile & { view: EditorView })[] = [];
  private versions: Record<string, number> = {};
  /** displayFile() waits here for the tab it asked for to mount its editor. */
  waiting = new Map<string, (v: EditorView) => void>();
  constructor(client: LSPClient, private show: (uri: string) => boolean) { super(client); }
  private next(uri: string) { return (this.versions[uri] = (this.versions[uri] ?? -1) + 1); }
  syncFiles() {
    const out: { file: WorkspaceFile; prevDoc: Text; changes: ChangeSet }[] = [];
    for (const file of this.files) {
      const p = LSPPlugin.get(file.view);
      if (!p || p.unsyncedChanges.empty) continue;
      out.push({ changes: p.unsyncedChanges, file, prevDoc: file.doc });
      file.doc = file.view.state.doc;
      file.version = this.next(file.uri);
      p.clear();
    }
    return out;
  }
  openFile(uri: string, languageId: string, view: EditorView) {
    const old = this.getFile(uri) as (WorkspaceFile & { view: EditorView }) | null;
    if (old) { old.view = view; old.doc = view.state.doc; }
    else {
      const f = { uri, languageId, version: this.next(uri), doc: view.state.doc, view, getView() { return this.view; } };
      this.files.push(f);
      this.client.didOpen(f);
    }
    this.waiting.get(uri)?.(view);
    this.waiting.delete(uri);
  }
  closeFile(uri: string, view: EditorView) {
    const f = this.files.find((x) => x.uri === uri);
    if (!f || f.view !== view) return; // a newer editor took the file over
    this.files = this.files.filter((x) => x !== f);
    this.client.didClose(uri);
  }
  displayFile(uri: string): Promise<EditorView | null> {
    const f = this.files.find((x) => x.uri === uri);
    if (!this.show(uri)) return Promise.resolve(null);
    if (f && f.view.dom.isConnected) return Promise.resolve(f.view);
    return new Promise((res) => {
      this.waiting.set(uri, res);
      setTimeout(() => { if (this.waiting.delete(uri)) res(null); }, 5000);
    });
  }
}

type Conn = { client: LSPClient; map: ReturnType<typeof uriMap>; failed: Promise<string> };
const conns = new Map<string, Promise<Conn | string>>();
/** Server process ids by the same key, for stopping them. */
const ids = new Map<string, number>();
/** Where Go to Definition sends a file it has to open. Set by the Explorer. */
let opener: (abs: string) => void = () => {};
export const setOpener = (f: (abs: string) => void) => { opener = f; };

/**
 * One server per (workspace, server kind), started the first time a file of
 * that kind opens and kept for the session.
 * ponytail: never stopped until the app quits (or `stopAll` on a workspace
 * switch); the upgrade path is an idle timeout per server.
 */
function connect(root: string, runtime: string, server: string): Promise<Conn | string> {
  const key = `${runtime}|${root}|${server}`;
  let c = conns.get(key);
  if (!c) {
    c = (async () => {
      const [id, seen] = await invoke<[number, string]>("lsp_start", { root, server, runtime });
      const map = uriMap(root, seen);
      const subs = new Set<(v: string) => void>();
      let died: (why: string) => void = () => {};
      const failed = new Promise<string>((r) => { died = r; });
      handlers.set(id, (m) => {
        if (m === null) { handlers.delete(id); conns.delete(key); ids.delete(key); died(`The ${server} language server stopped. Install it with: ${INSTALL[server]}`); return; }
        subs.forEach((h) => h(m));
      });
      const transport: Transport = {
        send: (m) => void invoke("lsp_send", { id, msg: m }).catch(() => {}),
        subscribe: (h) => subs.add(h),
        unsubscribe: (h) => subs.delete(h),
      };
      const client = new LSPClient({
        rootUri: map.base,
        extensions: languageServerExtensions(),
        timeout: 15000,
        workspace: (cl) => new Space(cl, (uri) => { const p = map.toPath(uri); if (p) opener(p); return !!p; }),
      }).connect(transport);
      ids.set(key, id);
      return { client, map, failed };
    })().catch((e) => { conns.delete(key); return String(e); });
    conns.set(key, c);
  }
  return c;
}

/** Stop every server of workspaces other than `root`. */
export function stopOthers(root: string) {
  for (const [k, id] of [...ids]) {
    if (k.includes(`|${root}|`)) continue;
    void invoke("lsp_stop", { id });
    ids.delete(k);
    conns.delete(k);
  }
}

/**
 * The editor extension for `abs`: completion, hover, diagnostics, F12, F2,
 * Shift+F12, Shift+Alt+F. Null when the language has no server; a string when
 * the server could not start (what to install).
 */
export async function lspFor(root: string, runtime: string, abs: string, onFail: (why: string) => void): Promise<Extension | null> {
  const l = langOf(abs);
  if (!l || !root) return null;
  const c = await connect(root, runtime, l[0]);
  if (typeof c === "string") { onFail(`${c} — install the ${l[0]} language server: ${INSTALL[l[0]]}`); return null; }
  void c.failed.then(onFail);
  return languageServerSupport(c.client, c.map.toUri(abs), l[1]);
}
