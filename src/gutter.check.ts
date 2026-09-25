import { Text } from "@codemirror/state";
import { lineMarks } from "./gutter.ts";

const doc = (s: string) => Text.of(s.split("\n"));
const show = (m: Map<number, string>) => [...m].sort((a, b) => a[0] - b[0]).map(([n, k]) => `${n}:${k}`).join(" ");
const cases: [string | null, string, string][] = [
  // original, edited, expected
  ["a\nb\nc", "a\nb\nc", ""],
  ["a\nb\nc", "a\nX\nc", "2:mod"],
  ["a\nb\nc", "a\nb\nnew\nc", "3:add"],
  ["a\nb\nc", "a\nc", "2:del"],
  [null, "one\ntwo", "1:add 2:add"],
];
let bad = 0;
for (const [o, e, want] of cases) {
  const got = show(lineMarks(o, doc(e)));
  if (got !== want) { bad++; console.error(`SAI ${JSON.stringify(o)} -> ${JSON.stringify(e)}: ${got} (ky vong ${want})`); }
}
if (bad) throw new Error(`gutter: ${bad} loi`);
console.log(`gutter: ${cases.length} ok`);
