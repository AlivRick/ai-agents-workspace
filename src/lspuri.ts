/**
 * Paths as the app stores them (`\\wsl.localhost\Ubuntu\home\x\a.ts`) and as
 * the server sees them (`file:///home/x/a.ts`). Only files under the workspace
 * map back; a definition in the Rust std lib has nowhere to open.
 */
export function uriMap(root: string, seenRoot: string) {
  const sep = root.includes("\\") ? "\\" : "/";
  const posix = seenRoot.replace(/\\/g, "/").replace(/\/$/, "");
  const drive = /^[A-Za-z]:/.test(posix);
  const base = "file://" + (drive ? "/" : "") + posix.split("/").map((p, i) => (drive && i === 0 ? p : encodeURIComponent(p))).join("/");
  return {
    base,
    toUri: (abs: string) => {
      const rel = abs.slice(root.length).replace(/^[\\/]/, "");
      return base + "/" + rel.split(/[\\/]/).map(encodeURIComponent).join("/");
    },
    toPath: (uri: string): string | null => {
      const u = uri.replace(/^file:\/\/\/([a-z])(:|%3A)/i, (_m, d) => `file:///${d.toUpperCase()}:`);
      const b = base.replace(/^file:\/\/\/([a-z]):/i, (_m, d) => `file:///${d.toUpperCase()}:`);
      if (!u.startsWith(b + "/")) return null;
      return root + sep + decodeURIComponent(u.slice(b.length + 1)).split("/").join(sep);
    },
  };
}
