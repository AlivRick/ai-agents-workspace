import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Marked } from "marked";
import { api, shortPath, type Entry, type ScmItem, type ScmStatus } from "./api";
import { parseDiff, sideBySide, type Row } from "./diff";

/** A file on screen. `rel` is set when git knows it changed — that is what
 *  makes the Diff tab available. */
type Open = { abs: string; rel?: string; staged?: boolean; status?: string };
type Mode = "edit" | "diff" | "preview";

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
const isMd = (p: string) => /\.(md|markdown|mdx)$/i.test(p);
const base = (p: string) => p.split(/[\\/]/).pop() ?? p;

/**
 * Explorer + Source Control, the part of VS Code you open to look at what an
 * agent did: browse the tree, edit a file, read a README rendered, stage and
 * commit.
 *
 * ponytail: a textarea, not a code editor — no syntax colours, no line
 * numbers, no find. The upgrade path is CodeMirror 6 in place of the textarea;
 * everything around it (open/save/diff) stays.
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
  const [diff, setDiff] = useState("");
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  /** Clicking away from unsaved edits asks once — a second click on the same
   *  file means "discard them". */
  const [pending, setPending] = useState("");
  const [tick, setTick] = useState(0);
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

  /** Status letter per on-disk path, so the tree can mark changed files. */
  const marks = useMemo(() => {
    const m: Record<string, string> = {};
    for (const i of [...(scm?.staged ?? []), ...(scm?.changes ?? [])]) if (i.abs) m[i.abs] = i.status;
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
       i.status === "U" ? (isMd(i.path) ? "preview" : "edit") : "diff");
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
  const stage = (files: ScmItem[], on: boolean) => files.length && run(() => api.scmStage(root, files.map((f) => f.path), on, runtime));
  const commit = () => run(async () => { await api.scmCommit(root, msg, runtime); setMsg(""); });

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
    else if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      e.currentTarget.setRangeText("  ", e.currentTarget.selectionStart, e.currentTarget.selectionEnd, "end");
      setText(e.currentTarget.value);
    }
  };

  const tree = (dir: string, depth: number): React.ReactNode =>
    kids[dir]?.map((e) => (
      <div key={e.path}>
        <button className={"frow" + (open?.abs === e.path ? " on" : "")} style={{ paddingLeft: 7 + depth * 12 }}
                onClick={() => (e.dir ? toggle(e.path) : fromTree(e))} title={e.path}>
          <span className="tw">{e.dir ? (kids[e.path] ? "▾" : "▸") : ""}</span>
          <span className={"t" + (marks[e.path] ? " s" + marks[e.path] : "")}>{e.name}</span>
          {marks[e.path] && <span className={"st s" + marks[e.path]}>{marks[e.path]}</span>}
        </button>
        {e.dir && kids[e.path] && tree(e.path, depth + 1)}
      </div>
    ));

  const group = (title: string, items: ScmItem[], staged: boolean) => (
    <>
      <div className="sec">
        <span>{title}</span><b>{items.length}</b><span className="sp" />
        {items.length > 0 && (
          <button className="mini" disabled={busy} onClick={() => stage(items, !staged)}
                  title={staged ? "Unstage all" : "Stage all"}>{staged ? "−" : "+"}</button>
        )}
      </div>
      {items.map((i) => (
        <div key={i.path} className="scm-row">
          <button className={"frow" + (open?.rel === i.path && !!open.staged === staged ? " on" : "")}
                  onClick={() => fromScm(i, staged)} title={i.path}>
            <span className="n">{i.path}</span>
            <span className={"st s" + i.status}>{i.status}</span>
          </button>
          <button className="mini" disabled={busy} onClick={() => stage([i], !staged)}
                  title={staged ? "Unstage" : "Stage"}>{staged ? "−" : "+"}</button>
        </div>
      ))}
    </>
  );

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
              <div className="commit">
                <textarea placeholder={`Message (Ctrl+Enter to commit on ${scm.branch})`} value={msg} rows={2}
                          onChange={(e) => setMsg(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && scm.staged.length) commit(); }} />
                <button className="btn primary" disabled={busy || !scm.staged.length || !msg.trim()} onClick={commit}>
                  ✓ Commit{scm.staged.length ? ` (${scm.staged.length})` : ""}
                </button>
              </div>
              {group("Staged Changes", scm.staged, true)}
              {group("Changes", scm.changes, false)}
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
                <textarea className="ed" spellCheck={false} value={text} onKeyDown={onKey}
                          onChange={(e) => setText(e.target.value)} />
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
