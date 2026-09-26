import { useEffect, useMemo, useRef, useState } from "react";
import { basicSetup } from "codemirror";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { vscodeDark } from "@uiw/codemirror-theme-vscode";

/** One reference, as the server gave it, plus where it lives on disk. */
export type Ref = { uri: string; path: string | null; line: number; from: number; to: number };

const name = (p: string) => p.split(/[\\/]/).pop() ?? p;
const dirOf = (rel: string) => rel.split(/[\\/]/).slice(0, -1).join("/");

/**
 * VS Code's Peek References: a zone under the line with a read-only preview
 * of the picked reference on the left and every reference, grouped by file,
 * on the right. Click previews, double-click (or Enter) opens it, Esc closes.
 */
export default function Peek({ refs, texts, rel, onOpen, onClose }: {
  refs: Ref[];
  /** File contents by URI; missing ones show a note instead of a preview. */
  texts: Record<string, string>;
  /** Path relative to the workspace, for the header and the group labels. */
  rel: (p: string) => string;
  onOpen: (r: Ref) => void; onClose: () => void;
}) {
  const groups = useMemo(() => {
    const m = new Map<string, Ref[]>();
    for (const r of refs) m.set(r.uri, [...(m.get(r.uri) ?? []), r]);
    return [...m].sort(([a], [b]) => a.localeCompare(b));
  }, [refs]);
  const flat = groups.flatMap(([, rs]) => rs);
  const [at, setAt] = useState(0);
  const [shut, setShut] = useState<Set<string>>(new Set());
  const cur = flat[at];
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);

  // The preview: one read-only editor, rebuilt when the file changes.
  useEffect(() => {
    const text = cur ? texts[cur.uri] : undefined;
    if (text === undefined || !host.current) return;
    const lang = new Compartment();
    const v = new EditorView({ parent: host.current, state: EditorState.create({ doc: text, extensions: [basicSetup, vscodeDark, lang.of([]), EditorState.readOnly.of(true)] }) });
    view.current = v;
    const desc = cur.path ? LanguageDescription.matchFilename(languages, name(cur.path)) : null;
    desc?.load().then((l) => { if (view.current === v) v.dispatch({ effects: lang.reconfigure(l) }); }).catch(() => {});
    return () => { v.destroy(); view.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur?.uri, texts[cur?.uri ?? ""] !== undefined]);
  useEffect(() => {
    const v = view.current;
    if (!v || !cur || cur.line >= v.state.doc.lines) return;
    const l = v.state.doc.line(cur.line + 1);
    const a = Math.min(l.from + cur.from, l.to), b = Math.min(l.from + cur.to, l.to);
    v.dispatch({ selection: { anchor: a, head: b }, effects: EditorView.scrollIntoView(a, { y: "center" }) });
  }, [cur, cur?.uri]);

  const line = (r: Ref) => (texts[r.uri]?.split("\n")[r.line] ?? "");
  const key = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
    else if (e.key === "Enter" && cur) { e.preventDefault(); onOpen(cur); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setAt((i) => Math.min(i + 1, flat.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setAt((i) => Math.max(i - 1, 0)); }
  };

  return (
    <div className="peek" onKeyDown={key} tabIndex={-1} ref={(el) => el?.focus({ preventScroll: true })}>
      <div className="peek-head">
        <b>{cur?.path ? name(cur.path) : "?"}</b>
        <span className="d">{cur?.path ? dirOf(rel(cur.path)) : cur?.uri}</span>
        <span className="d">— References ({refs.length})</span>
        <span className="sp" />
        <button title="Close (Esc)" onClick={onClose}>×</button>
      </div>
      <div className="peek-body">
        <div className="peek-prev" ref={host}>
          {cur && texts[cur.uri] === undefined && <div className="hint">{cur.path ? "Loading…" : "This file is outside the workspace."}</div>}
        </div>
        <div className="peek-list">
          {groups.map(([uri, rs]) => {
            const p = rs[0].path;
            return (
              <div key={uri}>
                <div className="pg" onClick={() => setShut((s) => { const n = new Set(s); if (n.has(uri)) n.delete(uri); else n.add(uri); return n; })}>
                  <span className={"chev" + (shut.has(uri) ? "" : " open")}>›</span>
                  <b>{p ? name(p) : uri}</b><span className="d">{p ? dirOf(rel(p)) : ""}</span>
                  <span className="n">{rs.length}</span>
                </div>
                {!shut.has(uri) && rs.map((r) => {
                  const i = flat.indexOf(r), t = line(r);
                  const lead = t.length - t.trimStart().length;
                  return (
                    <div key={i} className={"pr" + (i === at ? " on" : "")} onClick={() => setAt(i)} onDoubleClick={() => onOpen(r)}>
                      {t.slice(Math.min(lead, r.from), r.from)}<mark>{t.slice(r.from, r.to)}</mark>{t.slice(r.to)}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
