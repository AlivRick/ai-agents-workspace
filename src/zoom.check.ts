import { nextZoom, ZOOM_STEPS } from "./zoom.ts";

let bad = 0;
const eq = (got: unknown, want: unknown, msg: string) => {
  if (got !== want) { bad++; console.error(`FAIL ${msg}: ${got} != ${want}`); }
};

eq(nextZoom(1, 1), 1.1, "buoc len mot nac");
eq(nextZoom(1, -1), 0.9, "buoc xuong mot nac");

// Cham tran, cham day thi dung lai chu khong van ra ngoai thang.
eq(nextZoom(2, 1), 2, "het co to");
eq(nextZoom(0.7, -1), 0.7, "het co nho");

// Gia tri khong nam tren thang (localStorage bi sua tay): ve nac gan nhat theo
// dung huong, khong bao gio dung yen.
eq(nextZoom(1.05, 1), 1.1, "giua hai nac, di len");
eq(nextZoom(1.05, -1), 1, "giua hai nac, di xuong");
eq(nextZoom(0.5, 1), 0.7, "duoi thang, di len");
eq(nextZoom(9, -1), 2, "tren thang, di xuong");

// Moi nac deu tra ve mot nac hop le, khong ra NaN hay undefined.
for (const z of ZOOM_STEPS)
  for (const d of [1, -1] as const)
    eq(ZOOM_STEPS.includes(nextZoom(z, d) as never), true, `${z} ${d} van tren thang`);

if (bad) throw new Error("zoom: " + bad + " loi");
console.log("zoom.check: OK");
