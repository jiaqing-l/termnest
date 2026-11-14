# TERMNEST: ổn định, hiệu năng, giao diện mới — tracking

Cập nhật: 2026-11-14 23:21 (giờ máy).

| # | Việc | Trạng thái | Bằng chứng |
|---|---|---|---|
| 1 | Server sập khi SSH đứt lúc lệnh chờ kênh (`lib/remote.js`) | Xong, đã cài | commit 92eafab; test `remote-exec`, `terminal-attach` đạt |
| 2 | Pane thợ Crew hiện luồng hoạt động của Codex (`lib/crew.js` workerFeed, `crewpanes.js`) | Xong, đã cài | commit f7a42cb; test `crew-feature`, `crewpanes-feature` đạt (26) |
| 3 | Vòng rAF thú cưng chạy vô hạn (UI CPU 97% → ~14%) | Xong, đã cài | commit f7a42cb; test `pets` đạt (22) |
| 4 | Perf còn lại: đỉnh RAM quét token, poll tmux, `defer` script, animation CSS | Xong, đã cài (subagent báo) | commit 6d3782c; chi tiết `44-PERF-AUDIT.md` mục 'Kết quả đợt 2'; WebContent còn ~40% CPU, chưa đo trước/sau |
| 5 | Mockup giao diện mới (bấm được, màu #20285a/#d32027, đủ tính năng TERMNEST) | Bản 3, chờ DEV duyệt | `45-UI-REDESIGN-MOCKUP.html` |
| 6 | Tag `v1.1.18` đang trỏ nhầm `6a9b69f`; commit mới chưa đẩy | Chờ DEV chạy lệnh dời tag | xem hướng dẫn trong chat |

Chưa chạy lại toàn bộ bộ test sau các thay đổi 1–3 (chỉ test liên quan).
| 7 | Áp dụng thiết kế mới vào app thật (bản thử .gz) | Đang chạy: 3 subagent sonnet song song | A = skin CSS (app.css, features/*.css, index.html); B = cấu trúc UI (app.js, ux2.js/css); C = Ghi chú + lịch nhắc (notes.js/css, notes-core.js). Chuỗi ngôn ngữ ghi vào implementation/i18n-ux2-b.json, i18n-ux2-c.json, lead gộp vào locales. Sau đó: chạy test, đóng gói, cài, báo sha256 |
| 7a | Redesign vào app thật (3 agent + QA parity) | Đã cài nhiều bản thử (.gz); còn lệch nhỏ: Ghi chú tab, Token/Vận hành chỉ đổi màu | cỡ giao diện đã sửa nguyên nhân CSP (ui-zoom.js); bỏ tab Nhắc việc; menu dock trong cửa sổ |
| 8 | Tối ưu mở phiên Crew + ẩn thanh trạng thái tmux 2 dòng | Đang chạy: subagent sonnet | batch log thợ 1 request/crew, cache, ẩn status tmux phía client (không đổi tmux); kết quả sẽ ghi vào 44-PERF-AUDIT.md |
| 9 | Merge vào main | Xong: PR #39 (merge commit 435d604); CI dựng bộ cài còn chạy | tag v1.1.18 vẫn trỏ 6a9b69f, chưa có release |
| 10 | Rà soát bảo mật, rủi ro dữ liệu, tốc độ | Xong 3 báo cáo (bảo mật: 1 Cao/8 TB; dữ liệu: 3 Cao/11 TB; tốc độ: đo xong) | báo cáo: 48-AUDIT-SECURITY.md, 49-AUDIT-DATA-RISK.md, 50-AUDIT-LOAD-SPEED.md |
| 11 | Sửa bảo mật + dữ liệu theo báo cáo 48/49 | Xong, đã trong release 1.1.19 | tương thích vault/backup cũ; sẽ ghi mục 'Đã xử lý' vào 48/49 |
| 12 | Tối ưu tốc độ tải theo báo cáo 50 | Xong, đã trong release 1.1.19 | tải song song tính năng, cache có phiên bản, nén, /api/tokens gọn, locales theo ngôn ngữ; số trước/sau ghi vào 50 |
| 13 | Release 1.1.19 (UX: chip kết nối, cache khi mở lại, Ctrl/⌘K) | Đã merge main (PR #40, 2f0002d), tag v1.1.19; workflow dựng bộ cài đang chạy | chưa kiểm kết quả CI |
| 14 | Sau 1.1.19 (chưa phát hành): ưu tiên đọc tệp, chip hiện lý do mất kết nối | Đã commit local, đã cài app thử | cần 1.1.20 nếu phát hành |
| 15 | Tự xác định leader crew (không cần orchestrator-register) | Đang chạy: subagent sonnet | tài liệu sẽ ở 52-CREW-LEADER-AUTO.md hoặc 51 |
