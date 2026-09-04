import { loudest, quote } from "./task.ts";

let bad = 0;
const eq = (got: string, want: string, name: string) => {
  if (got !== want) { bad++; console.error("SAI " + name + " -> " + got + ", ky vong " + want); }
};

eq(loudest([]), "idle", "khong co terminal nao");
eq(loudest(["idle", "run"]), "run", "co mot cai dang chay");
eq(loudest(["done", "run", "att"]), "att", "cho duyet at hon dang chay");
eq(loudest(["idle", "done"]), "done", "xong at hon san sang");

eq(quote("sua lo i"), '"sua lo i"', "chuoi thuong");
eq(quote('noi "xin chao"'), '"noi \\"xin chao\\""', "nhay kep duoc thoat");
eq(quote("chay `rm -rf /`"), '"chay \\`rm -rf /\\`"', "backtick duoc thoat");
eq(quote("gia tri $HOME"), '"gia tri \\$HOME"', "bien moi truong khong no ra");
eq(quote("duong dan C:\\\\tmp"), '"duong dan C:\\\\\\\\tmp"', "dau gach nguoc duoc nhan doi");
eq(quote("hai\ndong  lien"), '"hai dong lien"', "xuong dong gop thanh mot dong");
eq(quote("  le  "), '"le"', "cat khoang trang hai dau");

if (bad) throw new Error("task: " + bad + " loi");
console.log("task: 11 truong hop deu dung");
