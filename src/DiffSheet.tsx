import { useCallback, useEffect, useState } from "react";
import { api, shortPath, type Review, type Tree } from "./api";
import { parseDiff, stat } from "./diff";

/**
 * What a task changed, and what to do about it.
 *
 * A worktree without this is a trap: three branches sitting on disk that you
 * have to merge and clean up by hand, which is more work than not having
 * branched at all. So the answers a review ends in are the buttons in the
 * footer — take it, throw it away, or send it out as a pull request.
 *
 * The two mid-task buttons are there because a review is not only read at the
 * end: Commit banks the work so far, and Update pulls the base branch in while
 * an agent is still around to resolve what it conflicts with. Both only appear
 * when they would do something, which is what keeps six buttons off the bar.
 */
export default function DiffSheet({
  tree, name, runtime, onClose, onDone,
}: {
  tree: Tree; name: string; runtime: string;
  onClose: () => void;
  /** Merged or discarded — either way this worktree is finished with. Removing
   *  it is the caller's job, because the terminals standing in it have to be
   *  closed first and only the caller owns those. */
  onDone: () => void;
}) {
  const [rev, setRev] = useState<Review | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<string>("");
  const [busy, setBusy] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [note, setNote] = useState<string>("");
  /** Bumped by every action, so the file list and the open diff both re-read
   *  what git says now — a commit or an update changes both. */
  const [tick, setTick] = useState(0);
  /** Discard deletes a branch, which git cannot undo — so it asks once, in the
   *  button itself rather than in a dialog the rest of this app never uses. */
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    let live = true;
    api.worktreeReview(tree, runtime)
      .then((r) => {
        if (!live) return;
        setRev(r);
        setFile((f) => (f && r.files.some((c) => c.path === f) ? f : r.files[0]?.path ?? null));
      })
      .catch((e) => live && (setRev({ files: [], ahead: 0, behind: 0, dirty: false, canPr: false }), setError(String(e))));
    return () => { live = false; };
  }, [tree, runtime, tick]);

  useEffect(() => {
    if (!file) return;
    let live = true;
    setDiff("");
    api.worktreeDiff(tree, file, runtime).then((d) => live && setDiff(d)).catch((e) => live && setDiff(String(e)));
    return () => { live = false; };
  }, [file, tree, runtime, tick]);

  const rows = parseDiff(diff);
  const files = rev?.files ?? [];
  const total = files.reduce(
    (a, c) => ({ added: a.added + c.added, removed: a.removed + c.removed }),
    { added: 0, removed: 0 },
  );

  /** One shape for every button: run it, show what it said, re-read git. */
  const act = useCallback(async (id: string, run: () => Promise<unknown>, done?: (out: unknown) => void) => {
    setBusy(id);
    setError("");
    setNote("");
    try {
      const out = await run();
      if (done) done(out);
      else setTick((n) => n + 1);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  }, []);

  const message = `${name} (Agentspace)`;
  const drift = [
    rev && rev.ahead > 0 ? `${rev.ahead} commit${rev.ahead === 1 ? "" : "s"}` : "",
    rev && rev.behind > 0 ? `${rev.behind} behind ${tree.base}` : "",
    rev?.dirty ? "uncommitted" : "",
  ].filter(Boolean).join(" · ");

  return (
    <div className="modal" onClick={onClose}>
      <div className="sheet wide" onClick={(e) => e.stopPropagation()}>
        <header>
          <b>Review · {name}</b>
          <span className="path">{tree.branch} → {tree.base}{drift && ` · ${drift}`}</span>
          <span className="sp" />
          {files.length > 0 && (
            <span className="path">{files.length} file{files.length === 1 ? "" : "s"} · <b className="plus">+{total.added}</b> <b className="minus">−{total.removed}</b></span>
          )}
        </header>

        <div className="review">
          <div className="files">
            {rev === null && <div className="hint">Reading the worktree…</div>}
            {rev !== null && files.length === 0 && <div className="hint">This task has not changed anything yet.</div>}
            {files.map((c) => (
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
        {note && <div className="hint pr">{note}</div>}

        <footer>
          <span className="path" title={tree.path}>{shortPath(tree.path)}</span>
          <span className="sp" />
          <button className={"btn " + (armed ? "danger" : "ghost")} disabled={!!busy}
                  onClick={() => (armed ? onDone() : setArmed(true))}
                  title={`Delete the worktree and branch ${tree.branch}`}>
            {armed ? `Delete ${tree.branch} — sure?` : "Discard"}
          </button>
          {!!rev?.behind && (
            <button className="btn ghost" disabled={!!busy}
                    title={`Merge ${tree.base} into this worktree, where the agent can resolve conflicts`}
                    onClick={() => act("update", () => api.worktreeUpdate(tree, runtime))}>
              {busy === "update" ? "Updating…" : `Update from ${tree.base}`}
            </button>
          )}
          {rev?.dirty && (
            <button className="btn ghost" disabled={!!busy}
                    title="Commit what the task has done so far and keep working"
                    onClick={() => act("commit", () => api.worktreeCommit(tree, message, runtime))}>
              {busy === "commit" ? "Committing…" : "Commit"}
            </button>
          )}
          {rev?.canPr && rev.ahead > 0 && (
            <button className="btn ghost" disabled={!!busy}
                    title={`Push ${tree.branch} and open a pull request against ${tree.base}`}
                    onClick={() => act("pr", () => api.worktreePr(tree, name, runtime), (url) => setNote(String(url)))}>
              {busy === "pr" ? "Opening…" : "Create PR"}
            </button>
          )}
          <button className="btn ghost" onClick={onClose}>Close</button>
          <button className="btn primary" disabled={!!busy || !files.length}
                  onClick={() => act("merge", () => api.worktreeMerge(tree, message, runtime), onDone)}>
            {busy === "merge" ? "Merging…" : `Merge into ${tree.base}`}
          </button>
        </footer>
      </div>
    </div>
  );
}
