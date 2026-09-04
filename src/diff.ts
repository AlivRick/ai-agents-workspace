/** One rendered row of a diff. `old`/`new` are line numbers, blank where the
 *  side has no line — which is what lets the two gutters stay aligned. */
export type Row = { kind: "add" | "del" | "ctx" | "hunk" | "meta"; text: string; old: number | null; new: number | null };

/**
 * Unified diff → rows to render.
 *
 * Written by hand rather than pulled in: the only thing a viewer needs from a
 * diff is which side each line belongs to and what number it carries, and git
 * already states both in the hunk header. A parser for that is this function.
 *
 * ponytail: line-level, not word-level. A one-character change shows as a whole
 * line replaced, the way `git diff` itself prints it. The upgrade path is an
 * intra-line diff on paired add/del rows, which needs a real diff algorithm.
 */
export function parseDiff(text: string): Row[] {
  const rows: Row[] = [];
  let o = 0;
  let n = 0;
  let inHunk = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("@@")) {
      // @@ -12,7 +12,9 @@ trailing context
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m) {
        o = Number(m[1]);
        n = Number(m[2]);
      }
      inHunk = true;
      rows.push({ kind: "hunk", text: line, old: null, new: null });
    } else if (!inHunk) {
      // Everything before the first hunk is git's header — index lines, mode
      // changes, the two file names. Worth showing, not worth numbering.
      if (line !== "") rows.push({ kind: "meta", text: line, old: null, new: null });
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file" belongs to neither side.
      rows.push({ kind: "meta", text: line, old: null, new: null });
    } else if (line.startsWith("+")) {
      rows.push({ kind: "add", text: line.slice(1), old: null, new: n++ });
    } else if (line.startsWith("-")) {
      rows.push({ kind: "del", text: line.slice(1), old: o++, new: null });
    } else if (line.startsWith(" ")) {
      rows.push({ kind: "ctx", text: line.slice(1), old: o++, new: n++ });
    }
    // A bare empty line is git's own trailing newline, not a line of the file:
    // a context line for an empty line still arrives as a single space.
  }
  return rows;
}

/** "+12 −3" for a file row, or "binary" when there is nothing to count. */
export const stat = (added: number, removed: number, binary: boolean) =>
  binary ? "binary" : `+${added} −${removed}`;
