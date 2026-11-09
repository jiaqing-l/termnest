# 38 — Orchestrator, worker, crew session và "ông trùm" ops-audit là gì

> 07/11/2026 17:40 · Viết theo skill `xspire-crew`, `xspire-crew-ops-audit` (devkit 0.6.8) và tệp `_crew` thật trên máy Mac.

## 1. Bốn khái niệm, nói ngắn

| Tên | Thực chất là gì | Nhìn thấy ở đâu |
|---|---|---|
| **Orchestrator (leader)** | Một phiên **Claude trong tmux** mà bạn bảo nó điều phối một việc bằng skill `xspire-crew` (`/xspire-crew new "…"`). Nó lập kế hoạch, chia việc thành các **track** (W1, W2…), giao cho worker, kiểm kết quả, sửa vòng, rồi gộp nhánh. **Nó không tự viết code.** | Một thẻ phiên trong TERMNEST (ví dụ SFA-B4), thường là Claude |
| **Worker** | Tiến trình **chạy ngầm, không có terminal riêng**: `codex exec …` hoặc `claude -p …`. Do orchestrator gọi qua `crew-dispatch.sh`, mỗi worker làm một track trong một worktree riêng (`_wt-<task>-W1`). | TERMNEST đã thấy dạng "worker Crew" gắn dưới phiên leader |
| **Task / track** | Một **task** = một việc lớn (`_crew/tasks/<id>/MANIFEST.md`); chia ra nhiều **track** = phần việc giao cho từng worker (`tracks/W1/…`, `ROUNDS.tsv` = các vòng làm / sửa) | Gói Xspire Crew → bảng "Tất cả task" |
| **Crew session** | Chính là **phiên orchestrator đang chạy một task**. Lúc tạo task, crew kit ghi `<pane tmux> <task>` vào `_crew/nudge.conf`. Nhờ đó crew-nudge (và TERMNEST) biết phiên nào đang lo task nào | Cột "đăng ký nhắc" ở gói Crew |

**Mỗi phiên bạn tạo có phải orchestrator không?** **Không.** Phiên chỉ thành orchestrator khi trong đó bạn chạy `/xspire-crew` (tạo / tiếp tục một task). Lúc đó pane của phiên được ghi vào `nudge.conf`. Phiên thường để bạn hỏi đáp hay sửa code trực tiếp thì không phải orchestrator.

Kiểm thật lúc 17:40:
- **Máy Mac:** `nudge.conf` có **0 dòng**, tức hiện **không có orchestrator nào chạy** trên máy này. 93 task trong 14 ngày là của các lượt chạy trước, phần lớn đã xong hoặc đã dừng.
- **dev-ubuntu-02:** có **1 phiên đăng ký**, tức là có 1 orchestrator đang lo 1 task.

## 2. Mô hình sếp nói, vẽ ra

```
VM dev-ubuntu-02 (cấu hình cho 2–3 orchestrator)
 ├─ Phiên SFA-B4  = orchestrator ── task "SFA đơn hàng"   ── W1 (codex exec) · W2 (codex exec) · W3 (claude -p)
 ├─ Phiên MGR-A   = orchestrator ── task "Manager KPI"    ── W1 · W2
 └─ Phiên DEX-1   = orchestrator ── task "DEX giao hàng"  ── W1 · W2 · W3
VM dev-ubuntu-03 … tương tự
⇒ 2–3 VM × 2–3 orchestrator = 6–9 "team"; mỗi team có vài worker ⇒ vài chục "member"
```

**Vì sao hay bị dừng / chờ:**
- Orchestrator làm xong một lượt rồi đứng chờ mà quên hẹn giờ quay lại (không bật `crew-watch --heartbeat`).
- Đang chờ bạn duyệt một câu hỏi.
- Track hết số vòng sửa cho phép.
- Chờ slot DB hoặc MR.
- Hết quota.
- Model chọn sai, máy quá tải…

## 3. "Ông trùm" = skill `xspire-crew-ops-audit`

Đây **không phải** một orchestrator. Nó là một phiên Claude đứng trên tất cả. Theo SKILL.md, nó:
1. **Chụp mọi máy crew:** mọi phiên, công cụ, model, đang làm / rảnh, câu hỏi đang chờ; task của từng phiên lấy từ `nudge.conf`; trạng thái track, số vòng; worktree, đĩa, tải; phiên bản crew và devkit.
2. **Đối chiếu với danh sách kiểm tra:** phiên ngủ quên, chia việc kém, chọn sai model, lãng phí worktree / CI / API, lỗi và lệch của crew / devkit, GitLab.
3. **Đề xuất cách sửa và chỉ làm khi chủ duyệt.** Mặc định chỉ đọc, không tự sửa.

Sếp nói "từ lúc có ông trùm thì mọi crew session luôn xanh" vì ông trùm chạy định kỳ, ví dụ ngày 2 lần, để tìm phiên kẹt và chỉ ra việc cần làm ngay.

## 4. TERMNEST đứng ở đâu trong mô hình này

| Việc | Ông trùm ops-audit (Claude, tốn token) | TERMNEST (không tốn token, liên tục) |
|---|---|---|
| Thấy mọi phiên, trạng thái thật | khi chạy | **liên tục mỗi vài giây** |
| Leader ngủ quên, track lỗi, hết vòng, thiếu heartbeat | khi chạy | **liên tục** (gói Xspire Crew) |
| Nhắc leader chạy tiếp | đề xuất | **một chạm hoặc tự động có giới hạn** |
| Tìm gốc vì sao kẹt, đề xuất sửa crew / devkit | **có** (suy luận) | không: gọi ông trùm |
| Gọi ông trùm | — | **nút + lịch** |

⇒ TERMNEST là "người trực" đo cơ học suốt ngày đêm; ông trùm là "chuyên gia" được gọi khi cần suy luận.

## 5. Các ý mới đạt "một phần": làm thêm được gì ngay trong TERMNEST

| Ý | Làm thêm được | Nguồn dữ kiện | Giới hạn |
|---|---|---|---|
| Leader điều phối nhiều worker | **Bảng theo orchestrator:** mỗi phiên leader → task → các track (trạng thái, vòng, worker nào đang chạy, chạy bao lâu) | `nudge.conf` + MANIFEST + ROUNDS + worker TERMNEST đã thấy | — |
| Chờ việc ngoài (MR, slot DB) | Đọc trạng thái chờ của crew-upstream (`_crew/watch/upstream-*.json`) và lease đang giữ | tệp crew | Trạng thái MR trên GitLab cần token GitLab: không đưa vào lõi |
| Quota | Gợi ý **tài khoản còn nhiều lượt nhất**, kèm % còn lại | số đo Token AI sẵn có | Chỉ gợi ý; không tự đổi tài khoản của phiên |
| Tìm gốc | Hiện **báo cáo ông trùm** thành phiếu, nếu skill ghi ra tệp cố định | tệp skill ghi | Cần kiểm skill ghi báo cáo ở đâu (`references/`) |
| Phiên bản crew kit giữa VM | So **commit của `scripts/crew`** trên từng máy (Mac đang ở `273abfd`, 03/11) | `git -C scripts/crew log -1` | — |
| (bước 2 còn lại) Ghi lệnh khởi chạy | Lưu model / cờ của phiên để mở lại y như cũ | tiến trình agent | Chạm vào phần khôi phục: cần test kỹ |

Làm hết bảng trên thì 5 ý "một phần" thành "đáp ứng", trừ phần MR trên GitLab. Mức đáp ứng ước tính lên khoảng 94%.

## 6. Phần nào dùng chung cho mọi người, phần nào chỉ cho Xspire Crew, và chính xác tới đâu

| Việc làm thêm | Nằm ở | Ai dùng được | Chính xác vì | Rủi ro / điều kiện |
|---|---|---|---|---|
| Tiến trình agent chạy ngầm dưới mỗi phiên (`codex exec`, `claude -p`): số lượng, chạy bao lâu | **Lõi** | Mọi người (ai cũng có thể chạy agent chạy ngầm) | Bảng tiến trình của hệ điều hành | Không biết "track" là gì: chỉ biết tiến trình |
| Gợi ý tài khoản AI còn nhiều lượt nhất | **Lõi** | Mọi người dùng Claude / Codex | Số đo quota của tab Token AI; tài khoản của phiên Claude lấy từ thư mục cấu hình nó chạy | Chỉ gợi ý, không tự đổi. Phiên Codex chưa biết chắc dùng tài khoản nào |
| Ghi lệnh khởi chạy (model, cờ) để mở lại y như cũ | **Lõi** | Mọi người | Dòng lệnh thật của tiến trình agent | Đụng vào phần khôi phục sau khởi động lại: phải test kỹ trên Ubuntu |
| Bảng theo orchestrator: task → track → worker | **Gói Xspire Crew** | Chỉ máy có `_crew` | Tệp crew kit tự ghi (`nudge.conf`, MANIFEST, ROUNDS) | Nếu crew kit đổi định dạng tệp thì phải sửa gói, không ảnh hưởng lõi |
| Trạng thái chờ / lease của crew-upstream | **Gói Xspire Crew** | Chỉ máy có `_crew` | Tệp crew-upstream ghi | Định dạng là nội bộ của crew kit, dễ đổi hơn ⇒ độ tin thấp hơn các mục khác; làm sau |
| Phiên bản crew kit giữa các máy | **Gói Xspire Crew** | Chỉ máy có `_crew` | Commit git của `scripts/crew` | Máy không dùng git cho `scripts/crew` thì hiện "không rõ" |
| Báo cáo ops-audit thành phiếu | **Gói Xspire Crew** | Chỉ máy có skill | Tệp báo cáo skill ghi ra | **Chưa đảm bảo:** chưa kiểm skill ghi báo cáo ở đâu, có cố định không. Phải kiểm trước rồi mới làm; không đoán |

Nguyên tắc giữ như cũ:
- Lõi không đọc rule hay skill của devkit. Test tự động kiểm rằng gói lõi không chứa từ xspire / crew / dotnet / gitlab / devkit.
- Gói Crew không có `_crew` thì im lặng.
- Không có dữ kiện thì ghi "chưa rõ", không đoán.
