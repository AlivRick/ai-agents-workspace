import { useEffect, useState } from "react";
import { api, shortPath, type Change, type Tree } from "./api";
import { parseDiff, stat } from "./diff";

/**
 * What a task changed, and what to do about it.
 *
 * A worktree without this is a trap: three branches sitting on disk that you
 * have to merge and clean up by hand, which is more work than not having
 * branched at all. So the two answers a review ends in — take it, or throw it
 * away — are the two buttons in the footer.
 */
export default function DiffSheet({
  tree, name, runtime, onClose, onMerged, onDiscarded,
}: {
  tree: Tree; name: string; runtime: string;
  onClose: () => void;
  /** Merged: the branch is in, the worktree is gone, the task has no home. */
  onMerged: () => void;
  onDiscarded: () => void;
}) {
  const [changes, setChanges] = useState<Change[] | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<string>("");
  const [busy, setBusy] = useState<string>("");
  const [error, setError] = useState<string>("");

  useEffect(() => {
    let live = true;
    api.worktreeChanges(tree, runtime)
      .then((c) => {
        if (!live) return;
        setChanges(c);
        setFile((f) => f ?? c[0]?.path ?? null);
      })
      .catch((e) => live && (setChanges([]), setError(String(e))));
    return () => { live = false; };
  }, [tree, runtime]);

  useEffect(() => {
    if (!file) return;
    let live = true;
    setDiff("");
    api.worktreeDiff(tree, file, runtime).then((d) => live && setDiff(d)).catch((e) => live && setDiff(String(e)));
    return () => { live = false; };
  }, [file, tree, runtime]);

  const rows = parseDiff(diff);
  const total = (changes ?? []).reduce(
    (a, c) => ({ added: a.added + c.added, removed: a.removed + c.removed }),
    { added: 0, removed: 0 },
  );

  const merge = async () => {
    setBusy("Merging…");
    setError("");
    try {
      await api.worktreeMerge(tree, `${name} (Agentspace)`, runtime);
      // The branch is in the base now; keeping the checkout would only leave a
      // second copy of code that already landed.
      await api.worktreeRemove(tree, true, runtime).catch(() => {});
      onMerged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  };

  const discard = async () => {
    if (!confirm(`Delete the worktree and branch ${tree.branch}? Everything this task wrote is lost.`)) return;
    setBusy("Removing…");
    setError("");
    try {
      await api.worktreeRemove(tree, true, runtime);
      onDiscarded();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="modal" onClick={onClose}>
      <div className="sheet wide" onClick={(e) => e.stopPropagation()}>
        <header>
          <b>Review · {name}</b>
          <span className="path">{tree.branch} → {tree.base}</span>
          <span className="sp" />
          {changes && changes.length > 0 && (
            <span className="path">{changes.length} file{changes.length === 1 ? "" : "s"} · <b className="plus">+{total.added}</b> <b className="minus">−{total.removed}</b></span>
          )}
        </header>

        <div className="review">
          <div className="files">
            {changes === null && <div className="hint">Reading the worktree…</div>}
            {changes?.length === 0 && <div className="hint">This task has not changed anything yet.</div>}
            {changes?.map((c) => (
              <button key={c.path} className={"frow" + (file === c.path ? " on" : "")} onClick={() => setFile(c.path)}>
                <span className={"st s" + c.status}>{c.status}</span>
                <span className="n" title={c.path}>{c.path}</span>
                <span className="num">{stat(c.added, c.removed, c.binary)}</span>
              </button>
            ))}
          </div>

          <div className="diff">
            {rows.length === 0 && file && <div className="hint">Loading {file}…</div>}
            {rows.map((r, i) => (
              <div key={i} className={"dl " + r.kind}>
                <span className="ln">{r.old ?? ""}</span>
                <span className="ln">{r.new ?? ""}</span>
                <span className="tx">{r.kind === "add" ? "+" : r.kind === "del" ? "-" : " "}{r.text}</span>
              </div>
            ))}
          </div>
        </div>

        {error && <div className="err">{error}</div>}

        <footer>
          <span className="path" title={tree.path}>{shortPath(tree.path)}</span>
          <span className="sp" />
          <button className="btn ghost" disabled={!!busy} onClick={discard}>Discard</button>
          <button className="btn ghost" onClick={onClose}>Close</button>
          <button className="btn primary" disabled={!!busy || !changes?.length} onClick={merge}>
            {busy || `Merge into ${tree.base}`}
          </button>
        </footer>
      </div>
    </div>
  );
}
