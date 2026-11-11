# Crew panes — prototype chạy thật trên TermNest (nhánh `feat/crew-panes-proto`)

## Là gì
Một **Crew** = 1 phiên điều phối + N phiên thợ (1–4), hiển thị cùng lúc trong màn Terminal thật của TermNest,
trạng thái **đo từ chính các pane** (màn hình + tuổi output), thay hộp "Crew (leader)" suy từ file.

## Chạy thử (không tốn token, agent giả lập)
```
TW_DATA=<thư mục riêng> TW_NEW_PASSWORD=<mật khẩu ≥10 ký tự> node scripts/set-password.js
TW_DATA=<thư mục riêng> TW_PORT=7791 TW_TMUX_SOCKET=twcrewdemo node server.js
```
Mở http://127.0.0.1:7791 → **Crew mới** → gõ task vào pane điều phối → `ok` → thợ chạy song song.
Tích "Dùng Claude/Codex thật" để mở Claude/Codex thật (tốn token).

## Đã có
- Bố cục Trái / Trên / 2×2 / 1 pane; pane thợ mặc định "Chỉ xem", bấm để can thiệp.
- Thanh tiến độ W1 › W2 › W3; nhóm Crew ở sidebar; thẻ Crew ở Tổng quan; điện thoại: slot cuộn ngang.
- Hộp Crew: nguồn + độ tươi từng dòng; im lặng > 45 s khi đang giao việc ⇒ "Cần kiểm tra"; mất kết nối ⇒ "Không đo được".
- Thêm thợ, nhắc điều phối, dừng cả Crew, giả lập thợ treo.

## Chưa có / cần quyết
- Tiến độ track đọc từ `.crew-demo/<crew>/tracks.json` (demo). Bản thật phải đọc `_crew/tasks` (crew.js) hoặc crew-panes state.
- Chỉ máy local; chuỗi tiếng Việt viết thẳng (chưa qua i18n en/vi); ngưỡng im lặng 45 s là của demo (thật: ~300 s).
- Hộp "Crew (leader)" cũ bị ẩn bằng CSS cho mọi phiên: crew kiểu cũ (không tạo từ nút Crew mới) hiện chưa có hộp thay thế.
- Windows không tmux (PowerShell thường): Crew chưa hỗ trợ.

## File
`lib/features/crewpanes.js`, `public/features/crewpanes.{js,css}`, `demo/crew-demo-agent.js`,
hook nhỏ trong `public/app.js` (`showPanes`, `inCrew`, `TW.sideCrews/gridCrews`), `test/crewpanes-feature.test.js`.
