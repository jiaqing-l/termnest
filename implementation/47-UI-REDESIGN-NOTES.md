# TERMNEST giao diện mới — ghi chú mockup (13/11/2026)

Mockup bấm được: `45-UI-REDESIGN-MOCKUP.html`. Màu: #20285a (chủ đạo), #d32027 (nhấn nhỏ), terminal xám đen.

## Token AI (theo màn thật)
- Thẻ Tài khoản AI: Đổi tên, gói/email/máy, Phiên 5 giờ, Tuần này (Đặt lại), Hôm nay + ngưỡng, cảnh báo vượt ngưỡng, ghi chú Codex.
- Điều khiển: Theo ngày/Theo tuần, Lọc AI, Tài khoản (thêm), Làm mới.
- Báo cáo dùng: Máy, Hôm nay/7 ngày/Tháng này, Từ–Đến; 4 ô (Tổng token, Chi phí ước tính, Đọc từ cache, Output); 3 tab Theo ngày/Theo phiên/Chi phí; biểu đồ thang căn bậc hai; bảng có Tổng cộng; Token theo thời gian; Theo model.

## Vận hành = Trạm Ops
- Đầu trang: Trạm Ops · 3/4 máy, "N team đang chạy · M việc cần anh", chip, trạng thái phiên Ops + nút (Báo cáo ngay, Đổi tài khoản, Mở phiên Ops, Khởi động lại).
- Tìm phiên/task/track, ✨ Hỏi sâu, Hỏi nhanh, Tự làm mới.
- Tab: Tiến độ (team crew + track, Phiên AI khác, Đang chờ anh, Quota AI), Báo cáo Ops, Hỏi sâu, Cài đặt (phiên Ops, tài khoản, model, quyền, chu kỳ, Telegram/Webhook).

## Đề xuất nhóm phiên ở sidebar
Mặc định "Ưu tiên": ★ Ghim → Cần bạn trả lời → Crew đang chạy → Phiên đang chạy → Nghỉ.
Các kiểu khác (chọn ở ô "Nhóm phiên"): Theo dự án, Theo máy chủ, Crew/phiên đơn, Theo công cụ AI, Theo trạng thái.
Lý do: nhóm theo trạng thái làm phiên nhảy chỗ liên tục; ghim + "cần bạn" luôn ở trên giúp tìm nhanh.
Bản thật cần thêm thuộc tính "dự án" (từ thư mục/repo) để nhóm theo dự án.

## Chưa làm / còn mở
Dữ liệu mockup là mẫu. Chưa đưa vào app thật (chờ DEV duyệt). Commit chưa đẩy lên GitHub; tag v1.1.18 vẫn trỏ nhầm.

## Sân chơi thú cưng
Thực tế (public/pet-yard.js): một khu sân theo ngày/đêm, mỗi phiên một thú đi lại, bấm thú ra bong bóng trạng thái (Mở phiên, 🍖 Cho ăn), có ⚽ Đá bóng (2 đội, tỉ số), 🔨 Búa, đuổi bắt, nhảy, câu cá, chia thức ăn; tối thì thú rảnh ngủ, thú đang làm vẫn thức; tối đa 14 thú ("Còn N phiên nữa"); thời tiết ở banner (☀️/🌧️/⛈️ theo tải).
Mockup bản cũ chỉ là hàng emoji tĩnh nên "kỳ"; bản mới vẽ lại sân có trời/cỏ/mây, thú đi lại, bong bóng, đá bóng, búa, ngày/đêm.

Đề xuất:
1. Có nút Thu gọn: thành một hàng thú nhỏ có chấm trạng thái (không chiếm 200px chiều cao, thấy nhiều phiên hơn).
2. Thú phải mang thông tin: ❗ chờ bạn, 💢 lỗi, 💤 nghỉ; bấm là mở phiên.
3. Mặc định thu gọn trên màn nhỏ/điện thoại; tắt hẳn (đã mặc định tắt cho người cài mới).
4. Hiệu năng: chỉ chuyển động khi tab hiện và đang ở Tổng quan, tôn trọng prefers-reduced-motion, giới hạn 14 thú.
5. Đá bóng/búa/câu cá giữ làm trứng phục sinh, không là tính năng chính.

## Màn Ghi chú (cập nhật 13/11)
Giữ bố cục danh sách | soạn thảo, bổ sung đúng các tính năng thật (public/features/notes.js) và phần mới:
- 3 tab: 📝 Ghi chú, ⏰ Nhắc việc (tất cả nhắc, nhắc bị lỡ khi app tắt, hoãn nhanh), ⚙ Cài đặt thông báo.
- Soạn thảo: tiêu đề, phiên liên quan, thú cưng, Xóa (xác nhận "Xóa thật?"), + Việc hôm nay / Quyết định / Việc kế tiếp, ⏱ Chèn giờ, Xuất .md/.txt, Nối vào file…, đếm "việc chưa xong" theo mục "- [ ]".
- Panel "Nhắc của ghi chú này": giờ, +10/+30/+1 giờ, lặp mỗi ngày, khi nhắc thì (chỉ thông báo / mở ghi chú / mở phiên liên quan), bật/tắt, xóa.
- MỚI: "Lịch nhắc kiểm tra ghi chú": nhiều khung giờ chung (vd 09:00, 13:30, 17:30), mỗi khung có nội dung thông báo, ngày trong tuần (T2–CN, Ngày làm việc, Mỗi ngày), bật/tắt, xóa; "Chỉ nhắc khi còn việc chưa xong".
- Cách báo: chuông trong TERMNEST, thông báo hệ điều hành, âm thanh, giờ yên lặng; gom nhắc bị lỡ khi mở lại app. Nút "Xem thử thông báo" hiện thẻ thông báo mẫu có Mở ghi chú / Hoãn 1 giờ.
Bản thật cần thêm lưu cấu hình lịch nhắc chung (server hoặc localStorage) và bộ hẹn giờ chạy theo khung.
