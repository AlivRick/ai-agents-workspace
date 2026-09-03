import { useEffect, useMemo, useState } from "react";
import { ago, api, fmtDur, fmtInt, fmtUsd, normPath, shortPath, type Hit, type Session } from "./api";

const PLACEHOLDER = "(không tiêu đề)";

export default function SessionsView({
  sessions, busy, scopePath, runtime, onRefresh, onResume, onDelete, onRename,
}: {
  sessions: Session[]; busy: boolean; scopePath: string | null; runtime: string;
  onRefresh: () => void;
  onResume: (s: Session, fork: boolean) => void;
  onDelete: (files: string[]) => Promise<void>;
  onRename: (file: string, title: string) => Promise<void>;
}) {
  const [q, setQ] = useState("");
  const [deep, setDeep] = useState(false);
  const [hits, setHits] = useState<Map<string, Hit> | null>(null);
  const [searching, setSearching] = useState(false);
  const [scoped, setScoped] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<{ file: string; title: string } | null>(null);

  // The placeholder is a label the scanner invents, not a title anyone typed —
  // starting a rename from it just makes the user delete it first.
  const startRename = (s: Session) =>
    setEditing({ file: s.file, title: s.title === PLACEHOLDER ? "" : s.title });

  // Grepping every transcript is a real read, so it waits for a pause in the
  // typing rather than firing on each keystroke.
  useEffect(() => {
    if (!deep || q.trim().length < 2) { setHits(null); return; }
    setSearching(true);
    const t = setTimeout(() => {
      api.searchSessions(q, runtime)
        .then((h) => setHits(new Map(h.map((x) => [x.file, x]))))
        .catch(() => setHits(new Map()))
        .finally(() => setSearching(false));
    }, 350);
    return () => { clearTimeout(t); setSearching(false); };
  }, [q, deep, runtime]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return sessions.filter((s) => {
      // Sessions that never exchanged a message carry nothing to resume to.
      if (s.messages === 0) return false;
      if (scoped && scopePath && normPath(s.cwd) !== normPath(scopePath)) return false;
      if (!needle) return true;
      if (deep) return hits?.has(s.file) ?? false;
      return (s.title + " " + s.lastPrompt + " " + s.cwd + " " + s.id).toLowerCase().includes(needle);
    });
  }, [sessions, q, scoped, scopePath, deep, hits]);

  const total = rows.reduce((a, s) => a + s.costUsd, 0);
  const chosen = rows.filter((s) => picked.has(s.file));
  const toggle = (file: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      next.has(file) ? next.delete(file) : next.add(file);
      setConfirming(false);
      return next;
    });

  const remove = async (files: string[]) => {
    setError("");
    try {
      await onDelete(files);
      setPicked(new Set());
      setConfirming(false);
    } catch (e) {
      setError(String(e));
    }
  };

  const commitRename = async () => {
    if (!editing) return;
    const { file, title } = editing;
    setEditing(null);
    if (!title.trim()) return;
    setError("");
    try { await onRename(file, title); } catch (e) { setError(String(e)); }
  };

  return (
    <>
      <div className="toolbar">
        <span className="title">Phiên làm việc</span>
        <span className="path">{fmtInt(rows.length)} phiên{total > 0 ? ` · ${fmtUsd(total)}` : ""}</span>
        <span className="sp" />
        {chosen.length > 0 &&
          (confirming ? (
            <>
              <span style={{ color: "var(--danger)", fontSize: 12 }}>
                Xoá vĩnh viễn {chosen.length} transcript? Không hoàn tác được.
              </span>
              <button className="btn danger" onClick={() => remove(chosen.map((s) => s.file))}>Xoá thật</button>
              <button className="btn ghost" onClick={() => setConfirming(false)}>Huỷ</button>
            </>
          ) : (
            <>
              <button className="btn ghost" onClick={() => setPicked(new Set())}>Bỏ chọn</button>
              <button className="btn danger" onClick={() => setConfirming(true)}>Xoá {chosen.length} phiên</button>
            </>
          ))}
        {scopePath && (
          <div className="seg">
            <button className={scoped ? "on" : ""} onClick={() => setScoped(true)}>Workspace này</button>
            <button className={!scoped ? "on" : ""} onClick={() => setScoped(false)}>Tất cả</button>
          </div>
        )}
        <div className="seg" title="Tìm trong tiêu đề, hay grep toàn bộ nội dung transcript">
          <button className={!deep ? "on" : ""} onClick={() => setDeep(false)}>Tiêu đề</button>
          <button className={deep ? "on" : ""} onClick={() => setDeep(true)}>Nội dung</button>
        </div>
        <input className="search" style={{ margin: 0, width: 210 }}
               placeholder={deep ? "Tìm trong nội dung phiên…" : "Tìm tiêu đề, prompt, đường dẫn…"}
               value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn" onClick={onRefresh} disabled={busy}>{busy ? "Đang quét…" : "Quét lại"}</button>
      </div>

      {error && <div className="banner err"><span>{error}</span></div>}

      <div className="scroll">
        <div className="rows">
          {rows.length === 0 && (
            <div className="hint">
              {busy || searching
                ? "Đang quét transcript…"
                : deep && q.trim().length < 2
                  ? "Gõ ít nhất 2 ký tự để tìm trong nội dung."
                  : "Không có phiên nào khớp."}
            </div>
          )}
          {rows.map((s) => (
            <div className={"row" + (picked.has(s.file) ? " picked" : "")} key={s.id}>
              <input type="checkbox" className="pick" checked={picked.has(s.file)}
                     onChange={() => toggle(s.file)} title="Chọn để xoá" />
              <div className="col">
                {editing?.file === s.file ? (
                  <input
                    className="rename" autoFocus value={editing.title}
                    placeholder="Tên phiên…"
                    onFocus={(e) => e.currentTarget.select()}
                    onChange={(e) => setEditing({ file: s.file, title: e.target.value })}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      if (e.key === "Escape") setEditing(null);
                    }}
                  />
                ) : (
                  <div className="t" onDoubleClick={() => startRename(s)}
                       title="Bấm đúp để đổi tên">{s.title}</div>
                )}
                {deep && hits?.get(s.file)
                  ? hits.get(s.file)!.snippets.map((sn, i) => (
                      <div className="p hit" key={i}>{sn}</div>
                    ))
                  : s.lastPrompt && <div className="p">↳ {s.lastPrompt}</div>}
                <div className="meta">
                  <span className="chip">{shortPath(s.cwd).split("/").slice(-2).join("/")}</span>
                  {s.gitBranch && <span className="chip mono">{s.gitBranch}</span>}
                  {s.models[0] && <span className="chip">{s.models[0].model.replace(/^claude-/, "")}</span>}
                  {s.costUsd > 0 && <span className="chip num">{fmtUsd(s.costUsd)}</span>}
                  <span className="chip num">{fmtInt(s.messages)} tin</span>
                  {(s.linesAdded > 0 || s.linesRemoved > 0) && (
                    <span className="chip num">+{fmtInt(s.linesAdded)} −{fmtInt(s.linesRemoved)}</span>
                  )}
                  {s.durationMs > 0 && <span className="chip num">{fmtDur(s.durationMs)}</span>}
                  {deep && hits?.get(s.file) && (
                    <span className="chip num">{fmtInt(hits.get(s.file)!.total)} dòng khớp</span>
                  )}
                  <span className="chip">{ago(s.updatedAtMs)} trước</span>
                </div>
              </div>
              <div className="acts">
                <button className="btn" onClick={() => onResume(s, false)}>Tiếp tục</button>
                <button className="btn ghost" title="Mở bản sao, giữ nguyên phiên gốc" onClick={() => onResume(s, true)}>Fork</button>
                <button className="btn ghost" title="Đổi tên phiên"
                        onClick={() => startRename(s)}>Đổi tên</button>
                <button className="btn ghost" title="Sao chép session id" onClick={() => navigator.clipboard.writeText(s.id)}>ID</button>
                <button className="btn ghost danger-text" title="Chọn phiên này để xoá"
                        onClick={() => { setPicked(new Set([s.file])); setConfirming(true); }}>Xoá</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
