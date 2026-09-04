import { THEMES, type Theme } from "./themes";

/** Grouped theme picker. Each row previews the palette it applies, so the
 *  choice is made by looking rather than by reading names. */
export default function SettingsView({
  current, onPick, restore, onRestore, notify, onNotify,
}: {
  current: string; onPick: (id: string) => void;
  restore: boolean; onRestore: (on: boolean) => void;
  notify: boolean; onNotify: (on: boolean) => void;
}) {
  const groups = [...new Set(THEMES.map((t) => t.group))];
  return (
    <>
      <div className="toolbar">
        <span className="title">Settings</span>
        <span className="path">themes apply to the app shell and the terminals alike</span>
      </div>
      <div className="scroll">
        <div className="usage">
          <div className="card">
            <h3>Sessions</h3>
            <div className="sub">takes effect the next time you open the app</div>
            <label className="opt">
              <input type="checkbox" checked={restore} onChange={(e) => onRestore(e.target.checked)} />
              <span>
                <b>Restore Claude sessions on launch</b>
                <i>
                  Each terminal remembers the Claude session it was running and re-opens it with
                  <code>claude --resume</code>. The old process does not survive a quit — what comes
                  back is the conversation, not the terminal's contents.
                </i>
              </span>
            </label>
            <label className="opt">
              <input type="checkbox" checked={notify} onChange={(e) => onNotify(e.target.checked)} />
              <span>
                <b>Notify me when an agent needs me</b>
                <i>
                  Sends a system notification and flashes the taskbar when a terminal turns
                  <b>waiting for you</b> or <b>done</b> — but only while the Agentspace window is
                  <b>not</b> focused. When you are looking straight at it, the status chip and the
                  inbox already say so.
                </i>
              </span>
            </label>
          </div>
          {groups.map((g) => (
            <div className="card" key={g}>
              <h3>Theme · {g}</h3>
              <div className="sub">{THEMES.filter((t) => t.group === g).length} palettes</div>
              <div className="themes">
                {THEMES.filter((t) => t.group === g).map((t) => (
                  <ThemeCard key={t.id} theme={t} on={t.id === current} onPick={() => onPick(t.id)} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function ThemeCard({ theme, on, onPick }: { theme: Theme; on: boolean; onPick: () => void }) {
  const t = theme.term;
  const swatches = [t.red, t.green, t.yellow, t.blue, t.magenta, t.cyan];
  return (
    <button className={"theme" + (on ? " on" : "")} onClick={onPick} title={theme.name}>
      <span className="prev" style={{ background: t.background, borderColor: theme.dark ? "#0006" : "#0002" }}>
        <span className="side" style={{ background: t.foreground, opacity: 0.08 }} />
        <span className="lines">
          <i style={{ background: theme.accent, width: "58%" }} />
          <i style={{ background: t.foreground, opacity: 0.55, width: "82%" }} />
          <i style={{ background: t.foreground, opacity: 0.3, width: "44%" }} />
        </span>
        <span className="dots">
          {swatches.map((c, i) => <i key={i} style={{ background: c }} />)}
        </span>
      </span>
      <span className="nm">{theme.name}{on ? " ✓" : ""}</span>
    </button>
  );
}
