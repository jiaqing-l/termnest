# TERMNEST: ổn định, hiệu năng, giao diện mới — tracking

Cập nhật: 2026-11-13 10:04 (giờ máy).

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
