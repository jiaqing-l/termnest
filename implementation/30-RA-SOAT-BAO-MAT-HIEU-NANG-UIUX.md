# Rà soát bảo mật, hiệu năng, UI/UX · TERMNEST (07/11/2026)

Nhánh `fix/ubuntu-ime-double` (gồm mọi nhánh trước). Test: 443/443 trên Mac; trên Linux (Debian, Docker) 441 test: 438 đạt, 0 lỗi, 3 bỏ qua có chủ ý.
CI Windows/Ubuntu/macOS của GitHub **không chạy được** lúc này (GitHub báo lỗi thanh toán của tài khoản); chạy lại khi tài khoản ổn.

## 1. Bảo mật

### Đã có (kiểm trong mã)
| Mục | Hiện trạng |
|---|---|
| Truy cập | Chỉ nghe `127.0.0.1`; kiểm `Host` và `Origin` cho mọi request ghi và WebSocket |
| Đăng nhập | Cookie HttpOnly + SameSite=Strict, hết hạn 12 giờ; sai 5 lần khóa 60 giây |
| Header | CSP chặt (`default-src 'self'`, `frame-ancestors 'none'`), nosniff, no-referrer, no-store |
| Kho dữ liệu | AES-256-GCM, khóa scrypt (N=2^15) từ mật khẩu TERMNEST; ghi có fsync; 10 bản sao mã hóa |
| SSH | Ghim vân tay khóa máy chủ, đổi là dừng kết nối; **mật khẩu SSH chỉ giữ trong bộ nhớ, không ghi đĩa**; khóa SSH lưu trong kho mã hóa |
| Lệnh từ xa | Mọi tham số bọc nháy (`shq`); tên, đường dẫn, mã hội thoại đều kiểm dạng; dữ liệu lớn đi qua stdin |
| Tệp | Duyệt/xem chỉ trong thư mục phiên (realpath, không theo link ra ngoài); chặn tệp chương trình khi gửi |

### Làm trong đợt này
- **Thêm máy chủ chỉ bằng SSH key** (mặc định). Ba cách:
  1. *Tạo khóa SSH mới (khuyến nghị)*: TERMNEST tạo khóa ed25519, đăng nhập **một lần** bằng mật khẩu để cài vào `~/.ssh/authorized_keys` (quyền 700/600, không cài trùng), rồi quên mật khẩu.
  2. *Tạo khóa, tôi tự cài*: hiện lệnh để dán trên server; khóa chờ 30 phút trong bộ nhớ.
  3. *Dùng tệp khóa có sẵn*.
  Mật khẩu chỉ dùng được khi bật "Cho phép thêm máy chủ bằng mật khẩu (không khuyến nghị)" trong Cài đặt → Máy chủ.
- **Chuyển máy chủ đang dùng mật khẩu sang khóa**: chi tiết máy chủ → "Chuyển sang SSH key". Cài khóa qua kết nối đang mở, thử đăng nhập bằng khóa ở kết nối thứ hai, chỉ đổi khi thử thành công.
- Sửa chữ trong app và tài liệu: tệp chuyển máy chứa **khóa SSH**, không phải mật khẩu SSH (trước đây ghi sai).

### Nên làm tiếp
| Ưu tiên | Việc | Lý do |
|---|---|---|
| P1 | Tự khóa khi không dùng N phút / khi máy ngủ | Ai ngồi vào máy đang mở TERMNEST là gõ được vào mọi server |
| P1 | Sau khi chuyển hết sang khóa: hướng dẫn tắt `PasswordAuthentication` trên server (cần sudo, chủ tự làm) | Chặn dò mật khẩu SSH từ bên ngoài |
| P2 | Mã khôi phục khi quên mật khẩu TERMNEST | Hiện quên là mất kho |
| P2 | Nhật ký thao tác nhạy cảm (đăng nhập, thêm/xóa server, xuất tệp, chuyển phiên) | Truy vết |
| P3 | Tăng scrypt N lên 2^16 khi tạo kho mới | Chậm dò mật khẩu hơn; đổi định dạng cần migrate |

## 2. Hiệu năng (đo trên MacBook, 2 phiên tmux)
| Chỉ số | Trước | Sau |
|---|---|---|
| Dữ liệu một lần quét gửi về (mỗi 3 giây, mỗi máy) | 215 KB (1.400 dòng ps) | **15 KB** (chỉ tiến trình trong phiên tmux và crew) |
| Thời gian chạy lệnh quét | ~200 ms | ~200 ms |
| Phân tích kết quả | 5 ms | < 5 ms |
| `/api/state` gửi lên trang | 6,6 KB, 3 ms | như cũ |
| CPU tiến trình TERMNEST khi rảnh | 0,6% | như cũ |

Với 3 VM × 10 phiên, phần tiết kiệm khoảng 4 MB/phút mỗi máy qua SSH.
Cũng sửa: trên Mac lệnh `ps` thiếu `etimes` làm hỏng toàn bộ phần nhận diện Claude/Codex của "Máy này".

Nên làm tiếp: nén gzip cho `/api/state` khi qua mạng (điện thoại, Tailscale); quét thưa hơn (10 giây) cho máy không có ai đang xem.

## 3. UI/UX (chụp WebKit 1440 px và 390 px)
### Đã sửa
- Điện thoại: "Thú cưng" và các tab "Tổng quan / Terminal / Token AI / Ghi chú" bị xuống dòng từng chữ → giờ một dòng, vuốt ngang được.
- Token AI trên điện thoại: hai vòng quota xếp dọc → giờ nằm cạnh nhau.
- Đã sửa trước đó: Cài đặt dạng thẻ có tiêu đề cố định; Tài khoản AI gọn; hộp chuyển phiên; xem tệp không còn kéo hết màn.

### Còn rối hoặc khó nhìn, nên sửa
| Ưu tiên | Chỗ | Vấn đề | Đề xuất |
|---|---|---|---|
| P1 | Thanh trên cùng | Ô chọn "Tất cả máy chủ" trùng với thanh bên; dải tài khoản AI màu tối dài, bị cắt trên điện thoại | Bỏ ô chọn trên máy tính (giữ thanh bên), dải tài khoản thành 1 chấm màu + % gọn |
| P1 | Token AI | Lúc đang đọc hiện 4 ô số "0", "$0.00" như thật; nhiều dòng ghi chú nhỏ trong mỗi thẻ | Hiện khung chờ (skeleton) khi đang đọc; gom ghi chú vào biểu tượng ⓘ |
| P2 | Thẻ phiên ở Tổng quan | Phiên đang chờ có vùng xem trước trắng, phiên khác nền terminal tối: không đồng nhất | Một kiểu xem trước cho mọi phiên |
| P2 | Tổng quan có 1 máy | Thẻ máy chủ nhỏ, bên phải trống | Thẻ máy kéo đủ hàng khi chỉ có 1–2 máy |
| P3 | Điện thoại | Hero chiếm gần nửa màn hình | Thu gọn hero còn một dòng trên điện thoại |

## 4. Thông báo
- Có câu hỏi: kêu meo ngay (nếu bật âm thanh), thông báo hệ thống sau **5 giây** (trước đây 2 phút).
- Phiên xong và đang chờ việc: thông báo sau **30 giây** yên lặng; loại này giờ bật mặc định.
- Thông báo hệ thống hiện **một lần** mỗi lần phiên bắt đầu chờ. Chuông trong app giữ số đỏ cho tới khi bạn xem.

## 5. Windows / Ubuntu
- Ubuntu: chạy toàn bộ test trong Linux (Docker): 441 test, 0 lỗi; lệnh quét mới (lọc tiến trình bằng awk) thử với `mawk` của Debian, giữ đúng tiến trình trong tmux.
- Windows: rà mã; các phần dùng shell (chuyển phiên, file tạm, chuyển máy) bỏ qua chế độ PowerShell; lớp sửa bộ gõ không bật trên WebView2 (Chromium) nên không ảnh hưởng. **Chưa có test thật trên Windows** vì CI GitHub đang bị chặn do thanh toán.

## 6. Kèm chat server (đã làm)
- Khi Xuất: ô "Kèm thêm chat của N phiên trên server (dung lượng)".
- Khi khôi phục: chat chỉ được ghi lại lên server nếu server đó không còn chat; còn thì giữ nguyên, không ghi đè.

## 7. Thông báo: hiện tới khi nào
- Thông báo hệ thống hiện **một lần** mỗi lần phiên bắt đầu chờ; không nhắc lại. Số đỏ ở chuông trong app giữ tới khi bạn xem.
- Trên Mac muốn thông báo đứng yên tới khi bấm: Cài đặt hệ thống → Thông báo → Termnest → kiểu "Cảnh báo".
- Có thể thêm: nhắc lại mỗi 10 phút khi phiên vẫn chờ mà chưa xem.
