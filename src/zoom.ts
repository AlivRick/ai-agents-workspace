//! Cỡ chữ toàn app, một con số duy nhất.
//!
//! Không có "cỡ chữ UI" và "cỡ chữ terminal" riêng: cả hai đều là `zoom` trên
//! <html>, đúng như Ctrl+/− của trình duyệt. xterm ở đây dùng renderer DOM nên
//! chữ terminal phóng to nét vẫn sắc, và ResizeObserver trong Pane tự fit lại
//! PTY theo kích thước mới.

export const ZOOM_STEPS = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;
export const ZOOM_DEFAULT = 1;

/** Nấc kế tiếp theo hướng `dir`. Giá trị lạ (localStorage bị sửa tay, phiên bản
 *  cũ có nấc khác) rơi về nấc gần nhất chứ không văng ra khỏi thang. */
export function nextZoom(cur: number, dir: 1 | -1): number {
  const near = ZOOM_STEPS.reduce((a, b) => (Math.abs(b - cur) < Math.abs(a - cur) ? b : a));
  const i = ZOOM_STEPS.indexOf(near);
  // Đang ở giữa hai nấc thì bước tới phải đi lên nấc trên, không đứng yên.
  const j = near === cur ? i + dir : dir > 0 && near < cur ? i + 1 : dir < 0 && near > cur ? i - 1 : i;
  return ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, j))];
}

export function loadZoom(): number {
  const n = Number(localStorage.getItem("zoom"));
  return Number.isFinite(n) && n > 0 ? n : ZOOM_DEFAULT;
}

export function applyZoom(z: number) {
  document.documentElement.style.zoom = String(z);
  localStorage.setItem("zoom", String(z));
}
