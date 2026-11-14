# 50 - Kiểm tra tốc độ tải và độ trễ thao tác (đo thực tế, 14/11/2026)

Chỉ đo, không sửa mã nguồn. Môi trường đo: Chrome headless (CDP) + server tạm (`TW_DATA` tạm, cổng 17811, mật khẩu ném đi) + tmux riêng `-L twqa`
với 12 phiên (qa-1..4 in 400 dòng mỗi 0,5 s, qa-5..8 in mỗi 2 s, qa-9..12 là bash rảnh). Máy: MacBook Air, Node 24. Đã dọn server, tmux, thư mục tạm.

Giới hạn đo (nói thẳng):
- Localhost nên mọi số "nhanh" đều là cận dưới. Con số có ý nghĩa cho người dùng từ xa (Tailscale/VPN/điện thoại) là các dòng có giả lập mạng.
- Các phiên giả đều ở trạng thái "Resting" (là vòng lặp shell, không phải Claude/Codex) nên hoạt ảnh thú gần như không chạy
  (`document.getAnimations()` = 0). Chi phí hoạt ảnh khi nhiều phiên "running/wait" chưa đo được.
- `/api/tokens` đọc nhật ký Claude/Codex thật của máy này (chỉ đọc): 3 tài khoản, 2.491 phiên. Dữ liệu người dùng thật, nên con số 620 KB có thể lớn hơn máy khác.
- Trong lúc đo, `server.js` bị người khác sửa (số dòng dịch ~10) và `public/look.css`, `public/look.js` chưa tồn tại (xem F7). Số dòng bên dưới lấy lúc cuối.
- Có một lượt đo tmux bị chết giữa chừng (tmux server biến mất, không rõ nguyên nhân, nghi do tiến trình nền bị dọn); các số dùng để kết luận đều lấy
  từ lượt chạy có đủ 12 phiên (đã kiểm `ls | wc -l` = 12 trước và sau).

## 1. Bảng số đo

### 1.1 Tải trang (Chrome headless, 12 phiên, đã đăng nhập)
| Kịch bản | First paint | FCP | DCL / load | Thấy thẻ phiên | Mọi tab tính năng (Ghi chú/Vận hành) sẵn sàng |
|---|---|---|---|---|---|
| localhost, cache tắt | 36 ms | 36 ms | 33 / 34 ms | 60-88 ms | 93 ms |
| localhost, tải lại (cache bật) | 36 ms | 36-48 ms | 37 / 38 ms | 67-90 ms | 98 ms |
| 60 ms RTT, 10 Mbps, cold | 208 ms | 476 ms | 686 / 687 ms | 826-846 ms | **1.716 ms** |
| 60 ms RTT, 10 Mbps, tải lại | 220 ms | 276 ms | 529 / 530 ms | 693-749 ms | **1.552 ms** |
| như trên + CPU chậm 4x, cold | 236 ms | 496 ms | 743 / 749 ms | 932 ms | (không đo) |
| 150 ms RTT, 1,6 Mbps, cold | 724 ms | 2.432 ms | 2.842 / 2.846 ms | 3.203-3.213 ms | **6.079 ms** |
| 150 ms RTT, 1,6 Mbps, tải lại | (không đo) | | | 1.867 ms | **3.972 ms** |

Long task (>50 ms) lúc tải: 0 ở mọi kịch bản. Tải lại có cache vẫn tốn gần bằng tải lần đầu ở mạng chậm vì phải hỏi lại 74 tệp (F2).

### 1.2 Tài nguyên và nén
| Nhóm | Số tệp | Thô | Gzip (trên đường truyền) |
|---|---|---|---|
| Tài nguyên tĩnh nạp trong `index.html` (41 URL gồm 2 tệp `look.*` đang 500) | 41 | 1.407 KB | 421 KB |
| `features/*` (nạp động sau đăng nhập, 16 tệp JS + CSS) | ~32 | 404 KB | 121 KB |
| Tổng wire lần nạp lạnh (đo bằng CDP, gồm API và phông) | **76 yêu cầu tĩnh + 20 API = 96** | | **680 KB** tĩnh |
| Tải lại có cache | 76 + 20 | | ~40 KB (nhưng vẫn **96 yêu cầu**, 74 cái là hỏi lại ETag) |

Lớn nhất (thô / gzip): `locales.js` 318 KB / 96 KB (mọi ngôn ngữ gộp một tệp), `vendor/xterm.js` 290 / 68, `app.css` 182 / 42, `app.js` 154 / 45,
`vendor/markdown-it.js` 126 / 46, `features/ops.js` 90 KB thô (27 KB gzip), `file-viewer.js` 50 / 15, `features/opshub.js` 40 KB, `features/crewpanes.js` 45 KB.
`fonts/fonts.css` 13,7 KB thô. Ba logo SVG mỗi cái 17 KB thô (5 KB gzip) và `icon-180.png` 22 KB không nén được.
Đầu ra: JS/CSS/locales/phông có `Content-Encoding: gzip` (khi nhỏ hơn 90 %), `ETag`, `Cache-Control: no-cache` (luôn hỏi lại), `Vary: Accept-Encoding`.
API: `Cache-Control: no-store`; JSON >2 KB được gzip **trừ `/api/tokens`**. Service worker (`public/sw.js`) chỉ có `install`/`activate`, **không có `fetch`, không cache gì**.
`<script>` đã có `defer` (27/28 thẻ).

### 1.3 Chuyển view và thao tác (12 phiên, đo bằng `performance.now()` + 2 lần rAF)
| Thao tác | Đồng bộ (JS) | Đến khi vẽ xong | Ghi chú |
|---|---|---|---|
| Tổng quan (về lại) | 1-4 ms | 8-17 ms | |
| Terminal, lần đầu | **37-58 ms (1 long task 51-58 ms)** | 40-61 ms | khởi tạo xterm + pane |
| Terminal, các lần sau | 4-15 ms | 16-21 ms | |
| Tất cả (bấm "All servers") / "Máy này" | 2-5 ms | 12-18 ms | |
| Token AI | 3-39 ms | 10-52 ms | 1.581 nút DOM |
| Ghi chú | 3-15 ms | 5-26 ms | |
| Vận hành | 3-6 ms | 11-32 ms | |
| Mở Settings | 5-14 ms | 13-31 ms | 416 nút; đổi tab trong Settings 17-30 ms |
| Mở hộp thoại "Phiên mới" | | 31 ms | |
| Mở terminal từ thẻ phiên -> WebSocket mở | | 5,5-6,5 ms | |
| ... -> tin nhắn đầu tiên của WS | | 19 ms (qa-1, nhiều output), 29-33 ms | |
| ... -> chữ hiện trên terminal | click đồng bộ 18-51 ms | **63-99 ms** | |

Không đo "dựng lại overview với 12 phiên" riêng được từ ngoài (hàm nằm trong IIFE); qua profiler 60 s, `renderFleet` ~3,7 ms bao gồm / 25 lần gọi
(~0,15 ms/lần), `fillCard` 2 ms, `petSync` 4,2 ms. Dựng đầy đủ `render()` đo gián tiếp: grid được thay mới ~7 lần/phút (xem F5), tổng JS toàn trang ~700 ms / 60 s (~1,2 % một lõi).

### 1.4 Tải nền, bộ nhớ, CPU (5 phút: Tổng quan 150 s, Vận hành 60 s, Token 45 s, Ghi chú 45 s)
| Chỉ số | Kết quả |
|---|---|
| Long task trong 5 phút | **0** |
| JS heap | 9,8 MB -> 11 MB -> 7,4 MB -> 7,7 MB; sau GC 7,7 MB. **Không rò rỉ.** |
| Số nút DOM | 1.756 (overview) - 3.079 (sau khi mở Token/Ops); 4.213 tổng khi cả 5 view đã dựng với 12 phiên |
| RSS renderer chính | 231 -> 282 MB sau 5 phút (theo các view đã mở) |
| CPU renderer (rảnh, overview) | 1-2 % (đo không bật profiler); 4,2-5 % khi bật profiler |
| CPU node (rảnh, 1 trình duyệt mở) | 0,9-1,3 %; RSS 237-427 MB (đỉnh khi quét token, tụt lại ~240 MB) |
| Độ trễ vòng lặp sự kiện node (thăm dò `/api/status` mỗi 20 ms) | rảnh: p50 1,3 / p99 3,5 / max 188 ms; 5 client x10 Hz `/api/state`+`opshub/state`: p50 1,0 / p95 2,3 / p99 6,4 / max 20 ms |
| Poll tmux (`POLL_SCRIPT`, 12 phiên, tiến trình sh riêng) | 337-380 ms/lần (trung vị 365), 28 KB đầu ra, chạy mỗi 3 s. Phần lớn là `ps -eo` (74 ms), AGENTIDS 23, CWD 19, PANEENV 18, FOREGROUND 14, JOBS 11; `tmux` chỉ ~12 ms |

### 1.5 API phía server (5 lần, localhost, 12 phiên)
| Route | Thô | Gzip | Thời gian |
|---|---|---|---|
| `GET /api/state` | 16,7 KB | 2,0 KB | 0,8-1,1 ms |
| `/api/features/ops/board` | 5,4 KB | 2,2 KB | ~1 ms |
| `/api/features/opshub/state` | 5,1 KB | 0,7 KB | 0,6-1,1 ms |
| `/api/features/crewpanes/list` | 25 B | | ~0,7 ms |
| `/api/features/context/data` · `watchdog/data` · `plugins/data` · `ops/supervision` · `server-backup/status` · `notes/data` | 74 B-1,3 KB | | 0,5-1,4 ms |
| **`/api/tokens`** (3 tài khoản, 2.491 phiên) | **620-680 KB** | **không gzip (bằng thô)** | 6 ms (đã ấm); lần đầu 17-28 ms |
| `/api/usage` (14 ngày) | 7,8 KB | 2,2 KB | **3,8 s lần đầu**, sau đó 7 ms (cache) |
| `POST /api/features/crew/logs` | | | (chỉ đo đường lỗi 400, 1,5 ms; chưa có crew thật để đo batch) |

### 1.6 Tần suất poll thực tế (đo bằng CDP ở view Tổng quan, 150 s)
| Route | Chu kỳ mã | Đo được | Nơi đặt |
|---|---|---|---|
| `/api/state` | 2,5 s (ẩn: 15 s) | 0,40/s | `public/app.js:1675` |
| `/api/features/crewpanes/list` | 2 s | **0,50/s** (kể cả khi không có crew) | `features/crewpanes.js:446` |
| `/api/features/crewpanes/tracks` | 2 s | 0 (không có crew) | `crewpanes.js:455` |
| `loadDerived` -> `/api/features/opshub/state` | 5 s | 0,2/s (0,32/s khi mở Vận hành) | `crewpanes.js:456`, `opshub.js:507` (10 s) |
| `refreshLogs` (POST logs) | 2,5 s | 0 (không có crew) | `crewpanes.js:456` |
| `/api/features/ops/board` + `ops/supervision` + `plugins/data` | 10 s | 0,1/s mỗi cái, **dù view Vận hành ẩn** | `features/ops.js:1085` |
| `/api/features/server-backup/status` | 10 s | 0,1/s, dù Settings đóng | `features/server-backup.js:243` |
| `/api/features/context/data` | 20 s | 0,05/s | `features/context.js:66` |
| `/api/features/watchdog/data` | 20 s | 0,05/s | `features/watchdog.js:66` |
| `/api/features/health/data` | 30 s | (không có hộp mở) | `features/health.js:44` |
| `/api/tokens` | 30 s (5 s khi đang quét) | 0,05-0,08/s | `public/token-ui.js:145`, `app.js:1676` |
| `/api/tokens` lần thứ 2 | 60 s | | `features/ops.js:1086`, `opshub.js:508` |
| Ghi chú | 15 s | | `features/notes.js:297` |
| `pollCrew` (log popup) | 1,5 s | chỉ khi mở popup | `app.js:264` |
| Cuộn terminal `scrollCall` | 3 s | mỗi pane đang xem | `app.js:655` |
| Còn lại, không gọi mạng | pet-scene 1 s, pet-yard 30 s, opshub "updated" 5 s, crewpanes vẽ lại 1 s | | `pet-scene.js:197`, `pet-yard.js:381`, `opshub.js:84`, `crewpanes.js:458` |

Tổng: **~1,7 yêu cầu/giây ≈ 100 yêu cầu/phút** khi chỉ mở Tổng quan, còn không có crew nào.
Server cũng tự poll tmux: 3 s (`server.js:35`, chỉ khi có trang mở), 60 s khi không ai xem, 15 s cho supervision (`server.js` ~1069-1090).

Dữ liệu `/api/state` ~2 KB gzip x 24/phút = ~2,9 MB/giờ; `ops/board` 0,8 MB/giờ; `opshub/state` 0,5 MB/giờ. Nhưng `/api/tokens` 620-680 KB không nén x 120/giờ = **~80 MB/giờ** khi thẻ token trong thanh bên đang hiện.

### 1.7 DOM, CSS, thay đổi DOM
- DOM theo view (12 phiên): v-over 700, v-focus 386 (sau khi mở terminal), v-token 1.581, v-notes 141, v-ops 269, side 260, fleet 62, grid 225; tổng 4.213.
- Quan sát thay đổi DOM (MutationObserver) 60 s ở Tổng quan, 12 phiên: `grid` 2.039 bản ghi / 1.700 nút thêm (~7 lần dựng lại cả lưới, mỗi lần 225 nút), `split` 2.484, `pet-yard2` 1.188, `health` 100, `fleet` 50 (25 lần xoá + dựng lại, 62 nút), `bell-n` 50, `v-ops` 108 và `ops-settings-mount` 78 (**khi đang ở Tổng quan**), `server-backup-settings-mount` 30.
- CSS đắt: `backdrop-filter` chỉ 2 chỗ (`app.css:907` ::backdrop của hộp hướng dẫn, `app.css:1323` chip hero blur 4 px). `filter:drop-shadow` ở tia sét `.wx-bolt` (`app.css:862`, chỉ khi trời bão). Bóng lớn: `.wx-sun` `box-shadow 40px 14px` + animation vô hạn (`app.css:850`, chỉ thời tiết nắng), hộp thoại 30px/70px (`app.css:205,1524`). Animation vô hạn: ~35 quy tắc (thú `bob/hop/blink`, sân chơi, thời tiết, `#fx` mưa/tuyết, `wire-dot`). Thực tế lúc đo `document.getAnimations()` = 0; tắt toàn bộ animation không đổi CPU rảnh (1,7-1,9 %). Đã có `html.tab-hidden` và `prefers-reduced-motion` dừng animation (từ bản 1.1.17).
- Layout thrash: Chrome ghi 39 lần Layout (54,9 ms) và 42 UpdateLayoutTree (23,7 ms) trong 60 s: rất thấp. Không thấy chuỗi đọc/ghi layout xen kẽ nào đáng kể ở các đường nóng.

## 2. Phát hiện, xếp theo (tác động / công sức)

| # | Phát hiện | Vị trí | Đo được | Cách sửa | Tác động/công sức |
|---|---|---|---|---|---|
| F1 | **Tính năng nạp tuần tự**: `TW.load()` chờ `/api/features` rồi nối chuỗi `<script>` từng cái một (16 tệp), mỗi cái 1 RTT. | `public/features-host.js:64` | Ở 60 ms RTT: thẻ phiên hiện 826 ms nhưng tab Ghi chú/Vận hành chỉ có lúc 1.716 ms; ở 150 ms: 3,2 s so với 6,1 s. | Nạp song song (đặt `async=false` hoặc tải tất cả rồi chạy theo thứ tự) hoặc đưa danh sách module vào `index.html`; hoặc gộp `features/*` thành 1 bundle. Bỏ được ~0,9 s (60 ms) và ~2,9 s (150 ms). | **Rất cao / thấp** |
| F2 | **Tài nguyên tĩnh luôn "hỏi lại"**: `Cache-Control: no-cache` + ETag nên mỗi lần tải lại là 74 yêu cầu 304. Service worker rỗng. | `server.js:212` (`sendAsset`), `public/sw.js` | Tải lại ở 60 ms RTT vẫn 693-749 ms và 1.552 ms đến khi đủ tính năng (cold 826/1.716); ở 150 ms: 1.867 vs 3.203 ms. 76 yêu cầu tĩnh mỗi lần. | Đổi URL theo hash/phiên bản (`?v=<etag>` hoặc `/app.<hash>.js`) rồi `Cache-Control: public, max-age=31536000, immutable`; HTML vẫn `no-cache`. Nếu muốn gọn hơn: gộp 28 JS thành 2-3 bundle. SW có thể cache-first cho phông/vendor. | **Cao / thấp-trung** |
| F3 | **`/api/tokens` không gzip, 620-680 KB, poll 30 s**. Một tài khoản có `sessions` 21 KB-600 KB (2.328 phiên). | `server.js:835-839` (`res.end(tokenCache.get(...))` bỏ qua `send()`), `token-ui.js:145`, `ops.js:570/1086`, `opshub.js:508` | ~80 MB/giờ trên điện thoại/VPN; mỗi lần 6-28 ms server + parse JSON 0,6 MB ở trình duyệt | (a) gzip như `send()` (xuống ~60-90 KB); (b) không trả mảng `sessions` đầy đủ trong tổng quan, chỉ top-N hoặc tải khi mở tài khoản; (c) dùng `ETag`/`updatedAt` để 304; (d) bỏ lần poll thứ hai 60 s của ops/opshub vì `token-ui` đã poll. | **Cao / thấp** |
| F4 | **Tải lần đầu bị chặn bởi phần nặng cả khi không dùng**: `locales.js` 318 KB (96 KB gzip) chứa mọi ngôn ngữ, `xterm.js` 290 KB nạp ngay cả khi ở Tổng quan, `markdown-it.js` 126 KB, `file-viewer.js` 50 KB, `features/ops.js` 90 KB. | `server.js:~995` (`/locales.js`), `index.html` | ~300 KB gzip chỉ cho phần chưa dùng (xterm+markdown+file-viewer+ops+opshub ≈ 200 KB gzip, locales thừa ≈ 50 KB). 3G: FCP 2,4 s | Chỉ gửi ngôn ngữ đang dùng (`/locales/<lang>.json`, tải ngôn ngữ khác khi đổi). Nạp lười xterm/markdown/file-viewer/ops/opshub khi mở view. | Trung-cao / trung |
| F5 | **Thay lưới thẻ khi chữ ký đổi**: `sig()` gồm `state, cmd, diary` và cả 8 dòng cuối của worker; phiên in liên tục làm `render()` dựng lại cả lưới (225 nút) + `split` ~7 lần/phút. Mỗi poll 2,5 s còn xoá và dựng lại `fleet`, `bell`, `health` cho dù chữ ký không đổi. | `public/app.js:1636-1640` (`sig`), `app.js:1654` (`renderHealth(); renderFleet(); renderBell();` mỗi poll), `app.js:909` (`renderFleet` `box.textContent=''`) | 1.700 nút thêm / 60 s ở grid; fleet 25 lần xoá+dựng/60 s (62 nút). CPU thực chỉ ~0,15-0,3 ms/lần nên hiện **chưa gây chậm**, nhưng tăng tuyến tính theo số phiên/máy. | Chỉ so sánh cặp `(state, cmd)`; cập nhật tại chỗ cho `diary`/worker lines. Cho `renderFleet`/`renderBell` một chữ ký riêng, bỏ qua nếu không đổi (giữ vị trí cuộn/focus). | Trung / thấp |
| F6 | **Timer của tính năng chạy cả khi view ẩn**: `ops.js` mỗi 10 s gọi `load()+loadPlugins()` và dựng lại v-ops dù đang ở Tổng quan (`v-ops` 108 bản ghi, `ops-settings-mount` 78 trong 60 s); `server-backup.js` dựng lại mount Settings (30/60 s) dù Settings đóng; `crewpanes/list` 0,5/s kể cả không có crew. Chỉ có `opshub.js` kiểm `visible()`. | `features/ops.js:1085`, `features/server-backup.js:243`, `features/crewpanes.js:446`, `context.js:66`, `watchdog.js:66` | ~1,0-1,2 yêu cầu/s không ai nhìn thấy; 4 route (`ops/board`, `supervision`, `plugins/data`, `server-backup/status`) mỗi 10 s | Một bộ lập lịch chung (`TW.poll(fn, ms, {when: viewOn})`) bỏ qua khi view/hộp ẩn; giãn `crewpanes/list` khi không có crew (ví dụ 15 s) hoặc đẩy qua `state`. Đã gợi ý ở `44-PERF-AUDIT.md`, nhưng chỉ làm với crewpanes lúc ẩn cửa sổ. | Trung / thấp |
| F7 | **Hai tệp 500**: `/look.css` và `/look.js` được `index.html` tham chiếu (`link` dòng 14, `script defer` dòng 313) và có route (`server.js:134-135`) nhưng `public/look.*` không tồn tại, server trả 500 mỗi lần tải. Có thể là thay đổi dở dang của người khác, nhưng nên chặn trước khi phát hành. | `public/index.html:14,313`, `server.js:134-135` | 2 yêu cầu lỗi mỗi lần tải; CSS bị chặn render chờ 1 RTT thừa | Thêm tệp hoặc bỏ tham chiếu. | Thấp / rất thấp (nhưng là lỗi) |
| F8 | **`/api/state` trùng dữ liệu**: `houseSessions` là bản sao của `sessions` (7,4 KB trong 17,8 KB thô, gzip làm nhẹ hơn). Cả hai phải `map(publicSession)` mỗi lần. | `lib/backend.js:155-156` | 7 KB thô / mỗi 2,5 s; gzip còn ~2 KB nên tác động nhỏ | Gửi một mảng + cờ `on`. | Thấp / thấp |
| F9 | **Terminal ẩn vẫn chạy**: sau khi mở Terminal rồi về Tổng quan, WebSocket pane vẫn nhận và xterm vẫn phân tích. | `app.js:775` (`sock.onmessage`), `vendor/xterm.js` | 60 s ở Tổng quan: xterm 148 ms + `onmessage` 32 ms (với phiên in nhiều: 375 tin/312 KB trong 15 s) ≈ 3 ms/s | Tạm dừng ghi vào xterm khi `view!=='focus'` (gom lại, ghi một lần khi quay lại) hoặc đóng WS sau N phút. | Thấp-trung / trung |
| F10 | **Khởi tạo xterm lần đầu = long task 51-58 ms** | `app.js:ensureTerm`, `vendor/xterm.js` | 1 long task khi chuyển Terminal lần đầu | Khởi tạo sớm khi rảnh (`requestIdleCallback`) hoặc cùng lúc nạp lười. | Thấp / thấp |
| F11 | **Poll tmux phía server** 337-380 ms mỗi 3 s trên macOS (12 phiên); `ps -eo args` 74 ms. Hiện chạy trong tiến trình con nên không chặn event loop (p99 3,5 ms), nhưng ~12 % thời gian của một lõi cho sh/ps/awk. | `lib/parse.js:74` (`POLL_SCRIPT`), `server.js:35` | 365 ms trung vị | Tách các phần chậm (`PS`, `AGENTIDS`, `CWD`, `PANEENV`, `JOBS`) sang nhịp 10-15 s; giữ `SESS`/`PANE` ở 3 s. | Trung / trung |
| F12 | `/api/usage` lần đầu 3,8 s (đọc log thật) | `server.js:~841` | chỉ lần đầu (sau đó 7 ms) | Làm nóng nền khi khởi động, hoặc trả "đang quét" + poll lại. | Thấp / thấp |

## 3. Việc không phải vấn đề (đã đo, không cần sửa)
- JS heap ổn định 7-11 MB sau 5 phút, không rò rỉ; 0 long task trong 5 phút; CPU node rảnh ~1 %; vòng lặp sự kiện node khỏe (p99 6,4 ms dưới tải 5 client x 10 Hz).
- Chi phí mỗi hàm render nhỏ: `renderFleet` ~0,15 ms/lần, `fillCard` ~0,1 ms, Layout 1,4 ms/lần, Paint 0,5 ms/lần. Chỉ lo khi số phiên/máy tăng gấp 10.
- `defer` script, ETag, gzip tĩnh, gzip `/api/state` đều đang đúng.
- Backdrop-filter chỉ 2 chỗ, không phải điểm nóng.

## 4. Thứ tự đề xuất
1. F1 (nạp tính năng song song) + F7 (sửa 500): nửa ngày, bớt ~0,9-2,9 s ở mạng chậm.
2. F3 (gzip + cắt `sessions` của `/api/tokens`): ~80 MB/giờ -> vài MB/giờ.
3. F2 (băm tên tệp + `immutable`): bỏ 74 lần hỏi lại, tải lại ở mạng chậm giảm >50 %.
4. F6 (bộ lập lịch theo view): bớt ~1 yêu cầu/giây, giảm số lần dựng lại DOM ẩn.
5. F4 (locales từng ngôn ngữ, nạp lười xterm/markdown/ops).
6. F5, F9, F11 khi số phiên/máy tăng.

Công cụ đo (kịch bản CDP, trace, thăm dò) nằm trong thư mục scratchpad của phiên, không đưa vào repo.

## 5. Kết quả tối ưu (14/11/2026)

Đo lại bằng đúng cách ở mục 1 (Chrome headless + CDP, 12 phiên tmux riêng `-L twqa`, server tạm, localhost + giả lập mạng). "Revisit" = mở lại URL (cache bật), "reload" = F5.
`cards` = thẻ phiên hiện; `ops` = tab Vận hành/Ghi chú đã được nạp (xong nạp tính năng). Đơn vị ms.

| Kịch bản | Trước: FCP / cards / ops | Sau: FCP / cards / ops |
|---|---|---|
| 60 ms RTT, cold | 484 / 828 / 1.711 | 384 / 795 / 1.246 |
| 60 ms RTT, revisit | 280 / 675 / 1.460 | 160 / 291 / 358 |
| 60 ms RTT, reload | 280 / 675 / 1.457 | 172 / 304 / 380 |
| 150 ms / 1,6 Mbps, cold | 2.532 / 3.193 / 6.089 | 1.576 / 2.900 / 4.315 |
| 150 ms / 1,6 Mbps, revisit | 708 / 1.679 / 3.794 | 392 / 740 / 911 |
| 150 ms / 1,6 Mbps, reload | 708 / 1.663 / 3.747 | 388 / 719 / 890 |
| localhost | không đổi đáng kể (cards 45-55 ms, ops 33-63 ms) | |

- Số yêu cầu chạm mạng khi mở lại: 96-100 (74 là hỏi lại ETag) -> **30-35** (toàn là API; 0 yêu cầu tĩnh). Hai yêu cầu 500 `look.*`: 2 -> 0.
- Byte `/api/tokens` (2.491 phiên, 3 tài khoản): 620-680 KB không nén -> **~21 KB thô / ~4,2 KB gzip** mỗi lần, và **~45 byte** khi không đổi (`etag=` -> `{notModified}`). Ước tính ~80 MB/giờ -> vài trăm KB/giờ.
- `locales.js`: 318 KB thô / 96 KB gzip -> 169 KB (vi) hoặc 150 KB (en) thô, **~49 KB / ~47 KB gzip**.
- Chuyển view, CPU rảnh, heap: không đo lại riêng vì không đổi đường chạy; bỏ dựng lại v-ops khi đang ở view khác và bỏ dựng lại thẻ sao lưu khi dữ liệu không đổi.

### Đã làm (hành vi giữ nguyên, có kiểm)
1. **F1 nạp song song**: `public/features-host.js` chèn mọi `<script>`/`<link>` cùng lúc (`async=false` giữ thứ tự thực thi theo danh sách server), `ready` phát sau khi xong cả 16 tệp; tệp lỗi không chặn tệp sau. Danh sách phiên bản đặt trong `<meta name="tw-assets">`.
2. **F2 cache**: HTML được gắn `?v=<hash nội dung>` cho mọi JS/CSS cục bộ, `fonts.css` gắn cho phông; URL có `v` khớp hash hiện tại -> `Cache-Control: public, max-age=31536000, immutable`; `v` sai/cũ hoặc không `v` -> `no-cache` + ETag/304 như cũ; HTML vẫn `no-cache`. Gói cài đặt/updater ghi đè tệp -> hash đổi -> URL mới. Mã mới ở `lib/web-assets.js`.
3. **Nén**: gzip một lần mỗi tệp (lưu theo nội dung), ngưỡng 1 KB, `Vary: Accept-Encoding`, `q=0` được tôn trọng; `/api/tokens` giờ cũng gzip. WebSocket và route API khác không đụng tới.
4. **F3 `/api/tokens`**: mặc định mỗi tài khoản giữ top 10 theo hôm nay + top 10 theo tuần + mọi dòng có `tmuxName`, thêm `sessionsTotal`; `?sessions=all` trả đủ. Tổng, `days`, `weeks`, limits... không đổi (đã đối chiếu 3 tài khoản). Token tab tự gọi `sessions=all` khi bấm "Xem thêm". Giữ `no-store`; không dùng cache trình duyệt mà dùng `?etag=` do client gửi lại.
5. **F4 locales**: server chỉ gửi ngôn ngữ đang dùng (cookie `tw-lang` > `?lang=` > Accept-Language, giống `i18n.js`), ngôn ngữ khác chỉ là stub tên/cờ; khoá thiếu được bù từ tiếng Việt như `t()` cũ. Đổi ngôn ngữ vẫn reload trang (đã sẵn), khi lệch cookie thì `i18n.js` nạp bảng một lần.
6. **F6**: `ops.js` không dựng lại bảng khi view Vận hành ẩn (vẽ ngay khi mở tab); `server-backup.js` bỏ dựng lại thẻ khi dữ liệu không đổi.
7. **F7**: bỏ `look.css`/`look.js` khỏi `index.html` và `STATIC` (không nơi nào dùng).
Test mới: `test/web-assets.test.js` (nén, header cache, locales, i18n stub, tóm tắt token, sendJson, thứ tự nạp song song).

### Không làm (và lý do)
- **Preload tính năng**: thử `<link rel=preload>` cho 16 tệp, làm FCP lạnh chậm hơn (752 so với 364 ms ở 60 ms RTT), đã bỏ.
- **Service worker cache-first**: không cần, `immutable` đã cho kết quả tương tự; thêm SW là thêm rủi ro cập nhật.
- **Brotli**: trình duyệt không xin `br` trên http thường, và test `http-assets` quy định gzip.
- **Dừng hẳn poll** (`ops/board`, `server-backup/status`, `crewpanes/list`): dữ liệu của chúng còn dùng ở bảng chi tiết phiên, banner sự cố sao lưu và thẻ crew ở Tổng quan, nên dừng sẽ đổi hành vi; chỉ bỏ phần dựng DOM. Nên làm riêng với kiểm chứng hành vi.
- **Lazy xterm/markdown/ops**: xterm được `app.js` dùng đồng bộ ở nhiều nơi, rủi ro cao; để lại.
- **`/api/usage` làm nóng khi khởi động**: nằm ngoài vùng `server.js` được phép sửa.
- F5, F8, F9, F10, F11: chưa làm (lợi ích thấp ở 12 phiên, đụng `app.js`/`lib/parse.js`).
- Ghi chú: `package-update.test.js` (ws pin 8.18.0 != 8.23.0) và các `*-browser.cjs` (ops-tabs, ops-settings, server-backup) đã đỏ từ trước khi sửa (xác nhận trên bản gốc); `opshub-browser.cjs` xanh.
