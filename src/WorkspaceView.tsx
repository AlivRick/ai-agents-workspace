import { useCallback, useEffect, useState } from "react";
import {
  ago, api, fmtBytes, shortPath,
  type Doc, type McpServer, type MemoryInfo, type PluginReport, type SkillInfo,
} from "./api";

export type Tab = "prompt" | "skills" | "agents" | "commands" | "mcp" | "plugins" | "memory";
type Target = { path: string; title: string; subtitle: string; canDelete: boolean; withDir: boolean } | null;
/** A read-only item: MCP servers and plugins are configuration this app shows
 *  but does not own — installing a plugin is `/plugin` inside a session, and an
 *  MCP block holds credentials that should not be sitting in a textarea. */
type Detail = { title: string; subtitle: string; rows: [string, string][] } | null;

/** Tab, tên, và một dòng nói tab đó là gì — sidebar dùng cả ba, nên nó nằm
 *  đây cạnh phần vẽ ra nội dung. */
export const TABS: { id: Tab; name: string; note: string }[] = [
  { id: "prompt", name: "CLAUDE.md", note: "Instructions Claude reads every session" },
  { id: "skills", name: "Skills", note: "Skills Claude loads when it needs them" },
  { id: "agents", name: "Subagents", note: "Helper agents for specialised work" },
  { id: "commands", name: "Slash commands", note: "Commands you define yourself" },
  { id: "mcp", name: "MCP", note: "External tool servers" },
  { id: "plugins", name: "Plugins", note: "Packages installed from a marketplace" },
  { id: "memory", name: "Memory", note: "What Claude remembers between sessions" },
];

const stamp = (ms: number) => (ms > 0 ? `${ago(ms)} ago` : "—");

/** Everything that shapes how Claude behaves in this folder, in one place:
 *  the root prompt, the skills, subagents, slash commands, MCP servers and
 *  plugins it can reach, and what it remembers. */
export default function WorkspaceView({ workspace, name, runtime, tab }: {
  workspace: string; name: string; runtime: string; tab: Tab;
}) {
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
  // Chuyển mục ở sidebar thì bỏ chọn theo — không thì trình soạn còn giữ tệp
  // của mục cũ trong khi danh sách bên trái đã là mục khác.
  useEffect(() => { setTarget(null); setDetail(null); setConfirmDelete(false); }, [tab]);

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
      <span className="d">{s.description || "(no description)"}</span>
      <span className="m">
        {fmtBytes(s.bytes)}
        {meta ? ` · ${meta}` : ""}
        {s.allowedTools ? ` · ${s.allowedTools}` : ""}
      </span>
    </button>
  );

  if (!workspace) return <div className="hint">Pick a workspace on the left.</div>;

  return (
    <>
      <div className="toolbar">
        <span className="title">{TABS.find((t) => t.id === tab)!.name}{count[tab] ? ` · ${count[tab]}` : ""}</span>
        <span className="path">{TABS.find((t) => t.id === tab)!.note} — {name}</span>
        <span className="sp" />
        <button className="btn" onClick={refresh}>Reload</button>
      </div>

      {error && <div className="banner err"><span>{error}</span></div>}

      <div className="split">
        <div className="split-list">
          {tab === "prompt" && docs.map((d) => (
            <button key={d.path} className={"item" + (target?.path === d.path ? " on" : "")}
                    onClick={() => open({ path: d.path, title: d.scope, subtitle: d.path, canDelete: d.exists, withDir: false }, d.exists)}>
              <span className="t">{d.scope}{d.exists ? "" : " · not created"}</span>
              <span className="d">{d.note}</span>
              <span className="m">{d.exists ? `${fmtBytes(d.bytes)} · ${stamp(d.updatedAtMs)}` : "click to create"}</span>
            </button>
          ))}

          {tab === "skills" && skills.length === 0 && (
            <div className="hint">This workspace has no skills yet.<br />Skills live in <code>.claude/skills/</code>.</div>
          )}
          {tab === "skills" && skills.map((s) => mdRow(s, s.extraFiles > 0 ? `+${s.extraFiles} bundled files` : ""))}

          {tab === "agents" && agents.length === 0 && (
            <div className="hint">
              No subagents yet.<br />
              They live in the workspace's <code>.claude/agents/</code> or in <code>~/.claude/agents/</code>.
            </div>
          )}
          {tab === "agents" && agents.map((a) => mdRow(a, a.meta))}

          {tab === "commands" && commands.length === 0 && (
            <div className="hint">
              No slash commands yet.<br />
              They live in <code>.claude/commands/</code>; a subfolder becomes a namespace, <code>/folder:command</code>.
            </div>
          )}
          {tab === "commands" && commands.map((c) => mdRow(c, c.meta))}

          {tab === "mcp" && mcp.length === 0 && (
            <div className="hint">No MCP server applies to this workspace.</div>
          )}
          {tab === "mcp" && mcp.map((s) => (
            <button key={s.scope + s.name} className={"item" + (detail?.title === s.name ? " on" : "")}
                    onClick={() => show({
                      title: s.name,
                      subtitle: s.source,
                      rows: [
                        ["Scope", s.scope],
                        ["Transport", s.transport],
                        [s.transport === "stdio" ? "Command" : "URL", s.target],
                        ["Arguments", s.args.join("\n") || "—"],
                        ["Environment", s.envKeys.join(", ") || "—"],
                        ["Declared in", s.source],
                      ],
                    })}>
              <span className="t">{s.name} <em>{s.transport}</em></span>
              <span className="d">{s.target}</span>
              <span className="m">{s.scope}{s.envKeys.length ? ` · ${s.envKeys.length} env vars` : ""}</span>
            </button>
          ))}

          {tab === "plugins" && plugins.plugins.length === 0 && plugins.marketplaces.length === 0 && (
            <div className="hint">No plugins installed. Install them with <code>/plugin</code> inside a Claude Code session.</div>
          )}
          {tab === "plugins" && plugins.plugins.map((p) => (
            <button key={p.installPath} className={"item" + (detail?.title === p.name ? " on" : "")}
                    onClick={() => show({
                      title: p.name,
                      subtitle: p.installPath,
                      rows: [
                        ["Marketplace", p.marketplace || "—"],
                        ["Version", p.version || "—"],
                        ["Scope", p.scope || "—"],
                        ["Contains", p.parts.join(" · ") || "—"],
                        ["Installed", stamp(p.installedAtMs)],
                        ["Updated", stamp(p.updatedAtMs)],
                        ["Folder", p.installPath],
                      ],
                    })}>
              <span className="t">{p.name} <em>{p.marketplace}</em></span>
              <span className="d">{p.description || "(no description)"}</span>
              <span className="m">{p.parts.join(" · ") || "contents unknown"} · {stamp(p.updatedAtMs)}</span>
            </button>
          ))}
          {tab === "plugins" && plugins.marketplaces.map((m) => (
            <button key={m.path} className={"item" + (detail?.title === m.name ? " on" : "")}
                    onClick={() => show({
                      title: m.name,
                      subtitle: m.path,
                      rows: [["Source", m.source || "—"], ["Folder", m.path], ["Updated", stamp(m.updatedAtMs)]],
                    })}>
              <span className="t">{m.name} <em>marketplace</em></span>
              <span className="d">{m.source || "(source unknown)"}</span>
              <span className="m">updated {stamp(m.updatedAtMs)}</span>
            </button>
          ))}

          {tab === "memory" && memories.length === 0 && (
            <div className="hint">
              No memories for this workspace yet.<br />
              Claude writes to <code>~/.claude/projects/…/memory/</code> when you ask it to remember a habit or a constraint.
            </div>
          )}
          {tab === "memory" && memories.map((m) => (
            <button key={m.path} className={"item" + (target?.path === m.path ? " on" : "")}
                    onClick={() => open({ path: m.path, title: m.name, subtitle: m.path, canDelete: !m.isIndex, withDir: false })}>
              <span className="t">{m.name} {m.kind && <em>{m.kind}</em>}</span>
              <span className="d">{m.description || "(no description)"}</span>
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
                <span className="hint" style={{ padding: 0, fontSize: 11 }}>read-only</span>
              </div>
              <div className="scroll">
                <dl className="facts">
                  {detail.rows.map(([k, v]) => (
                    <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
                  ))}
                </dl>
                <p className="note">
                  Environment values and passwords inside URLs are never shown — they stay in the
                  config file. Edit MCP servers or install plugins from inside a Claude Code session
                  (<code>/mcp</code>, <code>/plugin</code>).
                </p>
              </div>
            </>
          ) : !target ? (
            <div className="empty-main"><p>Pick an item on the left to view and edit it.</p></div>
          ) : (
            <>
              <div className="ed-head">
                <b>{target.title}</b>
                <span className="path">{shortPath(target.subtitle)}</span>
                <span className="sp" />
                {target.canDelete &&
                  (confirmDelete ? (
                    <>
                      <span style={{ color: "var(--danger)", fontSize: 12 }}>Delete for good?</span>
                      <button className="btn danger" onClick={remove} disabled={busy}>Delete</button>
                      <button className="btn ghost" onClick={() => setConfirmDelete(false)}>Cancel</button>
                    </>
                  ) : (
                    <button className="btn ghost danger-text" onClick={() => setConfirmDelete(true)}>Delete</button>
                  ))}
                <button className="btn ghost" onClick={() => setText(saved)} disabled={!dirty}>Revert</button>
                <button className="btn primary" onClick={save} disabled={!dirty || busy}>
                  {busy ? "Saving…" : dirty ? "Save" : "Saved"}
                </button>
              </div>
              <textarea className="ed" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)}
                        placeholder="Empty file — type something and press Save to create it." />
            </>
          )}
        </div>
      </div>
    </>
  );
}
