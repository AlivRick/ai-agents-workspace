import { parseDiff, stat } from "./diff.ts";

let bad = 0;
const eq = (got: unknown, want: unknown, name: string) => {
  const [g, w] = [JSON.stringify(got), JSON.stringify(want)];
  if (g !== w) { bad++; console.error("SAI " + name + " -> " + g + ", ky vong " + w); }
};

// Dung nhu `git diff <base> -- a.txt` in ra cho mot sua doi va mot dong bi xoa.
const rows = parseDiff(`diff --git a/a.txt b/a.txt
index 5626abf..814f4a4 100644
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,4 @@
 one
-two
+TWO
+three
 four
`);
eq(rows.map((r) => r.kind).join(" "), "meta meta meta meta hunk ctx del add add ctx", "phan loai tung dong");

// Danh so la muc dich chinh: hai cot le phai thang hang.
const at = (k: string, i: number) => rows.filter((r) => r.kind === k)[i];
eq([at("ctx", 0).old, at("ctx", 0).new], [1, 1], "dong ngu canh dau");
eq([at("del", 0).old, at("del", 0).new], [2, null], "dong bi xoa khong co ben moi");
eq([at("add", 0).old, at("add", 0).new], [null, 2], "dong them khong co ben cu");
eq([at("add", 1).old, at("add", 1).new], [null, 3], "dong them thu hai");
eq([at("ctx", 1).old, at("ctx", 1).new], [3, 4], "sau khoi sua, hai ben lech nhau");
eq(at("ctx", 1).text, "four", "noi dung dong ngu canh");

// Dong ngu canh RONG van den duoi dang mot dau cach, khong duoc lan voi dong
// trong cuoi cung git tu them vao.
const blank = parseDiff("--- a\n+++ b\n@@ -1,2 +1,2 @@\n \n-x\n+y\n");
eq(blank.filter((r) => r.kind === "ctx").length, 1, "dong rong van la ngu canh");
eq(blank[blank.length - 1].kind, "add", "khong sinh dong thua o cuoi");

// File moi thi khong co ben cu nao ca.
const added = parseDiff("--- /dev/null\n+++ b/b.txt\n@@ -0,0 +1,2 @@\n+new\n+file\n");
eq(added.filter((r) => r.kind === "add").map((r) => r.new), [1, 2], "file moi danh so tu 1");
eq(added.filter((r) => r.old !== null).length, 0, "file moi khong co so ben cu");

eq(stat(2, 1, false), "+2 −1", "tom tat so dong");
eq(stat(0, 0, true), "binary", "file nhi phan khong dem dong");

if (bad) throw new Error("diff: " + bad + " loi");
console.log("diff: 13 truong hop deu dung");
