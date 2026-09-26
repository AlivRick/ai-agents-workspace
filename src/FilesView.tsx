import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Marked } from "marked";
import { api, shortPath, type Entry, type ScmItem, type ScmStatus } from "./api";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import CodeEditor from "./CodeEditor";
import { setOpener, stopOthers } from "./lsp";
import { Menu, Picker, type Item, type Pick, type PickerAsk } from "./ScmMenu";
import DiffEditor from "./DiffEditor";
import { allFiles, buildTree, type Folder } from "./scmtree";
import { fileIcon, folderIcon, type IconTable } from "./icons";
import iconTable from "./icons.gen.json";

/** A file on screen. `rel` is set when git knows it changed — that is what
 *  makes the Diff tab available. */
type Open = { abs: string; rel?: string; staged?: boolean; status?: string };
type Mode = "edit" | "diff" | "preview";
/** An editor tab: a file and how it was last shown. */
type Tab = Open & { mode: Mode };
/** A file opened from Source Control's staged group is its own tab. */
const tkey = (o: Open) => o.abs + (o.staged ? "|staged" : "");
/** Drag payload from the tree: the files' paths, as JSON. */
const DRAG = "application/x-agentspace-files";
type Group = "merge" | "staged" | "changes";
const STATUS_NAME: Record<string, string> = {
  M: "Modified", A: "Added", D: "Deleted", R: "Renamed", C: "Copied", U: "Untracked", T: "Type changed", "!": "Conflict",
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Raw HTML inside a README is shown as text, never rendered: the page has
 *  `invoke`, so a `<img onerror>` in some repo's markdown would be code running
 *  with the app's rights. */
const md = new Marked({ renderer: { html: ({ text }) => esc(text) } });
const T = iconTable as IconTable;
/** A Material Icon Theme icon, the set VS Code users know. */
const Ico = ({ k }: { k: string }) => <img className="fi" src={`/material/${k}.svg`} alt="" draggable={false} />;
/** VS Code's chevron: points right when shut, down when open. */
const Chev = ({ open }: { open: boolean }) => (
  <svg className={"chev" + (open ? " open" : "")} viewBox="0 0 16 16" aria-hidden>
    <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
  </svg>
);
const lspWarned = new Set<string>();
/** Each project's tabs, the one on screen, and unsaved edits — kept while the
 *  app runs, so switching project or view and coming back finds them as left. */
type Kept = { tabs: Tab[]; active: string; stash: Record<string, { text: string; saved: string }> };
const kept = new Map<string, Kept>();
/** The tabs (not the edits) also go to localStorage, for the next launch. */
const tabsKey = (root: string) => "tabs:" + root;
const loadTabs = (root: string): Kept | null => {
  try { const v = JSON.parse(localStorage.getItem(tabsKey(root)) ?? "null"); return v?.tabs ? { ...v, stash: {} } : null; } catch { return null; }
};
const isMd = (p: string) => /\.(md|markdown|mdx)$/i.test(p);
const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
const parent = (p: string) => p.slice(0, Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")));
/** Is `p` the path `of` or something inside it. */
const under = (p: string, of: string) => p === of || p.startsWith(of + "/") || p.startsWith(of + "\\");

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
  /** The two sides of the Diff tab: the older copy, and the newer one when
   *  that is not the file on disk (a staged diff). */
  const [pair, setPair] = useState<{ a: string; b: string | null } | string | null>(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  /** Clicking away from unsaved edits asks once — a second click on the same
   *  file means "discard them". */
  const [tick, setTick] = useState(0);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  /** The Explorer's right-click menu; `e` null is the workspace folder itself. */
  const [ctx, setCtx] = useState<{ x: number; y: number; e: Entry | null } | null>(null);
  /** What Cut/Copy put aside for Paste. */
  const [clip, setClip] = useState<{ path: string; cut: boolean } | null>(null);
  /** The last row clicked, for F2 / Del / Ctrl+C·X·V. */
  const [sel, setSel] = useState<Entry | null>(null);
  /** Rows picked with Ctrl/Shift+click, to drag into the editor as tabs. */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const anchor = useRef("");
  const [tabs, setTabs] = useState<Tab[]>([]);
  /** Edits of tabs that are not on screen, so switching tabs loses nothing. */
  const stash = useRef<Record<string, { text: string; saved: string }>>({});
  const [dropping, setDropping] = useState(false);
  /** The right-click menu on an editor tab. */
  const [tabCtx, setTabCtx] = useState<{ x: number; y: number; t: Tab } | null>(null);
  const [ask, setAsk] = useState<PickerAsk | null>(null);
  const [output, setOutput] = useState<{ at: number; label: string; ok: boolean; text: string }[]>([]);
  const [showOut, setShowOut] = useState(false);
  /** Source Control as a folder tree or a flat list, like VS Code's toggle. */
  const [asTree, setAsTree] = useState(() => { try { return localStorage.getItem("scmTree") === "1"; } catch { return false; } });
  /** Collapsed groups and folders. */
  const [shut, setShut] = useState<Set<string>>(new Set());
  /** Old | new columns, or git's single column. Remembered across launches. */
  const [split, setSplit] = useState(() => { try { return localStorage.getItem("diffSplit") !== "0"; } catch { return true; } });
  const pickSplit = (v: boolean) => { setSplit(v); try { localStorage.setItem("diffSplit", v ? "1" : "0"); } catch { /* private mode */ } };
  const dirty = text !== saved;
  /** VS Code's sides: working tree is staged copy → file on disk; staged is
   *  HEAD → staged copy. A side git has no copy of is empty. */
  const sides = async (o: Open) => {
    const [a, b] = await Promise.all([
      api.scmOriginal(root, o.rel!, runtime, !o.staged),
      o.staged ? api.scmOriginal(root, o.rel!, runtime, true) : null,
    ]);
    return { a: a ?? "", b: o.staged ? b ?? "" : null };
  };

  // Coming to a project: its tabs as they were left. Leaving it (another
  // project, another view): remember them, the open file's edits included.
  const keep = useRef({ tabs, open, mode, dirty, text, saved });
  keep.current = { tabs, open, mode, dirty, text, saved };
  useEffect(() => {
    stopOthers(root);
    setKids({});
    const k = (root && (kept.get(root) ?? loadTabs(root))) || null;
    stash.current = { ...(k?.stash ?? {}) };
    setTabs(k?.tabs ?? []);
    const act = k?.tabs.find((t) => tkey(t) === k.active);
    setOpen(act ?? null);
    if (act) setMode(act.mode);
    if (root) api.fsList(root, root).then((e) => setKids({ [root]: e })).catch((e) => setError(String(e)));
    return () => {
      if (!root) return;
      const c = keep.current;
      const edits = { ...stash.current };
      if (c.open && c.dirty) edits[tkey(c.open)] = { text: c.text, saved: c.saved };
      const ts = c.tabs.map((t) => (c.open && tkey(t) === tkey(c.open) ? { ...t, mode: c.mode } : t));
      kept.set(root, { tabs: ts, active: c.open ? tkey(c.open) : "", stash: edits });
    };
  }, [root]);
  useEffect(() => {
    if (!root) return;
    const active = open ? tkey(open) : "";
    try { localStorage.setItem(tabsKey(root), JSON.stringify({ tabs: tabs.map((t) => (open && tkey(t) === active ? { ...t, mode } : t)), active })); } catch { /* private mode */ }
  }, [root, tabs, open, mode]);

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
            const d = await sides(o).catch((e) => String(e));
            if (!stop && live.current.open === o) setPair((p) => (same(p, d) ? p : d));
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
    // Back to a tab with edits of its own: show those, not the disk copy.
    const b = stash.current[tkey(open)];
    if (b) { delete stash.current[tkey(open)]; setText(b.text); setSaved(b.saved); setReadErr(""); return; }
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
    setPair(null);
    if (!open?.rel || open.status === "U") return;
    let live = true;
    sides(open).then((d) => live && setPair(d)).catch((e) => live && setPair(String(e)));
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

  /** Show `o` in its tab, opening one next to the current tab if needed. */
  const go = (o: Open, m: Mode) => {
    setError("");
    const k = tkey(o);
    if (open && tkey(open) !== k) {
      if (dirty) stash.current[tkey(open)] = { text, saved };
      setTabs((ts) => ts.map((t) => (tkey(t) === tkey(open) ? { ...t, mode } : t)));
    }
    const tab = { ...o, mode: m };
    setTabs((ts) => {
      if (ts.some((t) => tkey(t) === k)) return ts.map((t) => (tkey(t) === k ? tab : t));
      const at = open ? ts.findIndex((t) => tkey(t) === tkey(open)) + 1 : ts.length;
      return [...ts.slice(0, at || ts.length), tab, ...ts.slice(at || ts.length)];
    });
    setOpen(o);
    setMode(m);
  };
  /** Put `t` on screen without keeping the edits of the one leaving (they were discarded). */
  const show = (t: Tab | undefined) => {
    setText(""); setSaved("");
    if (t) { setOpen(t); setMode(t.mode); } else setOpen(null);
  };
  const unsaved = (t: Tab) => (!!open && tkey(open) === tkey(t) && dirty) || !!stash.current[tkey(t)];
  /** Close several tabs; asks once if any of them has unsaved edits. */
  const closeTabs = async (gone: Tab[]) => {
    if (!gone.length) return;
    const lost = gone.filter(unsaved);
    if (lost.length) {
      const ok = await confirmDialog(`Discard the unsaved changes in ${lost.map((t) => base(t.abs)).join(", ")}?`,
        { title: "Close", kind: "warning", okLabel: "Discard", cancelLabel: "Cancel" });
      if (!ok) return;
    }
    const keys = new Set(gone.map(tkey));
    for (const k of keys) delete stash.current[k];
    const rest = tabs.filter((x) => !keys.has(tkey(x)));
    setTabs(rest);
    if (open && keys.has(tkey(open))) {
      const i = tabs.findIndex((x) => tkey(x) === tkey(open));
      // The nearest survivor to the right, else the last one.
      show(tabs.slice(i + 1).find((x) => !keys.has(tkey(x))) ?? rest[rest.length - 1]);
    }
  };
  const closeTab = (t: Tab) => closeTabs([t]);
  const fromScm = (i: ScmItem, staged: boolean) =>
    go({ abs: i.abs, rel: i.path, staged, status: i.status },
       // A conflict opens as text: the <<<<<<< markers are what you edit.
       i.status === "U" || i.status === "!" ? (isMd(i.path) && i.status === "U" ? "preview" : "edit") : "diff");
  const openFile = (i: ScmItem, staged: boolean) =>
    go({ abs: i.abs, rel: i.path, staged, status: i.status }, isMd(i.path) ? "preview" : "edit");
  const asOpen = (p: string): Open => {
    const i = scm?.changes.find((c) => c.abs === p) ?? scm?.staged.find((c) => c.abs === p);
    return { abs: p, rel: i?.path, staged: !!i && !scm?.changes.includes(i), status: i?.status };
  };
  const fromTree = (e: Entry) => go(asOpen(e.path), isMd(e.path) ? "preview" : "edit");
  // Go to Definition in another file opens it here, as a tab in Edit mode.
  setOpener((abs) => go(asOpen(abs), "edit"));
  /** Files dropped on the editor: a tab each, the last one on screen. */
  const openMany = (paths: string[]) => {
    const news = paths.map((p) => ({ ...asOpen(p), mode: (isMd(p) ? "preview" : "edit") as Mode }));
    const last = news.pop();
    if (!last) return;
    setTabs((ts) => [...ts, ...news.filter((n) => !ts.some((t) => tkey(t) === tkey(n)))]);
    go(last, last.mode);
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
  const sync = (op: "push" | "publish" | "pull" | "fetch") => gitOp(op[0].toUpperCase() + op.slice(1), op);
  const nothingStaged = !scm?.staged.length;
  const canCommit = !!scm && !scm.merge.length && (scm.staged.length > 0 || scm.changes.length > 0);
  /** Nothing staged means "commit everything", VS Code's smart commit. */
  const commit = () => canCommit && void commitWith("auto");

  // ------------------------------------------------ the "…" menu, VS Code's
  /** Every git action run from this view, for "Show Git Output". */
  const note = (label: string, ok: boolean, text: string) =>
    setOutput((o) => [...o.slice(-199), { at: Date.now(), label, ok, text }]);
  const gitOp = (label: string, op: string, args: string[] = []) => run(async () => {
    try { note(label, true, await api.scmOp(root, op, args, runtime)); }
    catch (e) { note(label, false, String(e)); throw e; }
  });
  /** Ask with the quick pick; null when cancelled. */
  const prompt = (title: string, o: Omit<PickerAsk, "title" | "resolve">) =>
    new Promise<string | null>((res) => setAsk({ title, ...o, resolve: (v) => { setAsk(null); res(v); } }));
  const lines = async (op: string) => (await api.scmOp(root, op, [], runtime)).split("\n").filter(Boolean);
  const branches = async () => (await lines("branches"))
    .map((l) => {
      const [ref, head, when, subj] = l.split("\t");
      const remote = ref.startsWith("refs/remotes/");
      return { short: ref.replace(/^refs\/(heads|remotes)\//, ""), remote, current: head === "*", when, subj };
    })
    .filter((b) => !b.remote || (b.short.includes("/") && !b.short.endsWith("/HEAD")));
  const branchPicks = (bs: Awaited<ReturnType<typeof branches>>): Pick[] => bs.map((b) => ({
    label: b.short, value: b.short,
    description: b.current ? "current" : b.remote ? "remote branch" : "", detail: `${b.when} · ${b.subj}`,
  }));
  const remotes = async () => [...new Set((await lines("remotes")).map((l) => l.split("\t")[0]))];
  /** Wrap an async menu action so a failed list read lands in the banner. */
  const act = (f: () => Promise<unknown>) => () => { f().catch((e) => setError(String(e))); };

  const commitWith = async (mode: "auto" | "staged" | "all", amend = false, signoff = false) => {
    if (!scm) return;
    if (mode === "staged" && nothingStaged && !amend) return setError("There are no staged changes to commit.");
    let m = msg.trim();
    if (!m && !amend) {
      const v = await prompt("Commit message", { placeholder: `Message (commit on "${scm.branch}")`, free: true });
      if (!v) return;
      m = v;
    }
    const all = mode === "all" || (mode === "auto" && nothingStaged);
    run(async () => {
      try { await api.scmCommit(root, m, all, runtime, amend, signoff); note(amend ? "Commit (Amend)" : "Commit", true, m); }
      catch (e) { note("Commit", false, String(e)); throw e; }
      setMsg("");
    });
  };
  const checkoutTo = act(async () => {
    const bs = await branches();
    const v = await prompt("Checkout to…", { placeholder: "Select a branch to checkout", items: [
      { label: "+ Create new branch…", value: "\0new" },
      { label: "+ Create new branch from…", value: "\0from" },
      ...branchPicks(bs),
    ] });
    if (!v) return;
    if (v === "\0new" || v === "\0from") return createBranch(v === "\0from");
    const b = bs.find((x) => x.short === v);
    // A remote branch checks out as the local branch of the same name, which
    // `git switch` creates and sets to track the remote.
    const local = b?.remote ? v.slice(v.indexOf("/") + 1) : v;
    gitOp(`Checkout ${local}`, "checkout", [local]);
  });
  const createBranch = async (from: boolean) => {
    let ref = "";
    if (from) {
      const r = await prompt("Create branch from…", { placeholder: "Select a ref to create the branch from", items: branchPicks(await branches()) });
      if (!r) return;
      ref = r;
    }
    const n = await prompt("Create branch", { placeholder: "Branch name", free: true });
    if (!n) return;
    const name = n.replace(/\s+/g, "-");
    gitOp(`Create branch ${name}`, "branch-create", ref ? [name, ref] : [name]);
  };
  const pickOther = async (title: string, local = false) => {
    const bs = (await branches()).filter((b) => !b.current && (!local || !b.remote));
    return prompt(title, { placeholder: "Select a branch", items: branchPicks(bs) });
  };
  const deleteBranch = act(async () => {
    const b = await pickOther("Delete branch", true);
    if (!b) return;
    try { note(`Delete branch ${b}`, true, await api.scmOp(root, "branch-delete", [b], runtime)); setTick((n) => n + 1); }
    catch (e) {
      note(`Delete branch ${b}`, false, String(e));
      if (!/not fully merged/i.test(String(e))) return setError(String(e));
      const ok = await confirmDialog(`The branch "${b}" is not fully merged. Delete anyway?`,
        { title: "Delete branch", kind: "warning", okLabel: "Delete", cancelLabel: "Cancel" });
      if (ok) gitOp(`Force delete ${b}`, "branch-delete-force", [b]);
    }
  });
  const pickStash = async (title: string) => {
    const st = await lines("stashes");
    if (!st.length) { setError("There are no stashes."); return null; }
    return prompt(title, { placeholder: "Select a stash", items: st.map((l) => {
      const [ref, m] = l.split("\t");
      return { label: m, value: ref, description: ref };
    }) });
  };
  const pickRemote = async (title: string) => {
    const rs = await remotes();
    if (!rs.length) { setError("This repository has no remotes."); return null; }
    return prompt(title, { placeholder: "Select a remote", items: rs.map((r) => ({ label: r, value: r })) });
  };

  const menu: Item[] = [
    { label: "Pull", run: () => gitOp("Pull", "pull") },
    { label: "Push", run: () => gitOp(scm?.upstream ? "Push" : "Publish Branch", scm?.upstream ? "push" : "publish") },
    { label: "Checkout to…", run: checkoutTo },
    { label: "Fetch", run: () => gitOp("Fetch", "fetch") },
    "-",
    { label: "Commit", sub: [
      { label: "Commit", run: () => void commitWith("auto") },
      { label: "Commit Staged", run: () => void commitWith("staged") },
      { label: "Commit All", run: () => void commitWith("all") },
      { label: "Undo Last Commit", run: act(async () => {
        const last = await api.scmOp(root, "log", [], runtime);
        await gitOp("Undo Last Commit", "commit-undo");
        if (!msg.trim()) setMsg(last); // VS Code puts the message back in the box
      }) },
      { label: "Abort Rebase", run: () => gitOp("Abort Rebase", "rebase-abort") },
      "-",
      { label: "Commit (Amend)", run: () => void commitWith("auto", true) },
      { label: "Commit Staged (Amend)", run: () => void commitWith("staged", true) },
      { label: "Commit All (Amend)", run: () => void commitWith("all", true) },
      "-",
      { label: "Commit (Signed Off)", run: () => void commitWith("auto", false, true) },
      { label: "Commit Staged (Signed Off)", run: () => void commitWith("staged", false, true) },
      { label: "Commit All (Signed Off)", run: () => void commitWith("all", false, true) },
    ] },
    { label: "Changes", sub: [
      { label: "Stage All Changes", run: () => gitOp("Stage All", "stage-all") },
      { label: "Unstage All Changes", run: () => gitOp("Unstage All", "unstage-all") },
      { label: "Discard All Changes", run: () => void discard(scm?.changes ?? []) },
    ] },
    { label: "Pull, Push", sub: [
      { label: "Sync", run: () => gitOp("Sync", "sync") },
      "-",
      { label: "Pull", run: () => gitOp("Pull", "pull") },
      { label: "Pull (Rebase)", run: () => gitOp("Pull (Rebase)", "pull-rebase") },
      { label: "Pull from…", run: act(async () => {
        const r = await pickRemote("Pull from…");
        const b = r && await prompt(`Pull from ${r}`, { placeholder: "Branch name", free: true, items: [] });
        if (r && b) gitOp(`Pull from ${r}/${b}`, "pull-from", [r, b]);
      }) },
      "-",
      { label: "Push", run: () => gitOp("Push", scm?.upstream ? "push" : "publish") },
      { label: "Push to…", run: act(async () => { const r = await pickRemote("Push to…"); if (r) gitOp(`Push to ${r}`, "push-to", [r]); }) },
      { label: "Push (Force With Lease)", run: act(async () => {
        const ok = await confirmDialog("Force push overwrites the remote branch with yours. Continue?",
          { title: "Force push", kind: "warning", okLabel: "Force Push", cancelLabel: "Cancel" });
        if (ok) gitOp("Push (Force)", "push-force");
      }) },
      "-",
      { label: "Fetch", run: () => gitOp("Fetch", "fetch") },
      { label: "Fetch (Prune)", run: () => gitOp("Fetch (Prune)", "fetch-prune") },
      { label: "Fetch From All Remotes", run: () => gitOp("Fetch All", "fetch-all") },
    ] },
    { label: "Branch", sub: [
      { label: "Merge…", run: act(async () => { const b = await pickOther("Merge branch into current"); if (b) gitOp(`Merge ${b}`, "merge", [b]); }) },
      { label: "Rebase Branch…", run: act(async () => { const b = await pickOther("Rebase current branch onto"); if (b) gitOp(`Rebase onto ${b}`, "rebase", [b]); }) },
      { label: "Abort Merge", run: () => gitOp("Abort Merge", "merge-abort") },
      "-",
      { label: "Create Branch…", run: act(() => createBranch(false)) },
      { label: "Create Branch From…", run: act(() => createBranch(true)) },
      "-",
      { label: "Rename Branch…", run: act(async () => {
        const n = await prompt(`Rename branch "${scm?.branch}"`, { placeholder: "New branch name", free: true });
        if (n) gitOp(`Rename branch to ${n}`, "branch-rename", [n.replace(/\s+/g, "-")]);
      }) },
      { label: "Delete Branch…", run: deleteBranch },
      "-",
      { label: "Publish Branch…", run: () => gitOp("Publish Branch", "publish"), disabled: !!scm?.upstream },
    ] },
    { label: "Remote", sub: [
      { label: "Add Remote…", run: act(async () => {
        const url = await prompt("Add remote", { placeholder: "Repository URL", free: true });
        const n = url && await prompt("Add remote", { placeholder: "Remote name", free: true });
        if (url && n) gitOp(`Add remote ${n}`, "remote-add", [n, url]);
      }) },
      { label: "Remove Remote…", run: act(async () => { const r = await pickRemote("Remove remote"); if (r) gitOp(`Remove remote ${r}`, "remote-remove", [r]); }) },
    ] },
    { label: "Stash", sub: [
      { label: "Stash", run: () => gitOp("Stash", "stash") },
      { label: "Stash (Include Untracked)", run: () => gitOp("Stash (Include Untracked)", "stash-untracked") },
      { label: "Stash Staged", run: () => gitOp("Stash Staged", "stash-staged") },
      { label: "Stash with Message…", run: act(async () => {
        const m = await prompt("Stash", { placeholder: "Stash message", free: true });
        if (m) gitOp("Stash", "stash-message", [m]);
      }) },
      "-",
      { label: "Apply Stash…", run: act(async () => { const r = await pickStash("Apply stash"); if (r) gitOp(`Apply ${r}`, "stash-apply", [r]); }) },
      { label: "Pop Stash…", run: act(async () => { const r = await pickStash("Pop stash"); if (r) gitOp(`Pop ${r}`, "stash-pop", [r]); }) },
      "-",
      { label: "Drop Stash…", run: act(async () => { const r = await pickStash("Drop stash"); if (r) gitOp(`Drop ${r}`, "stash-drop", [r]); }) },
      { label: "Drop All Stashes…", run: act(async () => {
        const ok = await confirmDialog("Drop ALL stashes? This cannot be undone.",
          { title: "Drop stashes", kind: "warning", okLabel: "Drop All", cancelLabel: "Cancel" });
        if (ok) gitOp("Drop All Stashes", "stash-clear");
      }) },
    ] },
    { label: "Tags", sub: [
      { label: "Create Tag…", run: act(async () => {
        const n = await prompt("Create tag", { placeholder: "Tag name", free: true });
        if (!n) return;
        const m = await prompt(`Tag "${n}"`, { placeholder: "Message (optional — Esc for a lightweight tag)", free: true });
        gitOp(`Create tag ${n}`, "tag-create", m ? [n, m] : [n]);
      }) },
      { label: "Delete Tag…", run: act(async () => {
        const tags = await lines("tags");
        if (!tags.length) return setError("This repository has no tags.");
        const t = await prompt("Delete tag", { placeholder: "Select a tag", items: tags.map((x) => ({ label: x, value: x })) });
        if (t) gitOp(`Delete tag ${t}`, "tag-delete", [t]);
      }) },
      { label: "Push Tags", run: () => gitOp("Push Tags", "push-tags") },
    ] },
    "-",
    { label: "Show Git Output", run: () => setShowOut(true) },
  ];



  // ------------------------------------------ the Explorer's right-click menu
  const sep = root.includes("\\") ? "\\" : "/";
  const join = (dir: string, n: string) => dir + sep + n.replace(/[\\/]+/g, sep);
  /** Re-read folders now instead of waiting for the next poll, opening them. */
  const reload = (...dirs: string[]) => {
    for (const d of new Set(dirs)) api.fsList(root, d).then((e) => setKids((k) => ({ ...k, [d]: e }))).catch(() => {});
  };
  /** Forget listings under a path that was renamed or deleted. */
  const forget = (p: string) => {
    setKids((k) => Object.fromEntries(Object.entries(k).filter(([d]) => !under(d, p))));
    setSel((x) => (x && under(x.path, p) ? null : x));
  };
  /** A tab at or under `p` has unsaved edits: say so, don't lose them. */
  const holds = (p: string) => {
    const f = open && under(open.abs, p) && dirty ? open.abs
      : Object.keys(stash.current).map((k) => k.replace(/\|staged$/, "")).find((a) => under(a, p));
    if (!f) return false;
    setError(`Unsaved changes in ${base(f)} — save them first.`);
    return true;
  };
  /** Tabs follow a rename or move; git status catches up on the next poll. */
  const moveTabs = (from: string, to: string) => {
    const mv = (o: Open): Open => (under(o.abs, from) ? { abs: to + o.abs.slice(from.length) } : o);
    setTabs((ts) => ts.map((t) => (under(t.abs, from) ? { ...mv(t), mode: t.mode === "diff" ? "edit" : t.mode } : t)));
    if (open && under(open.abs, from)) { setOpen(mv(open)); if (mode === "diff") setMode("edit"); }
  };
  /** Tabs of deleted files close, edits and all. */
  const dropTabs = (p: string) => {
    for (const k of Object.keys(stash.current)) if (under(k.replace(/\|staged$/, ""), p)) delete stash.current[k];
    const rest = tabs.filter((t) => !under(t.abs, p));
    setTabs(rest);
    if (open && under(open.abs, p)) show(rest[rest.length - 1]);
  };
  const folderOf = (e: Entry | null) => (!e ? root : e.dir ? e.path : parent(e.path));

  const newItem = async (e: Entry | null, folder: boolean) => {
    const dir = folderOf(e);
    const n = await prompt(folder ? "New Folder" : "New File", { placeholder: folder ? "Folder name" : "File name (a/b.ts makes the folder too)", free: true });
    if (!n) return;
    const p = join(dir, n);
    run(async () => {
      await api.fsOp(root, folder ? "folder" : "file", p);
      reload(dir, parent(p));
      if (!folder) go({ abs: p }, isMd(p) ? "preview" : "edit");
    });
  };
  const renameItem = async (e: Entry) => {
    if (holds(e.path)) return;
    const n = await prompt("Rename", { placeholder: "New name", free: true, value: e.name });
    if (!n || n === e.name) return;
    const to = join(parent(e.path), n);
    run(async () => {
      await api.fsOp(root, "rename", e.path, to);
      forget(e.path);
      reload(parent(e.path), parent(to));
      moveTabs(e.path, to);
    });
  };
  const deleteItem = async (e: Entry) => {
    const ok = await confirmDialog(`Are you sure you want to permanently delete '${e.name}'${e.dir ? " and its contents" : ""}?\n\nThis action is irreversible!`,
      { title: "Delete Permanently", kind: "warning", okLabel: "Delete", cancelLabel: "Cancel" });
    if (!ok) return;
    run(async () => {
      await api.fsOp(root, "delete", e.path);
      forget(e.path);
      reload(parent(e.path));
      dropTabs(e.path);
      if (clip && under(clip.path, e.path)) setClip(null);
    });
  };
  const paste = (e: Entry | null) => {
    if (!clip) return;
    const dir = folderOf(e);
    if (clip.cut) {
      if (holds(clip.path)) return;
      const to = join(dir, base(clip.path));
      if (to === clip.path) return setClip(null);
      run(async () => {
        await api.fsOp(root, "rename", clip.path, to);
        forget(clip.path);
        reload(parent(clip.path), dir);
        moveTabs(clip.path, to);
        setClip(null);
      });
    } else {
      run(async () => { await api.fsOp(root, "copy", clip.path, dir); reload(dir); });
    }
  };
  /** A missing language server is said once per session, not per file. */
  const lspFail = (why: string) => { if (!lspWarned.has(why)) { lspWarned.add(why); setError(why); } };
  const copyText = (t: string) => void navigator.clipboard.writeText(t).catch((x) => setError(String(x)));
  /** Open the folders down to `p` in the tree, select it and scroll to it. */
  const revealInTree = async (p: string) => {
    const dirs: string[] = [];
    for (let d = parent(p); d.length > root.length; d = parent(d)) dirs.unshift(d);
    const got: Record<string, Entry[]> = {};
    try { for (const d of dirs) if (!kids[d]) got[d] = await api.fsList(root, d); } catch (e) { return setError(String(e)); }
    setKids((k) => ({ ...k, ...got }));
    setSel({ name: base(p), path: p, dir: false });
    setPicked(new Set([p]));
    anchor.current = p;
    setTimeout(() => document.querySelector(`.explorer .frow[data-path="${CSS.escape(p)}"]`)?.scrollIntoView({ block: "center" }), 50);
  };
  const tabItems = (t: Tab): Item[] => {
    const i = tabs.findIndex((x) => tkey(x) === tkey(t));
    const p = t.abs || t.rel || "";
    return [
      { label: "Close", key: "Ctrl+W", run: () => void closeTab(t) },
      { label: "Close Others", disabled: tabs.length < 2, run: () => void closeTabs(tabs.filter((x) => tkey(x) !== tkey(t))) },
      { label: "Close to the Right", disabled: i === tabs.length - 1, run: () => void closeTabs(tabs.slice(i + 1)) },
      { label: "Close Saved", run: () => void closeTabs(tabs.filter((x) => !unsaved(x))) },
      { label: "Close All", run: () => void closeTabs(tabs) },
      "-",
      { label: "Copy Path", key: "Shift+Alt+C", run: () => copyText(p) },
      { label: "Copy Relative Path", run: () => copyText(rel(p)) },
      "-",
      { label: "Reveal in Explorer View", disabled: !t.abs, run: () => void revealInTree(t.abs) },
      { label: "Reveal in File Explorer", key: "Shift+Alt+R", disabled: !t.abs, run: () => run(() => api.fsOp(root, "reveal", t.abs)) },
    ];
  };
  const rel = (p: string) => p.slice(root.length).replace(/^[\\/]/, "");

  const ctxItems = (e: Entry | null): Item[] => {
    const p = e?.path ?? root;
    return [
      { label: "New File…", run: () => void newItem(e, false) },
      { label: "New Folder…", run: () => void newItem(e, true) },
      { label: "Reveal in File Explorer", key: "Shift+Alt+R", run: () => run(() => api.fsOp(root, "reveal", p)) },
      "-",
      ...(e ? [
        { label: "Cut", key: "Ctrl+X", run: () => setClip({ path: e.path, cut: true }) },
        { label: "Copy", key: "Ctrl+C", run: () => setClip({ path: e.path, cut: false }) },
      ] : []),
      { label: "Paste", key: "Ctrl+V", disabled: !clip, run: () => paste(e) },
      "-",
      { label: "Copy Path", key: "Shift+Alt+C", run: () => copyText(p) },
      { label: "Copy Relative Path", run: () => copyText(rel(p) || ".") },
      ...(e ? [
        "-" as const,
        { label: "Rename…", key: "F2", run: () => void renameItem(e) },
        { label: "Delete Permanently", key: "Del", run: () => void deleteItem(e) },
      ] : []),
    ];
  };
  /** VS Code's keys, while a tree row has focus (not the commit box). */
  const treeKey = (ev: React.KeyboardEvent) => {
    if (!sel || !(ev.target as HTMLElement).closest(".frow")) return;
    const k = (ev.ctrlKey || ev.metaKey ? "C-" : "") + (ev.shiftKey ? "S-" : "") + (ev.altKey ? "A-" : "") + ev.key.toLowerCase();
    const f: Record<string, () => void> = {
      f2: () => void renameItem(sel),
      delete: () => void deleteItem(sel),
      "C-c": () => setClip({ path: sel.path, cut: false }),
      "C-x": () => setClip({ path: sel.path, cut: true }),
      "C-v": () => paste(sel),
      "S-A-r": () => run(() => api.fsOp(root, "reveal", sel.path)),
      "S-A-c": () => copyText(sel.path),
    };
    if (f[k]) { ev.preventDefault(); f[k](); }
  };

  // Ctrl+N: new file where the selection is. Ctrl+W: close the tab. Not while
  // typing in a terminal, where both keys belong to the shell.
  const keys = useRef({ newFile: () => {}, closeTab: () => {} });
  keys.current = { newFile: () => void newItem(sel, false), closeTab: () => { const t = tabs.find((x) => open && tkey(x) === tkey(open)); if (t) void closeTab(t); } };
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || (e.target as HTMLElement)?.closest?.(".xterm")) return;
      const k = e.key.toLowerCase();
      if (k === "n") { e.preventDefault(); keys.current.newFile(); }
      if (k === "w") { e.preventDefault(); keys.current.closeTab(); }
    };
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, []);

  /** The tree's rows in screen order, for Shift+click ranges and drags. */
  const visible = (dir = root): Entry[] => (kids[dir] ?? []).flatMap((e) => [e, ...(e.dir && kids[e.path] ? visible(e.path) : [])]);
  const pick = (ev: React.MouseEvent, e: Entry) => {
    setSel(e);
    if (ev.ctrlKey || ev.metaKey) {
      anchor.current = e.path;
      setPicked((p) => { const n = new Set(p); if (n.has(e.path)) n.delete(e.path); else n.add(e.path); return n; });
      return;
    }
    const v = visible();
    const a = v.findIndex((x) => x.path === anchor.current);
    const b = v.findIndex((x) => x.path === e.path);
    if (ev.shiftKey && a >= 0 && b >= 0) return setPicked(new Set(v.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.path)));
    anchor.current = e.path;
    setPicked(new Set([e.path]));
    if (e.dir) toggle(e.path); else fromTree(e);
  };
  const dragStart = (ev: React.DragEvent, e: Entry) => {
    const set = picked.has(e.path) ? picked : new Set([e.path]);
    if (!picked.has(e.path)) setPicked(set);
    const files = visible().filter((x) => set.has(x.path) && !x.dir).map((x) => x.path);
    if (!files.length) return ev.preventDefault();
    ev.dataTransfer.setData(DRAG, JSON.stringify(files));
    ev.dataTransfer.effectAllowed = "copy";
  };

  const ignored = useMemo(() => new Set(scm?.ignored ?? []), [scm]);
  /** `dim`: the folder being listed is git-ignored, so all of it is. */
  const tree = (dir: string, depth: number, dim = false): React.ReactNode =>
    kids[dir]?.map((e) => { const ig = dim || ignored.has(e.path); return (
      <div key={e.path}>
        <button className={"frow" + (open?.abs === e.path ? " on" : "") + (picked.has(e.path) && picked.size > 1 ? " sel" : "")
                           + (clip?.cut && clip.path === e.path ? " cut" : "") + (ig ? " ign" : "")}
                style={{ paddingLeft: 7 + depth * 12 }} title={e.path} data-path={e.path} draggable
                onClick={(ev) => pick(ev, e)} onDragStart={(ev) => dragStart(ev, e)}
                onContextMenu={(ev) => { ev.preventDefault(); ev.stopPropagation(); setSel(e); setCtx({ x: ev.clientX, y: ev.clientY, e }); }}>
          <span className="tw">{e.dir && <Chev open={!!kids[e.path]} />}</span>
          <Ico k={e.dir ? folderIcon(T, e.name, !!kids[e.path]) : fileIcon(T, e.name)} />
          <span className={"t" + (marks[e.path] ? " s" + marks[e.path] : "")}>{e.name}</span>
          {marks[e.path] && <span className={"st s" + marks[e.path]}>{marks[e.path]}</span>}
        </button>
        {e.dir && kids[e.path] && tree(e.path, depth + 1, ig)}
      </div>
    ); });

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
          <span className="tw"><Chev open={!shut.has(key)} /></span>
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
          <span className="tw"><Chev open={!shut.has(key)} /></span>
          <span>{title}</span><b>{items.length}</b><span className="sp" />
          {items.length > 0 && acts(items, kind)}
        </div>
        {!shut.has(key) && (asTree ? folderRows(buildTree(items), kind, 1) : items.map((i) => fileRow(i, kind, 1)))}
      </>
    );
  };

  if (!root) return <div className="view" style={{ display: "flex" }}><div className="hint">Pick a workspace in the sidebar first.</div></div>;

  // `git show` loses the final newline; give it back when the other side has
  // one, or every file would end on a changed line.
  const right = pair && typeof pair !== "string" ? pair.b ?? text : "";
  const left = pair && typeof pair !== "string" ? (right.endsWith("\n") && !pair.a.endsWith("\n") && pair.a ? pair.a + "\n" : pair.a) : "";
  const canEdit = !!open?.abs && open.status !== "D" && !readErr;

  return (
    <div className="view" style={{ display: "flex" }}>
      <div className="toolbar">
        <span className="title">{name}</span>
        <span className="path">{shortPath(root)}</span>
        {scm?.branch && (
          <button className="branch" title="Checkout to… (switch branch)" onClick={checkoutTo}>⎇ {scm.branch}</button>
        )}
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
                <button className="mini" title="More Actions…"
                        onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenuAt({ x: r.left, y: r.bottom + 2 }); }}>···</button>
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
          <div className="sec"><span>Explorer</span><span className="sp" />
            <button className="mini" title="New File…" onClick={() => void newItem(sel, false)}>+</button>
            <button className="mini" title="New Folder…" onClick={() => void newItem(sel, true)}>⊞</button>
          </div>
          {/* Right-click on the empty space below the tree: the workspace folder. */}
          <div className="ftree" onKeyDown={treeKey}
               onContextMenu={(ev) => { ev.preventDefault(); setCtx({ x: ev.clientX, y: ev.clientY, e: null }); }}>
            {tree(root, 0)}
          </div>
        </div>

        <div className={"pane-ed" + (dropping ? " drop" : "")}
             onDragOver={(ev) => { if (!ev.dataTransfer.types.includes(DRAG)) return; ev.preventDefault(); ev.dataTransfer.dropEffect = "copy"; setDropping(true); }}
             onDragLeave={(ev) => { if (!ev.currentTarget.contains(ev.relatedTarget as Node)) setDropping(false); }}
             onDrop={(ev) => {
               setDropping(false);
               const raw = ev.dataTransfer.getData(DRAG);
               if (!raw) return;
               ev.preventDefault();
               openMany(JSON.parse(raw) as string[]);
             }}>
          {tabs.length > 0 && (
            <div className="tabs-bar">
              {tabs.map((t) => {
                const k = tkey(t), on = !!open && tkey(open) === k, d = (on && dirty) || !!stash.current[k];
                return (
                  <div key={k} className={"etab" + (on ? " on" : "")} title={t.abs || t.rel}
                       onClick={() => !on && go(t, t.mode)}
                       onMouseDown={(ev) => { if (ev.button === 1) { ev.preventDefault(); void closeTab(t); } }}
                       onContextMenu={(ev) => { ev.preventDefault(); setTabCtx({ x: ev.clientX, y: ev.clientY, t }); }}>
                    <Ico k={fileIcon(T, base(t.abs || t.rel || ""))} />
                    <span>{base(t.abs || t.rel || "")}</span>
                    {(on ? mode : t.mode) === "diff" && <span className="k">{t.staged ? "Index" : "Working Tree"}</span>}
                    <button className={"x" + (d ? " dirty" : "")} title={d ? "Unsaved — close" : "Close (Ctrl+W)"}
                            onClick={(ev) => { ev.stopPropagation(); void closeTab(t); }}>{d ? "●" : "×"}</button>
                  </div>
                );
              })}
            </div>
          )}
          {!open && <div className="hint">Open a file from the tree, or drag files here — Ctrl/Shift+click to pick several.</div>}
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
              {mode === "diff" && typeof pair === "string" && <div className="hint">{pair}</div>}
              {mode === "diff" && pair && typeof pair !== "string" && (
                <DiffEditor key={open.abs + "|" + open.staged} file={open.abs || open.rel || ""} old={left} value={right}
                            editable={!open.staged && canEdit} split={split} onChange={setText} onSave={save} />
              )}
              {mode !== "diff" && readErr && <div className="hint">{readErr}</div>}
              {mode === "edit" && canEdit && (
                <CodeEditor key={open.abs} file={open.abs} value={text} original={orig} onChange={setText} onSave={save}
                            root={root} runtime={runtime} onLspFail={lspFail} />
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
      {menuAt && <Menu items={menu} x={menuAt.x} y={menuAt.y} onClose={() => setMenuAt(null)} />}
      {ctx && <Menu items={ctxItems(ctx.e)} x={ctx.x} y={ctx.y} onClose={() => setCtx(null)} />}
      {tabCtx && <Menu items={tabItems(tabCtx.t)} x={tabCtx.x} y={tabCtx.y} onClose={() => setTabCtx(null)} />}
      {ask && <Picker ask={ask} />}
      {showOut && (
        <div className="modal" onClick={() => setShowOut(false)}>
          <div className="sheet wide" onClick={(e) => e.stopPropagation()}>
            <header><b>Git Output</b><span className="sp" />
              <button className="btn ghost" onClick={() => setOutput([])}>Clear</button>
              <button className="btn ghost" onClick={() => setShowOut(false)}>Close</button></header>
            <div className="git-out">
              {output.length === 0 && <div className="hint">Nothing run yet.</div>}
              {output.map((o, i) => (
                <div key={i} className={o.ok ? "" : "bad"}>
                  <b>{new Date(o.at).toLocaleTimeString()} · {o.label}{o.ok ? "" : " — failed"}</b>
                  {o.text && <pre>{o.text}</pre>}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {error && <div className="banner err"><span>{error}</span><span className="sp" style={{ flex: 1 }} /><button className="btn" onClick={() => setError("")}>Dismiss</button></div>}
    </div>
  );
}
