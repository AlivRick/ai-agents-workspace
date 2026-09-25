import { fileIcon, folderIcon, type IconTable } from "./icons.ts";

const t: IconTable = {
  file: "file", folder: "folder", folderOpen: "folder-open",
  names: { "package.json": "nodejs", "vite.config.ts": "vite" },
  exts: { ts: "typescript", "test.ts": "test-ts", "d.ts": "typescript-def", md: "markdown" },
  folders: { src: "folder-src", odd: ["folder-a", "folder-b"] },
};
const cases: [string, string][] = [
  [fileIcon(t, "Package.JSON"), "nodejs"],
  [fileIcon(t, "vite.config.ts"), "vite"],
  [fileIcon(t, "a.test.ts"), "test-ts"],
  [fileIcon(t, "types.d.ts"), "typescript-def"],
  [fileIcon(t, "App.ts"), "typescript"],
  [fileIcon(t, "LICENSE"), "file"],
  [folderIcon(t, "src", false), "folder-src"],
  [folderIcon(t, "SRC", true), "folder-src-open"],
  [folderIcon(t, "odd", true), "folder-b"],
  [folderIcon(t, "misc", true), "folder-open"],
];
const bad = cases.filter(([g, w]) => g !== w);
if (bad.length) throw new Error("icons: " + JSON.stringify(bad));
console.log(`icons: ${cases.length} ok`);
