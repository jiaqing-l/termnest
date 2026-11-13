# TERMNEST: kiểm tra hiệu năng (12/11/2026)

Máy đo: MacBook Air, 7 phiên tmux cục bộ, Claude/Codex logs ~14 GB (574 file .jsonl). Bản 1.1.17. Chưa đo trên trình duyệt thật
(không có profile Performance) và chưa đo SSH tới máy từ xa nhiều phiên.

## Đã đo
| Hạng mục | Kết quả | Đánh giá |
|---|---|---|
| API cục bộ (`/api/state`, `/features/*`, `/tokens`) | 1–3 ms mỗi lần; state 26,8 KB thô / 3,1 KB gzip | Tốt |
| Tài nguyên trang | JS+CSS ~660 KB thô (app.js 148 KB, app.css 147 KB, ops.js 90 KB), ~160 KB gzip + vendor; có gzip + ETag | Ổn |
| Poll tmux (`POLL_SCRIPT`) | 0,64–0,87 s cho 7 phiên, 35 KB, ~12 lệnh tmux; chạy mỗi 3 s khi có trang mở | Tuyến tính theo số phiên |
| Quét token lúc nguội | 33 s, RSS đỉnh ~850 MB, CPU tới 260 %; xong vẫn giữ ~750 MB (lúc rảnh 113 MB) | **Nặng nhất** |
| App thật sau khi mở | CPU 123 %, RSS 977 MB sau ~1,7 phút, về 271 MB sau ~2 phút | Spike lúc khởi động |
| Quét token lúc ấm | 0 % CPU, không quét lại trong 60 s | Tốt |

## Đọc từ mã (chưa đo)
- crewpanes.js chạy 5 bộ đếm giờ luôn bật: `/list` 2 s, `/tracks` 2 s, `loadDerived` 5 s (kéo cả fleet Vận hành), log 2,5 s, vẽ lại thanh 1 s.
  Chỉ log có kiểm `document.hidden`; app.js còn `pollCrew` 1,5 s và refresh 2,5 s.
- 25 thẻ `<script>` chặn (không `defer`).
- Mỗi tính năng tự có bộ đếm giờ riêng (10–20 s): ops, opshub, context, watchdog, server-backup, notes, health.

## Cần cải tiến (theo thứ tự lợi)
1. **Quét token:** đọc theo luồng thay vì nạp cả file; lưu kết quả từng file theo (kích thước, mtime) để không quét lại 14 GB mỗi lần mở app;
   chấm dứt worker sau khi quét để trả bộ nhớ; chỉ quét khi mở tab Token AI. (Chưa xác minh bản hiện tại có tăng dần hay không:
   app thật vẫn tăng CPU 123 % dù đã có `token-aggregates.json`.)
2. **Hẹn giờ:** một bộ lập lịch chung, dừng khi tab ẩn, giãn khi không có Crew; gộp `/list`, `/tracks`, `/opshub/state` thành một lần gọi.
3. **Poll nhiều phiên:** thời gian poll tăng tuyến tính (~0,1 s/phiên). Với vài chục phiên trên máy từ xa có thể vượt chu kỳ 3 s;
   cần đo SSH thật, cân nhắc chỉ lấy màn hình của phiên đang xem + phiên đổi trạng thái.
4. `defer` cho script và tách `app.js`/`app.css` (148 KB/147 KB) theo màn.

## Đã cải tiến (1.1.17, commit 564e7a2)
1. **Cache quét token lưu ra đĩa** (`lib/tokens.js`, `token-scan-cache/` trong thư mục dữ liệu, ~7 MB, 0600): trước đây cache tăng dần chỉ nằm trong RAM nên mỗi lần mở app đọc lại
   toàn bộ log. Đo cùng máy: quét sau khi khởi động lại **37 s → 5 s** (script đo riêng); trên app thật, CPU cao (130–260 %) kéo dài ~30 s nay chỉ còn ~6 s đỉnh rồi ~20 % thêm ~40 s.
2. **Trả worker sau 2 phút rảnh** (`lib/token-cache.js`): worker quét không còn giữ vài trăm MB mãi; lần quét sau tạo worker mới, chỉ đọc phần log mới.
3. **Hẹn giờ màn Crew dừng khi cửa sổ ẩn** (`public/features/crewpanes.js`): `/list`, `/tracks`, `/opshub/state`, vòng vẽ lại 1 s; khi hiện lại thì cập nhật bù một lượt.
Test: 785/787 đạt (2 lỗi cũ: vault copy fallback); thêm 2 test (trả worker rảnh, cache ra đĩa).

## Còn lại
- RSS đỉnh khi quét vẫn ~880 MB (đo lại sau cải tiến): phần gộp `seen` theo message id của toàn bộ log Claude (8,4 GB) dựng lại mỗi lần đọc. Cần tổng hợp theo từng file và lưu kết quả đã gộp.
- Poll tmux tuyến tính theo số phiên; `defer` script; tách `app.js`/`app.css`.

## Kết quả đợt 2 (13/11/2026)
Đo trên bản sao APFS (clone) của log thật (~14 GB: Claude 2 tài khoản + Codex 2.498 file), không ghi vào thư mục dữ liệu Termnest.
Chữ ký tổng (today/week/ngày/tuần/phiên theo từng tài khoản) **trước = sau** (sha256 cắt 16 ký tự `e91d834f2358877a`); tổng token 7.763.963.139 / 6.304.571.054 / 9.499.881.364.

| Hạng mục | Trước | Sau |
|---|---|---|
| Quét token nguội, RSS đỉnh | 938 MB | 432 MB |
| Quét token ấm (khởi động có cache), RSS đỉnh / thời gian | 825 MB / 4,3 s | 153 MB / 0,5 s |
| Phần tmux của poll, 40 phiên | 984 ms | 102 ms |
| Phần tmux của poll, 5 phiên | 67 ms | 40 ms |

Thay đổi:
1. **Nguyên nhân thật của ~830 MB lúc khởi động** không phải bảng `seen` (chỉ ~44 nghìn message) mà là 3 file Codex (76–156 MB) có một dòng > 16 MB: đọc lỗi nên *không bao giờ vào cache* và bị đọc lại từ byte 0 mỗi lần quét (303 MB I/O + rác bộ nhớ). Nay lưu "file lỗi" theo (ino, size, mtime) trong `cache.failed`; file không đổi thì bỏ qua, kết quả/thông báo lỗi giữ nguyên (nên tổng không đổi; nếu muốn đếm cả các file đó cần quyết định riêng vì tổng sẽ tăng).
2. `lib/token-source.js`: đọc bằng một buffer 1 MB dùng lại (không `Buffer.alloc` + `concat` mỗi chunk), chỉ sao chép dòng vắt qua chunk; dòng > 4 KB không chứa `"assistant"`/`"token_count"`/`"session_meta"`/`"cwd"` được bỏ qua ở mức byte, không giải mã/JSON.parse. Dòng ngắn vẫn parse nên dòng lỗi vẫn được đếm.
3. `lib/token-cache.js`: worker quét được trả sau 30 s rảnh (trước 120 s).
4. `lib/parse.js` `POLL_SCRIPT`: trước mỗi phiên tốn 1 tmux + grep + tail (+ 4 lần list). Nay 1 `list-sessions`, 1 client tmux chụp mọi pane qua chuỗi `;` + 1 awk, 1 tmux cho DETAIL+OWNERS: số tiến trình không còn tăng theo số phiên. Nếu một phiên biến mất giữa chừng (tmux huỷ chuỗi) thì chạy vòng cũ từng phiên. Đầu ra byte-by-byte giống bản cũ (so trên 40 phiên socket tmux riêng, đã xoá sau khi đo); chỉ đọc, không attach/kill phiên của người dùng.
5. `public/index.html`: 25 thẻ `<script>` đều ở cuối body, không có `document.write`/`currentScript`; `i18n.js` tự xử lý readyState. Thêm `defer`; kiểm bằng Chrome headless: không lỗi JS, i18n áp dụng, `pets-off`/`pets-still` được đặt.
6. Hoạt ảnh: `prefers-reduced-motion` đã tắt `*` từ trước. Thêm: tắt mọi animation của thú khi `pets-off`/`pets-still`; thú không chạy/chờ (ngủ) không còn chớp mắt vô hạn; class `html.tab-hidden` (đặt khi `document.hidden`) tạm dừng mọi animation. (Tab/view không hiển thị là `display:none` nên đã không chạy.)

Còn lại: quét nguội lần đầu vẫn đọc ~14 GB (~47 s, đỉnh 432 MB); dòng JSONL > 16 MB bị bỏ (hành vi cũ, giữ để tổng không đổi); chưa đo CPU WebContent sau khi bỏ animation; pet off-screen trong cùng view chưa dùng IntersectionObserver; hẹn giờ chung và tách `app.js`/`app.css` chưa làm.
