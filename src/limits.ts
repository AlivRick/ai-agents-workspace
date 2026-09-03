//! Hạn mức thật của gói, đọc từ `claude -p /usage`.
//!
//! Cửa sổ 5 giờ dựng từ transcript chỉ là ước lượng: nó không thấy usage từ
//! claude.ai hay máy khác, và không có cách nào biết trần thật của gói. CLI thì
//! biết — nên số ở đây là số của server, phần dựng lại chỉ còn để vẽ lịch sử.

export type Limit = { label: string; pct: number; resetMs: number };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Sep 3, 9:09am" (UTC, không có năm) → ms. Năm suy ra từ hôm nay; một mốc
 *  reset nằm quá xa trong quá khứ là chuyện bắc cầu qua giao thừa. */
function parseReset(s: string): number {
  // Phút là tuỳ chọn: CLI in "9:09am" nhưng đúng đầu giờ thì chỉ in "7am".
  const m = /([A-Z][a-z]{2}) (\d{1,2}),?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(s);
  if (!m) return 0;
  const mon = MONTHS.indexOf(m[1]);
  if (mon < 0) return 0;
  const ap = m[5]?.toLowerCase();
  const h = ap ? (Number(m[3]) % 12) + (ap === "pm" ? 12 : 0) : Number(m[3]);
  const at = (y: number) => Date.UTC(y, mon, Number(m[2]), h, Number(m[4] ?? 0));
  const y = new Date().getUTCFullYear();
  return at(y) < Date.now() - 30 * 86_400_000 ? at(y + 1) : at(y);
}

/** Ba dòng phần trăm của `/usage`. Dòng nào CLI không in thì bỏ qua — phiên bản
 *  cũ và tài khoản API-key không có đủ cả ba. */
export function parseLimits(text: string): Limit[] {
  const out: Limit[] = [];
  for (const line of text.split("\n")) {
    const m = /^(Current [^:]+):\s*(\d+)% used(?:.*?resets ([^(]+))?/.exec(line.trim());
    if (m) out.push({ label: m[1], pct: Number(m[2]), resetMs: m[3] ? parseReset(m[3]) : 0 });
  }
  return out;
}
