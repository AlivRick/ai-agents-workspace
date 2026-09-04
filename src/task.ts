/** Status của một terminal, xếp từ ồn nhất xuống im nhất. */
export const RANK = ["att", "run", "done", "idle"] as const;
export type Status = (typeof RANK)[number];

/** Chấm màu cạnh tên tác vụ = việc ồn nhất trong tác vụ đó. */
export const loudest = (all: Status[]): Status => RANK.find((s) => all.includes(s)) ?? "idle";

/**
 * Lời nhắc gõ trong bảng tạo tác vụ đi thẳng vào dòng lệnh `claude "…"`.
 * Bốn ký tự shell vẫn đọc bên trong nháy kép phải được thoát, nếu không một
 * dấu backtick hay `$(…)` trong lời nhắc sẽ *chạy* thay vì được gửi đi.
 * Xuống dòng gộp thành khoảng trắng: một lệnh là một dòng.
 */
export const quote = (s: string) => `"${s.replace(/\s+/g, " ").trim().replace(/(["\\$`])/g, "\\$1")}"`;
