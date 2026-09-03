import { reorder } from "./reorder.ts";

const L = ["a", "b", "c", "d"].map((id) => ({ id }));
const ids = (l: { id: string }[]) => l.map((x) => x.id).join("");
let bad = 0;
const eq = (got: string, want: string, name: string) => {
  if (got !== want) { bad++; console.error("SAI " + name + " -> " + got + ", ky vong " + want); }
};

eq(ids(reorder(L, "a", "c")), "bcad", "keo a xuong cho c");
eq(ids(reorder(L, "d", "a")), "dabc", "keo d len dau");
eq(ids(reorder(L, "b", 1)), "acbd", "b sang phai");
eq(ids(reorder(L, "b", -1)), "bacd", "b sang trai");
eq(ids(reorder(L, "a", -1)), "abcd", "dau danh sach: khong doi");
eq(ids(reorder(L, "d", 1)), "abcd", "cuoi danh sach: khong doi");
eq(ids(reorder(L, "a", "a")), "abcd", "tha len chinh no: khong doi");
eq(ids(reorder(L, "z", 1)), "abcd", "id khong ton tai: khong doi");
if (reorder(L, "a", "a") !== L) { bad++; console.error("SAI: khong doi thi phai tra ve dung mang cu"); }

if (bad) throw new Error("reorder: " + bad + " loi");
console.log("reorder: 9 truong hop deu dung");
