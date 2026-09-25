import { allFiles, buildTree } from "./scmtree.ts";

const t = buildTree([
  { path: "src-tauri/src/lib.rs" }, { path: "src/App.tsx" }, { path: "package.json" },
  { path: "src-tauri/src/explorer.rs" }, { path: "src/ui/a.css" },
]);
const draw = (f: ReturnType<typeof buildTree>, d = 0): string[] => [
  ...f.dirs.flatMap((x) => [`${"  ".repeat(d)}${x.name}/`, ...draw(x, d + 1)]),
  ...f.files.map((x) => `${"  ".repeat(d)}${x.path.split("/").pop()}`),
];
const got = draw(t).join("\n");
const want = ["src/", "  ui/", "    a.css", "  App.tsx", "src-tauri/src/", "  explorer.rs", "  lib.rs", "package.json"].join("\n");
if (got !== want) throw new Error("scmtree: cay sai\n" + got);
if (allFiles(t).length !== 5) throw new Error("scmtree: allFiles thieu file");
console.log("scmtree: ok");
