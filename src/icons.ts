/** Lookup table generated from Material Icon Theme by scripts/icons.mjs. */
export type IconTable = {
  file: string; folder: string; folderOpen: string;
  names: Record<string, string>; exts: Record<string, string>;
  folders: Record<string, string | [string, string]>;
};

/**
 * The icon key VS Code's Material Icon Theme would pick, same order it does:
 * exact file name, then the longest compound extension ("test.ts" before
 * "ts"), then the generic file. Names are matched lower-case.
 *
 * ponytail: no languageId step — VS Code also maps by the language it detected,
 * which needs its language registry. Extensions cover nearly all of it.
 */
export function fileIcon(t: IconTable, name: string): string {
  const n = name.toLowerCase();
  if (t.names[n]) return t.names[n];
  for (let i = n.indexOf("."); i !== -1; i = n.indexOf(".", i + 1)) {
    const ext = n.slice(i + 1);
    if (t.exts[ext]) return t.exts[ext];
  }
  return t.file;
}

export function folderIcon(t: IconTable, name: string, open: boolean): string {
  const f = t.folders[name.toLowerCase()];
  if (!f) return open ? t.folderOpen : t.folder;
  if (Array.isArray(f)) return f[open ? 1 : 0];
  return open ? `${f}-open` : f;
}
