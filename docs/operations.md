# Cài đặt và vận hành

Bản cài macOS: mở `Termnest-arm64.dmg` hoặc `Termnest-x64.dmg`, kéo `Termnest.app` vào Applications. Windows: chạy `Termnest-Setup.exe`, mở Termnest từ Start menu. Bản cài dùng Tauri, không cần Chrome/Edge; phông, xterm và Markdown chạy tại máy. Windows cần WebView2 (bộ cài có bootstrapper). Để giữ phiên sau khi dừng ứng dụng, cài tmux trên macOS (`brew install tmux`) hoặc trong WSL (`wsl --install`, rồi `sudo apt install tmux`). Phiên PowerShell không có WSL kết thúc khi server dừng.

Chạy từ source: `npm ci`, `npm run set-password`, `npm start`, mở `http://127.0.0.1:7681`. Windows PowerShell có thể dùng `$env:TW_PORT='7682'; npm start`. Đổi mật khẩu bằng `npm run set-password`; đọc lời nhắc trước khi xác nhận. Xem [bảo mật](../SECURITY.md).

Dữ liệu bản cài nằm tại `%APPDATA%\Termnest` hoặc `~/Library/Application Support/Termnest`, giữ lại khi gỡ cài đặt. Lần đầu nâng cấp, nếu chưa có thư mục mới nhưng có `Tmux Dev`, launcher chuyển toàn bộ thư mục bằng rename; nếu không được thì copy qua thư mục tạm và chỉ công bố khi copy hoàn tất. Copy thành công vẫn giữ bản cũ làm dự phòng. Lỗi sẽ dừng khởi động, giữ dữ liệu cũ và không để lại thư mục mới dở dang. Thư mục Termnest đã có luôn được ưu tiên, không tự trộn hai kho dữ liệu. `TW_DATA` là đường dẫn chỉ định tường minh nên bỏ qua chuyển đổi. Vault giữ nguyên byte, gồm máy chủ, mật khẩu mở khóa, khóa SSH, prefs và lịch sử. Không thể khôi phục mật khẩu vault đã quên.

Tauri sao chép `.window-state.json` từ thư mục cấu hình `com.jiaqing.tmux-dev` sang `com.jiaqing.termnest` nếu chưa có bản mới; giữ nhãn cửa sổ `main` và tên plugin `single-instance`, `window-state`. Khóa single-instance native dùng bundle ID mới; các lần mở Termnest tiếp theo đưa cửa sổ hiện có lên trước. Định danh `/__app` vẫn là `tmux-dev` để nhận ra server phiên bản cũ hoặc chạy từ source. Khi nâng cấp, đóng cửa sổ cũ trước khi mở bản mới.

Source mặc định dùng `data/` trong repo; Linux bản launcher giữ `~/.tmux-web`. Giữ `TW_*`, cổng 7681, tên service `tmux-web`, các tên pipe/cache `tmux-dev-*` và khóa lưu trình duyệt cũ để tương thích. `TW_DEFAULT_DIR` đổi thư mục mặc định của SSH; Máy này dùng home của backend (home Linux trong WSL). Máy chủ web luôn lắng nghe trên `127.0.0.1`, không mở trực tiếp ra mạng.

## Linux và systemd

```bash
sudo apt install tmux
npm ci
npm run set-password
sudo bash scripts/install.sh
systemctl status tmux-web
journalctl -u tmux-web -n 50
sudo systemctl restart tmux-web
```

Cổng khác: `TW_PORT=7682 sudo -E bash scripts/install.sh`. Đóng cửa sổ, dừng web hoặc restart dịch vụ không dừng phiên tmux; tắt máy chạy tmux sẽ dừng phiên. Khôi phục tạo lại phiên/chương trình, không khôi phục tiến trình đang chạy dở. Đóng desktop chờ yêu cầu đang xử lý rồi dừng server do nó tạo; server source đã có sẵn được dùng lại và không bị desktop dừng.

Nếu lỗi `EADDRINUSE`, kiểm tra cổng đang dùng hoặc port forwarding của trình soạn thảo. `127.0.0.1:7681` có thể trỏ tới máy chủ qua tunnel, khi đó phải dùng mật khẩu trên máy chủ. Có thể chọn cổng khác cho source (`TW_PORT=7682 npm start`); desktop native vẫn dùng 7681 trong chế độ thường.

## Điện thoại và truy cập từ xa

Máy từ xa chỉ cần SSH và tmux; thêm máy trong giao diện bằng mật khẩu hoặc khóa. Mật khẩu SSH chỉ giữ trong RAM phiên đăng nhập; khóa riêng lưu mã hóa trong vault. Kiểm tra fingerprint host key trước khi chấp nhận. Không đưa vault hoặc khóa vào Git.

Dùng SSH tunnel để truy cập máy chạy Termnest:

```bash
ssh -L 7681:127.0.0.1:7681 user@your-server
```

Trên điện thoại, tạo Port Forwarding trong Termius: Local `7681` → `127.0.0.1:7681` qua máy chủ, rồi mở địa chỉ local bằng Chrome/Safari. Dùng thanh điều hướng dưới để chuyển Tổng quan/Terminal. Cần kết nối được tới máy SSH; tunnel phải còn hoạt động.

**Cài đặt → Cài lên máy này** cài PWA nếu trình duyệt hỗ trợ; nếu không dùng menu **Thêm vào màn hình chính**. PWA không cache trang/API để dùng ngoại tuyến. Thông báo cần cấp quyền và giữ ứng dụng/trình duyệt chạy; không có push khi đã đóng.
