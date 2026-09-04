import { useMemo, useState } from "react";
import { normPath, shortPath } from "./api";

type Node = { name: string; path: string; importable: boolean; children: Node[]; leaves: number };

/**
 * A flat list of 60+ folders is unusable — parents and their children sit side
 * by side with no relationship shown. This folds the paths into a tree, then
 * collapses single-child chains so the depth stays shallow, so you open one
 * parent and pick from what is actually inside it.
 */
function buildTree(paths: string[]): Node[] {
  const root: Node = { name: "", path: "", importable: false, children: [], leaves: 0 };
  const importable = new Set(paths);

  for (const p of paths) {
    let node = root;
    let acc = "";
    for (const seg of p.split("/").filter(Boolean)) {
      acc += "/" + seg;
      let child = node.children.find((c) => c.path === acc);
      if (!child) {
        child = { name: seg, path: acc, importable: importable.has(acc), children: [], leaves: 0 };
        node.children.push(child);
      }
      node = child;
    }
  }

  // A branch that is not itself importable and has exactly one child adds no
  // information — fold it into its child's label.
  const collapse = (n: Node): Node => {
    let cur = n;
    while (!cur.importable && cur.children.length === 1) {
      const only = cur.children[0];
      cur = { ...only, name: `${cur.name}/${only.name}` };
    }
    const children = cur.children.map(collapse).sort((a, b) => a.name.localeCompare(b.name));
    const leaves = (cur.importable ? 1 : 0) + children.reduce((a, c) => a + c.leaves, 0);
    return { ...cur, children, leaves };
  };

  return root.children.map(collapse).sort((a, b) => a.name.localeCompare(b.name));
}

const descendants = (n: Node): string[] =>
  (n.importable ? [n.path] : []).concat(n.children.flatMap(descendants));

export default function ImportSheet({
  paths, onCancel, onConfirm,
}: {
  paths: string[]; onCancel: () => void; onConfirm: (paths: string[]) => void;
}) {
  // The tree splits on "/", but a WSL folder arrives as
  // `\\wsl.localhost\Ubuntu\home\thuan\x` — one unsplittable segment, which
  // flattens the tree into a list of long ugly names. Build it on the POSIX
  // form and map back to the real path only when adding.
  const byKey = useMemo(() => new Map(paths.map((p) => [normPath(p), p])), [paths]);
  const tree = useMemo(() => buildTree([...byKey.keys()]), [byKey]);
  const [open, setOpen] = useState<Set<string>>(() => new Set(tree.filter((n) => n.leaves <= 8).map((n) => n.path)));
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const toggleOpen = (p: string) =>
    setOpen((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; });

  const setMany = (list: string[], on: boolean) =>
    setPicked((s) => { const n = new Set(s); list.forEach((p) => (on ? n.add(p) : n.delete(p))); return n; });

  const render = (n: Node, depth: number): React.ReactNode => {
    const all = descendants(n);
    const chosen = all.filter((p) => picked.has(p)).length;
    const expanded = open.has(n.path);
    const isBranch = n.children.length > 0;
    return (
      <div key={n.path}>
        <div className="node" style={{ paddingLeft: 8 + depth * 16 }}>
          <button className={"twist" + (isBranch ? "" : " hidden")} onClick={() => toggleOpen(n.path)}
                  title={expanded ? "Collapse" : "Expand"}>{expanded ? "▾" : "▸"}</button>
          <input
            type="checkbox"
            checked={all.length > 0 && chosen === all.length}
            ref={(el) => { if (el) el.indeterminate = chosen > 0 && chosen < all.length; }}
            onChange={(e) => setMany(all, e.target.checked)}
            title={isBranch ? `Select all ${all.length} folders in this branch` : "Select this folder"}
          />
          <span className={"n" + (n.importable ? "" : " branch")} onClick={() => isBranch && toggleOpen(n.path)}>
            {n.name}
          </span>
          {isBranch && <span className="count">{n.leaves}</span>}
          {n.importable && <span className="path">{shortPath(n.path)}</span>}
        </div>
        {expanded && n.children.map((c) => render(c, depth + 1))}
      </div>
    );
  };

  return (
    <div className="modal" onClick={onCancel}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <header>
          <b>Import workspaces</b>
          <span className="path">{byKey.size} folders your agents have worked in · click ▸ to open a branch</span>
          <span className="sp" />
          <button className="btn ghost"
                  onClick={() => setOpen(new Set([...byKey.keys()].flatMap((p) =>
                    p.split("/").map((_, i, a) => "/" + a.slice(1, i + 1).join("/")))))}>Expand all</button>
          <button className="btn ghost" onClick={() => setPicked(new Set())}>Clear</button>
        </header>
        <div className="sheet-list tree">
          {tree.length === 0 && <div className="hint">No folders left to add.</div>}
          {tree.map((n) => render(n, 0))}
        </div>
        <footer>
          <span className="path">{picked.size} selected</span>
          <span className="sp" />
          <button className="btn ghost" onClick={onCancel}>Cancel</button>
          <button className="btn primary" disabled={picked.size === 0}
                  onClick={() => onConfirm([...picked].map((k) => byKey.get(k) ?? k))}>
            Add {picked.size || ""} workspace{picked.size === 1 ? "" : "s"}
          </button>
        </footer>
      </div>
    </div>
  );
}
