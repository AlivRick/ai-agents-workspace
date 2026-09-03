import { parseLimits } from "./limits.ts";

// Nguyên văn output `claude -p "/usage"`.
const TEXT = `You are currently using your subscription to power your Claude Code usage

Current session: 43% used · resets Sep 3, 9:09am (UTC)
Current week (all models): 23% used · resets Sep 5, 7am (UTC)
Current week (Fable): 0% used

What's contributing to your limits usage?
Last 24h · 864 requests · 7 sessions
  91% of your usage was at >150k context`;

// Nam suy ra tu hom nay, nen ky vong cung phai theo nam hien tai.
const Y = new Date().getUTCFullYear();
let bad = 0;
const eq = (got: unknown, want: unknown, name: string) => {
  if (got !== want) { bad++; console.error("SAI " + name + " -> " + got + ", ky vong " + want); }
};

const ls = parseLimits(TEXT);
eq(ls.length, 3, "bat dung 3 dong phan tram, khong an nham dong 91%");
eq(ls[0].label, "Current session", "nhan phien");
eq(ls[0].pct, 43, "phan tram phien");
eq(new Date(ls[0].resetMs).toISOString(), `${Y}-09-03T09:09:00.000Z`, "reset 9:09am UTC");
eq(new Date(ls[1].resetMs).toISOString(), `${Y}-09-05T07:00:00.000Z`, "dung gio chan thi CLI bo phut: '7am'");
eq(ls[2].resetMs, 0, "dong khong co mocreset thi de 0");

// 12 gio dem/trua la cho am/pm de sai nhat.
eq(new Date(parseLimits("Current session: 1% used · resets Sep 3, 12:30am (UTC)")[0].resetMs).toISOString(),
   `${Y}-09-03T00:30:00.000Z`, "12:30am la nua dem");
eq(new Date(parseLimits("Current session: 1% used · resets Sep 3, 12:30pm (UTC)")[0].resetMs).toISOString(),
   `${Y}-09-03T12:30:00.000Z`, "12:30pm la giua trua");

eq(parseLimits("khong co gi o day").length, 0, "text la rac thi khong bia ra hạn mức");

if (bad) throw new Error("limits: " + bad + " loi");
console.log("limits.check: OK");
