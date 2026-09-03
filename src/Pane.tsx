import { useEffect, useRef, useState } from "react";
import { Terminal, type IMarker } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { listen } from "@tauri-apps/api/event";
import { api, shortPath } from "./api";
import type { Palette } from "./themes";

export type Block = { id: number; cmd: string; exit: number | null; at: number; cwd: string; marker: IMarker | undefined };

/** Text the user typed: everything between the OSC 133;B mark and the cursor. */
function readCommand(term: Terminal, start: { y: number; x: number } | null) {
  if (!start) return "";
  const buf = term.buffer.active;
  const end = buf.baseY + buf.cursorY;
  let out = "";
  for (let y = start.y; y <= end; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    out += y === start.y ? line.translateToString(true, start.x) : line.translateToString(true);
  }
  return out.trim();
}

export default function Pane({
  id, cwd, runtime, focused, palette, onFocus, onBlocks, onCwd, onReady,
}: {
  id: string; cwd: string; runtime: string; focused: boolean; palette: Palette;
  onFocus: () => void; onBlocks: (b: Block[]) => void; onCwd: (c: string) => void;
  onReady: (term: Terminal) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [dead, setDead] = useState(false);

  useEffect(() => {
    const term = new Terminal({
      fontFamily: 'ui-monospace, "JetBrains Mono", "SFMono-Regular", Menlo, Consolas, monospace',
      fontSize: 12.5, lineHeight: 1.25, theme: palette, cursorBlink: true,
      scrollback: 12000, allowProposedApi: true, macOptionIsMeta: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(host.current!);
    fit.fit();

    // --- OSC 133 command blocks -------------------------------------------
    let seq = 0;
    let promptEnd: { y: number; x: number } | null = null;
    let pending: Block | null = null;
    const blocks: Block[] = [];
    let paneCwd = cwd;

    const decorate = (b: Block) => {
      if (!b.marker) return;
      const dec = term.registerDecoration({ marker: b.marker, x: 0, width: 1 });
      dec?.onRender((el) => {
        el.style.cssText =
          "width:4px;margin-left:-8px;border-radius:2px;background:var(" +
          (b.exit === 0 ? "--ok" : b.exit === null ? "--faint" : "--danger") +
          ")";
      });
    };

    term.parser.registerOscHandler(133, (data) => {
      const [kind, arg] = data.split(";");
      const buf = term.buffer.active;
      if (kind === "A") {
        // A prompt that never ran a command leaves nothing worth keeping.
        pending = { id: ++seq, cmd: "", exit: null, at: Date.now(), cwd: paneCwd, marker: term.registerMarker(0) };
      } else if (kind === "B") {
        promptEnd = { y: buf.baseY + buf.cursorY, x: buf.cursorX };
      } else if (kind === "C") {
        if (pending) { pending.cmd = readCommand(term, promptEnd); pending.at = Date.now(); }
      } else if (kind === "D" && pending?.cmd) {
        pending.exit = Number(arg ?? 0);
        decorate(pending);
        blocks.unshift(pending);
        blocks.splice(50);
        onBlocks([...blocks]);
        pending = null;
      }
      return true;
    });
    term.parser.registerOscHandler(9, (data) => {
      if (!data.startsWith("9;")) return false;
      paneCwd = data.slice(2);
      onCwd(paneCwd);
      return true;
    });

    // --- wiring ------------------------------------------------------------
    // The listeners must be attached *before* the PTY starts, or the shell's
    // first write — the banner and prompt — races the subscription and is lost.
    let disposed = false;
    const unlisteners: (() => void)[] = [];
    term.onData((d) => void api.ptyWrite(id, d).catch(() => setDead(true)));
    void (async () => {
      try {
        unlisteners.push(await listen<string>(`pty:${id}`, (e) => term.write(e.payload)));
        unlisteners.push(
          await listen(`pty-exit:${id}`, () => {
            setDead(true);
            term.write("\r\n\x1b[2m— phiên đã kết thúc —\x1b[0m\r\n");
          }),
        );
        if (disposed) return;
        await api.ptyOpen(id, cwd, term.cols, term.rows, runtime);
        if (disposed) return;
        onReady(term);
      } catch (e) {
        term.write(`\r\n\x1b[31mKhông mở được terminal: ${e}\x1b[0m\r\n`);
        setDead(true);
      }
    })();

    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        try { fit.fit(); } catch { /* hidden pane */ }
        void api.ptyResize(id, term.cols, term.rows).catch(() => {});
      });
    });
    ro.observe(host.current!);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      unlisteners.forEach((f) => f());
      void api.ptyClose(id);
      term.dispose();
    };
    // Panes are keyed by id; cwd is fixed for the life of one pane.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  return (
    <div className={"term" + (dead ? " dead" : "")} ref={host} onMouseDown={onFocus}
         style={{ opacity: dead ? 0.55 : 1 }} data-focused={focused} />
  );
}

export function BlockList({ blocks, onJump }: { blocks: Block[]; onJump: (b: Block) => void }) {
  if (!blocks.length) return <div className="blocks"><div className="empty">Chưa có lệnh nào được ghi nhận.<br />Shell integration đánh dấu từng lệnh khi bạn chạy.</div></div>;
  return (
    <div className="blocks">
      {blocks.map((b) => (
        <div className="b" key={b.id} onClick={() => onJump(b)} title={b.cwd}>
          <span className="ec" style={{ color: b.exit === 0 ? "var(--ok)" : "var(--danger)" }}>
            {b.exit === 0 ? "✓" : b.exit}
          </span>
          <code>{b.cmd}</code>
          <span className="ec" style={{ color: "var(--faint)" }}>{shortPath(b.cwd).split("/").pop()}</span>
        </div>
      ))}
    </div>
  );
}
