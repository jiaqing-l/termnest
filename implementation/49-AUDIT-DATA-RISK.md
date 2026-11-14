# 49 - Rà soát rủi ro dữ liệu (read-only)

Ngày: 2026-11-14. Phạm vi: `server.js`, `lib/*`, `lib/features/*`, `packaging/*`, `scripts/*`, `public/features/notes.js`.
Phương pháp: đọc mã + 1 kiểm chứng động trên tmux riêng (`tmux -L twqa2`, đã `kill-server`, không đụng phiên của user). Thư mục dữ liệu thật
(`~/Library/Application Support/Termnest`) chỉ liệt kê tên/kích thước/quyền, không đọc nội dung vault/token.

Quan sát thực tế trên máy: `vault.json` 548 KB; `backups/` 10 bản (cũ nhất 06:46, mới nhất 15:12 cùng ngày, tức cửa sổ khoảng 8,5 giờ);
`server-backups/` 968 MB gồm 3935 `.chunk` + 96 `.manifest` + `catalog.enc` (4030 tệp phẳng, không phải thư mục); `crash.log` quyền 0644;
`token-aggregates.json` 2,9 MB quyền 0600; ổ đĩa còn 69 GiB.

Tóm tắt: Cao 3 · Trung bình 11 · Thấp 10.

---

## CAO

### C1. Sao lưu server giữ theo SỐ bản (32), mỗi 5 phút một bản dù không đổi: cửa sổ lịch sử thật chỉ ~2 giờ 40
- Mã: `lib/server-backup-store.js:174-192` (`commit`: luôn `snapshots.unshift(summary)`, cắt còn `retention`, rồi `gc()` xoá object mồ côi);
  mặc định `intervalMinutes=5`, `retention=32` ở `lib/server-backup-controller.js` (`config()`); `docs/server-backups.md` ghi "Termnest keeps 32 versions".
- Kịch bản: agent hoặc người xoá/ghi đè/cắt cụt một chat `.jsonl` hay file làm việc trên server. 5 phút sau bản sao lưu mới không còn file; sau 32 lần chạy
  (~160 phút) mọi bản cũ chứa nó bị loại và `gc()` xoá chunk. Chỉ "bản complete gần nhất" được giữ thêm, mà bản đó cũng đã chứa trạng thái hỏng. Phát hiện muộn hơn
  ~3 giờ (qua đêm, cuối tuần) thì không còn gì để khôi phục. Máy hiện có 96 manifest cho 3 server, khớp 32 bản/server.
- Sửa: bỏ qua commit khi manifest trùng bản trước (dedupe theo hash danh sách chunk); giữ theo bậc thời gian (vd 12 bản theo giờ + 14 theo ngày + 8 theo tuần)
  thay vì theo số bản; cảnh báo trên UI khi file biến mất giữa hai bản; sửa tài liệu cho đúng.
- Đã an toàn: chunk đặt tên theo HMAC nội dung (dedupe, tốn đĩa ít); ghi atomic (tmp + fsync + rename + fsync thư mục); bản lỗi/rỗng không thay bản cũ; lease chặn `gc`
  khi đang tải/export; mã hoá AES-256-GCM với AAD theo tên.

### C2. Khôi phục sao lưu / "Chuyển máy" ghi đè toàn bộ `vault.data` kể cả `contentKey` của server-backup; bản chụp trước khi ghi đè có thể thất bại âm thầm
- Mã: `server.js:861-880` (`/api/backup/restore`): `vault.copy()` (nuốt mọi lỗi, `lib/vault.js:98-119`) rồi `vault.data = forThisMachine(data)`; không kiểm tra
  `copy` có thật sự ghi được, không đối chiếu `features['server-backup'].contentKey`. Đường first-run `server.js:752-765` cũng `vault.create` với dữ liệu nhập vào.
- Kịch bản: (a) khôi phục file của máy khác hoặc bản cũ trước khi có `contentKey`: kho `server-backups` (968 MB, có thể là bản duy nhất của chat server) không giải mã được
  (`corrupt_store` do `catalog.enc` ký bằng khoá khác, hoặc `key_lost`). Tài liệu nói "không tự reset kho", nên mọi tick báo lỗi, không ghi bản mới, không có UI để xử lý.
  (b) Ổ đầy / thư mục `backups/` không ghi được: `copy()` im lặng thất bại, vẫn ghi đè dữ liệu hiện tại, mất danh sách server/ghi chú/phiên đã biết. (c) Bản chụp tiền-khôi-phục
  nằm trong 10 bản xoay vòng (xem C3), vài lần lưu/khởi động sau sẽ bị đẩy ra.
- Sửa: dùng `forceVaultBackup` kiểu `lib/features.js:47-55` (kiểm lại bản vừa chép giải mã được và khớp) làm điều kiện bắt buộc, huỷ khôi phục nếu lỗi; giữ bản
  tiền-khôi-phục tên riêng (`vault-prerestore-<ts>.json`) ngoài vòng xoay; giữ `contentKey` hiện có nếu kho tại chỗ tồn tại (hoặc cảnh báo rõ trước khi thay);
  validate `data.prefs/features/known` thay vì chỉ `Array.isArray(data.servers)`.
- Đã an toàn: restore yêu cầu phiên đăng nhập + mật khẩu của file; chat đến sau được mã hoá bằng khoá vault (`keepIncoming`, `INCOMING_FILE` ghi tmp+rename);
  `placeIncoming` không ghi đè chat đang có (`link` độc quyền ở `lib/features/move.js:204-210`).

### C3. Vòng xoay sao lưu vault chỉ 10 bản và dễ bị "quét sạch" bởi khởi động lại / khôi phục; vault là điểm hỏng duy nhất của khoá SSH do Termnest sinh
- Mã: `lib/vault.js:40` (`KEEP=10`), `:81` (`copyNext=true` mỗi lần unlock thành công), `:91-95` (một bản mỗi 15 phút-24 giờ, mặc định 1 giờ), `:106` xoá bản cũ,
  `:68-85` unlock chỉ thử các bản trong `backups/`.
- Kịch bản: (1) Supervisor/dịch vụ có `TW_PASSWORD_FILE` bị crash-loop (`lib/crash-guard.js:25-29` thoát `exit(1)` cho mọi lỗi không phải mạng): mỗi lần mở lại sinh một bản,
  10 lần là hết mọi bản lành, tất cả đều chứa trạng thái hỏng. (2) Người dùng chọn 15 phút thì 10 bản chỉ phủ 2,5 giờ. (3) Nếu `vault.json` bị xoá nhầm, UI về màn
  thiết lập lần đầu (`server.js:766-780` `vault.create` không nhìn `backups/`); các bản cũ mã hoá bằng mật khẩu cũ vẫn chiếm 10 chỗ và bị đẩy ra sau ~10 giờ chạy.
  (4) Khoá SSH tạo bởi "newkey" chỉ tồn tại trong vault (`server.js:383-440`), mất vault = mất đường vào server (khoá công khai vẫn nằm trên server).
- Sửa: giữ bản theo bậc (vd 10 theo giờ + 7 theo ngày + 4 theo tuần), không chép khi nội dung giống bản trước, không tính chép-khi-khởi-động vào `KEEP`;
  khi vault thiếu mà `backups/` còn thì hỏi khôi phục thay vì tạo mới; khuyến nghị/nhắc bật thư mục sao lưu ngoài (đã có `extraDir`).
- Đã an toàn: `writeAtomic` (`lib/vault.js:30-37`) = tmp theo PID + `fsync` + `rename` + `fsync` thư mục, quyền 0600/0700; một tiến trình duy nhất sửa vault trong JS
  đơn luồng nên không có ghi chồng; hỏng thì thử bản sao và giữ `vault.json.damaged-<ts>` (`:76-80`).

---

## TRUNG BÌNH

### T1. Gỡ server là không đảo ngược và không chụp vault trước
- Mã: `server.js:444-455` (`removeServer`): xoá cấu hình (gồm khoá riêng, passphrase), `known[id]` (danh sách phiên để khôi phục), lịch sử; không gọi `vault.copy()`.
- Kịch bản: bấm nhầm "Gỡ" (chỉ có hộp thoại xác nhận phía trình duyệt, `public/app.js:1585`). Khoá do Termnest sinh biến mất vĩnh viễn, thêm lại sẽ là UUID mới, mất
  liên kết với bản sao lưu server (`server-backups` vẫn giữ theo `serverId` cũ nhưng không còn cấu hình để quét tiếp). Server-backup của server đó bị loại khỏi cấu hình tự động.
- Sửa: `vault.copy()` bắt buộc trước khi xoá; hoặc cho "gỡ" thành trạng thái ẩn 7 ngày; yêu cầu gõ tên server (như `reboot`); xuất khoá riêng trước.
- Đã an toàn: không xoá gì trên server; bản sao server-backup được giữ (`docs/server-backups.md`).

### T2. Kho server-backup có thể tự khoá chết (quota) và dừng vì một tệp lạ
- Mã: `lib/server-backup-store.js:86` (`usage()` ném `quota` ngay trong constructor khi >10 GiB), `:77-81` (`names()` ném `quota` khi >100000 đối tượng),
  `:84` (`stat()` ném `unsafe_store` nếu quyền/owner khác), `:280-284` (`gc()` ném `unsafe_store` với tên không khớp mẫu).
- Kịch bản: (a) Kho chạm trần: `begin()` gọi `gc()` rồi `usage()` ném `quota`; việc cắt retention chỉ diễn ra trong `commit` nên không bao giờ tới; mở/xem/tải bản cũ cũng
  thất bại vì constructor ném. (b) Finder/Explorer tạo `.DS_Store`/`Thumbs.db` (quyền 0644) trong `server-backups/`, hoặc người dùng thả tệp vào: `openStore` ném `unsafe_store`,
  mọi bản sao lưu dừng, không tự phục hồi. (c) Đĩa đầy trong lúc ghi: lỗi `ENOSPC` được báo `quota` và tmp bị dọn (an toàn), nhưng retention không giải phóng chỗ.
- Sửa: cho constructor mở chế độ chỉ-đọc khi quá hạn mức; cho phép cắt retention/xoá bản qua API khi `quota`; `gc()` bỏ qua (không ném) tệp lạ và ghi cảnh báo; cảnh báo từ 80% hạn mức.

### T3. Ghi chú: mỗi lần lưu thay toàn bộ tài liệu (last-writer-wins) và cắt xén im lặng
- Mã: `lib/features/notes.js:63-67` (`PUT /data` thay cả doc), `:15-18` (`clean()` cắt còn 200 ghi chú, 200000 ký tự/ghi chú, 120 ký tự tiêu đề, 300 nhắc),
  `public/features/notes.js:28-37` (khách giữ bản làm việc, có cờ `loaded`).
- Kịch bản: mở Termnest trên 2 thiết bị (desktop + điện thoại qua Tailscale) hoặc 2 tab; thiết bị có bản cũ lưu sau sẽ xoá ghi chú tạo ở thiết bị kia. Ghi chú thứ 201 và phần
  vượt giới hạn bị bỏ không báo. Ghi chú nằm trong vault nên chỉ được bảo vệ bởi 10 bản ở C3. Ngoài ra `readJson` mặc định 256 KB (`server.js:211`) nhỏ hơn `MAX_BODY` 1,5 MB của notes:
  doc >256 KB trả "bad json", không lưu được (người dùng thấy "Chưa lưu được" nhưng bản làm việc vẫn chỉ ở trình duyệt).
- Sửa: kèm `updatedAt/rev` mỗi ghi chú và hợp nhất theo id; từ chối PUT nếu `rev` cũ; báo khi cắt; truyền `limit` đúng cho `readJson`.
- Đã an toàn: client chặn lưu khi chưa tải xong (`loaded=false`); "Nối vào tệp" chỉ nối vào tệp `.md/.txt` đã tồn tại, `O_APPEND|O_NOFOLLOW`, realpath nằm trong thư mục phiên (`notes.js:35-57`).

### T4. Thao tác tệp (đổi tên/thùng rác/tạo/nối) tính thư mục gốc theo thư mục HIỆN TẠI của pane mỗi lần gọi
- Mã: `lib/file-viewer.js` `sessionCwd` (`tmux display-message #{pane_current_path}`), dùng bởi `lib/features/browse.js` `fsop` (`:~330`) và `notes.js:73`;
  đường dẫn từ UI là tương đối so với gốc đó (`browse.js:92-93` `entry()`).
- Kịch bản: UI liệt kê thư mục A, người dùng (hoặc agent) `cd B` trong pane, rồi bấm Đổi tên/Thùng rác một mục tên `README.md`: thao tác rơi vào `B/README.md`. Nếu cwd là `$HOME`
  hoặc `/`, phạm vi "an toàn trong thư mục phiên" là cả thư mục home. Ngoài ra `rename` kiểm `exists()` rồi `rename()` (`browse.js:129-132`): giữa hai bước, tệp mới tạo cùng tên bị
  ghi đè (POSIX `rename` thay thế); tương tự `restore` (`:162-164`).
- Sửa: UI gửi kèm `root` (đường dẫn tuyệt đối đã hiển thị) và server từ chối nếu cwd hiện tại khác; dùng `link()`+`unlink()` hoặc `renameat2(RENAME_NOREPLACE)`-tương đương; từ chối gốc là `$HOME`/`/`.
- Đã an toàn: `realpath` từng bước, chặn thoát khỏi gốc/symlink, không đụng chính gốc và `.termnest-trash`, tên cấm ký tự điều khiển; thùng rác thay vì xoá vĩnh viễn; `purge/empty/expire` chỉ chạm
  ô có `info.json` do Termnest tạo (`ownSlot`); `create` dùng `wx`.

### T5. Thùng rác nằm TRONG thư mục dự án, không được sao lưu, mặc định giữ mãi
- Mã: `lib/features/browse.js:135-143` (trash), `:283-292` (`CLEANUP_DEFAULT = { tempDays: 1, trashDays: 0 }`), `:386-399` (quét mỗi giờ), `lib/server-backup-source.js:5`
  (`.termnest-trash` nằm trong `EXCLUSIONS`).
- Kịch bản: tệp bị chuyển vào thùng rác không còn trong bản sao lưu server (bị loại trừ) và biến mất khỏi bản chụp sau ≤32 lần chạy (C1), nên thùng rác là bản duy nhất.
  `git clean -fdx`, `crew-task janitor` gỡ worktree, `rm -rf` dự án đều xoá luôn thùng rác. Nếu tiến trình chết giữa `rename` và ghi `info.json` (`:141-142`), ô không có `info.json`
  không bao giờ hiện trong danh sách và không bao giờ bị dọn (`ownSlot`, `list` bỏ qua). `trashDays=0` thì phình mãi trên server từ xa; ngược lại đặt 7 ngày thì `expire` xoá theo `at`;
  `info.json` hỏng cho `at=0` sẽ bị coi là "rất cũ" và xoá ngay (`:177-180`).
- Sửa: ghi `info.json` trước, rename sau (hoặc rename kèm tên chứa metadata); đưa thùng rác vào sao lưu hoặc dùng thư mục trash tập trung theo người dùng (`~/.local/share/Trash` kiểu XDG,
  trên macOS `~/.Trash`); khi `at` không đọc được thì bỏ qua thay vì xoá.

### T6. Ổ đầy khi lưu vault không được xử lý; trạng thái trong RAM và trên đĩa lệch nhau âm thầm
- Mã: `lib/vault.js:30-37` (khi `writeSync` ném `ENOSPC`, tệp `vault.json.<pid>.tmp` dở dang không bị xoá), `server.js:239-259` (`onPoll` gọi `saveVault()` mỗi lần poll, mọi ngoại lệ trở thành
  `unhandledRejection` bị `crash-guard` ghi nhật ký và "continued", `lib/crash-guard.js:24`), `:105-108 copy()` nuốt lỗi.
- Kịch bản: đĩa đầy: vault không lưu được liên tục, người dùng vẫn thêm server/sửa ghi chú trong RAM, tắt máy là mất; không có cảnh báo UI. Các tệp `*.tmp` 550 KB xếp chồng theo PID.
- Sửa: bọc `save()` trả trạng thái lỗi để UI hiện banner "Không lưu được dữ liệu"; xoá tmp khi lỗi; dọn `*.tmp` mồ côi lúc khởi động; ngưỡng đĩa trống tối thiểu trước khi chụp.
- Ghi chú liên quan: `saveVault()` chạy mỗi chu kỳ poll (3 giây khi UI hoạt động, mỗi server) ghi lại ~550 KB + 2 lần fsync: mài mòn SSD và mở rộng cửa sổ lỗi; nên chỉ lưu khi dữ liệu đổi.

### T7. `scripts/set-password.js` bỏ qua `service.lock` và bị app đang chạy ghi đè lại mật khẩu cũ
- Mã: `scripts/set-password.js:26-38` (`new Vault(...).create(a, data)` không gọi `acquireDataLock`), tiến trình chạy giữ khoá cũ trong RAM và `saveVault()` mỗi poll.
- Kịch bản: đổi mật khẩu bằng CLI khi app đang mở: vài giây sau app ghi lại `vault.json` bằng khoá/salt cũ (mật khẩu đổi bị hoàn tác, người dùng tưởng đã đổi). Nếu chiều ngược
  (CLI ghi sau app) thì `contentKey` vẫn bảo toàn nhưng app đang chạy sẽ ghi đè lần kế. Các bản sao cũ vẫn mở được bằng mật khẩu CŨ: nếu đổi mật khẩu vì nghi lộ, 10 bản
  trong `backups/` và các bản trong thư mục sao lưu ngoài vẫn giải mã được bằng mật khẩu bị lộ.
- Sửa: lấy `acquireDataLock` trong script (từ chối khi đang chạy); sau khi đổi, tạo lại toàn bộ bản sao bằng khoá mới và xoá bản cũ.

### T8. Lệnh `window-size latest` lúc attach: không hề có tác dụng trên tmux 3.7b (đã kiểm chứng), và nếu sửa đúng thì ảnh hưởng mọi client của phiên
- Mã: `lib/local.js:142` và `lib/remote.js:124`: `tmux set-option -q -t '=<name>' window-size latest`.
- Kiểm chứng động (tmux 3.7b, server riêng): `tmux set-option -t '=a' window-size latest` trả `no such window: =a` (rc=1); `-q` che lỗi nên không ai thấy. Dạng `-t '=a:'` mới thành công
  (`show-options -t a window-size` = `latest`) và chỉ đổi phiên `a`, không đổi toàn cục hay phiên `b`.
- Hệ quả dữ liệu: (1) không mất dữ liệu; lỗi chức năng: lệnh vô hiệu nên vấn đề "hai người xem làm phiên co lại / chấm chấm" vẫn xảy ra trên tmux mới. (2) Khi sửa thành `=name:`, tuỳ chọn
  được đặt ở mức PHIÊN, lưu trong bộ nhớ tmux server (không ghi đĩa, mất khi tmux server khởi động lại, không sửa `~/.tmux.conf`), nhưng áp dụng cho MỌI client gắn vào phiên đó, kể cả terminal
  riêng của người dùng, và đè lên cấu hình `window-size smallest/manual` mà họ chủ ý đặt. (3) `this.sized` của local (`lib/local.js:139`) không bao giờ xoá: phiên bị kill rồi tạo lại cùng tên
  sẽ không được đặt lại tuỳ chọn.
- Sửa: dùng `-t '=name:'` (hoặc `-w -t`), bỏ `-q` để ghi log khi lỗi; cân nhắc `tmux attach-session -f ignore-size` hoặc `window-size` chỉ khi người dùng bật; xoá `sized` khi phiên biến mất.
- Đã an toàn: attach không dùng `-d`, không ngắt client khác; đóng WebSocket chỉ `terminal.kill()` client gắn (phiên tmux vẫn chạy).

### T9. Hai tiến trình / khoá dữ liệu: an toàn nhưng có điểm kẹt
- Mã: `lib/service-runtime.js:255-300` (`acquireDataLock`), `lib/app-instance.js`.
- Đã an toàn: trọng tài là một cổng loopback độc quyền (49152+) cộng `service.lock` ghi tmp-free bằng `wx` + fsync, xác minh PID+identity, không bao giờ xoá khoá không rõ chủ;
  bản thứ hai thoát `RUNTIME_ALREADY_RUNNING` trước khi mở vault. Hai app Termnest cùng DATA không thể cùng ghi vault.
- Rủi ro còn lại: (a) `service.lock` bị cắt cụt (đĩa đầy) hoặc cổng arbiter bị phần mềm khác chiếm hết 32 cổng: `RUNTIME_LOCK_UNCERTAIN`, app không khởi động và không có đường xử lý trong UI
  ngoài xoá tay. (b) Các bước trước khi lấy khoá chạy trước: `crash-guard.install(DATA)` và `new TokenCache({dataDir})` ở `server.js:31-32` (khởi tạo trước `boot()`); bản thứ hai không bị chặn ghi
  `crash.log` nhưng không ghi vault. (c) `scripts/set-password.js` (T7) không dùng khoá.

### T10. Gói cập nhật: ghi đè thư mục app, không chạm DATA khi DATA nằm ngoài, nhưng chạy từ nguồn thì DATA mặc định nằm TRONG app
- Mã: `scripts/package-update.js:9-17` (`roots` và `safeEntry` loại `data|vault|credentials|secrets|node_modules|implementation`, tệp nhị phân, dotfile, symlink; `lib/vault.js` được phép), `server.js:30`
  (`DATA = TW_DATA || <repo>/data`), `packaging/launcher.js:8-12` (macOS `~/Library/Application Support/Termnest`, Windows `%APPDATA%\Termnest`, Linux `~/.tmux-web`; bản cũ `Tmux Dev` được di chuyển bằng khoá
  và `rename`, không ghi đè đích tồn tại), `scripts/install-supervisor*.sh/.ps1` (Linux `${XDG_STATE_HOME:-~/.local/state}/termnest`, macOS Application Support).
- Kịch bản: giải nén `.tar.gz` đè thư mục app là phủ lên chứ không xoá tệp thừa; `scripts/` do người dùng sửa (unit supervisor) bị ghi đè; SHA256 chỉ là tệp đi kèm, không chữ ký. Nếu chạy `node server.js`
  không đặt `TW_DATA`, vault nằm trong `<repo>/data` (đã tồn tại, 134 byte): `git clean -fdx`, xoá/clone lại repo hoặc `rsync --delete` mất vault (đối với repo này không phải git nhưng mô hình nguy hiểm).
  Windows: `%APPDATA%` là Roaming, kho `server-backups` (tới 10 GiB) và `app-profile` có thể bị đồng bộ qua roaming profile/OneDrive KFM; quyền 0600/0700 bị bỏ qua, phụ thuộc ACL kế thừa
  (chỉ kiểm khi dùng `TW_PASSWORD_FILE`).
- Sửa: mặc định DATA ra ngoài cây mã (giống launcher) và cảnh báo khi DATA nằm trong thư mục app; Windows dùng `%LOCALAPPDATA%` cho kho lớn; cập nhật bằng cách giải nén ra thư mục mới rồi đổi tên.

### T11. Tệp xuất "Chuyển máy" và bản sao: mã hoá tốt, nhưng bị ghi đè cùng phút và rò rỉ qua mật khẩu cũ
- Mã: `server.js:886-895` (`fs.writeFileSync(file, text, { mode: 0o600 })` không `wx`; tên `TERMNEST-chuyen-may-YYYY-MM-DD-HHmm.termnest` độ phân giải 1 phút, mặc định ra Desktop/Downloads có thể được đồng bộ
  lên đám mây), `lib/vault.js:128-131` (`Vault.pack`: scrypt N=2^15 + AES-256-GCM, mật khẩu = mật khẩu vault đã xác nhận bằng `vault.check`).
- Kịch bản: hai lần xuất trong cùng phút ghi đè nhau (nếu lần sau lỗi giữa chừng thì tệp cũ bị cắt cụt vì không ghi tmp+rename). Tệp chứa toàn bộ vault (khoá SSH) + chat; độ mạnh chỉ bằng mật khẩu vault
  (tối thiểu 10 ký tự); đổi mật khẩu sau đó không thu hồi các tệp đã xuất.
- Sửa: ghi tmp rồi `rename`, thêm giây/hậu tố ngẫu nhiên; nhắc xoá tệp sau khi chuyển.

---

## THẤP

- L1. `lib/features/crewpanes.js:95-98` (tạo Crew lỗi thì `stop` MỌI tên gồm cả `name`): nếu một phiên cùng tên xuất hiện giữa lúc kiểm `taken` (snapshot cũ ≤3 giây) và `start` (trả `EXISTS 409`), nhánh `catch`
  kill luôn phiên có sẵn của người dùng; `:125` (`/stop`) kill theo tên đã lưu, tên có thể đã được tái dùng. Tính năng chỉ chạy khi `TW_CREW_DEMO=1` (`:78`) nên rủi ro thấp. Sửa: chỉ stop những tên thực sự do lần gọi này tạo.
- L2. "Gửi tệp" (`lib/features/drop.js:38-41`, `browse.js:196-219`): thư mục `${TMPDIR:-/tmp}/termnest-drop-<uid>` có tên đoán trước; `mkdir -p && chmod 700` theo symlink nếu người khác tạo sẵn trên máy dùng chung
  (chmod đổi quyền thư mục đích, tệp có thể rơi vào nơi do kẻ khác kiểm soát). Mặc định `tempDays=1`: mỗi lần tải lên cũng `find -mtime +0 -delete` mọi tệp >1 ngày, tệp đã tham chiếu trong chat cũ sẽ biến mất.
  Tải lên đứt SSH giữa chừng để lại tệp dở (`cat >`) không ai dọn tới hạn. Sửa: dùng `mktemp -d` + `chown/lstat` kiểm owner, tạo thư mục bằng `mkdir` không `-p` và từ chối symlink.
- L3. Nhật ký sự cố: `lib/crash-guard.js:21` ghi `crash.log` bằng `appendFileSync` không đặt quyền: thực tế `-rw-r--r--` (0644) trong thư mục 0700 nên không lộ cho người dùng khác, nhưng chứa stack/đường dẫn/host
  và sẽ lộ nếu thư mục bị nới quyền hay đồng bộ. `unhandledRejection` luôn "continued" (`:24`) nên lỗi lưu vault/backup (T6) bị chôn. `uncaughtException` không phải mạng thì `exit(1)` ngay: không `saveHistory`, `tokenCache.close`,
  WebSocket đứt; tmux không bị ảnh hưởng (client attach bị kill, phiên sống). Sửa: `mode: 0o600`, và gọi `shutdown()` ngắn gọn (lưu lịch sử) trước khi thoát.
- L4. Dữ liệu dẫn xuất không mã hoá: `token-aggregates.json` (2,9 MB, chứa email/nickname tài khoản AI, 0600), `history.json` (0600), `token-scan-cache/` (0700), `app-profile/` (158 MB WebView). `lib/token-cache.js:28` và
  `lib/tokens.js:133` ghi tmp+rename không fsync (chấp nhận được vì dựng lại được). Rủi ro: đồng bộ/sao lưu thư mục dữ liệu bằng công cụ ngoài làm lộ email. Đã an toàn: vault và server-backups mã hoá; chat/khoá nằm trong blob GCM.
- L5. `lib/move-files.js:100-117` (chép tệp liên quan khi chuyển phiên): ghi tmp `.termnest-<pid>` rồi rename (tốt) và giữ bản `.truoc-chuyen-<stamp>` của tệp khác nội dung (tốt), nhưng các tệp `.truoc-chuyen-*` và tmp
  mồ côi nằm lẫn trong repo người dùng (hiện thành tệp untracked), không fsync, `mkdirSync recursive` đi qua symlink thư mục con bên trong gốc.
- L6. Quy trình con/tiến trình mồ côi: token scan chạy bằng `worker_threads` (`lib/token-cache.js:42`, `terminate` khi đóng/nhàn rỗi 30 giây) nên không mồ côi. `runOnHost` qua SSH hết hạn thì chỉ `stream.close()`
  (`lib/remote.js` `exec`); `node -e` ở xa không có pty, `find` lập chỉ mục (`file-viewer.js`, `browse.js:243`) có thể chạy tiếp tới khi stdout đóng. Nguồn sao lưu (`server-backup-source.js:112`) thoát khi stdin kết thúc (tốt).
  Local `terminal.kill()` chỉ giết client attach. Rủi ro thấp: tốn CPU/RAM máy chủ khi SSH chập chờn.
- L7. Đứt SSH giữa lúc ghi: các thao tác ghi tệp trên host (`create` ≤200 KB `wx`, `append` ≤60 KB một `write`) ngắn nên hầu như nguyên tử; `create` có thể để lại tệp rỗng/ dở nếu đứt đúng lúc (người dùng không thấy phản hồi).
  Bản chuyển chat dùng tmp `.move-*` + `link` độc quyền + kiểm SHA (an toàn). Gỡ/ghi vault là cục bộ nên không bị ảnh hưởng.
- L8. `.damaged-<ts>` (`lib/vault.js:78`) và tệp `vault.json.<pid>.tmp` không có chính sách dọn, tích tụ chậm. Mỗi lần mở thư mục dữ liệu qua Finder tạo `.DS_Store` (đã có ở gốc DATA; vô hại, nhưng xem T2 nếu vào `server-backups`).
- L9. Dừng phiên (`server.js:627-649`, `public/app.js:1578`): kill theo khớp chính xác `=name`, có hộp xác nhận ở UI, kiểm Origin cho non-GET (`server.js:~1068`), xoá bản ghi `known` để không bị "khôi phục". API phía server không yêu cầu mật khẩu/xác nhận thứ hai
  nên script có phiên hợp lệ giết được mọi phiên (chấp nhận được với mô hình tin cậy hiện tại). Nhánh `kill-session` khi khởi chạy Claude/Codex thất bại (`server.js:603,611`) chỉ chạm phiên vừa tạo (có `has-session` chặn từ trước): an toàn.
  `reboot` yêu cầu gõ đúng tên + `rebootRequired` + sudo không mật khẩu (`lib/reboot.js`): an toàn.
- L10. Tệp Linux/Windows/macOS: Linux launcher dùng `~/.tmux-web` (tên cũ, không theo XDG) trong khi supervisor dùng `$XDG_STATE_HOME/termnest`: hai tiến trình khác DATA, người dùng có thể có hai vault khác nhau mà không biết. Chỉ liệt kê, không phải lỗi mất dữ liệu.

---

## Danh sách "đã an toàn" (đã kiểm)
- Vault: AES-256-GCM, khoá dẫn xuất scrypt (N=2^15) giữ trong RAM; ghi atomic có fsync tệp + thư mục; bản hỏng tự phục hồi từ bản sao; `service.lock` + trọng tài cổng + xác minh PID chống hai bản chạy.
- Server-backup: mã hoá toàn bộ (kể cả manifest/catalog), tên chunk là HMAC, ghi tmp+rename+fsync, kiểm identity/owner/mode/nlink chống symlink, giới hạn kích thước/số lượng, lease khi tải xuống, vé tải một lần 120 giây;
  không ghi đè bất cứ thứ gì trên server nguồn (chỉ đọc); loại `.ssh/.aws/.gnupg/.kube/.config/.claude*/.codex*` khỏi phạm vi chọn.
- Duyệt tệp: mọi đường dẫn qua `realpath` và phải nằm trong thư mục phiên; tạo bằng `wx`; thùng rác thay vì xoá vĩnh viễn; xoá vĩnh viễn chỉ ô do Termnest tạo và theo từng mục.
- Chuyển chat giữa máy: SHA, kiểm "nguồn không đổi" hai lần trước khi dừng nguồn, `link` độc quyền, không ghi đè chat có sẵn.
- Dữ liệu từ ngoài vào qua `forThisMachine` loại `known[LOCAL_ID]`; `/api/setup` chỉ khi chưa có vault, cần `TW_SETUP_TOKEN` so sánh timing-safe.
- Cập nhật `package-update.js`: loại `data/`, `vault*`, khoá/bí mật, tệp thực thi, symlink; kiểm nội dung sau khi nén.

## Thứ tự ưu tiên đề xuất
1. C1 (cửa sổ sao lưu server 2 giờ 40) + C3 (vòng xoay vault 10 bản): sửa chính sách retention hai nơi.
2. C2: bắt buộc chụp có kiểm chứng + bảo toàn `contentKey` khi khôi phục.
3. T1, T6, T7: chụp trước khi gỡ server; xử lý ổ đầy; khoá `set-password`.
4. T2, T5, T4: hạn mức/gc kho sao lưu, thùng rác an toàn hơn, gốc thao tác tệp cố định.
5. T8: sửa `-t '=name:'` (lỗi chức năng đã tái hiện) kèm cân nhắc tác động tới client khác.

---

## Đã xử lý (phiên sửa lỗi, 2026-11-14)

- C1: sao lưu server bỏ qua khi cây không đổi (so chữ ký nội dung HMAC của đường dẫn+kích thước+chunk); giữ theo bậc: 32 bản mới nhất + bản mới nhất mỗi giờ (24 giờ) + mỗi ngày (14 ngày), tối đa 100; bản đầy đủ gần nhất vẫn được giữ. `docs/server-backups.md` đã sửa. (`lib/server-backup-store.js`)
- C2: khôi phục chụp `vault.snapshot('prerestore')` có KIỂM LẠI (giải mã + so khớp), thất bại thì hủy và không đổi dữ liệu; bản chụp nằm ngoài vòng xoay (giữ 5); giữ `contentKey` của server-backup hiện có để kho cũ vẫn giải mã được; kiểm `prefs/features/known` là object (cả đường first-run).
- C3: vault giữ theo bậc (10 mới nhất + 14 ngày + 4 tuần, tối đa 28 file, cả thư mục phụ), không chép khi dữ liệu y hệt bản trước (mở lại cùng dữ liệu không tạo bản mới nên crash-loop không quét sạch); khi `vault.json` mất mà `backups/` còn: log lúc khởi động + cờ `vaultCopiesFound` ở `/api/status` (không tự khôi phục; đăng nhập bằng mật khẩu cũ vẫn khôi phục bản mới nhất như trước).
- T1: gỡ server chụp `vault.snapshot('preremove')` có kiểm chứng trước, lỗi thì không gỡ.
- T2 (một phần): `gc()`/`usage()` bỏ qua tệp lạ (`.DS_Store`, `Thumbs.db`), không ném `unsafe_store`, không xóa.
- T6 (một phần): `writeAtomic` xóa tệp `.tmp` khi lỗi (ổ đầy).
- T7: `scripts/set-password.js` lấy `service.lock` (từ chối khi app đang chạy), sau khi đổi xóa các bản sao cục bộ còn mật khẩu cũ.
- T8: lệnh tmux đổi thành `-t '=name:'`, bỏ `-q`, chỉ áp khi phiên chưa đặt `window-size` và global khác `manual`; vẫn một lệnh attach duy nhất (remote.js, local.js, `windowSizeCmd` ở backend.js); đã kiểm với tmux thật `-L twqa`.
- L2 (thư mục drop an toàn), L3 (`crash.log` 0600).

## Chưa xử lý + lý do

- T2 (chế độ chỉ-đọc khi quota, cắt retention qua API), T3 (ghi chú last-writer-wins), T4 (gốc thao tác tệp cố định), T5 (thùng rác), T9, T10, T11 (tên tệp xuất trùng phút): thay đổi hành vi/UI hoặc cần quyết định sản phẩm, để đợt sau.
- T6 phần banner UI "Không lưu được dữ liệu" và chỉ lưu khi dữ liệu đổi: đụng luồng poll/UI.
- T8 mục (3) `this.sized` của local không xóa khi phiên bị kill: lệnh vẫn đúng, chỉ không đặt lại tùy chọn cho phiên tạo lại cùng tên.
- L1, L4, L5, L6, L7, L9, L10: không thuộc phạm vi sửa rẻ.
