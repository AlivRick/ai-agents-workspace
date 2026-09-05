import { makeWriteQueue } from "./writeq.ts";

let bad = 0;
const eq = (got: unknown, want: unknown, msg: string) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) { bad++; console.error(`FAIL ${msg}: ${a} != ${b}`); }
};
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

const got: string[] = [];
let slow = true;
const q = makeWriteQueue((_id, data) => {
  got.push(data);
  // Lần gửi đầu chậm nhất. Không có hàng đợi thì "c" về đích trước tiền tố của
  // nó, và đầu kia đọc "c" thành một ký tự thường.
  const wait = slow ? 20 : 0;
  slow = false;
  return tick(wait) as Promise<void>;
});

q.write("p", "\x1b[?62;");
await null; // lần ghi đầu đã bay đi
q.write("p", "c");
q.write("p", "xin chào");
// Pane khác là hàng đợi khác: không phải xếp sau pane "p".
q.write("q", "khác pane");
await tick(60);

eq(got.filter((s) => s !== "khác pane"), ["\x1b[?62;", "cxin chào"],
   "đúng thứ tự, gộp phần gõ trong lúc chờ thành một lần ghi");
eq(got.includes("khác pane"), true, "pane khác không bị hàng đợi của p chặn");

// Nhiều lần ghi trong cùng một nhịp thì gộp làm một.
got.length = 0;
q.write("p", "a"); q.write("p", "b"); q.write("p", "c");
await tick(10);
eq(got, ["abc"], "gộp trong cùng một nhịp");

// forget xoá sạch trạng thái của pane đã đóng.
q.forget("p");
got.length = 0;
await q.write("p", "lại từ đầu");
eq(got, ["lại từ đầu"], "forget rồi ghi lại được");

if (bad) throw new Error("writeq: " + bad + " loi");
console.log("writeq.check: OK");
