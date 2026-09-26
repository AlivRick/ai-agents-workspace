import { useEffect, useRef, useState } from "react";
import { basicSetup } from "codemirror";
import { indentWithTab } from "@codemirror/commands";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Compartment, EditorState, RangeSet, StateEffect, StateField } from "@codemirror/state";
import { EditorView, GutterMarker, gutter, keymap } from "@codemirror/view";
import { vscodeDark } from "@uiw/codemirror-theme-vscode";
import { lineMarks, type Mark } from "./gutter";
import ScrollRuler from "./ScrollRuler";

class Bar extends GutterMarker {
  constructor(readonly kind: Mark) { super(); }
  eq(o: Bar) { return o.kind === this.kind; }
  toDOM() { const d = document.createElement("div"); d.className = "cm-chg " + this.kind; return d; }
}
const BARS = { add: new Bar("add"), mod: new Bar("mod"), del: new Bar("del") };

/** What the change bars compare against: HEAD's text, `null` for a new file,
 *  `undefined` for "no bars" (not a repo, an ignored file, still loading). */
const setBase = StateEffect.define<string | null | undefined>();
const base = StateField.define<string | null | undefined>({
  create: () => undefined,
  update: (v, tr) => tr.effects.reduce((a, e) => (e.is(setBase) ? e.value : a), v),
});
const bars = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(v, tr) {
    const b = tr.state.field(base);
    if (!tr.docChanged && !tr.effects.some((e) => e.is(setBase))) return v;
    if (b === undefined) return RangeSet.empty;
    const doc = tr.state.doc;
    const marks = [...lineMarks(b, doc)].sort((x, y) => x[0] - y[0]);
    return RangeSet.of(marks.map(([n, k]) => BARS[k].range(doc.line(n).from)));
  },
});
const changeGutter = [base, bars, gutter({ class: "cm-chg-gutter", markers: (v) => v.state.field(bars) })];

/**
 * The code editor: VS Code's dark theme, line numbers, syntax colours picked
 * by file name, folding, search (Ctrl+F), and the green/blue/red change bars
 * against HEAD. One view per file — `key` it by path.
 *
 * ponytail: always the VS Code Dark colours, whichever of the app's themes is
 * on. The upgrade path is a light theme compartment switched with the app's.
 */
export default function CodeEditor({ file, value, original, onChange, onSave }: {
  file: string; value: string; original: string | null | undefined;
  onChange: (v: string) => void; onSave: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const lang = useRef(new Compartment());
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  // The view is built once; these keep its callbacks pointing at the latest props.
  const cb = useRef({ onChange, onSave });
  cb.current = { onChange, onSave };

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          changeGutter, // after basicSetup, so the bars sit right of the line numbers
          vscodeDark,
          lang.current.of([]),
          keymap.of([indentWithTab, { key: "Mod-s", preventDefault: true, run: () => (cb.current.onSave(), true) }]),
          EditorView.updateListener.of((u) => u.docChanged && cb.current.onChange(u.state.doc.toString())),
        ],
      }),
    });
    view.current = v;
    setScroller(v.scrollDOM);
    const desc = LanguageDescription.matchFilename(languages, file.split(/[\\/]/).pop() ?? file);
    desc?.load().then((l) => view.current === v && v.dispatch({ effects: lang.current.reconfigure(l) }));
    return () => { v.destroy(); view.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  // The file changed on disk (an agent wrote it) and the parent re-read it.
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    // `git show` loses the final newline; put it back when the file has one,
    // or every file would show its last line as changed.
    const o = typeof original === "string" && value.endsWith("\n") && !original.endsWith("\n") ? original + "\n" : original;
    v.dispatch({ effects: setBase.of(o) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [original, file]);

  return (
    <div className="code-ed">
      <div className="code-host" ref={host} />
      <ScrollRuler target={scroller} />
    </div>
  );
}
