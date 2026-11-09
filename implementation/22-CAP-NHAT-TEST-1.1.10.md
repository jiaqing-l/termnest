# Cập nhật để test (chuẩn bị cho 1.1.10)

File cập nhật: `implementation/termnest-update-test.tar.gz` (lib + public + server.js).
Cài: giải nén vào `/Applications/Termnest.app/Contents/Resources/app`, thoát hẳn TERMNEST rồi mở lại.
Nhánh: `fix/page-width-and-language` (gồm các nhánh trước). Chưa merge, chưa phát hành. Test: 417/417 đạt.

## 1. Bố cục bị dư bên phải (Token AI, Ghi chú)
- Nguyên nhân: `.token-page` và `.feature-page` có `max-width:1120px`, nội dung lệch trái.
- Đã sửa: bỏ giới hạn, các trang dùng hết bề rộng cửa sổ.

## 2. Chữ tiếng Việt lọt vào giao diện tiếng Anh
- Trang Token AI: "Chưa có phiên", "Chưa có dữ liệu tuần", "Chưa có dữ liệu", "Chưa có bản ghi usage" (server gửi tiếng Việt) được dịch ở trang theo ngôn ngữ đã chọn; nhãn "Theo model" dùng khóa ngôn ngữ.
- Đơn vị số ("Tr" = triệu) và định dạng ngày giờ dùng khóa `lang.locale` (vi-VN / en-US) thay cho vi-VN cố định.
- Tên thú cưng trong bảng chọn (Mèo, Cáo, Cú…) lấy từ khóa `pet.name_*`.
- "Ghi chú mới" trong ảnh là dữ liệu bạn tạo lúc dùng tiếng Việt, không phải lỗi.

## 3. Máy Ubuntu chưa có Node.js (ảnh dev-ubuntu-03)
- Server: lỗi từ máy chủ có mã (`no-node`) và hệ điều hành của máy (từ snapshot `sys.os`); mọi thông báo đọc tệp được dịch theo ngôn ngữ giao diện.
- Trang: hộp hướng dẫn "Máy này cần cài Node.js": nhận diện hệ điều hành, đưa lệnh cài đúng loại, nút Sao chép và nút "Gõ vào terminal" (gõ sẵn lệnh vào terminal của phiên, người dùng nhấn Enter, sudo hỏi mật khẩu). Có mục "Hệ điều hành khác": Fedora/RHEL, Alpine, Arch, openSUSE, macOS. Nút "Đã cài xong, thử lại".
- Lệnh Ubuntu/Debian dùng NodeSource LTS (`apt` mặc định của Ubuntu 22.04 chỉ có Node 12, quá cũ cho bộ đọc tệp).
- Không tự chạy lệnh cài vì cần sudo.

## 4. Full screen trên Windows bị đơ chuột
- Triệu chứng (đổi cửa sổ thì hết) khớp lỗi WebView2 mất nhận chuột sau full screen của hệ điều hành.
- Đã sửa: trên app desktop Windows, nút ⛶ / F11 chỉ ở chế độ trang (ẩn thanh, terminal chiếm hết cửa sổ), không gọi full screen của hệ điều hành; sự kiện `tw-fullscreen` bị bỏ qua ở chế độ này.
- Chưa thử trên Windows thật. Phần này nằm trong mã trang (view-controls) nhưng cần bản cài mới cho vỏ ứng dụng.

## Cùng nhánh, đã làm trước đó
- Gửi file/ảnh bằng kéo thả và nút 📎 chưa từng chạy (đọc sai `current()` nên gửi `server=undefined`): đã sửa và thử đầu-cuối.
- Thư mục bắt đầu bằng dấu chấm (`.mobile`…) hiện trong trình duyệt file.
- Tìm tệp theo tên có chỉ mục (một lần quét mỗi thư mục phiên, giữ 45 giây).
- Kéo tên file từ panel xem vào terminal/ô tab "Tất cả" để chèn đường dẫn (cùng máy); dùng `window.__twDrag` vì WebKit ẩn kiểu tùy chỉnh khi dragover.
- Tạo thư mục/tệp mới trong trình duyệt file (không ghi đè, chỉ trong thư mục phiên).
- Đổi tên; chuyển vào thùng rác (thư mục ẩn `.termnest-trash` trong thư mục phiên, git bỏ qua) kèm Hoàn tác và Khôi phục; không xóa vĩnh viễn.
- Token AI: nút "Tài khoản" mở đúng hộp thoại thêm (trước đây truyền sự kiện chuột nên luôn thành đổi tên).
- Vỏ ứng dụng Windows: tắt trình xử lý kéo thả riêng của Tauri để trang nhận kéo thả HTML5 (đã `cargo check`, chưa chạy trên Windows).

## Cần bạn thử
1. Mở Token AI và Ghi chú ở tiếng Anh: không còn khoảng trống bên phải, không còn chữ Việt.
2. Mở file trên máy Ubuntu chưa có Node.js: thấy hộp hướng dẫn, bấm "Gõ vào terminal".
3. Gửi ảnh bằng 📎 hoặc kéo thả; kéo tên file từ panel xem vào terminal.
4. Đổi tên, xóa vào thùng rác, khôi phục trên một phiên Ubuntu server.

## Việc chưa làm / cần quyết định
- Phát hành 1.1.10 (gộp mọi nhánh): chờ lệnh "merge và phát hành 1.1.10"; ghi chú release cần có phần đính chính lỗi gửi file và lỗi Token AI.
- Unikey tự tắt trên Windows: chưa tìm ra nguyên nhân (nghi thông báo Windows); cần thêm thông tin khi nào xảy ra.
- Tìm theo nội dung file, sửa nội dung file, xóa vĩnh viễn trong thùng rác: chưa làm.

## Gửi file (mục mới)
- Nút "Send picture" đổi thành **Gửi file**; gửi được mọi loại file (html, docx, xlsx, pptx, zip, md, json…), tối đa 25 MB. Chỉ từ chối chương trình (exe, dll, msi, bat, cmd…).
- Ảnh/PDF/Office vẫn được kiểm tra đúng loại; file text không được chứa dữ liệu nhị phân; loại lạ cho qua. Nhánh `feat/send-any-file`.

## Hướng dẫn cài Node.js: thêm Windows
- Máy Windows (SSH) chưa có Node.js: hiện lệnh `winget install OpenJS.NodeJS.LTS`, nhận diện lỗi "node is not recognized". Windows cũng nằm trong mục "Hệ điều hành khác". Nhánh `fix/node-help-windows`.

## Chèn đường dẫn bằng cú bấm (thay cho kéo thả)
- Nút ↳ trên mỗi tệp trong danh sách, trong kết quả tìm, và nút "Chèn đường dẫn vào chat" ở đầu panel xem tệp: gõ đường dẫn vào phiên đang mở (cùng máy), nhấn Enter để gửi. Nhánh `feat/insert-path-button`.

## Gửi file từ máy chủ khác (mới)
- Dưới terminal có nút **📂 Từ máy chủ khác…** cạnh **Gửi file**. Chọn máy nguồn (máy đang kết nối, khác máy của phiên đang mở) và một phiên trên máy đó, bấm **Chọn tệp…**: trình duyệt file mở trên máy nguồn (có tìm theo tên), bấm một tệp là xong.
- Tệp được đọc từ máy nguồn, kiểm tra như Gửi file (không chương trình, tối đa 20 MB), lưu vào thư mục tạm riêng của máy có phiên đang mở và đường dẫn được gõ vào chat. Hai máy không cần thấy nhau, dữ liệu đi qua TERMNEST.
- An toàn: chỉ lấy tệp nằm trong thư mục của phiên trên máy nguồn (realpath, không theo liên kết ra ngoài), chỉ tệp thường. Máy nguồn cần có Node.js (nếu thiếu sẽ hiện hướng dẫn cài). Máy đích không được là phiên PowerShell thuần.
- Đã test: đọc tệp có giới hạn và chặn thoát thư mục, route chuyển bằng hai máy giả, và giao diện (chọn máy, chọn phiên, chọn tệp, đúng yêu cầu gửi lên). **Chưa thử với hai máy SSH thật** (máy này không có SSH tới máy khác).
- Nhánh `feat/send-from-other-server`.

## Gọn lại giao diện xem file và gửi file (theo phản hồi UI/UX)
- Đầu panel xem file: chỉ còn Danh sách (←), Chèn đường dẫn vào chat (khi đang xem một tệp), Đóng và nút ⋯ (Sao chép đường dẫn, Tải xuống, Tải lại).
- Trình duyệt file: ô tìm, một hàng 3 nút gọn (Thư mục / Tệp / Thùng rác), mỗi dòng chỉ còn một nút ⋯ mở menu nhỏ (Chèn đường dẫn, Đổi tên, Chuyển vào thùng rác). Trên điện thoại menu hiện dạng bảng chọn dưới màn hình, nút to hơn.
- **Gửi file** là một nút: có máy chủ khác đang kết nối thì hiện menu "Từ máy này" / "Từ máy chủ khác"; không có thì mở hộp chọn file luôn. Bỏ nút riêng và hộp "chọn phiên": chọn máy (bỏ qua bước này nếu chỉ có một máy khác) rồi duyệt thư mục của phiên gần nhất trên máy đó.
- Nhánh `fix/viewer-ux-compact`.

## Giao diện chọn trong Cài đặt (mới)
- Cài đặt → Giao diện: 5 kiểu (Vui tươi, Tối giản, Terminal cổ điển, Biển xanh, Tương phản cao) + tùy chọn Gọn. Bấm là đổi ngay, nhớ trên thiết bị. Kiểu không thú cưng tự tắt thú.
- Trang Ghi chú dùng hết bề rộng và chiều cao (bỏ giới hạn 1180px). Ảnh các kiểu: `implementation/23-MOCKUP-GIAO-DIEN-LUA-CHON.html`. Nhánh `fix/notes-fill`.

## Hiệu ứng trên giao diện quen thuộc (thay cho bản chủ đề)
- Giao diện giữ nguyên. Cài đặt → Hiệu ứng: Không / Hoa anh đào / Hoa mai (Tết) / Lá thu / Tuyết / Bong bóng / Sao, và Lượng hiệu ứng (Ít, Vừa, Nhiều). Hạt rơi nhẹ, không chặn thao tác, tự ẩn ở màn Terminal, khi tab bị ẩn và khi hệ thống yêu cầu giảm chuyển động; trên điện thoại giảm một nửa số hạt. Tùy chọn "Gọn" vẫn còn.
- Ảnh chụp từ app thật: `implementation/23-MOCKUP-GIAO-DIEN-LUA-CHON.html`. Nhánh `feat/effects-only`.

## Thêm 6 hiệu ứng
- Mưa, Giáng sinh (tuyết + quả châu + hộp quà), Lồng đèn Trung thu (bay lên), Halloween (bí ngô + dơi), Bướm (bay lượn vỗ cánh), Pháo hoa (nở nhiều màu). Tổng 12 hiệu ứng + Không. Mã hiệu ứng nằm trong `public/fx.js`.
- Xem thử sống không cần cài: `implementation/24-XEM-THU-HIEU-UNG-DONG.html` (mở bằng trình duyệt, bấm từng hiệu ứng). Nhánh `feat/more-effects`.

## Sau 1.1.10: khôi phục cả hội thoại Claude/Codex sau khi máy khởi động lại
- Trước đây TERMNEST chỉ nhớ "phiên chạy gì" lúc thấy phiên lần đầu; phiên mở shell rồi gõ `claude` bị nhớ là shell, nên khôi phục chỉ mở lại shell.
- Giờ mỗi lần quét: đọc `~/.claude/sessions/<pid>.json` (sessionId + cwd) của Claude đang chạy trong phiên; Codex đọc tệp rollout đang mở (`/proc`, chỉ Linux). Ghi vào bản nhớ phiên: `{dir, run, resume}`.
- Khôi phục: Claude chạy `claude --resume <id>` trong đúng thư mục (nếu còn transcript), Codex chạy `codex resume <id>`.
- Thoát agent về shell quá 2 phút thì phiên được nhớ là shell; ngay sau khởi động (shell hiện trước agent) không làm mất mã.
- Chống pid cũ trùng sau reboot: chỉ nhận khi tiến trình đó đúng là claude/codex.
- Nhánh `feat/resume-agents-after-reboot` (b6c0614), test 421/421. Chưa thử trên Ubuntu thật. Mac: Codex không đọc được mã (không có /proc) → vẫn dùng bảng chọn `codex resume`.

## Sau 1.1.10: thùng rác, file tạm, sao lưu, an toàn (nhánh `feat/trash-and-temp-cleanup`, nối sau `feat/resume-agents-after-reboot`)
- Thùng rác (📂 → Thùng rác): mỗi mục có dung lượng, nút Khôi phục và **Xóa vĩnh viễn** (hỏi lại); nút **Dọn thùng rác**. Chỉ xóa thư mục do TERMNEST tạo.
- **File tạm** (📂 → File tạm): danh sách file nhận qua Gửi file trên máy đó (tên, cỡ, ngày), chọn để xóa hoặc Xóa tất cả.
- Cài đặt → **Sao lưu và dọn dẹp**: sao lưu dữ liệu TERMNEST mỗi 15 phút / 1 / 6 / 24 giờ; xóa file tạm sau 1/3/7/30 ngày hoặc không tự xóa; tự dọn thùng rác sau 7/14/30/90 ngày hoặc không. Kiểm tra mỗi giờ trên mọi máy đang kết nối (cần Node.js trên máy đó).
- Kho dữ liệu: ghi xuống đĩa chắc chắn (fsync); bản sao mã hóa mỗi lần mở TERMNEST và theo chu kỳ, giữ 10 bản; tệp hỏng thì tự mở bản sao mới nhất, giữ lại tệp hỏng, báo cho người dùng.
- Tự khôi phục phiên trên **server khác** sau reboot (Cài đặt, mặc định tắt).
- Hộp **khởi động lại server**: liệt kê phiên đang chạy Claude/Codex và thư mục có tệp chưa commit / commit chưa push.
- Test 430/430. Chạy thật trên Mac: API dọn dẹp, cài đặt, sao lưu, danh sách file tạm. **Chưa chụp giao diện**, chưa thử trên Ubuntu.
