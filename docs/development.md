# Phát triển và kiểm thử

Cài phụ thuộc bằng `npm ci`, theo phong cách mã hiện có và chạy `npm test` trước khi gửi PR. Test tự động dùng dữ liệu giả; không gọi nhà cung cấp AI. Kiểm thử HTTP, WebSocket, single-instance và tmux cần môi trường cho phép socket. Kiểm thử Chrome cần trình duyệt và quyền mở tiến trình.

## Kiểm thử tùy chọn

- `TW_REAL_BROWSER_TEST=1 npm test`: smoke tạo mật khẩu qua Chrome, token khởi động, đăng nhập.
- `TW_CHROME_ARTIFACTS=<thư-mục> node test/browser-check.cjs`: HTTP/SSH/WebSocket thật với SSH fixture, lưu ảnh và kết quả rồi dọn profile/tiến trình; không chứng minh tmux Linux thật.
- `TW_CHROME_ARTIFACTS=<thư-mục> node test/local-browser-check.cjs`: tmux thật trên Mac với socket `tmux -L` riêng, IME, attach, tạo/khôi phục và giữ phiên qua restart. `TW_TMUX_SOCKET` chọn socket local riêng.
- `TW_CHROME_ARTIFACTS=<thư-mục> node test/token-browser-check.cjs`: tài khoản giả cô lập, lọc/biểu đồ, đổi tên, che credential, bố cục 1280/1440. `TW_TOKEN_MOCKUP` có thể trỏ tới HTML tham chiếu của bạn.
- `node test/token-merge-browser.cjs`, `node test/viewer-browser-check.cjs`: kiểm tra tương tác Token AI và trình xem tệp.
- `node test/capture-readme.cjs`: chụp lại `docs/images/` bằng dữ liệu demo, HOME tạm, không chạy lệnh thật trên máy chủ và chặn tài nguyên mạng ngoài. Giữ kiểm tra không lọt thông tin riêng. `CHROME` chọn executable.

## Desktop và bản phát hành

Pin Node 22.14.0, Rust 1.98.0, Tauri CLI 2.12.4; giữ cả npm/Cargo lockfiles. macOS: `bash packaging/mac/build-app.sh`. Windows (Developer PowerShell có Rust/MSVC):

```sh
npm ci --no-audit --no-fund
npm run prepare:desktop
npm ci --prefix desktop --no-audit --no-fund
cd desktop
npm run build -- --bundles nsis --ci -- --locked
```

`.github/workflows/release.yml` tạo `Termnest-Setup.exe`, `Termnest-arm64.dmg`, `Termnest-x64.dmg`, kiểm tra giới hạn payload, cài bundle rồi kiểm tra WebView/IPC, setup/login/native PTY/quit bằng Node đã đóng gói. Branch/manual chỉ tải artifact; chỉ push tag `v*` mới tạo GitHub Release. Bản hiện tại chưa ký chứng chỉ thương mại (macOS ký ad-hoc). Native binary là `Termnest`, macOS bundle `Termnest.app`.

Bridge native dùng hộp lưu file của OS, mở liên kết HTTP(S) ngoài bằng trình duyệt mặc định, clipboard/thông báo native; giữ cô lập Markdown/HTML. Ctrl+C ngắt terminal; Cmd+C/Ctrl+Shift+C sao chép, Cmd+V/Ctrl+Shift+V dán. Cần kiểm tra thủ công IME, chọn chữ bằng modifier, thông báo, lưu file và reconnect trên macOS/Windows. Click thông báo native hiện chưa chọn phiên.

Smoke từ bản đã cài: `TW_DESKTOP_SMOKE_ISOLATED=1 node packaging/desktop-smoke.js <executable> <resources> <node>`. Cổng tạm chỉ được shell chấp nhận khi có marker smoke riêng; chế độ thường dùng 7681. Smoke không thay thế kiểm thử tương tác thật.

## Nhận diện và giấy phép phụ thuộc

Tài sản gốc nằm ở `docs/brand/`, không vẽ lại. Tạo desktop icons bằng đúng CLI đã pin:

```sh
desktop/node_modules/.bin/tauri icon docs/brand/termnest-icon-1024.png --output desktop/icons
```

PWA dùng cùng master với các kích thước 180, 192, 512. Không đổi hình thú cưng khi đổi logo. Xem [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md); bản cài giữ nguyên LICENSE của các gói và bổ sung thư mục `licenses/` chứa bản sao thông báo. Khi nâng dependency, đối chiếu LICENSE thực tế, cập nhật tên/phiên bản/bản quyền và bản sao trong `docs/licenses/`. Node runtime đi kèm có giấy phép đầy đủ gồm thành phần nhúng; giữ đồng bộ với pin runtime.
