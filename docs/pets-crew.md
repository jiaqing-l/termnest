# Thú cưng và Crew

### Thú cưng và Crew live

- Công tắc **Thú cưng** lưu trên trình duyệt; tắt chuyển động theo thiết lập giảm chuyển động của hệ điều hành. Sân chơi chỉ nằm trên Tổng quan, không phủ terminal. Timer chơi ngẫu nhiên 11–23 giây dừng khi tab ẩn.
- Pet chờ giơ bảng, sau 2 phút quan sát liên tục thì gõ cửa rồi nghỉ cằm. Đạo cụ lấy từ tiến trình foreground thật: git push, test, docker build, Claude. Không suy diễn lệnh từ nội dung log. Tuổi phiên lấy từ `session_created`; kết nối bị mất giữ hình ảnh cuối với dấu vẫy tay.
- Trophy/confetti hoặc khói chỉ hiện khi tmux cung cấp `pane_dead` và `pane_dead_status` (ví dụ phiên đã bật `remain-on-exit`). Shell bình thường không cung cấp exit code đáng tin cậy qua polling; quay về prompt **không** bị coi là thành công/thất bại. Công cụ không cài shell hook hoặc thay đổi cấu hình tmux.
- Bấm worker hoặc **Xem log** để đọc 64 KiB cuối của file log mới nhất, làm mới mỗi 1,5 giây qua tài khoản đăng nhập và SSH hiện có. Cuộn lên ngừng tự cuộn; cuộn xuống đáy để tiếp tục. **Tạm dừng** ngừng cập nhật. Tab ẩn/Terminal cũng dừng đọc panel.
- Worker đã quan sát được giữ trong bộ nhớ 1 giờ sau khi biến mất khỏi bảng tiến trình thành công. Kết quả lấy từ sentinel `DONE`/`FAILED`; không có sentinel thì hiện chưa rõ kết quả. Thời lượng dựa trên tuổi tiến trình và thời điểm quan sát kết thúc, có sai số theo chu kỳ poll. Khởi động lại dịch vụ xóa lịch sử worker này; không quét lại các task cũ chưa từng quan sát.
- Chỉ đọc log nằm trong `_crew/tasks/<task>/tracks/<track>/logs` dưới cwd của dispatcher. Tên task/track chỉ nhận chữ Latin, số, `_`, `-`; không nhận đường dẫn từ trình duyệt. Kiểm tra đường dẫn thực và bỏ qua file symlink, từ chối thư mục symlink thoát khỏi track. Máy chủ cần `readlink -f` và các trường `ps` của Linux để xác định tiến trình/log đầy đủ.

### Thú cưng và Crew theo phiên

- Bật/tắt **Thú cưng** ở đầu trang; lựa chọn được lưu trên trình duyệt. Giảm chuyển động theo cài đặt hệ điều hành. Thú và hiệu ứng nằm trong thẻ, sân chơi hoặc cột chi tiết, không che terminal.
- Trong Terminal, **Đổi thú cưng** cho phép đặt tên riêng, chọn loài và mũ theo mùa. Lưu trong prefs đã mã hóa trên máy chạy web; không đổi tên phiên tmux.
- **Cài đặt → Tiếng meo** mặc định tắt. Bật rồi tương tác với trang để trình duyệt cho phép âm thanh; phát khi phiên chuyển sang chờ, không phát hàng loạt lúc mở trang.
- **Crew của phiên này** dựa trên chuỗi PID cha từ dispatcher tới pane tmux (bao gồm các pane không được chọn). Không suy đoán từ thư mục. Dispatcher đã tách khỏi cây tiến trình trước lần quan sát đầu có thể hiện **Chưa rõ phiên**. Worker kết thúc được giữ một giờ trong bộ nhớ, kèm kết quả/log cuối; khởi động lại web xóa bộ nhớ này.
- Bảng xếp hạng cộng thời gian chạy/chờ **đã quan sát** trong ngày địa phương của máy chạy web, lưu trong vault. Khoảng trống hơn 75 giây không được cộng. Đổi ngày xóa chi tiết ngày trước, giữ bảng tổng kết gần nhất. Số lỗi chỉ từ pane chết với exit status khác 0, mỗi sự kiện một lần.
- Shell trở về prompt không cung cấp exit status đáng tin cậy. Cúp/khói chỉ dùng `pane_dead_status` khi `pane_dead=1`; không suy đoán từ chữ “PASS/FAIL” trong terminal. Phiên tự biến mất mà không có status không được báo thắng/thua.

Pet mang câu hỏi thật tới thẻ chờ; bấm giấy để vào ô trả lời nhanh. Thông báo trình duyệt nhắc sau hai phút chờ, với icon pet tạo tại máy. Phải bật công tắc, cấp quyền và giữ trình duyệt chạy; không có push tới điện thoại khi trình duyệt đóng. Nhật ký trong chi tiết phiên lưu tối đa 40 sự kiện quan sát/phiên (500 phiên gần nhất) trong vault: lần đầu quan sát, chờ/hết chờ, gửi trả lời thành công từ web và kết quả có exit status rõ ràng. Không backfill sự kiện đã xảy ra trước khi quan sát.
