# Tối ưu trải nghiệm TERMNEST — cách các công ty lớn làm và áp dụng cho TERMNEST

Ghi ngày 14/11/2026. Phần "cách các công ty làm" là kiến thức chung về ngành (Google, Apple, Linear, Figma, Vercel, Slack…), không phải đo đạc của TERMNEST.

## 1. Nguyên tắc cốt lõi họ dùng

1. **Cảm giác nhanh quan trọng hơn nhanh thật.** Ngưỡng tâm lý: dưới 100 ms là "tức thì", 100–300 ms vẫn mượt, trên 1 s người dùng mất mạch, trên 10 s bỏ đi. Vì vậy họ đo *thời gian tới lúc dùng được* chứ không đo thời gian tải xong.
2. **Optimistic UI.** Bấm là giao diện đổi ngay, gửi lên máy chủ phía sau, lỗi thì hoàn tác. Linear, Figma, Slack đều làm vậy.
3. **Skeleton / nội dung cũ thay vì màn trống hoặc vòng xoay.** Hiện hình dạng nội dung (hoặc dữ liệu lần trước) ngay, thay bằng dữ liệu mới khi tới (stale-while-revalidate).
4. **Không bao giờ chặn người dùng.** Việc nặng chạy nền; giao diện luôn bấm được (60 fps, tác vụ chính luồng < 50 ms).
5. **Ngân sách hiệu năng (performance budget)** như một test: đo mỗi lần phát hành, vượt ngưỡng thì build đỏ (Google Core Web Vitals: LCP < 2,5 s, INP < 200 ms, CLS < 0,1).
6. **Mật độ thông tin có chủ đích.** Công cụ chuyên nghiệp (Linear, Raycast, VS Code) ưu tiên *ít nút, nhiều phím tắt, một bảng lệnh*.
7. **Nhất quán qua hệ thống thiết kế**: khoảng cách 4/8 px, vài cỡ chữ, vài màu có nghĩa; cùng một khuôn cho mọi hộp thoại.
8. **Tiết lộ dần (progressive disclosure):** việc hay dùng ở ngoài, việc hiếm trong menu "⋯".
9. **Phản hồi trạng thái rõ ràng:** đang nối, đã nối, mất kết nối, tự thử lại; không để người dùng đoán.
10. **Đo người dùng thật (RUM) và thử nghiệm A/B** thay cho cảm tính.

## 2. Việc đã làm ở TERMNEST (khớp các nguyên tắc trên)
- Nạp tính năng song song, cache bất biến, nén gzip, `/api/tokens` gọn → tải lại 358 ms (trước 1.460 ms).
- Hiện ngay vài dòng cuối của phiên thay vì màn đen khi mở terminal; nối lại nhanh.
- Giảm trang trí gây rối (nút, chip lặp), gom nút vào menu, tooltip khi rê chuột.
- Quét tmux và log thợ crew gộp một lần thay vì nhiều lần.

## 3. Đề xuất tiếp theo, xếp theo (tác động / công sức)

### A. Tức thì (vài ngày, rủi ro thấp)
1. **Thanh trạng thái kết nối** ở đầu màn: "Đang nối dev-ubuntu-02… / Đã nối 180 ms / Mất kết nối, thử lại sau 3 s". Người dùng không còn thấy "đen không biết vì sao".
2. **Skeleton cho thẻ phiên, panel chi tiết, Token, Vận hành** và *giữ dữ liệu lần trước khi mở lại màn* (lưu bản chụp cuối trong bộ nhớ và localStorage; nền làm mới).
3. **Mở terminal "lạc quan":** hiện dòng cuối + con trỏ ngay, gõ phím được xếp hàng trong lúc đang nối (đã có phần xếp hàng gõ phím).
4. **Làm nóng trước (prefetch):** rê chuột lên phiên ≥ 150 ms thì mở sẵn kết nối terminal; bấm vào là có hình ngay.
5. **Số đo tới lúc dùng được** ghi vào `crash.log`/bảng chẩn đoán: thời gian nối SSH, mở kênh, chữ đầu tiên. Cơ sở để chỉnh tiếp bằng số thật thay vì đoán.
6. **Phím tắt + bảng lệnh (Cmd/Ctrl-K):** nhảy tới phiên theo tên, mở Cài đặt, chuyển màn, "gửi file", "chọn máy chủ". Một ô tìm kiếm thay cho nhiều nút.

### B. Trung hạn (1–3 tuần)
1. **Ảo hóa danh sách (virtualization):** thanh bên và lưới phiên chỉ dựng phần đang nhìn thấy; chịu được hàng trăm phiên mà vẫn 60 fps.
2. **Tách `app.js`/`app.css` (hiện 154 KB và 182 KB) theo màn:** chỉ nạp Token/Vận hành/Ghi chú khi mở lần đầu. Xterm chỉ nạp khi vào màn Terminal (cần sửa các chỗ đồng bộ trong `app.js`).
3. **Một kênh cập nhật đẩy (SSE/WebSocket) thay cho nhiều vòng hỏi 2,5 s/3 s/10 s/30 s:** máy chủ chỉ gửi *thay đổi* (delta). Giảm yêu cầu mạng từ ~100/phút xuống gần 0 khi không có gì đổi và cập nhật tức thì khi có đổi.
3b. **Ghép kênh SSH ở phía máy chủ**: thay vì mỗi tab một kênh trên cùng kết nối, dùng ControlMaster hoặc tmux control mode (`tmux -CC`) để một kênh phục vụ nhiều phiên; hết cảnh "hết 10 kênh".
4. **Mất kết nối êm:** giữ nguyên màn hình cuối, đánh mờ và hiện nhãn "mất kết nối", tự nối lại có backoff, không xoá nội dung.
5. **Hệ thống thiết kế chính thức:** một tệp token (màu, cỡ chữ, bán kính, bóng), một bộ component (nút, ô nhập, hộp thoại, tab, menu) dùng chung; thay thế các lớp CSS chồng lên nhau (`app.css` hiện có nhiều khối ghi đè nối đuôi).
6. **Lưu trạng thái giao diện:** nhớ tab đang mở, chia màn, cuộn, bộ lọc, nhóm phiên giữa các lần mở app.

### C. Dài hạn
1. **Đo người dùng thật (RUM, riêng tư, tắt được):** thời gian mở màn, tỉ lệ lỗi nối, thao tác thừa; xem bằng số.
2. **Kiểm thử hiệu năng tự động** trong CI (Chrome không giao diện + mạng giả lập chậm) với ngân sách: tải lại < 500 ms ở 60 ms RTT, tương tác < 100 ms, không có tác vụ treo > 50 ms.
3. **Truy cập (accessibility):** thứ tự phím Tab, nhãn ARIA, độ tương phản AA, hỗ trợ giảm chuyển động (một phần đã có).
4. **Thử nghiệm có kiểm soát (A/B hoặc cờ tính năng)** cho thay đổi lớn (nhóm phiên, layout Crew).

## 4. Thứ tự gợi ý
1. Thanh trạng thái kết nối + số đo thời gian từng bước (A1, A5): vài giờ, giúp biết chính xác chậm ở đâu.
2. Skeleton + giữ dữ liệu cũ + prefetch khi rê chuột (A2, A4): cảm giác nhanh rõ nhất.
3. Bảng lệnh Cmd-K (A6): bớt nút bấm, đúng hướng "ít nút" bạn đã yêu cầu.
4. Kênh cập nhật đẩy + ghép kênh SSH (B3, B3b): giải quyết tận gốc việc phải hỏi liên tục và hết kênh.

## 5. Ràng buộc giữ nguyên khi làm
Không bỏ tính năng đang dùng; mọi thay đổi phải tương thích vault/sao lưu hiện có; đo trước/sau; mỗi thay đổi có test và có thể tắt bằng một công tắc.

## 6. Kết quả (14/11/2026, đợt 3A đầu tiên)
Làm trong `public/features/ux3.js` + `ux3.css` (nạp trước `app.js` như ux2; host tính năng cũng nạp lại nên có chốt chống chạy hai lần). Công tắc tắt: Cài đặt → Khác → "Bật tối ưu trải nghiệm" (`localStorage tw-ux3=off`, tải lại trang) — tắt thì mọi hook thành no-op.
- **Chip kết nối** cạnh nhóm Tổng quan/Terminal: "Đang nối…" / "Đã nối · N ms" (tới byte đầu) / "Mất kết nối · thử lại sau Ns" (dùng đúng backoff `retry` của `connectPane`). **Chẩn đoán tốc độ** (Cài đặt → Khác): 20 lần mở gần nhất, mở kênh, byte đầu, thời gian máy chủ. Máy chủ chỉ gửi khung văn bản `{t:'timing',open}` khi URL có `?timing=1`; trình duyệt nuốt khung này, không ghi vào terminal.
- **Giữ dữ liệu cũ**: bọc GET của `/api/tokens` và `/api/features/opshub/state` (bộ nhớ + localStorage `tw-ux3c1:*`, ≤200 KB, bỏ khóa nhạy cảm, tối đa 7 ngày). Lần gọi đầu mỗi lần tải trang có cache thì trả bản cũ ngay (nhãn "dữ liệu lúc HH:MM"), chạy yêu cầu thật nền rồi gọi chủ sở hữu vẽ lại nếu khác; chưa có cache thì hiện skeleton (tắt animation khi reduced-motion / pets-off). **Bỏ qua có chủ đích**: Ghi chú (sửa được, trả bản cũ có thể ghi đè dữ liệu), `/api/state` (điều khiển cảnh báo/phát hiện mất phiên), thẻ fleet Tổng quan (dựng từ `/api/state`).
- **Làm nóng**: rê ≥200 ms lên hàng/thẻ phiên (`data-k`) → một `POST /api/servers/<id>/screens` cho đúng phiên đó (route `/screens` chỉ có POST, không có GET; là lệnh đọc 1 lần, cùng đường như tường "Tất cả") điền `screens[key]`; bỏ qua khi trang ẩn, máy chủ offline/powershell, đã có, hoặc đang có yêu cầu làm nóng khác; không quá 1 lần/60 s/phiên.
- **Bảng lệnh Ctrl/⌘ K** (`<dialog role=dialog>`, combobox/listbox, mũi tên + Enter + Esc, khớp mờ không dấu): phiên, máy chủ, màn hình, lệnh (Phiên mới, Cài đặt, Đổi giao diện, Mở file, Gửi file). Bắt ở pha capture nên `^K` không tới phiên; thêm dòng cho `attachCustomKeyEventHandler`. Khi màn Vận hành đang hiện, Ctrl/⌘ K vẫn do ô tìm của Vận hành xử lý như cũ (bảng lệnh vẫn mở bằng chip "⌘ K" ở đầu trang). Chuỗi vi/en trong khóa `ux3.*`.
- Hook trong `app.js`: `api` → `apiRaw` (qua `TWUX3.wrapGet`), sự kiện `connectPane`, `data-k` trên hàng/thẻ, 3 hàm trong `TW.attach`, khung văn bản trong `onmessage`. `server.js`: một dòng gửi timing.
- Kiểm: `test/ux3.test.js` (10 test: fuzzy, rank, cache, SWR, timing, phím); i18n/http-assets/features-host/ux2/fleet-ui vẫn xanh. Chrome headless trên máy chủ tạm (`TW_DATA` tạm, tmux `-L twqa`): trang tải không lỗi console, Cmd-K mở bảng lệnh (cả khi đang ở terminal), Enter mở phiên, chip "Đã nối · 37 ms", chẩn đoán có dòng đo, tải lại thấy "dữ liệu lúc …".
