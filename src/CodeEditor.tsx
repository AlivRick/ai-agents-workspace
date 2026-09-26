import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { basicSetup } from "codemirror";
import { indentWithTab } from "@codemirror/commands";
import { selectSelectionMatches } from "@codemirror/search";
import { LSPPlugin, formatDocument, jumpToDefinition, jumpToImplementation, jumpToTypeDefinition, renameSymbol } from "@codemirror/lsp-client";
import { Menu, type Item } from "./ScmMenu";
import { locations, lspFor } from "./lsp";
import { api } from "./api";
import Peek, { type Ref } from "./Peek";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Compartment, EditorState, RangeSet, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, GutterMarker, WidgetType, gutter, keymap } from "@codemirror/view";
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
/** Where Peek References sits: after this position's line, or nowhere. */
const setPeekAt = StateEffect.define<number | null>();
/** The zone Peek renders into (through a React portal). One element per editor. */
class Slot extends WidgetType {
  constructor(readonly dom: HTMLElement) { super(); }
  toDOM() { return this.dom; }
  eq(o: Slot) { return o.dom === this.dom; }
  ignoreEvent() { return true; }
  get estimatedHeight() { return 300; }
}
const peekZone = (dom: HTMLElement) => StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(d, tr) {
    for (const e of tr.effects) if (e.is(setPeekAt)) {
      return e.value == null ? Decoration.none
        : Decoration.set([Decoration.widget({ widget: new Slot(dom), block: true, side: 1 }).range(tr.state.doc.lineAt(e.value).to)]);
    }
    return d.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
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
  const [peek, setPeek] = useState<{ refs: Ref[]; texts: Record<string, string> } | null>(null);
  const slot = useMemo(() => { const d = document.createElement("div"); d.className = "peek-slot"; d.contentEditable = "false"; return d; }, []);
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
          peekZone(slot),
          // Ctrl+Click (Cmd on a Mac) goes to the definition, as in VS Code.
          EditorView.domEventHandlers({
            mousedown: (e, v) => {
              if (!(e.ctrlKey || e.metaKey) || e.button !== 0 || !LSPPlugin.get(v)) return false;
              const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
              if (pos == null) return false;
              e.preventDefault();
              v.dispatch({ selection: { anchor: pos } });
              void acts.current.goDef();
              return true;
            },
          }),
          // VS Code's keys. The LSP ones do nothing until a server is attached.
          keymap.of([
            indentWithTab, { key: "Mod-s", preventDefault: true, run: () => (cb.current.onSave(), true) },
            { key: "F12", run: () => (acts.current.goDef(), true) }, { key: "Mod-F12", run: jumpToImplementation },
            { key: "Shift-F12", run: () => (acts.current.refs(), true) }, { key: "F2", run: renameSymbol },
            { key: "Escape", run: () => acts.current.closePeek() },
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

  // ------------------------------------------------------ Peek References
  const closePeek = () => {
    if (!peek) return false;
    setPeek(null);
    view.current?.dispatch({ effects: setPeekAt.of(null) });
    view.current?.focus();
    return true;
  };
  const showRefs = async () => {
    const v = view.current;
    if (!v) return;
    const refs = await locations(v, "references").catch((e) => { onLspFail(String(e)); return null; });
    if (!refs?.length || view.current !== v) return;
    const me = LSPPlugin.get(v)?.uri ?? "";
    const texts: Record<string, string> = { [me]: v.state.doc.toString() };
    const head = v.state.selection.main.head;
    v.dispatch({ effects: [setPeekAt.of(head), EditorView.scrollIntoView(head, { y: "start", yMargin: 60 })] });
    setPeek({ refs, texts });
    // Other files' text, for their preview and their lines in the list.
    for (const u of new Set(refs.map((r) => r.uri))) {
      const p = refs.find((r) => r.uri === u)?.path;
      if (u === me || !p) continue;
      api.fsRead(root, p).then((t) => setPeek((k) => (k ? { ...k, texts: { ...k.texts, [u]: t } } : k))).catch(() => {});
    }
  };
  /** F12. On the definition itself there is nowhere to go: show its references, as VS Code does. */
  const goDef = async () => {
    const v = view.current;
    if (!v) return;
    const d = await locations(v, "definition").catch(() => null);
    const me = LSPPlugin.get(v)?.uri;
    const line = v.state.doc.lineAt(v.state.selection.main.head).number - 1;
    if (d?.some((x) => x.uri === me && x.line === line)) void showRefs();
    else jumpToDefinition(v);
  };
  /** Double-click in Peek: go there, in this file or in its own tab. */
  const openRef = (r: Ref) => {
    const v = view.current;
    closePeek();
    if (!v) return;
    const go = (t: EditorView) => {
      const l = t.state.doc.line(Math.min(r.line + 1, t.state.doc.lines));
      const a = Math.min(l.from + r.from, l.to);
      t.dispatch({ selection: { anchor: a, head: Math.min(l.from + r.to, l.to) }, effects: EditorView.scrollIntoView(a, { y: "center" }) });
      t.focus();
    };
    const p = LSPPlugin.get(v);
    if (r.uri === p?.uri) go(v);
    else if (r.path) void p?.client.workspace.displayFile(r.uri).then((t) => t && go(t));
  };
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const f = (e: KeyboardEvent) => box.current?.classList.toggle("ctrl", smart && (e.ctrlKey || e.metaKey));
    window.addEventListener("keydown", f);
    window.addEventListener("keyup", f);
    return () => { window.removeEventListener("keydown", f); window.removeEventListener("keyup", f); };
  }, [smart]);
  // The zone lives inside the editor's content, which is as wide as its longest
  // line. Size it to what is on screen and pin it left of a sideways scroll.
  useEffect(() => {
    const v = view.current;
    if (!peek || !v) return;
    const fit = () => {
      const g = v.dom.querySelector<HTMLElement>(".cm-gutters")?.offsetWidth ?? 0;
      slot.style.left = `${g}px`;
      slot.style.width = `${Math.max(320, v.scrollDOM.clientWidth - g - 4)}px`;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(v.scrollDOM);
    return () => ro.disconnect();
  }, [!!peek]); // eslint-disable-line react-hooks/exhaustive-deps
  const acts = useRef({ goDef, refs: showRefs, closePeek });
  acts.current = { goDef, refs: showRefs, closePeek };
  const rel = (p: string) => p.slice(root.length).replace(/^[\\/]/, "");

  /** Run an editor command from the menu, on the editor, where the click was. */
  const cmd = (f: (v: EditorView) => boolean) => () => { const v = view.current; if (v) { v.focus(); f(v); } };
  const items: Item[] = [
    { label: "Go to Definition", key: "F12", disabled: !smart, run: () => void goDef() },
    { label: "Go to Type Definition", disabled: !smart, run: cmd(jumpToTypeDefinition) },
    { label: "Go to Implementations", key: "Ctrl+F12", disabled: !smart, run: cmd(jumpToImplementation) },
    { label: "Go to References", key: "Shift+F12", disabled: !smart, run: () => void showRefs() },
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
    <div className="code-ed" ref={box} onContextMenu={(e) => {
      const el = e.target as HTMLElement;
      if (!el.closest(".cm-content") || el.closest(".peek")) return;
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
      {peek && createPortal(<Peek refs={peek.refs} texts={peek.texts} rel={rel} onOpen={openRef} onClose={() => void closePeek()} />, slot)}
    </div>
  );
}
