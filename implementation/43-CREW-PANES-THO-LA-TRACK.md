# Crew panes: thợ là track của `_crew`, khớp màn Vận hành

Nhánh `feat/crew-panes-proto`, worktree `tools/_wt-termnest-crew-panes`. Chưa commit.

## Sai lầm trước đó
Hướng "thợ = một phiên tmux" không khớp mô hình thật. Trong Vận hành, worker là tiến trình
`crew-dispatch.sh` do phiên điều phối sở hữu; mỗi worker là một **track** trong `_crew/tasks/<task>`
và có file log riêng. Bản thật không nên tạo phiên cho thợ.

## Đã làm (public/features/crewpanes.js)
- **Crew** = phiên điều phối + task của nó, lấy từ cùng dữ liệu Vận hành: `opshub/state`
  (`tasks[].leader`, `tasks[].tracks`, `sessions[].workers`). Không đăng ký, không tạo gì thêm.
- **Thợ** = track. Trạng thái từ `_crew`:
  - dispatched / running / fix / review: đang chạy
  - queued / pending / blocked: chờ lượt
  - failed: lỗi (viền đỏ, Crew báo "Cần kiểm tra")
  - done / merged: xong
- Loại Codex/Claude lấy từ tiến trình đang chạy (`sessions[].workers[].kind`); chưa chạy thì ghi "track".
- Nội dung pane thợ = đuôi log track qua route sẵn có `crew/log` (chỉ đọc), làm mới mỗi 2,5 giây.
- Vận hành và Crew dùng một nguồn nên không còn hai nguồn sự thật; không có phiên thợ nên Vận hành
  không bị nhiễu "phiên AI khác".
- `/create` và `/spawn` (tạo phiên thợ giả) chỉ còn khi chạy `TW_CREW_DEMO=1`; ngoài đó trả 404.

## Làm thêm theo yêu cầu
- Nút ẩn/hiện thợ ở thanh Crew: điều phối chiếm cả chiều cao.
- Kéo thanh mảnh giữa điều phối và thợ để đổi độ cao (bấm đúp: mặc định). Mặc định điều phối cao hơn
  (khoảng 62% khi 1-3 thợ, 50% khi 4-6 thợ). Tỉ lệ lưu ở localStorage `tw-crew-lead`.
- Nút chuông "Nhắc điều phối" bấm thẳng trên thanh (gửi một dòng vào phiên điều phối).
- Hàng Crew ở sidebar hiện chữ cái đầu khi tắt thú cưng (trước đó là ô trống).

## Kiểm chứng
- 10 test `test/crewpanes-feature.test.js` qua, gồm `deriveCrews`: một Crew mỗi leader; bỏ task không
  leader hoặc không track; hai task cùng leader không lẫn track; không bật `TW_CREW_DEMO` thì không tạo phiên.
- Chạy thật trên bản thử (http://127.0.0.1:7792) với fleet giả: leader TEST2 (phiên thật) ở trên,
  4 pane thợ đọc log, hiện đúng Đang chạy / Lỗi / Xong / Chờ lượt.
- 6 test lỗi ở `crew-popup`, `i18n` lỗi y hệt khi trả `app.js`/`app.css` về bản gốc: không do thay đổi này.

## Chưa kiểm chứng / còn lại
- Chưa chạy với `_crew` thật và Claude/Codex thật; quan hệ leader-task còn phụ thuộc cách Vận hành suy từ
  `nudge.conf` và bằng chứng.
- i18n en/vi cho chuỗi mới.
- Nhắc điều phối thật hiện gửi một dòng cố định vào phiên.

## Cập nhật: chi tiết giữ của phiên điều phối, thợ xong tự gọn
- Chọn thợ (chip, dòng sidebar, bấm vào pane thợ) không đổi panel chi tiết và tab: luôn là của phiên điều phối
  (`app.js` focusPane bỏ qua pane thợ khi đổi `cur`).
- Thợ xong rời lưới sau 8 giây (`TIDY_MS`), chip vẫn còn. Thợ đang chạy / chờ / lỗi và thợ người dùng đã chọn thì ở lại.
- Tất cả xong: lưới thợ tự gập, điều phối chiếm cả chiều cao. Nút ở thanh Crew: "Hiện cả các thợ đã xong" /
  "Chỉ hiện thợ cần xem" / "Ẩn các thợ". Plan mới bắt đầu thì tự về chế độ gọn.
- Kiểm tra trên bản thử: 3 pane về 1 sau ~8 giây; chọn W2 mở pane W2 viền sáng, chi tiết vẫn "UIUX", W2 ở lại.
