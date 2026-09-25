// Material Icon Theme (the VS Code extension, MIT) → what the Explorer needs:
// the SVGs under public/material/<key>.svg, and a compact lookup table in
// src/icons.gen.json. Both are generated, both gitignored. Runs before
// `vite` and `vite build`.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const manifestPath = require.resolve("material-icon-theme/dist/material-icons.json");
const m = JSON.parse(readFileSync(manifestPath, "utf8"));
const iconsDir = join(dirname(manifestPath), "..", "icons");

mkdirSync("public/material", { recursive: true });
for (const [key, def] of Object.entries(m.iconDefinitions)) {
  // A handful of keys point at a differently named file; copy under the key.
  cpSync(join(iconsDir, basename(def.iconPath)), `public/material/${key}.svg`);
}

// Folders: store the closed key only, plus the open key when it is not
// simply "<closed>-open" — which is almost never.
const folders = {};
for (const [name, key] of Object.entries(m.folderNames)) {
  const open = m.folderNamesExpanded[name];
  folders[name] = open && open !== `${key}-open` ? [key, open] : key;
}
writeFileSync("src/icons.gen.json", JSON.stringify({
  file: m.file, folder: m.folder, folderOpen: m.folderExpanded,
  names: m.fileNames, exts: m.fileExtensions, folders,
}));
console.log(`icons: ${Object.keys(m.iconDefinitions).length} svg → public/material`);
