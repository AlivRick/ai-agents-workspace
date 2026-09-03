import { useCallback, useEffect, useState } from "react";
import { ago, api, fmtBytes, shortPath, type Doc, type MemoryInfo, type SkillInfo } from "./api";

type Tab = "prompt" | "skills" | "memory";
type Target = { path: string; title: string; subtitle: string; canDelete: boolean; withDir: boolean } | null;

const TABS: [Tab, string][] = [["prompt", "CLAUDE.md"], ["skills", "Skills"], ["memory", "Memory"]];

/** Everything that shapes how Claude behaves in this folder, in one place:
 *  the root prompt, the skills it can reach, and what it remembers. */
export default function WorkspaceView({ workspace, name, runtime }: { workspace: string; name: string; runtime: string }) {
  const [tab, setTab] = useState<Tab>("prompt");
  const [docs, setDocs] = useState<Doc[]>([]);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [memories, setMemories] = useState<MemoryInfo[]>([]);
  const [target, setTarget] = useState<Target>(null);
  const [text, setText] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const refresh = useCallback(async () => {
    if (!workspace) return;
    const [d, s, m] = await Promise.all([
      api.claudeDocs(workspace, runtime),
      api.listSkills(workspace, runtime),
      api.listMemories(workspace, runtime),
    ]);
    setDocs(d); setSkills(s); setMemories(m);
  }, [workspace, runtime]);

  useEffect(() => { setTarget(null); setText(""); setSaved(""); setError(""); refresh(); }, [refresh]);

  const open = async (t: NonNullable<Target>, exists = true) => {
    setError(""); setConfirmDelete(false); setTarget(t);
    if (!exists) { setText(""); setSaved(""); return; }
    try {
      const c = await api.readDoc(t.path, workspace, runtime);
      setText(c); setSaved(c);
    } catch (e) { setError(String(e)); setText(""); setSaved(""); }
  };

  const save = async () => {
    if (!target) return;
    setBusy(true); setError("");
    try {
      await api.writeDoc(target.path, workspace, text, runtime);
      setSaved(text);
      await refresh();
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };

  const remove = async () => {
    if (!target) return;
    setBusy(true); setError("");
    try {
      await api.deleteDoc(target.path, workspace, target.withDir, runtime);
      setTarget(null); setText(""); setSaved("");
      await refresh();
    } catch (e) { setError(String(e)); } finally { setBusy(false); setConfirmDelete(false); }
  };

  const dirty = text !== saved;

  if (!workspace) return <div className="hint">Chọn một workspace bên trái.</div>;

  return (
    <>
      <div className="toolbar">
        <span className="title">{name}</span>
        <span className="path">{shortPath(workspace)}</span>
        <span className="sp" />
        <div className="seg">
          {TABS.map(([k, l]) => (
            <button key={k} className={tab === k ? "on" : ""} onClick={() => { setTab(k); setTarget(null); }}>
              {l}
              {k === "skills" && skills.length > 0 ? ` ${skills.length}` : ""}
              {k === "memory" && memories.length > 0 ? ` ${memories.length}` : ""}
            </button>
          ))}
        </div>
        <button className="btn" onClick={refresh}>Tải lại</button>
      </div>

      {error && <div className="banner err"><span>{error}</span></div>}

      <div className="split">
        <div className="split-list">
          {tab === "prompt" && docs.map((d) => (
            <button key={d.path} className={"item" + (target?.path === d.path ? " on" : "")}
                    onClick={() => open({ path: d.path, title: d.scope, subtitle: d.path, canDelete: d.exists, withDir: false }, d.exists)}>
              <span className="t">{d.scope}{d.exists ? "" : " · chưa có"}</span>
              <span className="d">{d.note}</span>
              <span className="m">{d.exists ? `${fmtBytes(d.bytes)} · ${ago(d.updatedAtMs)} trước` : "bấm để tạo"}</span>
            </button>
          ))}

          {tab === "skills" && skills.length === 0 && (
            <div className="hint">Workspace này chưa có skill nào.<br />Skill nằm ở <code>.claude/skills/</code>.</div>
          )}
          {tab === "skills" && skills.map((s) => (
            <button key={s.path} className={"item" + (target?.path === s.path ? " on" : "")}
                    onClick={() => open({ path: s.path, title: s.name, subtitle: s.path, canDelete: true, withDir: s.extraFiles > 0 || s.path.endsWith("/SKILL.md") })}>
              <span className="t">{s.name} <em>{s.scope}</em></span>
              <span className="d">{s.description || "(không có mô tả)"}</span>
              <span className="m">
                {fmtBytes(s.bytes)}
                {s.extraFiles > 0 ? ` · +${s.extraFiles} tệp kèm` : ""}
                {s.allowedTools ? ` · ${s.allowedTools}` : ""}
              </span>
            </button>
          ))}

          {tab === "memory" && memories.length === 0 && (
            <div className="hint">
              Chưa có ghi nhớ nào cho workspace này.<br />
              Claude ghi vào <code>~/.claude/projects/…/memory/</code> khi bạn bảo nó nhớ một thói quen hay ràng buộc.
            </div>
          )}
          {tab === "memory" && memories.map((m) => (
            <button key={m.path} className={"item" + (target?.path === m.path ? " on" : "")}
                    onClick={() => open({ path: m.path, title: m.name, subtitle: m.path, canDelete: !m.isIndex, withDir: false })}>
              <span className="t">{m.name} {m.kind && <em>{m.kind}</em>}</span>
              <span className="d">{m.description || "(không có mô tả)"}</span>
              <span className="m">{fmtBytes(m.bytes)} · {ago(m.updatedAtMs)} trước</span>
            </button>
          ))}
        </div>

        <div className="split-editor">
          {!target ? (
            <div className="empty-main"><p>Chọn một mục bên trái để xem và sửa.</p></div>
          ) : (
            <>
              <div className="ed-head">
                <b>{target.title}</b>
                <span className="path">{shortPath(target.subtitle)}</span>
                <span className="sp" />
                {target.canDelete &&
                  (confirmDelete ? (
                    <>
                      <span style={{ color: "var(--danger)", fontSize: 12 }}>Xoá hẳn?</span>
                      <button className="btn danger" onClick={remove} disabled={busy}>Xoá thật</button>
                      <button className="btn ghost" onClick={() => setConfirmDelete(false)}>Huỷ</button>
                    </>
                  ) : (
                    <button className="btn ghost danger-text" onClick={() => setConfirmDelete(true)}>Xoá</button>
                  ))}
                <button className="btn ghost" onClick={() => setText(saved)} disabled={!dirty}>Hoàn tác</button>
                <button className="btn primary" onClick={save} disabled={!dirty || busy}>
                  {busy ? "Đang lưu…" : dirty ? "Lưu" : "Đã lưu"}
                </button>
              </div>
              <textarea className="ed" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)}
                        placeholder="Tệp trống — gõ nội dung rồi bấm Lưu để tạo." />
            </>
          )}
        </div>
      </div>
    </>
  );
}
