# Rủi ro: khôi phục hội thoại Claude/Codex sau khi máy khởi động lại

Nhánh `feat/resume-agents-after-reboot`. Ngày 06/11/2026. Test 422/422.

## Tính năng làm gì
- Mỗi lần quét (3 giây khi đang mở trang), TERMNEST đọc trên máy chủ: Claude ghi `~/.claude/sessions/<pid>.json` (mã hội thoại, thư mục); Codex giữ mở tệp `rollout-…-<mã>.jsonl` (đọc qua `/proc`, chỉ Linux).
- Ghép tiến trình đó với phiên tmux (tiến trình con của pane), lưu `{dir, run, resume}` vào kho dữ liệu của TERMNEST.
- Khi khôi phục: `claude --resume <mã>` hoặc `codex resume <mã>`.

## Đánh giá rủi ro và xử lý

| # | Rủi ro | Mức | Xử lý | Trạng thái |
|---|---|---|---|---|
| 1 | **Gửi thừa dữ liệu qua SSH**: bản đầu gửi nguyên tệp JSON của Claude (pid, đường dẫn socket, trạng thái…) về TERMNEST mỗi 3 giây | Trung bình | Lọc ngay trên máy chủ: chỉ gửi `mã` + `thư mục`. Không bao giờ đọc tệp `.key` cạnh đó (chỉ nhận tên `<số>.json`) | Đã sửa |
| 2 | **Lộ mã hội thoại ra trình duyệt**: danh sách phiên và "phiên bị mất" gửi lên trang chứa mã và thư mục của agent | Thấp (người xem đã đăng nhập, có quyền terminal) | Trang chỉ nhận `resumes: true/false`; mã và thư mục ở lại server. Có test kiểm tra mã không xuất hiện trong `/api/servers` | Đã sửa |
| 3 | **Nơi lưu**: mã hội thoại nằm trong kho dữ liệu | Thấp | Kho đã mã hóa AES-256-GCM, khóa từ mật khẩu (scrypt). Không ghi log nội dung quét | Đã có sẵn |
| 4 | **Chèn lệnh**: mã/thư mục từ máy chủ được ghép vào lệnh shell khi khôi phục | Cao nếu không chặn | Mã phải đúng dạng UUID (kiểm 2 lần: lúc đọc và lúc chạy); thư mục phải là đường dẫn tuyệt đối, không ký tự điều khiển, luôn được bọc nháy (`shq`). Test với `$(rm -rf /)` bị từ chối | Đã có |
| 5 | **Nhầm hội thoại do pid bị dùng lại**: sau reboot (máy tắt đột ngột), tệp `<pid>.json` cũ còn lại; pid đó có thể thuộc tiến trình khác trong phiên | Trung bình | Chỉ nhận khi tiến trình đó đúng là `claude`/`codex`; bỏ qua tệp của tiến trình đã chết | Đã sửa + test |
| 6 | **Hai phiên mở cùng một hội thoại** (ví dụ đã resume cùng chat ở 2 phiên): khôi phục cả hai sẽ cùng ghi một transcript, có thể **hỏng lịch sử chat** | Cao | Một mã chỉ được resume vào **một** phiên; phiên thứ hai mở Claude mới. Cũng bỏ qua nếu mã đó đang mở ở phiên khác | Đã sửa + test |
| 7 | **Quên hội thoại lúc máy đang tắt**: lúc reboot, Claude có thể chết trước tmux, một lần quét thấy shell rồi ghi "shell" | Trung bình | Chỉ ghi "shell" khi phiên đã chạy > 2 phút **và** vẫn là shell liên tục ≥ 60 giây | Đã sửa + test |
| 8 | **Tốn tài nguyên**: thư mục `sessions` tích tệp cũ, quét mỗi 3 giây | Thấp | Chỉ xem 32 tệp mới nhất, tối đa 16 tiến trình codex; lệnh luôn thoát 0 (tránh làm hỏng cả vòng quét) | Đã sửa |
| 9 | **Agent tự chạy tiếp việc cũ** sau khôi phục | Thấp | `--resume` chỉ mở lại chat, chờ người gõ; không thêm cờ bỏ qua quyền | Chấp nhận |
| 10 | **Mã cũ sau `/clear` hoặc `/resume` bên trong Claude** | Thấp | Claude cập nhật tệp `<pid>.json`; nếu transcript không còn, TERMNEST mở phiên Claude mới thay vì báo lỗi | Chấp nhận, cần thử thật |
| 11 | **Nhiều người dùng / root trên một máy** | Thấp | Chỉ đọc thư mục của tài khoản SSH đang dùng; tiến trình người khác không ghép được vì không là con của pane | Chấp nhận |
| 12 | **Thư mục agent đã bị xóa** khi khôi phục | Thấp | Phiên báo "không thấy thư mục", vẫn nằm trong danh sách khôi phục để thử lại/bỏ qua | Chấp nhận |

## Chưa làm được / giới hạn
- Codex trên **Mac**: không có `/proc` nên chưa biết mã; vẫn mở bảng chọn `codex resume`.
- Windows chế độ PowerShell: không áp dụng.
- **Chưa thử trên Ubuntu thật có reboot.** Đã chạy thật lệnh đọc mã trên Mac (bash và dash), kết quả đúng, chỉ có mã + thư mục.

## Cần bạn thử
1. Cài bản cập nhật, mở 2–3 phiên Claude/Codex trên Ubuntu, chat vài câu.
2. Chờ ~10 giây, khởi động lại Ubuntu, bấm Khôi phục.
3. Kiểm: mỗi phiên mở lại đúng chat của nó; phiên chỉ là shell vẫn là shell.
