import { uriMap } from "./lspuri.ts";

let bad = 0;
const eq = (a: unknown, b: unknown, what: string) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) { bad++; console.error("SAI:", what, "\n  ra:  ", a, "\n  mong:", b); }
};

// App tren Windows, workspace trong WSL: server thay duong dan Linux.
const w = uriMap("\\\\wsl.localhost\\Ubuntu\\home\\t\\my app", "/home/t/my app");
eq(w.base, "file:///home/t/my%20app", "goc co dau cach");
eq(w.toUri("\\\\wsl.localhost\\Ubuntu\\home\\t\\my app\\src\\a.ts"), "file:///home/t/my%20app/src/a.ts", "file trong WSL -> uri");
eq(w.toPath("file:///home/t/my%20app/src/a.ts"), "\\\\wsl.localhost\\Ubuntu\\home\\t\\my app\\src\\a.ts", "uri -> file tren Windows");
eq(w.toPath("file:///home/t/.rustup/lib.rs"), null, "ngoai workspace thi khong mo");

// Workspace tren o dia Windows.
const c = uriMap("C:\\proj", "C:\\proj");
eq(c.toUri("C:\\proj\\x.ts"), "file:///C:/proj/x.ts", "o dia C");
eq(c.toPath("file:///c%3A/proj/x.ts"), "C:\\proj\\x.ts", "server tra ve c%3A kieu VS Code");

// Linux thuan.
const l = uriMap("/home/t/p", "/home/t/p");
eq(l.toPath(l.toUri("/home/t/p/a b/c#.ts")), "/home/t/p/a b/c#.ts", "khu hoi voi ky tu dac biet");

if (bad) throw new Error("lspuri: " + bad + " loi");
console.log("lspuri: 7 truong hop deu dung");
