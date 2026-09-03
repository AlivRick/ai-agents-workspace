/**
 * Runnable check for `normPath`, the one place that decides whether a folder
 * named on Windows is the same folder its Linux-written sessions recorded.
 * Getting this wrong is what made "Workspace này" list nothing.
 *
 *   node --experimental-strip-types src/paths.check.ts
 */
import { normPath } from "./api.ts";

declare const process: { exit(code: number): never };

const B = "\\";
const cases = [
  [`${B}${B}?${B}UNC${B}wsl.localhost${B}Ubuntu${B}home${B}thuan${B}hutech`, "/home/thuan/hutech"],
  [`${B}${B}wsl.localhost${B}Ubuntu${B}home${B}thuan${B}hutech`, "/home/thuan/hutech"],
  [`${B}${B}wsl$${B}Ubuntu${B}home${B}thuan`, "/home/thuan"],
  ["/home/thuan/hutech/", "/home/thuan/hutech"],
  ["/home/thuan/hutech", "/home/thuan/hutech"],
  [`C:${B}code`, "/mnt/c/code"],
  ["/", "/"],
];

let bad = 0;
for (const [input, want] of cases) {
  const got = normPath(input);
  if (got !== want) {
    bad++;
    console.error("SAI " + JSON.stringify(input) + " -> " + got + ", ky vong " + want);
  }
}
// Hai thu muc khac nhau phai van khac nhau.
if (normPath("/home/thuan/hutech") === normPath("/home/thuan/hutech-bill")) {
  bad++;
  console.error("SAI: hutech va hutech-bill khong duoc coi la mot");
}
console.log(bad === 0 ? "normPath: " + (cases.length + 1) + " truong hop deu dung" : "normPath: " + bad + " loi");
process.exit(bad === 0 ? 0 : 1);
