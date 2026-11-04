<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/termnest-logo-dark.svg">
    <img src="docs/brand/termnest-logo.svg" alt="TERMNEST by JIAQING" width="460">
  </picture>
</h1>

<p align="center">
  <strong>It stays awake for you, so you can sleep soundly.</strong><br>
  Máy thức thay bạn, để bạn yên giấc.<br>
  <sub>Mọi phiên terminal trên mọi máy, gọn trong một cửa sổ.</sub>
</p>

<p align="center">
  <a href="../../releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/jiaqing-l/termnest?color=1f7a4a"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-13294b"></a>
  <img alt="macOS | Windows | Linux" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Ubuntu-e3b341">
  <a href="../../stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/jiaqing-l/termnest?style=social"></a>
</p>

<p align="center">
  <img src="docs/images/overview.png" alt="Màn hình tổng quan của TERMNEST" width="860">
</p>

Bạn chạy Claude Code trên máy chủ, build ở máy khác, rồi gập laptop đi họp. Quay lại là phải mở lại từng cửa sổ SSH và đoán xem phiên nào đang đợi mình.

**TERMNEST** gom hết các phiên tmux đó vào một cửa sổ. Nhìn là biết phiên nào đang chạy, phiên nào cần bạn trả lời. Đóng app hay mất mạng cũng không sao, phiên vẫn chạy tiếp.

## Tính năng

- 🪺 **Không mất phiên** khi đóng app, mất mạng hay đổi máy: phiên nằm trong tmux, TERMNEST chỉ là cửa sổ nhìn vào
- 🖥️ **Một cửa sổ cho nhiều máy**, cả máy bạn lẫn máy chủ SSH
- 🔔 **Chỉ báo khi thật sự cần**: phiên đang hỏi bạn (y/n, mật khẩu, chọn menu) hiện ngay trên thẻ để trả lời; bạn chọn loại cảnh báo nào được báo, nút “Đánh dấu đã đọc tất cả” gọn chuông
- 🤖 **Mở nhanh Claude Code, Codex**, xem token đã dùng, thấy mức đầy của ngữ cảnh và **làm mới hoặc mở phiên mới** (bàn giao) khi phiên sắp đầy
- 🧭 **Trạng thái phiên ổn định**: đang chạy, chờ bạn hay đang nghỉ được suy ra từ chữ thật trên màn hình, đồng hồ hay bộ đếm tự nhảy không làm phiên chớp liên tục
- 📄 **Xem tệp ngay cạnh terminal**: Markdown, HTML (kèm ảnh và CSS cùng thư mục), ảnh; có nút gửi ảnh và mở tệp từ điện thoại
- 🪟 **Chia 1, 2 hoặc 4 ô** terminal, chỉnh cỡ chữ, toàn màn hình, chuột phải trên tab để đóng các tab khác hoặc tất cả
- 📱 **Dùng được trên điện thoại**: vuốt để cuộn, bàn phím chỉ bật khi bạn bấm, bố cục terminal gọn, cài như ứng dụng
- 📊 **Theo dõi CPU, RAM, ổ đĩa** từng máy, thời tiết ở đầu trang đổi từ nắng sang mưa, sấm khi tải cao
- 🐼 **Mỗi phiên một bạn thú cưng** trên sân chơi: cho ăn, trò chuyện, đá bóng hai đội, đuổi bắt, nhảy múa, câu cá. Phiên đang làm việc thì khuya vẫn thức, phiên nghỉ mới đi ngủ
- 🌐 **Tiếng Việt và English**, chọn ngay ở màn đăng nhập (🇻🇳 / 🇬🇧). Thêm ngôn ngữ mới chỉ cần thêm một file trong `public/locales/`
- 🇻🇳 **Gõ tiếng Việt** (Telex, VNI) ngay trong terminal

## Cài đặt

Tải bản mới nhất ở **[Releases](../../releases/latest)**:

- macOS Apple Silicon: `Termnest-arm64.dmg`
- macOS Intel: `Termnest-x64.dmg`
- Windows 10/11: `Termnest-Setup.exe`
- Ubuntu desktop (Intel/AMD 64-bit): `Termnest-amd64.deb`

Cài thêm tmux để phiên được giữ lại: `brew install tmux` trên macOS, `sudo apt install tmux` trên Ubuntu, hoặc `sudo apt install tmux` trong WSL trên Windows.

> [!NOTE]
> Bản cài chưa được ký. Nếu macOS báo ứng dụng “bị hỏng”, chạy `xattr -cr /Applications/Termnest.app`. Nếu Windows hiện SmartScreen, chọn **More info → Run anyway**. Trên Ubuntu, cài bằng `sudo apt install ./Termnest-amd64.deb` (apt tự kéo các thư viện cần thêm), rồi mở **TERMNEST** từ menu ứng dụng; không cần bước nào khác.

## Chạy từ mã nguồn

Cần Node.js 18 trở lên và tmux.

```bash
git clone https://github.com/jiaqing-l/termnest.git && cd termnest
npm install
npm run set-password
npm start   # mở http://127.0.0.1:7681
```

Muốn dùng từ xa thì mở qua SSH tunnel: `ssh -L 7681:127.0.0.1:7681 user@your-server`. Xem thêm [tài liệu hướng dẫn](docs/).

### Dùng trên điện thoại

Điện thoại mở giao diện web của TERMNEST đang chạy trên một máy luôn bật (ví dụ server Ubuntu). Máy đó **không được mở ra Internet**: hãy nối qua VPN (Tailscale hoặc VPN công ty) hoặc SSH tunnel (Termius, Termux). Nếu mở qua một tên miền riêng, khai báo tên đó trong biến môi trường `TW_ALLOWED_HOSTS` (nhiều tên ngăn cách bằng dấu phẩy). Xem thêm [vận hành](docs/operations.md).

## English

**TERMNEST** keeps every tmux session on every machine in one window: you see which one is running and which one needs you, and you can answer right on its card. Close the app or lose the network and the sessions keep running. It also shows token usage for Claude Code and Codex, previews Markdown/HTML/images next to the terminal, works on a phone, and gives each session a small pet that lives in a yard. The interface is available in Vietnamese and English (pick it on the sign-in screen); a new language is one more file in `public/locales/`.

> *It stays awake for you, so you can sleep soundly.*

## Bảo mật

- **TERMNEST** chỉ chạy trên `127.0.0.1`, không mở cổng ra ngoài.
- Khóa SSH được mã hóa bằng mật khẩu **TERMNEST**. Mật khẩu máy chủ không bao giờ được lưu.
- Không thu thập dữ liệu. Mục Token AI chỉ gọi API của Anthropic bằng tài khoản Claude trên máy bạn để xem hạn mức.

Nếu phát hiện lỗ hổng, hãy báo riêng theo [hướng dẫn bảo mật](SECURITY.md).

## Đóng góp

Mọi góp ý, báo lỗi hay pull request đều đáng quý. Xem [hướng dẫn đóng góp](CONTRIBUTING.md) để bắt đầu.

Nếu thấy **TERMNEST** hữu ích, tặng dự án một ⭐ nhé!

## Giấy phép

**TERMNEST** dùng [Giấy phép MIT](LICENSE). Bạn có thể dùng, sửa và chia sẻ thoải mái, kể cả cho công việc, miễn là giữ lại thông báo bản quyền và nội dung giấy phép.

Tên **TERMNEST**, **JIAQING** và logo không thuộc phạm vi giấy phép. Nếu bạn phát hành bản sửa riêng, hãy đặt tên và dùng logo khác.

Phần mềm được cung cấp nguyên trạng, không kèm bảo đảm. Bạn tự chịu trách nhiệm về các lệnh chạy qua **TERMNEST**. **TERMNEST** là dự án độc lập, không liên quan đến tmux, Anthropic hay OpenAI.

## Cảm ơn

**TERMNEST** được xây dựng trên [tmux](https://github.com/tmux/tmux), [xterm.js](https://xtermjs.org), [node-pty](https://github.com/microsoft/node-pty), [ssh2](https://github.com/mscdex/ssh2) và [Tauri](https://tauri.app). Xem [danh sách đầy đủ các thư viện](THIRD-PARTY-NOTICES.md).

---

<p align="center"><sub>MIT © 2026 <b>JIAQING</b></sub></p>
