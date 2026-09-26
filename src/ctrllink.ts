import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, showTooltip, type DecorationSet, type Tooltip, type TooltipView } from "@codemirror/view";

/** What a Ctrl+hover shows: the definition's lines, and how to draw them. */
export type Preview = { text: string; file: string } | null;

const setLink = StateEffect.define<{ from: number; to: number; tip: Tooltip | null } | null>();
const link = Decoration.mark({ class: "cm-ctrl-link" });
const field = StateField.define<{ deco: DecorationSet; tip: Tooltip | null }>({
  create: () => ({ deco: Decoration.none, tip: null }),
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setLink)) {
      return e.value ? { deco: Decoration.set([link.range(e.value.from, e.value.to)]), tip: e.value.tip } : { deco: Decoration.none, tip: null };
    }
    return tr.docChanged ? { deco: Decoration.none, tip: null } : v;
  },
  provide: (f) => [EditorView.decorations.from(f, (v) => v.deco), showTooltip.from(f, (v) => v.tip)],
});

/**
 * VS Code's Ctrl+hover: the word under the mouse turns into a link and a
 * tooltip shows the lines it is defined on. `lookup` asks the language server;
 * a word it has no definition for stays plain. `render` builds the preview.
 */
export function ctrlLink(lookup: (v: EditorView, pos: number) => Promise<Preview>, render: (p: NonNullable<Preview>) => TooltipView): Extension {
  const plugin = ViewPlugin.fromClass(class {
    x = 0; y = 0; inside = false; word = ""; timer = 0;
    constructor(readonly view: EditorView) {
      window.addEventListener("keydown", this.key);
      window.addEventListener("keyup", this.key);
      window.addEventListener("blur", this.clear);
    }
    key = (e: KeyboardEvent) => (e.ctrlKey || e.metaKey) && this.inside ? this.mark() : this.clear();
    clear = () => {
      clearTimeout(this.timer);
      this.word = "";
      if (this.view.state.field(field).deco.size) this.view.dispatch({ effects: setLink.of(null) });
    };
    mark() {
      const pos = this.view.posAtCoords({ x: this.x, y: this.y });
      const w = pos == null ? null : this.view.state.wordAt(pos);
      if (!w) return this.clear();
      const key = `${w.from}:${w.to}`;
      if (key === this.word) return;
      this.clear();
      this.word = key;
      // Wait for the mouse to settle before asking the server.
      this.timer = window.setTimeout(async () => {
        const p = await lookup(this.view, w.from).catch(() => null);
        if (!p || this.word !== key) return;
        this.view.dispatch({ effects: setLink.of({ from: w.from, to: w.to, tip: { pos: w.from, create: () => render(p) } }) });
      }, 120);
    }
    destroy() {
      clearTimeout(this.timer);
      window.removeEventListener("keydown", this.key);
      window.removeEventListener("keyup", this.key);
      window.removeEventListener("blur", this.clear);
    }
  }, {
    eventObservers: {
      mousemove(e) { this.x = e.clientX; this.y = e.clientY; this.inside = true; if (e.ctrlKey || e.metaKey) this.mark(); else if (this.word) this.clear(); },
      mouseleave() { this.inside = false; this.clear(); },
    },
  });
  return [field, plugin];
}
