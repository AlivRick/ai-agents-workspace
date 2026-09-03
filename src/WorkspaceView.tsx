import { useCallback, useEffect, useState } from "react";
import {
  ago, api, fmtBytes, shortPath,
  type Doc, type McpServer, type MemoryInfo, type PluginReport, type SkillInfo,
} from "./api";

type Tab = "prompt" | "skills" | "agents" | "commands" | "mcp" | "plugins" | "memory";
type Target = { path: string; title: string; subtitle: string; canDelete: boolean; withDir: boolean } | null;
/** A read-only item: MCP servers and plugins are configuration this app shows
 *  but does not own — installing a plugin is `/plugin` inside a session, and an
 *  MCP block holds credentials that should not be sitting in a textarea. */
type Detail = { title: string; subtitle: string; rows: [string, string][] } | null;

const TABS: [Tab, string][] = [
  ["prompt", "CLAUDE.md"], ["skills", "Skills"], ["agents", "Agents"], ["commands", "Lệnh"],
  ["mcp", "MCP"], ["plugins", "Plugin"], ["memory", "Memory"],
];

const stamp = (ms: number) => (ms > 0 ? `${ago(ms)} trước` : "—");

/** Everything that shapes how Claude behaves in this folder, in one place:
 *  the root prompt, the skills, subagents, slash commands, MCP servers and
 *  plugins it can reach, and what it remembers. */
export default function WorkspaceView({ workspace, name, runtime }: { workspace: string; name: string; runtime: string }) {
  const [tab, setTab] = useState<Tab>("prompt");
  const [docs, setDocs] = useState<Doc[]>([]);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [agents, setAgents] = useState<SkillInfo[]>([]);
  const [commands, setCommands] = useState<SkillInfo[]>([]);
  const [mcp, setMcp] = useState<McpServer[]>([]);
  const [plugins, setPlugins] = useState<PluginReport>({ plugins: [], marketplaces: [] });
  const [memories, setMemories] = useState<MemoryInfo[]>([]);
  const [target, setTarget] = useState<Target>(null);
  const [detail, setDetail] = useState<Detail>(null);
  const [text, setText] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const refresh = useCallback(async () => {
    if (!workspace) return;
    // One rejected read used to blank every tab at once, silently. Now the
    // banner says which one failed and the rest still render.
    try {
      const [d, s, a, c, m, p, mem] = await Promise.all([
        api.claudeDocs(workspace, runtime),
        api.listSkills(workspace, runtime),
        api.listAgents(workspace, runtime),
        api.listCommands(workspace, runtime),
        api.listMcp(workspace, runtime),
        api.listPlugins(runtime),
        api.listMemories(workspace, runtime),
      ]);
      setDocs(d); setSkills(s); setAgents(a); setCommands(c); setMcp(m); setPlugins(p); setMemories(mem);
    } catch (e) { setError(String(e)); }
  }, [workspace, runtime]);

  useEffect(() => { setTarget(null); setDetail(null); setText(""); setSaved(""); setError(""); refresh(); }, [refresh]);

  const open = async (t: NonNullable<Target>, exists = true) => {
    setError(""); setConfirmDelete(false); setDetail(null); setTarget(t);
    if (!exists) { setText(""); setSaved(""); return; }
    try {
      const c = await api.readDoc(t.path, workspace, runtime);
      setText(c); setSaved(c);
    } catch (e) { setError(String(e)); setText(""); setSaved(""); }
  };

  const show = (d: NonNullable<Detail>) => { setError(""); setTarget(null); setDetail(d); };

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
  const count: Partial<Record<Tab, number>> = {
    skills: skills.length, agents: agents.length, commands: commands.length,
    mcp: mcp.length, plugins: plugins.plugins.length, memory: memories.length,
  };

  /** Agents, commands and skills are all markdown with frontmatter, so they
   *  share one row and one editor. */
  const mdRow = (s: SkillInfo, meta?: string) => (
    <button key={s.path} className={"item" + (target?.path === s.path ? " on" : "")}
            onClick={() => open({
              path: s.path, title: s.name, subtitle: s.path, canDelete: true,
              withDir: s.extraFiles > 0 || s.path.endsWith("/SKILL.md"),
            })}>
      <span className="t">{s.name} <em>{s.scope}</em></span>
      <span className="d">{s.description || "(không có mô tả)"}</span>
      <span className="m">
        {fmtBytes(s.bytes)}
        {meta ? ` · ${meta}` : ""}
        {s.allowedTools ? ` · ${s.allowedTools}` : ""}
      </span>
    </button>
  );

  if (!workspace) return <div className="hint">Chọn một workspace bên trái.</div>;

  return (
    <>
      <div className="toolbar">
        <span className="title">{name}</span>
        <span className="path">{shortPath(workspace)}</span>
        <span className="sp" />
        <div className="seg">
          {TABS.map(([k, l]) => (
            <button key={k} className={tab === k ? "on" : ""}
                    onClick={() => { setTab(k); setTarget(null); setDetail(null); }}>
              {l}{count[k] ? ` ${count[k]}` : ""}
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
              <span className="m">{d.exists ? `${fmtBytes(d.bytes)} · ${stamp(d.updatedAtMs)}` : "bấm để tạo"}</span>
            </button>
          ))}

          {tab === "skills" && skills.length === 0 && (
            <div className="hint">Workspace này chưa có skill nào.<br />Skill nằm ở <code>.claude/skills/</code>.</div>
          )}
          {tab === "skills" && skills.map((s) => mdRow(s, s.extraFiles > 0 ? `+${s.extraFiles} tệp kèm` : ""))}

          {tab === "agents" && agents.length === 0 && (
            <div className="hint">
              Chưa có subagent nào.<br />
              Agent nằm ở <code>.claude/agents/</code> của workspace hoặc <code>~/.claude/agents/</code>.
            </div>
          )}
          {tab === "agents" && agents.map((a) => mdRow(a, a.meta))}

          {tab === "commands" && commands.length === 0 && (
            <div className="hint">
              Chưa có lệnh gạch chéo nào.<br />
              Lệnh nằm ở <code>.claude/commands/</code>; thư mục con thành namespace <code>/thư-mục:lệnh</code>.
            </div>
          )}
          {tab === "commands" && commands.map((c) => mdRow(c, c.meta))}

          {tab === "mcp" && mcp.length === 0 && (
            <div className="hint">Không có MCP server nào áp cho workspace này.</div>
          )}
          {tab === "mcp" && mcp.map((s) => (
            <button key={s.scope + s.name} className={"item" + (detail?.title === s.name ? " on" : "")}
                    onClick={() => show({
                      title: s.name,
                      subtitle: s.source,
                      rows: [
                        ["Phạm vi", s.scope],
                        ["Giao thức", s.transport],
                        [s.transport === "stdio" ? "Lệnh" : "URL", s.target],
                        ["Tham số", s.args.join("\n") || "—"],
                        ["Biến môi trường", s.envKeys.join(", ") || "—"],
                        ["Khai báo trong", s.source],
                      ],
                    })}>
              <span className="t">{s.name} <em>{s.transport}</em></span>
              <span className="d">{s.target}</span>
              <span className="m">{s.scope}{s.envKeys.length ? ` · ${s.envKeys.length} biến môi trường` : ""}</span>
            </button>
          ))}

          {tab === "plugins" && plugins.plugins.length === 0 && plugins.marketplaces.length === 0 && (
            <div className="hint">Chưa cài plugin nào. Cài bằng <code>/plugin</code> trong một phiên Claude Code.</div>
          )}
          {tab === "plugins" && plugins.plugins.map((p) => (
            <button key={p.installPath} className={"item" + (detail?.title === p.name ? " on" : "")}
                    onClick={() => show({
                      title: p.name,
                      subtitle: p.installPath,
                      rows: [
                        ["Marketplace", p.marketplace || "—"],
                        ["Phiên bản", p.version || "—"],
                        ["Phạm vi", p.scope || "—"],
                        ["Gồm", p.parts.join(" · ") || "—"],
                        ["Cài lúc", stamp(p.installedAtMs)],
                        ["Cập nhật", stamp(p.updatedAtMs)],
                        ["Thư mục", p.installPath],
                      ],
                    })}>
              <span className="t">{p.name} <em>{p.marketplace}</em></span>
              <span className="d">{p.description || "(không có mô tả)"}</span>
              <span className="m">{p.parts.join(" · ") || "không rõ nội dung"} · {stamp(p.updatedAtMs)}</span>
            </button>
          ))}
          {tab === "plugins" && plugins.marketplaces.map((m) => (
            <button key={m.path} className={"item" + (detail?.title === m.name ? " on" : "")}
                    onClick={() => show({
                      title: m.name,
                      subtitle: m.path,
                      rows: [["Nguồn", m.source || "—"], ["Thư mục", m.path], ["Cập nhật", stamp(m.updatedAtMs)]],
                    })}>
              <span className="t">{m.name} <em>marketplace</em></span>
              <span className="d">{m.source || "(không rõ nguồn)"}</span>
              <span className="m">cập nhật {stamp(m.updatedAtMs)}</span>
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
              <span className="m">{fmtBytes(m.bytes)} · {stamp(m.updatedAtMs)}</span>
            </button>
          ))}
        </div>

        <div className="split-editor">
          {detail ? (
            <>
              <div className="ed-head">
                <b>{detail.title}</b>
                <span className="path">{shortPath(detail.subtitle)}</span>
                <span className="sp" />
                <span className="hint" style={{ padding: 0, fontSize: 11 }}>chỉ đọc</span>
              </div>
              <div className="scroll">
                <dl className="facts">
                  {detail.rows.map(([k, v]) => (
                    <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
                  ))}
                </dl>
                <p className="note">
                  Giá trị biến môi trường và mật khẩu trong URL không bao giờ được hiển thị — chúng ở lại
                  trong tệp cấu hình. Sửa MCP hay cài plugin thì làm trong phiên Claude Code
                  (<code>/mcp</code>, <code>/plugin</code>).
                </p>
              </div>
            </>
          ) : !target ? (
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
