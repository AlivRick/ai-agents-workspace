import { AGENTS, agentOf, allBins, binOf, launchCommand } from "./agents.ts";

let bad = 0;
const eq = (got: string, want: string, name: string) => {
  if (got !== want) { bad++; console.error("SAI " + name + " -> " + got + ", ky vong " + want); }
};
const ok = (cond: boolean, name: string) => { if (!cond) { bad++; console.error("SAI " + name); } };

const all = allBins();

// Prompt di dung cho tung kieu CLI.
eq(launchCommand("claude", all, "sua bug"), 'claude "sua bug"', "claude nhan prompt positional");
eq(launchCommand("gemini", all, "sua bug"), 'gemini -i "sua bug"', "gemini can co -i");
eq(launchCommand("opencode", all, "sua bug"), 'opencode --prompt "sua bug"', "opencode dung --prompt");
// Copilot chi nhan prompt o che do headless, nen bo qua thay vi lam no thoat ngay.
eq(launchCommand("copilot", all, "sua bug"), "copilot", "copilot khong nhan prompt");
eq(launchCommand("terminal", all, "sua bug"), "", "terminal khong chay gi");

// Continue.
eq(launchCommand("claude", all, "", true), "claude --continue", "claude tiep phien cu");
eq(launchCommand("cursor", all, "x", true), 'cursor-agent --continue "x"', "cursor: co tiep va prompt");
eq(launchCommand("gemini", all, "x", true), 'gemini -i "x"', "gemini khong co co tiep phien");

// Binary duoc chon theo cai thuc su co tren PATH.
eq(binOf(agentOf("cursor")!, ["agent"]), "agent", "cursor ban moi ten la agent");
eq(binOf(agentOf("cursor")!, ["cursor-agent", "agent"]), "cursor-agent", "co ca hai thi uu tien ten cu");
eq(binOf(agentOf("cursor")!, []), "cursor-agent", "khong do duoc thi van chay duoc mot dong");

// Bang phai nhat quan: id duy nhat, va chi Claude bao status live.
ok(new Set(AGENTS.map((a) => a.id)).size === AGENTS.length, "id trung nhau");
ok(AGENTS.filter((a) => a.live).length === 1, "chi Claude co live status");
ok(AGENTS.every((a) => a.id === "terminal" || a.bins.length > 0), "agent nao cung phai co binary");
ok(all.length === new Set(all).size, "danh sach binary bi lap");

if (bad) throw new Error("agents: " + bad + " loi");
console.log("agents: 15 truong hop deu dung");
