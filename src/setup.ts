/** Lệnh dựng lại môi trường chạy trong một worktree mới.
 *
 *  Worktree là thư mục trống về mặt runtime: dev server, docker compose, redis
 *  đang chạy ở thư mục gốc không phục vụ nó. Không có chỗ này thì người dùng
 *  phải tự mở source ra bật lại từng thứ — đúng cái Conductor gọi là run script
 *  và Vibe Kanban gọi là dev script.
 *
 *  ponytail: nhớ trong localStorage, cùng chỗ với theme/notify — một dòng chuỗi
 *  cho mỗi workspace thì không đáng để đụng vào state.json và backend. Nâng cấp
 *  khi cần nhiều lệnh hoặc đồng bộ giữa máy: chuyển vào store.rs. */

const KEY = "setup";

export function loadSetups(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export const setupFor = (wsId: string) => loadSetups()[wsId] ?? "";

export function saveSetup(wsId: string, cmd: string) {
  const all = loadSetups();
  const c = cmd.trim();
  if (c) all[wsId] = c;
  else delete all[wsId];
  localStorage.setItem(KEY, JSON.stringify(all));
}

/** Số hiệu nhỏ nhất chưa ai dùng, đếm từ 1. Hai worktree cùng chạy `npm run
 *  dev` sẽ đâm nhau ở cổng 3000, nên mỗi tác vụ cần một số riêng để cộng vào
 *  cổng — và số phải *lấp lại chỗ trống*, không thì đóng mở vài tác vụ là số
 *  trôi ra ngoài dải cổng còn trống. */
export function freeSlot(used: number[]): number {
  let n = 1;
  const taken = new Set(used);
  while (taken.has(n)) n++;
  return n;
}

/** Thay `{n}`, `{task}`, `{tree}` trong lệnh. Thay chuỗi chứ không xuất biến
 *  môi trường: shell của host trên Windows là PowerShell, `export` chết ở đó. */
export function expand(cmd: string, v: { n: number; task: string; tree: string }) {
  return cmd.replace(/\{(n|task|tree)\}/g, (_, k: "n" | "task" | "tree") => String(v[k]));
}
