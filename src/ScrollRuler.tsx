import { useEffect, useState } from "react";

/** A mark on the ruler, as fractions of the document height. */
export type RulerMark = { top: number; h: number; lane: "a" | "b" };

/**
 * VS Code's wide scrollbar (its overview ruler), standing in for `target`'s
 * own thin one, which it hides: the visible part shaded, optional marks, and
 * the whole strip is grab-able — click to jump there, drag the shaded part to
 * scroll. The parent places it (`.ruler`) beside or over the scroller.
 */
export default function ScrollRuler({ target, marks = [] }: { target: HTMLElement | null; marks?: RulerMark[] }) {
  const [port, setPort] = useState({ top: 0, h: 1 });

  useEffect(() => {
    if (!target) return;
    target.classList.add("ruled");
    const m = () => setPort({ top: target.scrollTop / target.scrollHeight, h: Math.min(1, target.clientHeight / target.scrollHeight) });
    m();
    target.addEventListener("scroll", m, { passive: true });
    // Content grows without a scroll event (terminal output, typing, a file
    // swapped in): watch the scroller's children too.
    const ro = new ResizeObserver(m);
    ro.observe(target);
    for (const c of target.children) ro.observe(c);
    return () => { target.removeEventListener("scroll", m); ro.disconnect(); target.classList.remove("ruled"); };
  }, [target]);

  const drag = (e: React.MouseEvent<HTMLDivElement>) => {
    const t = target;
    if (!t || e.button !== 0) return;
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    const f = (e.clientY - r.top) / r.height;
    // Outside the shaded part: jump so the point is centred, then drag from there.
    if (f < port.top || f > port.top + port.h) t.scrollTop = f * t.scrollHeight - t.clientHeight / 2;
    const y0 = e.clientY;
    const s0 = t.scrollTop;
    const move = (ev: MouseEvent) => { t.scrollTop = s0 + ((ev.clientY - y0) / r.height) * t.scrollHeight; };
    const up = () => { removeEventListener("mousemove", move); removeEventListener("mouseup", up); };
    addEventListener("mousemove", move);
    addEventListener("mouseup", up);
  };
  const pct = (f: number) => `${f * 100}%`;

  return (
    <div className="ruler" onMouseDown={drag}>
      {port.h < 1 && <div className="port" style={{ top: pct(port.top), height: pct(port.h) }} />}
      {marks.map((m, i) => <div key={i} className={"rm " + m.lane} style={{ top: pct(m.top), height: pct(m.h) }} />)}
    </div>
  );
}
