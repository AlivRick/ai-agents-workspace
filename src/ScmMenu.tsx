import { useEffect, useRef, useState } from "react";

/** A menu entry: an action, a submenu, or a separator ("-"). */
export type Item = "-" | { label: string; run?: () => void; sub?: Item[]; disabled?: boolean };

/**
 * VS Code's "…" menu in Source Control: one column, submenus open on hover to
 * the right. Clicking outside or picking anything closes it.
 */
export function Menu({ items, x, y, onClose }: { items: Item[]; x: number; y: number; onClose: () => void }) {
  return (
    <>
      <div className="icon-back" onClick={onClose} />
      <List items={items} style={{ left: x, top: y }} onClose={onClose} />
    </>
  );
}

function List({ items, style, onClose }: { items: Item[]; style: React.CSSProperties; onClose: () => void }) {
  const [sub, setSub] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  // A submenu opens to the right of its row; flip left when the window ends.
  const subLeft = (ref.current?.getBoundingClientRect().right ?? 0) + 220 > window.innerWidth;
  return (
    <div className="ctx-menu" style={style} ref={ref}>
      {items.map((it, i) =>
        it === "-" ? (
          <div key={i} className="sep" />
        ) : (
          <div key={i} className={"mi" + (it.disabled ? " off" : "") + (sub === i ? " hot" : "")}
               onMouseEnter={() => setSub(it.sub ? i : null)}
               onClick={() => { if (it.disabled || it.sub) return; onClose(); it.run?.(); }}>
            <span>{it.label}</span>
            {it.sub && <span className="arr">›</span>}
            {it.sub && sub === i && (
              <List items={it.sub} onClose={onClose}
                    style={subLeft ? { right: "100%", top: -5 } : { left: "100%", top: -5 }} />
            )}
          </div>
        ))}
    </div>
  );
}

export type Pick = { label: string; value: string; description?: string; detail?: string };
export type PickerAsk = {
  title: string; placeholder?: string; items?: Pick[];
  /** Accept whatever was typed when it matches no item — for names. */
  free?: boolean;
  resolve: (v: string | null) => void;
};

/**
 * VS Code's quick pick: a box at the top with a filter and a list. Also its
 * input box, when there are no items and `free` is set.
 */
export function Picker({ ask }: { ask: PickerAsk }) {
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const items = (ask.items ?? []).filter((p) =>
    `${p.label} ${p.description ?? ""} ${p.detail ?? ""}`.toLowerCase().includes(q.trim().toLowerCase()));
  useEffect(() => setAt(0), [q]);
  const done = (v: string | null) => ask.resolve(v);
  const enter = () => {
    if (items[at]) done(items[at].value);
    else if (ask.free && q.trim()) done(q.trim());
  };
  return (
    <div className="picker-back" onMouseDown={() => done(null)}>
      <div className="picker" onMouseDown={(e) => e.stopPropagation()}>
        <div className="pt">{ask.title}</div>
        <input autoFocus value={q} placeholder={ask.placeholder} onChange={(e) => setQ(e.target.value)}
               onKeyDown={(e) => {
                 if (e.key === "Escape") done(null);
                 else if (e.key === "Enter") { e.preventDefault(); enter(); }
                 else if (e.key === "ArrowDown") { e.preventDefault(); setAt((a) => Math.min(a + 1, items.length - 1)); }
                 else if (e.key === "ArrowUp") { e.preventDefault(); setAt((a) => Math.max(a - 1, 0)); }
               }} />
        {items.length > 0 && (
          <div className="pl">
            {items.map((p, i) => (
              <div key={p.value + i} className={"pi" + (i === at ? " on" : "")}
                   onMouseEnter={() => setAt(i)} onClick={() => done(p.value)}>
                <span className="pn">{p.label}</span>
                {p.description && <span className="pd">{p.description}</span>}
                {p.detail && <span className="px">{p.detail}</span>}
              </div>
            ))}
          </div>
        )}
        {ask.free && !items.length && <div className="ph">Enter to confirm · Esc to cancel</div>}
      </div>
    </div>
  );
}
