/** Di chuyển phần tử `id` tới vị trí của `to` (id khác) hoặc lệch `to` bước. */
export function reorder<T extends { id: string }>(all: T[], id: string, to: string | number): T[] {
  const i = all.findIndex((x) => x.id === id);
  const j = typeof to === "number" ? i + to : all.findIndex((x) => x.id === to);
  if (i < 0 || j < 0 || j >= all.length || i === j) return all;
  const next = all.slice();
  next.splice(j, 0, next.splice(i, 1)[0]);
  return next;
}
