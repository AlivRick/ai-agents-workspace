import { THEMES, type Theme } from "./themes";

/** Grouped theme picker. Each row previews the palette it applies, so the
 *  choice is made by looking rather than by reading names. */
export default function SettingsView({
  current, onPick, restore, onRestore,
}: {
  current: string; onPick: (id: string) => void;
  restore: boolean; onRestore: (on: boolean) => void;
}) {
  const groups = [...new Set(THEMES.map((t) => t.group))];
  return (
    <>
      <div className="toolbar">
        <span className="title">Cài đặt</span>
        <span className="path">giao diện áp cho cả vỏ ứng dụng lẫn terminal</span>
      </div>
      <div className="scroll">
        <div className="usage">
          <div className="card">
            <h3>Phiên làm việc</h3>
            <div className="sub">áp dụng cho lần mở app kế tiếp</div>
            <label className="opt">
              <input type="checkbox" checked={restore} onChange={(e) => onRestore(e.target.checked)} />
              <span>
                <b>Khôi phục phiên Claude khi mở lại</b>
                <i>
                  Mỗi pane nhớ phiên Claude đang chạy và tự <code>claude --resume</code> khi mở app.
                  Tiến trình cũ không sống sót qua lần đóng app — cái khôi phục được là phiên trò chuyện,
                  không phải nội dung terminal.
                </i>
              </span>
            </label>
          </div>
          {groups.map((g) => (
            <div className="card" key={g}>
              <h3>Giao diện · {g}</h3>
              <div className="sub">{THEMES.filter((t) => t.group === g).length} bộ màu</div>
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
