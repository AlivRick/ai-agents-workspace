/** A folder in Source Control's tree view. */
export type Folder<T> = { name: string; path: string; dirs: Folder<T>[]; files: T[] };

/**
 * Repo-relative paths → folders, the way VS Code's "View as Tree" draws them:
 * sorted, and a folder whose only child is another folder is folded into one
 * row ("src-tauri/src"), so a deep path does not cost five clicks.
 */
export function buildTree<T extends { path: string }>(items: T[]): Folder<T> {
  const root: Folder<T> = { name: "", path: "", dirs: [], files: [] };
  for (const it of items) {
    const parts = it.path.split("/");
    let f = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts.slice(0, i + 1).join("/");
      let d = f.dirs.find((x) => x.path === p);
      if (!d) f.dirs.push((d = { name: parts[i], path: p, dirs: [], files: [] }));
      f = d;
    }
    f.files.push(it);
  }
  const tidy = (f: Folder<T>): Folder<T> => {
    while (f !== root && f.files.length === 0 && f.dirs.length === 1) {
      const c = f.dirs[0];
      f = { ...c, name: `${f.name}/${c.name}` };
    }
    f.dirs = f.dirs.map(tidy).sort((a, b) => a.name.localeCompare(b.name));
    f.files.sort((a, b) => a.path.localeCompare(b.path));
    return f;
  };
  return tidy(root);
}

/** Every file under a folder — what a folder's Stage / Discard acts on. */
export const allFiles = <T,>(f: Folder<T>): T[] => [...f.files, ...f.dirs.flatMap(allFiles)];
