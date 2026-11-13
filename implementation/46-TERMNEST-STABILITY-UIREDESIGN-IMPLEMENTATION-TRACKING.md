# TERMNEST: ổn định, hiệu năng, giao diện mới — tracking

Cập nhật: 2026-11-13 08:53 (giờ máy).

| # | Việc | Trạng thái | Bằng chứng |
|---|---|---|---|
| 1 | Server sập khi SSH đứt lúc lệnh chờ kênh (`lib/remote.js`) | Xong, đã cài | commit 92eafab; test `remote-exec`, `terminal-attach` đạt |
| 2 | Pane thợ Crew hiện luồng hoạt động của Codex (`lib/crew.js` workerFeed, `crewpanes.js`) | Xong, đã cài | commit f7a42cb; test `crew-feature`, `crewpanes-feature` đạt (26) |
| 3 | Vòng rAF thú cưng chạy vô hạn (UI CPU 97% → ~14%) | Xong, đã cài | commit f7a42cb; test `pets` đạt (22) |
| 4 | Perf còn lại: đỉnh RAM quét token, poll tmux, `defer` script, animation CSS | Đang chạy (subagent nền, sonnet) | kết quả sẽ ghi vào `44-PERF-AUDIT.md` |
| 5 | Mockup giao diện mới 14 màn | Xong bản mockup, chờ DEV duyệt | `45-UI-REDESIGN-MOCKUP.html` |
| 6 | Tag `v1.1.18` đang trỏ nhầm `6a9b69f`; commit mới chưa đẩy | Chờ DEV chạy lệnh dời tag | xem hướng dẫn trong chat |

Chưa chạy lại toàn bộ bộ test sau các thay đổi 1–3 (chỉ test liên quan).
