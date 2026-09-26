import { useEffect, useRef, useState } from "react";
import { basicSetup } from "codemirror";
import { indentWithTab } from "@codemirror/commands";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { MergeView, getChunks, getOriginalDoc, unifiedMergeView, updateOriginalDoc } from "@codemirror/merge";
import { ChangeSet, Compartment, EditorState, Text, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { vscodeDark } from "@uiw/codemirror-theme-vscode";

/**
 * VS Code's diff editor: the whole file on both sides, syntax colours, lines
 * aligned with hatched filler, changed words marked darker inside changed
 * lines. `split` false is its inline mode. When `editable`, the right side is
 * the working file — type in it, Ctrl+S saves, and the arrows between the
 * columns revert a change, as in VS Code. The strip on the right is its
 * overview ruler: every change as a red (old) or green (new) mark, the visible
 * part shaded; click or drag on it to scroll there.
 */
export default function DiffEditor({ file, old, value, editable, split, onChange, onSave }: {
  file: string; old: string; value: string; editable: boolean; split: boolean;
  onChange: (v: string) => void; onSave: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const cur = useRef<{ a?: EditorView; b: EditorView; destroy: () => void } | null>(null);
  const cb = useRef({ onChange, onSave });
  cb.current = { onChange, onSave };
  /** Ruler marks and the shaded viewport, as fractions of the document height. */
  const [marks, setMarks] = useState<{ top: number; h: number; lane: "a" | "b" }[]>([]);
  const [port, setPort] = useState({ top: 0, h: 1 });
  const geo = useRef<{ scroller: HTMLElement; measure: () => void } | null>(null);

  useEffect(() => {
    const langs: [EditorView, Compartment][] = [];
    const side = (v: string, edit: boolean, extra: Extension = []) => {
      const lang = new Compartment();
      return {
        lang,
        state: {
          doc: v,
          extensions: [
            basicSetup, vscodeDark, lang.of([]), extra,
            EditorView.updateListener.of((u) => (u.docChanged || u.geometryChanged) && requestAnimationFrame(() => geo.current?.measure())),
            EditorState.readOnly.of(!edit), EditorView.editable.of(edit),
            edit ? [
              keymap.of([indentWithTab, { key: "Mod-s", preventDefault: true, run: () => (cb.current.onSave(), true) }]),
              EditorView.updateListener.of((u) => u.docChanged && cb.current.onChange(u.state.doc.toString())),
            ] : [],
          ],
        },
      };
    };
    const b = side(value, editable, split ? [] : unifiedMergeView({ original: old, mergeControls: false, gutter: true }));
    if (split) {
      const a = side(old, false);
      const mv = new MergeView({
        a: a.state, b: b.state, parent: host.current!, gutter: true, highlightChanges: true,
        revertControls: editable ? "a-to-b" : undefined,
      });
      langs.push([mv.a, a.lang], [mv.b, b.lang]);
      cur.current = { a: mv.a, b: mv.b, destroy: () => mv.destroy() };
    } else {
      const v = new EditorView({ parent: host.current!, state: EditorState.create(b.state) });
      langs.push([v, b.lang]);
      cur.current = { b: v, destroy: () => v.destroy() };
    }
    const mine = cur.current;
    const scroller = split ? (mine.a!.dom.closest(".cm-mergeView") as HTMLElement) : mine.b.scrollDOM;
    const measure = () => {
      if (cur.current !== mine) return;
      const { a, b } = mine;
      const H = b.contentHeight || 1;
      // A chunk's `to` points past its last newline, so step back one and clamp.
      const at = (v: EditorView, from: number, to: number) => {
        const top = v.lineBlockAt(from).top;
        return { top: top / H, h: (v.lineBlockAt(Math.min(Math.max(from, to - 1), v.state.doc.length)).bottom - top) / H };
      };
      const out: typeof marks = [];
      for (const c of getChunks(b.state)?.chunks ?? []) {
        // Inline mode has no old editor: the deleted lines sit above fromB.
        if (c.toA > c.fromA) out.push({ lane: "a", ...(a ? at(a, c.fromA, c.toA) : at(b, c.fromB, c.fromB)) });
        if (c.toB > c.fromB) out.push({ lane: "b", ...at(b, c.fromB, c.toB) });
      }
      setMarks(out);
      setPort({ top: scroller.scrollTop / scroller.scrollHeight, h: scroller.clientHeight / scroller.scrollHeight });
    };
    geo.current = { scroller, measure };
    scroller.addEventListener("scroll", measure, { passive: true });
    requestAnimationFrame(measure);
    const desc = LanguageDescription.matchFilename(languages, file.split(/[\\/]/).pop() ?? file);
    desc?.load().then((l) => cur.current === mine && langs.forEach(([v, c]) => v.dispatch({ effects: c.reconfigure(l) })));
    return () => { scroller.removeEventListener("scroll", measure); mine.destroy(); cur.current = null; geo.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, split, editable]);

  // The poll brought a newer copy of either side.
  useEffect(() => {
    const v = cur.current?.b;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);
  useEffect(() => {
    const c = cur.current;
    if (!c) return;
    if (c.a) {
      if (c.a.state.doc.toString() !== old) c.a.dispatch({ changes: { from: 0, to: c.a.state.doc.length, insert: old } });
      return;
    }
    const prev = getOriginalDoc(c.b.state);
    if (prev.toString() === old) return;
    const doc = Text.of(old.split("\n"));
    c.b.dispatch({ effects: updateOriginalDoc.of({ doc, changes: ChangeSet.of({ from: 0, to: prev.length, insert: doc }, prev.length) }) });
  }, [old]);

  /** Centre the view on the ruler point under the mouse, and keep doing so while dragged. */
  const drag = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const go = (y: number) => {
      const s = geo.current?.scroller;
      if (s) s.scrollTop = ((y - r.top) / r.height) * s.scrollHeight - s.clientHeight / 2;
    };
    go(e.clientY);
    const move = (m: MouseEvent) => go(m.clientY);
    const up = () => { removeEventListener("mousemove", move); removeEventListener("mouseup", up); };
    addEventListener("mousemove", move);
    addEventListener("mouseup", up);
    e.preventDefault();
  };
  const pct = (f: number) => `${f * 100}%`;

  return (
    <div className="diff-ed">
      <div className="diff-host" ref={host} />
      <div className="ruler" onMouseDown={drag} title="Changes — click or drag to scroll">
        <div className="port" style={{ top: pct(port.top), height: pct(port.h) }} />
        {marks.map((m, i) => <div key={i} className={"rm " + m.lane} style={{ top: pct(m.top), height: pct(m.h) }} />)}
      </div>
    </div>
  );
}
