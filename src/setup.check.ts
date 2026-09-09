import { freeSlot, expand } from "./setup.ts";

let bad = 0;
const eq = (got: unknown, want: unknown, msg: string) => {
  if (got !== want) { bad++; console.error(`FAIL ${msg}: ${got} != ${want}`); }
};

// So hieu: lap cho trong, khong troi ra ngoai dai cong.
eq(freeSlot([]), 1, "tac vu dau tien");
eq(freeSlot([1, 2, 3]), 4, "noi tiep");
eq(freeSlot([1, 3]), 2, "dong tac vu so 2 thi tac vu sau nhan lai so 2");
eq(freeSlot([0, 1]), 2, "tac vu cu chua co so (0) khong chiem cho cua ai");

const v = { n: 2, task: "9f2a-fix-checkout", tree: "/repo/.agentspace/9f2a-fix-checkout" };
eq(expand("SERVER_RUNING_AT_PORT=300{n} npm start", v), "SERVER_RUNING_AT_PORT=3002 npm start", "cong lech");
eq(expand("docker compose -p {task} up", v), "docker compose -p 9f2a-fix-checkout up", "ten du an");
eq(expand("code {tree}", v), `code ${v.tree}`, "duong dan");
eq(expand("echo {nope} {n}", v), "echo {nope} 2", "chi thay dung ba ten da hua");
eq(expand("{n}{n}", v), "22", "moi lan xuat hien, khong chi lan dau");

if (bad) throw new Error("setup: " + bad + " loi");
console.log("setup.check: OK");
