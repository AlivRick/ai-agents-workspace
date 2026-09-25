import { Chunk } from "@codemirror/merge";
import { Text } from "@codemirror/state";

export type Mark = "add" | "mod" | "del";

/**
 * VS Code's change bars, per line of the edited file, against the committed
 * version: green for lines added, blue for lines changed, a red wedge where
 * lines were deleted. `original` is null for a file HEAD does not have.
 * Recomputed from the text, so it follows your typing.
 */
export function lineMarks(original: string | null, doc: Text): Map<number, Mark> {
  const out = new Map<number, Mark>();
  // Not in HEAD at all: a new file, every line of it added.
  if (original === null) {
    for (let n = 1; n <= doc.lines; n++) out.set(n, "add");
    return out;
  }
  for (const c of Chunk.build(Text.of(original.split("\n")), doc)) {
    if (c.fromB === c.toB) {
      // Only deleted: mark the line the deletion sits above.
      out.set(doc.lineAt(Math.min(c.fromB, doc.length)).number, "del");
      continue;
    }
    const kind: Mark = c.fromA === c.toA ? "add" : "mod";
    const first = doc.lineAt(c.fromB).number;
    const last = doc.lineAt(Math.min(c.endB, doc.length)).number;
    for (let n = first; n <= last; n++) out.set(n, kind);
  }
  return out;
}
