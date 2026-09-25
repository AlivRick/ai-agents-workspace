import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Marked } from "marked";
import { api, shortPath, type Entry, type ScmItem, type ScmStatus } from "./api";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import CodeEditor from "./CodeEditor";
import { parseDiff, sideBySide, type Row } from "./diff";
import { allFiles, buildTree, type Folder } from "./scmtree";
import { fileIcon, folderIcon, type IconTable } from "./icons";
import iconTable from "./icons.gen.json";

/** A file on screen. `rel` is set when git knows it changed — that is what
 *  makes the Diff tab available. */
type Open = { abs: string; rel?: string; staged?: boolean; status?: string };
type Mode = "edit" | "diff" | "preview";
type Group = "merge" | "staged" | "changes";
const STATUS_NAME: Record<string, string> = {
  M: "Modified", A: "Added", D: "Deleted", R: "Renamed", C: "Copied", U: "Untracked", T: "Type changed", "!": "Conflict",
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Raw HTML inside a README is shown as text, never rendered: the page has
 *  `invoke`, so a `<img onerror>` in some repo's markdown would be code running
 *  with the app's rights. */
const md = new Marked({ renderer: { html: ({ text }) => esc(text) } });
/** One half of a side-by-side row. `changed` is false for context lines, which
 *  are the same object on both sides. */
const cell = (r: Row | null, side: "old" | "new", changed: boolean) => (
  <>
    <span className="ln">{r ? (side === "old" ? r.old : r.new) : ""}</span>
    <span className={"tx" + (!r ? " none" : changed ? (side === "old" ? " del" : " add") : "")}>{r?.text ?? ""}</span>
  </>
);
const T = iconTable as IconTable;
/** A Material Icon Theme icon, the set VS Code users know. */
const Ico = ({ k }: { k: string }) => <img className="fi" src={`/material/${k}.svg`} alt="" draggable={false} />;
const isMd = (p: string) => /\.(md|markdown|mdx)$/i.test(p);
const base = (p: string) => p.split(/[\\/]/).pop() ?? p;

/**
 * Explorer + Source Control, the part of VS Code you open to look at what an
 * agent did: browse the tree, edit a file, read a README rendered, stage and
 * commit.
 *
 * The editor itself is CodeMirror 6 (see CodeEditor.tsx).
 */
export default function FilesView({ root, name, runtime, terminals, docked, onDock }: {
  root: string; name: string; runtime: string;
  /** Terminals of the open task, which App docks on the right of this view. */
  terminals: number; docked: boolean; onDock: () => void;
}) {
  const [kids, setKids] = useState<Record<string, Entry[]>>({});
  const [scm, setScm] = useState<ScmStatus | null>(null);
  const [open, setOpen] = useState<Open | null>(null);
  const [mode, setMode] = useState<Mode>("edit");
  const [text, setText] = useState("");
  const [saved, setSaved] = useState("");
  const [readErr, setReadErr] = useState("");
  /** HEAD's copy of the open file, for the editor's change bars. */
  const [orig, setOrig] = useState<string | null | undefined>(undefined);
  const [diff, setDiff] = useState("");
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  /** Clicking away from unsaved edits asks once — a second click on the same
   *  file means "discard them". */
  const [pending, setPending] = useState("");
  const [tick, setTick] = useState(0);
  /** Source Control as a folder tree or a flat list, like VS Code's toggle. */
  const [asTree, setAsTree] = useState(() => { try { return localStorage.getItem("scmTree") === "1"; } catch { return false; } });
  /** Collapsed groups and folders. */
  const [shut, setShut] = useState<Set<string>>(new Set());
  /** Old | new columns, or git's single column. Remembered across launches. */
  const [split, setSplit] = useState(() => { try { return localStorage.getItem("diffSplit") !== "0"; } catch { return true; } });
  const pickSplit = (v: boolean) => { setSplit(v); try { localStorage.setItem("diffSplit", v ? "1" : "0"); } catch { /* private mode */ } };
  const dirty = text !== saved;

  useEffect(() => {
    setKids({});
    setOpen(null);
    if (root) api.fsList(root, root).then((e) => setKids({ [root]: e })).catch((e) => setError(String(e)));
  }, [root]);

  // VS Code watches files and re-runs `git status` on change. A Windows app
  // reading a distro over \\wsl.localhost gets no reliable change events, so
  // this polls instead: every 2s while the Explorer is on screen, never two
  // rounds at once, and only touching state that actually changed.
  // ponytail: the ceiling is ~3 short git processes per 2s; the upgrade path is
  // an inotify watcher run inside the distro, the way VS Code's WSL server does.
  const live = useRef({ dirty, open, saved, kids });
  live.current = { dirty, open, saved, kids };
  useEffect(() => {
    if (!root) return;
    let stop = false;
    let timer = 0;
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const round = async () => {
      if (!document.hidden) {
        try {
          const s = await api.scmStatus(root, runtime);
          if (stop) return;
          setScm((p) => (same(p, s) ? p : s));
          const o = live.current.open;
          if (o?.rel && o.status !== "U") {
            const d = await api.scmDiff(root, o.rel, !!o.staged, runtime).catch((e) => String(e));
            if (!stop && live.current.open === o) setDiff(d);
          }
          // An agent rewrote the file you are looking at: show its version,
          // unless you have edits of your own in the box.
          if (o?.abs && o.status !== "D" && !live.current.dirty) {
            const t = await api.fsRead(root, o.abs).catch(() => null);
            const c = live.current;
            if (!stop && t !== null && c.open === o && !c.dirty && t !== c.saved) { setText(t); setSaved(t); }
          }
          for (const dir of Object.keys(live.current.kids)) {
            const e = await api.fsList(root, dir).catch(() => null);
            if (!stop && e) setKids((k) => (k[dir] && !same(k[dir], e) ? { ...k, [dir]: e } : k));
          }
        } catch { /* the next round will try again */ }
      }
      if (!stop) timer = window.setTimeout(round, 2000);
    };
    timer = window.setTimeout(round, 2000);
    return () => { stop = true; clearTimeout(timer); };
  }, [root, runtime]);

  useEffect(() => {
    if (!root) return;
    let live = true;
    api.scmStatus(root, runtime).then((s) => live && setScm(s)).catch((e) => live && setError(String(e)));
    return () => { live = false; };
  }, [root, runtime, tick]);
  useEffect(() => {
    const f = () => setTick((n) => n + 1);
    window.addEventListener("focus", f);
    return () => window.removeEventListener("focus", f);
  }, []);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setText(""); setSaved(""); setReadErr("");
    if (open.abs && open.status !== "D") {
      api.fsRead(root, open.abs)
        .then((t) => live && (setText(t), setSaved(t)))
        .catch((e) => live && setReadErr(String(e)));
    }
    return () => { live = false; };
  }, [open, root]);

  useEffect(() => {
    if (!open?.rel || open.status === "U") return setDiff("");
    let live = true;
    api.scmDiff(root, open.rel, !!open.staged, runtime).then((d) => live && setDiff(d)).catch((e) => live && setDiff(String(e)));
    return () => { live = false; };
  }, [open, root, runtime, tick]);

  // Re-read when git status moves (a commit changes HEAD, so the bars reset).
  useEffect(() => {
    setOrig(undefined);
    if (!open?.abs || !scm?.isRepo) return;
    const i = [...scm.changes, ...scm.staged].find((c) => c.abs === open.abs);
    // Untracked or newly added: HEAD has nothing, every line is new.
    if (i && (i.status === "U" || i.status === "A")) return setOrig(null);
    if (!i) return; // unchanged since HEAD (or ignored): no bars to draw
    let live = true;
    api.scmOriginal(root, i.path, runtime).then((o) => live && setOrig(o ?? undefined)).catch(() => {});
    return () => { live = false; };
  }, [open, scm, root, runtime]);

  /** Status letter per on-disk path, so the tree can mark changed files. */
  const marks = useMemo(() => {
    const m: Record<string, string> = {};
    for (const i of [...(scm?.staged ?? []), ...(scm?.changes ?? []), ...(scm?.merge ?? [])]) if (i.abs) m[i.abs] = i.status;
    return m;
  }, [scm]);

  const go = (o: Open, m: Mode) => {
    const key = `${o.abs}|${o.rel}|${o.staged}`;
    if (dirty && pending !== key) {
      setPending(key);
      setError(`Unsaved changes in ${base(open!.abs)} — Ctrl+S to save, or click again to discard them.`);
      return;
    }
    setPending(""); setError("");
    setOpen(o);
    setMode(m);
  };
  const fromScm = (i: ScmItem, staged: boolean) =>
    go({ abs: i.abs, rel: i.path, staged, status: i.status },
       // A conflict opens as text: the <<<<<<< markers are what you edit.
       i.status === "U" || i.status === "!" ? (isMd(i.path) && i.status === "U" ? "preview" : "edit") : "diff");
  const openFile = (i: ScmItem, staged: boolean) =>
    go({ abs: i.abs, rel: i.path, staged, status: i.status }, isMd(i.path) ? "preview" : "edit");
  const fromTree = (e: Entry) => {
    const i = scm?.changes.find((c) => c.abs === e.path) ?? scm?.staged.find((c) => c.abs === e.path);
    go({ abs: e.path, rel: i?.path, staged: !!i && !scm?.changes.includes(i), status: i?.status },
       isMd(e.path) ? "preview" : "edit");
  };

  const toggle = (dir: string) => {
    if (kids[dir]) return setKids(({ [dir]: _drop, ...rest }) => rest);
    api.fsList(root, dir).then((e) => setKids((k) => ({ ...k, [dir]: e }))).catch((e) => setError(String(e)));
  };

  const run = useCallback(async (f: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try { await f(); setTick((n) => n + 1); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }, []);
  const save = () => open && dirty && run(async () => { await api.fsWrite(root, open.abs, text); setSaved(text); });
  const stage = (files: ScmItem[], on: boolean) =>
    files.length && run(() => api.scmStage(root, files.map((f) => f.path), on, runtime));
  /** Irreversible, so it asks — the one native dialog in this view, the same
   *  wording VS Code uses. */
  const discard = async (files: ScmItem[]) => {
    if (!files.length) return;
    const what = files.length === 1 ? `the changes in ${base(files[0].path)}` : `${files.length} files`;
    const ok = await confirmDialog(`Discard ${what}?\n\nThis is IRREVERSIBLE — the working-tree changes are lost, and new (untracked) files are deleted.`,
      { title: "Discard changes", kind: "warning", okLabel: "Discard", cancelLabel: "Cancel" });
    if (!ok) return;
    const untracked = files.filter((f) => f.status === "U").map((f) => f.path);
    const tracked = files.filter((f) => f.status !== "U").map((f) => f.path);
    run(() => api.scmDiscard(root, tracked, untracked, runtime));
  };
  const sync = (op: "push" | "publish" | "pull" | "fetch") => run(() => api.scmSync(root, op, runtime));
  const nothingStaged = !scm?.staged.length;
  const canCommit = !!scm && !!msg.trim() && !scm.merge.length && (scm.staged.length > 0 || scm.changes.length > 0);
  /** Nothing staged means "commit everything", VS Code's smart commit. */
  const commit = () => canCommit && run(async () => { await api.scmCommit(root, msg, nothingStaged, runtime); setMsg(""); });



  const tree = (dir: string, depth: number): React.ReactNode =>
    kids[dir]?.map((e) => (
      <div key={e.path}>
        <button className={"frow" + (open?.abs === e.path ? " on" : "")} style={{ paddingLeft: 7 + depth * 12 }}
                onClick={() => (e.dir ? toggle(e.path) : fromTree(e))} title={e.path}>
          <span className="tw">{e.dir ? (kids[e.path] ? "▾" : "▸") : ""}</span>
          <Ico k={e.dir ? folderIcon(T, e.name, !!kids[e.path]) : fileIcon(T, e.name)} />
          <span className={"t" + (marks[e.path] ? " s" + marks[e.path] : "")}>{e.name}</span>
          {marks[e.path] && <span className={"st s" + marks[e.path]}>{marks[e.path]}</span>}
        </button>
        {e.dir && kids[e.path] && tree(e.path, depth + 1)}
      </div>
    ));

  const fold = (key: string) => setShut((c) => { const n = new Set(c); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const pickTree = (v: boolean) => { setAsTree(v); try { localStorage.setItem("scmTree", v ? "1" : "0"); } catch { /* ok */ } };

  /** The hover buttons VS Code puts on a row, for one file or a whole folder. */
  const acts = (items: ScmItem[], kind: Group, one?: ScmItem) => (
    <span className="acts" onClick={(e) => e.stopPropagation()}>
      {one?.abs && one.status !== "D" && (
        <button className="mini" title="Open File" onClick={() => openFile(one, kind === "staged")}>↗</button>
      )}
      {kind === "changes" && (
        <button className="mini" disabled={busy} title={one ? "Discard Changes" : "Discard All Changes"}
                onClick={() => void discard(items)}>↶</button>
      )}
      {kind === "staged" ? (
        <button className="mini" disabled={busy} title={one ? "Unstage Changes" : "Unstage All Changes"}
                onClick={() => stage(items, false)}>−</button>
      ) : (
        <button className="mini" disabled={busy} title={kind === "merge" ? "Stage (mark resolved)" : one ? "Stage Changes" : "Stage All Changes"}
                onClick={() => stage(items, true)}>+</button>
      )}
    </span>
  );

  const fileRow = (i: ScmItem, kind: Group, depth: number) => {
    const slash = i.path.lastIndexOf("/");
    const on = open?.rel === i.path && !!open.staged === (kind === "staged");
    return (
      <div key={kind + i.path} className={"scm-row" + (on ? " on" : "")} style={{ paddingLeft: 7 + depth * 12 }}
           title={`${i.path} · ${STATUS_NAME[i.status] ?? i.status}`}
           onClick={() => fromScm(i, kind === "staged")}>
        <Ico k={fileIcon(T, i.path.slice(slash + 1))} />
        <span className={"t s" + i.status + (i.status === "D" ? " gone" : "")}>{i.path.slice(slash + 1)}</span>
        {!asTree && slash > 0 && <span className="dir">{i.path.slice(0, slash)}</span>}
        <span className="sp" />
        {acts([i], kind, i)}
        <span className={"st s" + i.status}>{i.status}</span>
      </div>
    );
  };

  const folderRows = (f: Folder<ScmItem>, kind: Group, depth: number): React.ReactNode[] => [
    ...f.dirs.flatMap((d) => {
      const key = `${kind}:${d.path}`;
      return [
        <div key={key} className="scm-row folder" style={{ paddingLeft: 7 + depth * 12 }} onClick={() => fold(key)}>
          <span className="tw">{shut.has(key) ? "▸" : "▾"}</span>
          <Ico k={folderIcon(T, d.name.split("/").pop() ?? d.name, !shut.has(key))} />
          <span className="t">{d.name}</span>
          <span className="sp" />
          {acts(allFiles(d), kind)}
        </div>,
        ...(shut.has(key) ? [] : folderRows(d, kind, depth + 1)),
      ];
    }),
    ...f.files.map((i) => fileRow(i, kind, depth)),
  ];

  const group = (title: string, items: ScmItem[], kind: Group) => {
    if (!items.length && kind !== "changes") return null;
    const key = "group:" + kind;
    return (
      <>
        <div className="sec click" onClick={() => fold(key)}>
          <span className="tw">{shut.has(key) ? "▸" : "▾"}</span>
          <span>{title}</span><b>{items.length}</b><span className="sp" />
          {items.length > 0 && acts(items, kind)}
        </div>
        {!shut.has(key) && (asTree ? folderRows(buildTree(items), kind, 1) : items.map((i) => fileRow(i, kind, 1)))}
      </>
    );
  };

  if (!root) return <div className="view" style={{ display: "flex" }}><div className="hint">Pick a workspace in the sidebar first.</div></div>;

  const rows = mode === "diff" ? parseDiff(diff) : [];
  const canEdit = !!open?.abs && open.status !== "D" && !readErr;

  return (
    <div className="view" style={{ display: "flex" }}>
      <div className="toolbar">
        <span className="title">{name}</span>
        <span className="path">{shortPath(root)}</span>
        {scm?.branch && <span className="branch">{scm.branch}</span>}
        <span className="sp" />
        <button className="btn ghost" onClick={() => setTick((n) => n + 1)} title="Re-read git status">⟳ Refresh</button>
        {terminals > 0 && (
          <button className={"btn ghost" + (docked ? " on" : "")} onClick={onDock}
                  title={docked ? "Ẩn terminal bên phải" : "Hiện terminal của tác vụ bên phải"}>
            {docked ? "Ẩn terminal" : `Terminal (${terminals})`}
          </button>
        )}
      </div>

      <div className="review explorer">
        <div className="files">
          {scm?.isRepo && (
            <>
              <div className="sec">
                <span>Source Control</span><span className="sp" />
                <button className="mini" title={asTree ? "View as List" : "View as Tree"} onClick={() => pickTree(!asTree)}>
                  {asTree ? "☰" : "🌲"}
                </button>
                <button className="mini" disabled={busy} title="Pull (fetch + fast-forward)" onClick={() => sync("pull")}>↓</button>
                <button className="mini" disabled={busy} title={scm.upstream ? "Push" : "Publish Branch"}
                        onClick={() => sync(scm.upstream ? "push" : "publish")}>↑</button>
                <button className="mini" disabled={busy} title="Fetch" onClick={() => sync("fetch")}>⟳</button>
              </div>
              <div className="commit">
                <textarea placeholder={`Message (Ctrl+Enter to commit on "${scm.branch}")`} value={msg} rows={2}
                          onChange={(e) => setMsg(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); } }} />
                <button className="btn primary" disabled={busy || !canCommit} onClick={commit}
                        title={scm.merge.length ? "Resolve the merge conflicts first" : nothingStaged ? "Nothing staged: stage every change and commit it" : ""}>
                  ✓ {nothingStaged && scm.changes.length ? "Commit All" : "Commit"}
                </button>
                {/* VS Code's Sync button: only there when there is something to sync. */}
                {(scm.ahead > 0 || scm.behind > 0 || !scm.upstream) && (
                  <button className="btn ghost" disabled={busy}
                          onClick={() => (!scm.upstream ? sync("publish") : scm.behind > 0 ? sync("pull") : sync("push"))}>
                    {!scm.upstream ? "↑ Publish Branch"
                      : scm.behind > 0 ? `↓ Pull ${scm.behind}${scm.ahead ? ` · ↑ ${scm.ahead}` : ""}`
                      : `↑ Push ${scm.ahead} commit${scm.ahead === 1 ? "" : "s"}`}
                  </button>
                )}
              </div>
              {group("Merge Changes", scm.merge, "merge")}
              {group("Staged Changes", scm.staged, "staged")}
              {group("Changes", scm.changes, "changes")}
            </>
          )}
          <div className="sec"><span>Explorer</span></div>
          {tree(root, 0)}
        </div>

        <div className="pane-ed">
          {!open && <div className="hint">Open a file from the tree, or a change to review its diff.</div>}
          {open && (
            <>
              <div className="ed-head">
                <Ico k={fileIcon(T, base(open.abs || open.rel || ""))} />
                <b title={open.abs || open.rel}>{base(open.abs || open.rel || "")}{dirty ? " ●" : ""}</b>
                {open.rel && <span className="path">{open.staged ? "staged" : "working tree"}</span>}
                <span className="sp" />
                {mode === "diff" && (
                  <div className="seg" title="How to lay the diff out">
                    <button className={split ? "on" : ""} onClick={() => pickSplit(true)}>Old | New</button>
                    <button className={!split ? "on" : ""} onClick={() => pickSplit(false)}>Inline</button>
                  </div>
                )}
                <div className="seg">
                  {open.rel && open.status !== "U" && <button className={mode === "diff" ? "on" : ""} onClick={() => setMode("diff")}>Diff</button>}
                  {canEdit && <button className={mode === "edit" ? "on" : ""} onClick={() => setMode("edit")}>Edit</button>}
                  {canEdit && isMd(open.abs) && <button className={mode === "preview" ? "on" : ""} onClick={() => setMode("preview")}>Preview</button>}
                </div>
                {canEdit && (
                  <button className="btn primary" disabled={!dirty || busy} onClick={save}>{dirty ? "Save" : "Saved"}</button>
                )}
              </div>
              {mode === "diff" && rows.length === 0 && <div className="hint">{diff || "No diff."}</div>}
              {/* No hunk at all means git printed an error, not a diff — show it. */}
              {mode === "diff" && rows.length > 0 && split && !rows.some((r) => r.kind === "hunk") && <div className="hint">{diff}</div>}
              {mode === "diff" && rows.some((r) => r.kind === "hunk") && split && (
                <div className="diff sbs">
                  <div className="sl head"><span>Old{open.staged ? " (HEAD)" : open.rel && " (staged / HEAD)"}</span><span>New{open.staged ? " (staged)" : " (working tree)"}</span></div>
                  {sideBySide(rows).map((p, i) =>
                    "hunk" in p ? (
                      <div key={i} className="dl hunk"><span className="tx">{p.hunk}</span></div>
                    ) : (
                      <div key={i} className="sl">
                        {cell(p.l, "old", p.l !== p.r)}
                        {cell(p.r, "new", p.l !== p.r)}
                      </div>
                    ))}
                </div>
              )}
              {mode === "diff" && rows.length > 0 && !split && (
                <div className="diff">
                  {rows.map((r, i) => (
                    <div key={i} className={"dl " + r.kind}>
                      <span className="ln">{r.old ?? ""}</span>
                      <span className="ln">{r.new ?? ""}</span>
                      <span className="tx">{r.kind === "add" ? "+" : r.kind === "del" ? "-" : " "}{r.text}</span>
                    </div>
                  ))}
                </div>
              )}
              {mode !== "diff" && readErr && <div className="hint">{readErr}</div>}
              {mode === "edit" && canEdit && (
                <CodeEditor key={open.abs} file={open.abs} value={text} original={orig} onChange={setText} onSave={save} />
              )}
              {/* Links would navigate the whole app away from itself. */}
              {mode === "preview" && canEdit && (
                <div className="md" onClick={(e) => (e.target as HTMLElement).closest("a") && e.preventDefault()}
                     dangerouslySetInnerHTML={{ __html: md.parse(text, { async: false }) as string }} />
              )}
            </>
          )}
        </div>
      </div>
      {error && <div className="banner err"><span>{error}</span><span className="sp" style={{ flex: 1 }} /><button className="btn" onClick={() => setError("")}>Dismiss</button></div>}
    </div>
  );
}
