//! Hàng đợi ghi về PTY: đúng thứ tự, và gộp bớt round-trip.
//!
//! Mỗi lần `term.onData` bắn ra một lần `invoke` riêng. Trên Windows, IPC của
//! Tauri v2 đi qua custom protocol (fetch), nhiều request bay song song thì thứ
//! tự tới tay Rust KHÔNG được đảm bảo — hai chunk đảo chỗ là một chuỗi escape
//! bị xé đôi. Ví dụ xterm trả lời truy vấn Device Attributes bằng "\x1b[?62;c":
//! nếu "c" tới trước phần đầu, đầu kia đọc nó thành ký tự thường và nó dính lại
//! trong ô nhập.
//!
//! Cách chữa: mỗi pane chỉ để đúng MỘT lần ghi bay trên đường; những gì gõ
//! trong lúc chờ được gộp lại thành một lần ghi kế tiếp.

export function makeWriteQueue(send: (id: string, data: string) => Promise<void>) {
  const pending = new Map<string, string>();
  const tail = new Map<string, Promise<unknown>>();

  return {
    write(id: string, data: string): Promise<void> {
      pending.set(id, (pending.get(id) ?? "") + data);
      const next = (tail.get(id) ?? Promise.resolve()).then(() => {
        const buf = pending.get(id);
        // Lần ghi trước đã cuốn luôn phần này rồi.
        if (buf === undefined) return;
        pending.delete(id);
        return send(id, buf);
      });
      // Lỗi vẫn trả về cho người gọi (Pane bắt để đánh dấu pane chết), nhưng
      // không được làm đứt dây chuyền của những lần ghi sau.
      tail.set(id, next.catch(() => {}));
      return next as Promise<void>;
    },
    forget(id: string) {
      pending.delete(id);
      tail.delete(id);
    },
  };
}
