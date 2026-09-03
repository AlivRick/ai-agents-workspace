# Agentspace

Desktop app quản lý workspace và session cho **Claude Code**, dựng bằng Tauri v2 + Rust,
theo đúng kiến trúc mà BridgeMind One đang dùng.

Nó **không thay thế** Claude Code — nó chạy chính binary `claude` đã cài trên máy bạn, bằng
subscription của bạn, trong PTY thật.

## Ranh giới tuân thủ

Đây là phần load-bearing của thiết kế, không phải lời hứa suông:

- App **dò** `claude` trên PATH và các vị trí cài quen thuộc, đọc `--version`, và kiểm tra
  trạng thái đăng nhập. Nếu chưa đăng nhập, nó **bảo bạn tự chạy `claude`** — không tự
  đăng nhập hộ.
- App đọc **metadata** tài khoản từ `~/.claude.json` (email, tổ chức, hạng gói) để hiển thị.
- App **kiểm tra file `~/.claude/.credentials.json` có tồn tại hay không, và không bao giờ
  mở nó**. Không trích token, không gọi thẳng `api.anthropic.com`, không xoay vòng nhiều
  tài khoản. Xem `src-tauri/src/engine.rs`.
- Hook được nạp qua `claude --settings <file>` cho từng lần chạy. `~/.claude/settings.json`
  của bạn không bị sửa.

## Tính năng

| | |
|---|---|
| **Workspace** | Danh sách bắt đầu **rỗng** — app không tự thêm thư mục nào. Bạn chọn thư mục, hoặc mở "Nhập từ Claude Code" để tick chọn trong số project Claude Code đã biết. Ghim để đưa lên đầu. Hiện branch git + số file đang thay đổi; tên trùng được phân biệt bằng thư mục cha. |
| **Giao diện** | 22 bộ màu: đủ bộ dựng sẵn của VS Code (Dark+, Light+, Monokai, Monokai Dimmed, Solarized Dark/Light, Quiet Light, Abyss, Kimbie Dark, Red, Tomorrow Night Blue, High Contrast Dark/Light) và các bộ phổ biến (Dracula, Nord, One Dark Pro, Tokyo Night, GitHub Dark/Light, Gruvbox Dark/Light). Áp cho **cả vỏ ứng dụng lẫn terminal** cùng lúc. |
| **Terminal đa pane** | PTY thật (`portable-pty`), lưới 1–3 cột tự động, khôi phục layout sau khi khởi động lại. Nút chạy Claude cho một pane hoặc tất cả. Pane **không bị đóng khi chuyển tab** — chỉ đóng khi bạn bấm × hoặc thoát app. |
| **Chuyển runtime (Windows ↔ WSL)** | Trên Windows, mỗi pane chọn được chạy shell ở đâu: **Windows** (PowerShell) hay **WSL · \<distro\>**. Chọn WSL thì app spawn `wsl.exe -d <distro> --cd <đường-dẫn-Linux>`, dịch đường dẫn Windows/UNC sang Linux, đưa `ZDOTDIR` và thư mục hook qua `WSLENV`, và dùng `claude` của distro. Workspace nằm trên ổ Linux thì app tự chọn WSL. |
| **Command blocks** | Shell integration OSC 133 cho zsh/bash: mỗi lệnh thành một block có exit code, cwd, và vạch màu ở lề. Danh sách 50 lệnh gần nhất, bấm để nhảy tới. |
| **Trạng thái agent** | Hook Claude Code (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop`, `SessionEnd`) báo về theo từng pane: đang chạy tool gì, pane nào đang chờ bạn duyệt. |
| **Hộp thư** | Một danh sách gộp mọi pane đang **chờ bạn duyệt** hoặc vừa **xong**, bấm để nhảy thẳng tới pane đó. Kèm thông báo hệ thống + nháy thanh tác vụ, **chỉ khi cửa sổ Agentspace không được focus**. |
| **Cửa sổ 5 giờ** | Đồng hồ quota: token đã dùng trong cửa sổ đang mở, còn bao lâu tới lúc đóng, tốc độ đốt token/phút và ước tính lúc hết cửa sổ — vẽ **so với cửa sổ nặng nhất của chính bạn**, không phải một trần số bịa ra. |
| **Session** | Đọc thẳng từ `~/.claude/projects/**/*.jsonl` — tiêu đề AI, prompt cuối, model, chi phí, token, dòng code, thời lượng. Tìm kiếm, lọc theo workspace, **Tiếp tục** (`--resume`), **Fork** (`--fork-session`), **đổi tên**, và **xoá** một hoặc nhiều phiên (hai bước xác nhận). |
| **Nội dung workspace** | Mọi thứ quyết định cách Claude hành xử trong thư mục đó, một chỗ: **CLAUDE.md** (cả 4 tầng: dự án, cá nhân, `.claude/`, toàn cục — tầng nào chưa có thì bấm để tạo), **Skills**, **Agents** (`.claude/agents/`), **Lệnh** gạch chéo (`.claude/commands/`, thư mục con thành `/nhóm:lệnh`), **MCP** (gộp từ `.mcp.json`, `settings.json`, `settings.local.json` và `.claude.json`), **Plugin** (đã cài + marketplace), **Memory**. Bốn nhóm markdown sửa được ngay trong app; MCP và plugin chỉ đọc. |
| **Mức sử dụng** | Token và chi phí theo ngày / model / workspace, khoảng hôm nay–7–30 ngày–tất cả. |

## Vì sao 22 bộ màu mà không cần file theme riêng

Một theme chỉ là 16 màu ANSI + nền/chữ/con trỏ/vùng chọn + một màu nhấn. Mọi token
bề mặt còn lại (panel, viền, chữ mờ, nền chip trạng thái) được **suy ra** bằng cách trộn
nền với chữ, nên thêm một theme là 20 giá trị hex chứ không phải một stylesheet — và
terminal với phần vỏ quanh nó không bao giờ lệch nhau. Xem `src/themes.ts`.

## Đường dẫn: POSIX bên trong, UNC bên ngoài

Một distro ghi mọi thứ bằng đường dẫn POSIX — `.claude.json` liệt kê
`/home/thuan/hutech`, transcript ghi `cwd` cũng vậy. Windows **không stat được**
những đường dẫn đó; nó chỉ mở được `\\wsl.localhost\<distro>\home\thuan\hutech`.
Hai lỗi đến từ đúng chỗ này:

- Sheet "Nhập từ Claude Code" trống trơn: 65 project đều bị `is_dir()` trả false nên
  bị coi là đã biến mất. Giờ mỗi key được đổi sang UNC **trước khi** kiểm tra, và lưu ở
  dạng đó — trùng với thứ hộp thoại chọn thư mục sinh ra.
- Bộ lọc "Workspace này" không ra gì: workspace lưu `\\?\UNC\...` còn session ghi
  `/home/...`. Cả hai vế giờ đi qua `normPath` (TS, có `npm run check:paths`) và
  `util::norm_path` (Rust, dùng để khử trùng lặp khi thêm workspace).

Cây trong sheet nhập cũng dựng trên dạng POSIX rồi mới map ngược về đường dẫn thật,
vì tách UNC theo `/` chỉ ra một đoạn duy nhất.

## Đọc dữ liệu Claude Code của đúng runtime

Không chỉ shell: khi chọn WSL thì **phiên, mức dùng, skill, memory và CLAUDE.md toàn cục**
cũng phải đọc từ distro. Windows phục vụ filesystem của distro đang chạy qua
`\\wsl.localhost\<distro>`, nên `App::claude_dir(runtime)` chỉ cần trả về đường dẫn UNC đó
và mọi thứ còn lại dùng file IO bình thường — không phải bơm qua `wsl.exe`. Mỗi runtime có
scan-cache riêng vì hai bên là hai tập transcript khác nhau.

Runtime mặc định được **nhớ lại**. Lần chạy đầu app dò: trong số các runtime đã đăng nhập,
chọn cái **thực sự có transcript** (đếm file, không parse). Chỉ dựa vào "đã đăng nhập" là
không đủ — máy Windows thường đăng nhập cả hai bên trong khi công việc chỉ nằm ở một bên,
và chọn nhầm là mở lên thấy app rỗng.

## Vì sao mở app không nháy cửa sổ đen

Mỗi lần gọi `wsl.exe`, `claude --version` hay `git` trên Windows là spawn một tiến trình
console — và mỗi cái nháy một cửa sổ đen vài frame. Lúc khởi động app gọi cả chục lần, đó
chính là cái "giật giật, mở terminal gì đó". Mọi `Command` giờ đi qua `util::quiet_command`
với cờ `CREATE_NO_WINDOW`. Danh sách runtime cũng chỉ probe **một lần mỗi phiên** thay vì
mỗi lần có ai hỏi (trước đó mở một pane WSL là probe lại `1 + 2N` tiến trình).

## Vì sao mở app không giật

Tauri chạy lệnh **không async trên main thread**. Quét vài trăm MB transcript hay gọi
`wsl.exe` ở đó là đóng băng cửa sổ. Mọi lệnh nặng giờ là `async fn` + `spawn_blocking`, và
lần quét transcript đầu tiên dời lại 250ms sau khi vỏ app đã vẽ xong.

Một lỗi nữa: effect lưu layout phụ thuộc vào mảng `panes`, mà mảng này đổi identity mỗi lần
hook cập nhật trạng thái — nghĩa là **ghi `state.json` xuống đĩa hai lần mỗi giây**. Giờ nó
chỉ lưu khi phần thực sự được persist thay đổi.

## Vì sao cần chuyển runtime chứ không chỉ một shell

Trên Windows, `cmd.exe` **không cd được vào đường dẫn UNC** — chọn một thư mục WSL thì nó
âm thầm rơi về `C:\Windows`. Và `claude` cài trong distro thì Windows không thấy. Nên pane
mang theo một *runtime*: host thì chạy PowerShell (có shell integration riêng, xem
`PWSH_INIT`), WSL thì chạy `wsl.exe` với đường dẫn đã dịch. `engine_status` cũng hỏi đúng
runtime đó — bản Claude Code trên Windows không nói gì về bản trong WSL.

## Đổi tên phiên: dùng đúng cơ chế của Claude Code

Claude Code lưu tiêu đề bằng các bản ghi `ai-title` trong chính transcript và đọc bản ghi
cuối cùng. Nên "đổi tên" ở đây là **ghi thêm một dòng `ai-title`** — tên mới hiện luôn cả
trong `claude --resume`, không phải một lớp tên riêng chỉ app này thấy. Một lần append nhỏ
dưới `O_APPEND` là atomic nên không thể làm rách transcript kể cả khi phiên đang chạy.

## Xoá phiên: vì sao chỗ này không "lười"

`sessions::delete` canonicalise từng đường dẫn, bắt buộc phải là `.jsonl` nằm **trong**
`~/.claude/projects`, và một đường dẫn sai làm hỏng cả lệnh thay vì xoá được một nửa.
Thư mục project rỗng được dọn bằng `remove_dir` — lệnh này từ chối thư mục còn nội dung,
nên nó không thể kéo theo thứ gì khác. Có test cho cả hai nhánh.

`ws::resolve` (dùng cho CLAUDE.md / skill / memory) kiểm tra theo đường dẫn **từ vựng** —
gấp `..` lại rồi mới so với workspace và `~/.claude`. Bản đầu canonicalise trước, trông
chặt hơn nhưng lại **sai**: một skill symlink vào `~/.claude/skills` (máy này có một cái
trỏ sang ổ Windows) bị đẩy ra ngoài root và bị từ chối. Traversal vẫn bị chặn; thứ được
cho phép là symlink do chính người dùng đặt trong thư mục cấu hình của họ.

## Vì sao đồng hồ quota vẽ theo *bạn*, không theo một trần số

Không có API nào nói hạn mức của bạn là bao nhiêu. Một thanh "83% của 200k" sẽ là con số
tự bịa. Nên vạch mức được vẽ so với **cửa sổ 5 giờ nặng nhất bạn từng có** — "gấp rưỡi lần
nặng nhất từ trước tới nay" là một cảnh báo có thật.

Cửa sổ mở tại đầu giờ của hoạt động đầu tiên sau khi cửa sổ trước đóng, và kéo 5 giờ — nên
một khoảng nghỉ dài hơn 5 giờ tự khắc mở cửa sổ mới, đúng hình dạng hạn mức của Claude Code.

Chỗ này không thể tính từ tổng của phiên: một phiên chạy từ sáng tới tối sẽ rơi trọn vào
cửa sổ mà nó *bắt đầu*. Nên `parse_file` cộng token vào **từng giờ đồng hồ** theo timestamp
của từng message (`Session::hours`), và cửa sổ là tổng các giờ trong đó. Có test khẳng định
tổng theo giờ bằng đúng tổng của phiên — nếu hai con số này lệch nhau thì biểu đồ đang nói dối.

Những giờ đó **nằm trong cache** nhưng bị gỡ (`slim`) trước khi danh sách phiên đi qua IPC:
giao diện không đọc chúng, và trên máy vài trăm transcript chúng chiếm phần lớn payload.

## Đô-la của một cửa sổ là ước tính

Claude Code ghi tiền theo *phiên*, không theo message. Nên chi phí của một phiên được chia
cho các giờ của nó theo tỷ lệ token ra. Token thì chính xác; con số đô-la trong thẻ cửa sổ
5 giờ là ước tính, và tổng các phần vẫn bằng đúng tiền của phiên (có test).

## Cấu hình MCP không bao giờ hiện giá trị

Đây là chỗ chứa bí mật: chuỗi kết nối Postgres có mật khẩu trong `args`, session token
Telegram trong `env`. Một dashboard vẽ nguyên chuỗi đó lên màn hình là kiểu rò rỉ mà không
thứ gì khác trong app gây ra được — nhất là lúc chia sẻ màn hình.

Nên giá trị không rời khỏi Rust: `env` chỉ còn **tên biến**, và phần `user:pass@` của mọi
URL bị thay bằng `***@` ngay trong `ws::redact`. MCP và plugin **chỉ đọc** — sửa thì dùng
`/mcp`, `/plugin` trong phiên Claude Code, đúng cơ chế của nó.

## Thông báo chỉ bắn khi bạn không nhìn

Pane đang chờ duyệt trong lúc bạn ở cửa sổ khác là thứ duy nhất app này biết mà terminal
không nói được. Nhưng một toast đè lên cửa sổ bạn đang gõ là tiếng ồn — lúc đó chip trên
pane và bộ đếm dưới chân đã đủ. Nên điều kiện là `!document.hasFocus()`, kèm
`requestUserAttention` để nháy thanh tác vụ.

## Hạn mức lấy từ `/usage`, không tự đoán

Cửa sổ 5 giờ dựng lại từ transcript chỉ đoán được mốc mở/đóng và không biết trần thật của
gói, nên thẻ hạn mức chạy thẳng `claude -p /usage` — cùng số mà `/usage` trong Claude Code
hiển thị, do server trả về. Vẫn là binary và tài khoản của bạn; app không gọi API Anthropic.

Hai cái bẫy đã xử lý:

* Một print-run vẫn để lại transcript. Hỏi 5 phút một lần thì mỗi ngày đẻ ra hàng trăm
  "phiên" giả ngay trong thống kê mà thẻ đang vẽ — nên probe chạy trong thư mục riêng
  (`$TMPDIR/agentspace-usage-probe`) rồi xoá đúng thư mục transcript của nó.
* Mốc reset in ra không có năm, và đúng đầu giờ thì bỏ luôn phút (`7am`, không phải
  `7:00am`). `npm run check:limits` giữ cả hai trường hợp đó.

Không đọc được `/usage` (chưa đăng nhập, CLI cũ) thì thẻ quay về ước lượng từ transcript và
nói rõ trên giao diện là ước.

## Vì sao dashboard đọc token trước, không đọc đô-la trước

Claude Code chỉ ghi bản ghi `cost-state` cho **một phần** phiên (trên máy này: 28/160).
Nếu chỉ cộng `cost-state`, biểu đồ sẽ báo thiếu ~5 lần. Nên app cộng token từ **từng
message** (`usage` trong mỗi bản ghi assistant) — luôn đầy đủ — và chỉ dùng `cost-state`
cho phần đô-la, kèm chú thích bao nhiêu phiên thực sự có số liệu.

## Chạy

```bash
npm install
npm run tauri dev      # dev
npm run tauri build    # đóng gói
cd src-tauri && cargo test
```

Bản đóng gói ra ở:

```
src-tauri/target/release/bundle/appimage/Agentspace_0.1.0_amd64.AppImage   (~77 MB)
src-tauri/target/release/bundle/deb/Agentspace_0.1.0_amd64.deb             (~2 MB)
```

Bản cài Windows build chéo ngay từ Linux, không cần máy Windows:

```bash
rustup target add x86_64-pc-windows-msvc
cargo install --locked cargo-xwin
sudo apt install -y llvm clang lld
npm run tauri build -- --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis
# -> src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/*-setup.exe
```

Lần đầu `cargo-xwin` tải ~2 GB SDK/CRT của Microsoft vào `~/.cache/cargo-xwin`; các lần sau
dùng lại cache. Bản cài chưa ký số nên Windows SmartScreen sẽ cảnh báo lần chạy đầu.

Trên WSL2, nếu cửa sổ đen thì đặt `WEBKIT_DISABLE_COMPOSITING_MODE=1`.

`npm run check:paths` kiểm tra `normPath` — chỗ quyết định một thư mục đặt tên kiểu Windows
có phải cùng thư mục mà session (do Claude Code bên Linux ghi) đã lưu hay không. Sai chỗ này
là tab "Workspace này" không liệt kê gì.

`cargo test` gồm 22 test, trong đó hai test chạy shell thật qua PTY thật: một test dựng
`write_shell_files()` rồi mở zsh và bash tương tác để khẳng định `133;D;0` và `133;D;1`
đúng exit code; một test khẳng định file hook phủ đủ vòng đời agent và ghi nguyên tử
(`.part` rồi `mv`).

## Cấu trúc

```
src-tauri/src/
  engine.rs    dò CLI, kiểm tra version + đăng nhập, đọc metadata tài khoản
  sessions.rs  quét transcript (cache theo mtime+size, có version), tổng hợp usage
  term.rs      PTY, shell integration OSC 133, hộp thư hook
  store.rs     workspace + layout (một file JSON), git branch/dirty
  ws.rs        CLAUDE.md / skill / agent / lệnh / MCP / plugin / memory của workspace
  lib.rs       lệnh Tauri
src/
  App.tsx      shell, lưới pane, máy trạng thái hook
  Pane.tsx     xterm.js + parser OSC 133 + decoration ở lề
  WorkspaceView.tsx  bảy tab nội dung workspace
  SessionsView.tsx / UsageView.tsx
```

Trạng thái nằm ở `~/.local/share/dev.thuan.agentspace/`.
