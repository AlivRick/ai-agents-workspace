import { useEffect, useRef, useState } from "react";
import { basicSetup } from "codemirror";
import { indentWithTab } from "@codemirror/commands";
import { selectSelectionMatches } from "@codemirror/search";
import { findReferences, formatDocument, jumpToDefinition, jumpToImplementation, jumpToTypeDefinition, renameSymbol } from "@codemirror/lsp-client";
import { Menu, type Item } from "./ScmMenu";
import { lspFor } from "./lsp";
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
export default function CodeEditor({ file, value, original, onChange, onSave, root, runtime, onLspFail }: {
  file: string; value: string; original: string | null | undefined;
  onChange: (v: string) => void; onSave: () => void;
  /** Workspace and runtime the language server runs in (see lsp.ts). */
  root: string; runtime: string; onLspFail: (why: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const lang = useRef(new Compartment());
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const lsp = useRef(new Compartment());
  /** A language server is attached: its menu entries work. */
  const [smart, setSmart] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // The view is built once; these keep its callbacks pointing at the latest props.
  const cb = useRef({ onChange, onSave, root, runtime, onLspFail });
  cb.current = { onChange, onSave, root, runtime, onLspFail };

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
          lsp.current.of([]),
          // VS Code's keys. The LSP ones do nothing until a server is attached.
          keymap.of([
            indentWithTab, { key: "Mod-s", preventDefault: true, run: () => (cb.current.onSave(), true) },
            { key: "F12", run: jumpToDefinition }, { key: "Mod-F12", run: jumpToImplementation },
            { key: "Shift-F12", run: findReferences }, { key: "F2", run: renameSymbol },
            { key: "Shift-Alt-f", run: formatDocument }, { key: "Mod-F2", run: selectSelectionMatches },
          ]),
          EditorView.updateListener.of((u) => u.docChanged && cb.current.onChange(u.state.doc.toString())),
        ],
      }),
    });
    view.current = v;
    setScroller(v.scrollDOM);
    const desc = LanguageDescription.matchFilename(languages, file.split(/[\\/]/).pop() ?? file);
    desc?.load().then((l) => view.current === v && v.dispatch({ effects: lang.current.reconfigure(l) }));
    setSmart(false);
    lspFor(cb.current.root, cb.current.runtime, file, cb.current.onLspFail).then((ext) => {
      if (!ext || view.current !== v) return;
      v.dispatch({ effects: lsp.current.reconfigure(ext) });
      setSmart(true);
    }).catch((e) => cb.current.onLspFail(String(e)));
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

  /** Run an editor command from the menu, on the editor, where the click was. */
  const cmd = (f: (v: EditorView) => boolean) => () => { const v = view.current; if (v) { v.focus(); f(v); } };
  const items: Item[] = [
    { label: "Go to Definition", key: "F12", disabled: !smart, run: cmd(jumpToDefinition) },
    { label: "Go to Type Definition", disabled: !smart, run: cmd(jumpToTypeDefinition) },
    { label: "Go to Implementations", key: "Ctrl+F12", disabled: !smart, run: cmd(jumpToImplementation) },
    { label: "Go to References", key: "Shift+F12", disabled: !smart, run: cmd(findReferences) },
    "-",
    { label: "Rename Symbol", key: "F2", disabled: !smart, run: cmd(renameSymbol) },
    { label: "Change All Occurrences", key: "Ctrl+F2", run: cmd(selectSelectionMatches) },
    { label: "Format Document", key: "Shift+Alt+F", disabled: !smart, run: cmd(formatDocument) },
    "-",
    { label: "Cut", key: "Ctrl+X", run: cmd(() => document.execCommand("cut")) },
    { label: "Copy", key: "Ctrl+C", run: cmd(() => document.execCommand("copy")) },
    { label: "Paste", key: "Ctrl+V", run: () => {
      const v = view.current;
      if (v) void navigator.clipboard.readText().then((t) => { v.focus(); v.dispatch(v.state.replaceSelection(t)); }).catch(() => {});
    } },
  ];

  return (
    <div className="code-ed" onContextMenu={(e) => {
      if (!(e.target as HTMLElement).closest(".cm-content")) return;
      e.preventDefault();
      // Right-click on a word puts the cursor there first, like VS Code, so
      // Go to Definition acts on what was clicked.
      const v = view.current, pos = v?.posAtCoords({ x: e.clientX, y: e.clientY });
      if (v && pos != null && !v.state.selection.ranges.some((r) => r.from <= pos && pos <= r.to)) v.dispatch({ selection: { anchor: pos } });
      setMenu({ x: e.clientX, y: e.clientY });
    }}>
      <div className="code-host" ref={host} />
      <ScrollRuler target={scroller} />
      {menu && <Menu items={items} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
    </div>
  );
}
