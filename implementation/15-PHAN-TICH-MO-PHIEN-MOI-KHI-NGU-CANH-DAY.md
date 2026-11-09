# 15 · Khi ngữ cảnh phiên gần đầy: mở phiên mới hay làm mới tại chỗ?

> Trạng thái: **đã duyệt và triển khai** (bản 1.1.4) theo các mặc định ở mục 7: phiên mới là mặc định, `/clear` tại chỗ và `/compact` là phụ, tên `<tên>-2`, ghi snapshot cần xác nhận. Ban đầu là đề xuất. Mockup: `15-MOCKUP-MO-PHIEN-MOI.html`.
> Mục tiêu: từ cảnh báo "Gần đầy · nên mở phiên mới" (tính năng 14) đi tới **hành động** tối ưu token,
> không làm giảm chất lượng và độ chính xác của công việc đang dở. Termnest **không dùng token AI** để làm việc này.

## 1. Sự thật cần dựa vào (đã đo, không đoán)

| Dữ kiện | Giá trị | Nguồn |
|---|---|---|
| Phiên Smart-Visibility | 902k / 1M token (90%) | log Claude + danh mục model của Claude Code |
| Phiên mới trong workspace này bắt đầu ở | **≈ 56–68k token** (10 phiên đo, điển hình 63–68k) | lượt assistant đầu tiên của 10 log gần nhất |
| Mỗi lượt gửi lại toàn bộ ngữ cảnh | chi phí phiên ≈ số lượt × ngữ cảnh mỗi lượt | `55-TOKEN-ECONOMY.md` §2c |
| Giá Sonnet 5.5 (model của Smart-Visibility) | $2 / $10 mỗi Mtok; đọc cache $0,20 / Mtok | `changelog.md` của Claude Code trên máy |
| Giá Opus 5.5 | $4 / $20 mỗi Mtok; đọc cache $0,20 / Mtok | như trên |
| Cache hết hạn khi phiên nghỉ lâu | lượt kế tiếp tính **giá đầy đủ** trên cả ngữ cảnh | cơ chế prompt caching |

Hệ quả: phiên 902k đang "Chờ bạn" nhiều giờ. Khi bạn trả lời, lượt kế tiếp tốn **≈ $0,18 nếu cache còn**,
nhưng **≈ $1,8 (Sonnet 5.5) hoặc ≈ $3,6 (Opus 5.5)** nếu cache đã hết hạn, vì tính giá đầy đủ trên cả 902k.
Phiên mới ≈ 80k (65k nền + snapshot) tốn khoảng $0,16 (Sonnet) hoặc $0,32 (Opus) cho lượt đầu rồi ≈ $0,016 mỗi lượt sau.
Input mỗi lượt **giảm hơn 90%** (80k so với 902k). Đây là ước tính theo giá công bố, không phải hoá đơn.

## 2. Quy tắc sẵn có của workspace (phải tuân thủ)

- **Không** `claude --continue/--resume` phiên dài: nạp lại toàn bộ lịch sử (đo 04/10: 16 lượt mang 22M token). Mở phiên mới, đọc file trạng thái.
- Trước khi tạm dừng/đổi phiên: ghi `Implementation/<stream>/NN-CONTEXT-SNAPSHOT.md` (crew: `_crew/tasks/<id>/`). Nhận "tiếp tục": **đọc snapshot trước**, không dựng lại từ trí nhớ/chat (`55` §4, skill-095).
- Biến thể 1M **không** làm mặc định (`55` §2c). Phiên đang 902k là ngoại lệ cần thu hẹp, không phải trạng thái bình thường.
- Một task một phiên; điều phối crew đọc `STATUS.md`/MANIFEST, không đọc log worker.

## 3. So sánh các phương án

| Phương án | Token | Chất lượng / chính xác | Rủi ro | Kết luận |
|---|---|---|---|---|
| **A. Cứ tiếp tục** | cao nhất, tăng mỗi lượt; cache hết hạn ≈ $1,8–3,6/lượt | giảm dần (ngữ cảnh loãng, gần ngưỡng tự nén) | tự nén bất ngờ giữa việc | Không |
| **B. `/compact` tại chỗ** | 1 lượt trên 902k + tóm tắt model viết | **mất chi tiết không kiểm soát được**, không có bằng chứng tóm tắt đủ | tóm tắt sai rồi cả phiên tin vào nó | Chỉ dùng khi chưa có snapshot và 70–85% |
| **C. `/clear` tại chỗ + snapshot** | ≈ 80k, giữ pane | tốt nếu snapshot đúng | có thể ảnh hưởng shell nền / watcher của phiên | Dùng khi **không** có shell nền/crew đang chạy |
| **D. Phiên mới (tmux mới) từ snapshot** | ≈ 80k, phiên cũ giữ nguyên để đối chiếu | tốt nhất: bắt đầu sạch, đọc đúng nguồn sự thật | pane mới: tên mới, thú mới, crew đang chạy vẫn gắn pane cũ | **Mặc định** |
| **E. resume/continue** | nạp lại cả 902k | như A | bị cấm bởi `55` §2c | Cấm |

Lý do chọn D làm mặc định, C làm phương án phụ: D giữ nguyên phiên cũ để đối chiếu nên **không có điểm mất dữ liệu**.
C tiện (giữ tên, tab, thú) nhưng `/clear` không hoàn tác được và chưa rõ tác động lên shell nền (phiên Smart-Visibility đang có "2 shells still running").

## 4. Quy trình đề xuất (một nút, 5 kiểm tra, không dùng AI)

1. **Kiểm tra trước khi mở** (code thuần, vài giây):
   - Snapshot/tracker: tìm file trạng thái của phiên (task Crew đã nối với phiên, `Implementation/<stream>/*TRACKING*.md`, `*CONTEXT-SNAPSHOT*.md`, `_crew/tasks/<id>/MANIFEST.md`).
   - **Độ tươi**: so giờ sửa file trạng thái với hoạt động cuối của phiên và số lần sửa file kể từ đó. Đỏ nếu snapshot cũ hơn các sửa đổi gần nhất.
   - Git: nhánh, `git status -sb`, 5 commit cuối, file đang sửa dở.
   - Crew đang chạy / shell nền / câu hỏi đang chờ bạn trả lời.
2. **Nếu snapshot thiếu hoặc cũ**: hiện nút *"Nhờ phiên cũ ghi snapshot"*. Gửi **một câu lệnh cố định** vào phiên cũ
   (chuẩn hoá theo skill-095: mục tiêu, quyết định đã chốt, trạng thái, bước kế, câu hỏi mở, đường dẫn file/nhánh). Có hiện ước tính chi phí lượt này (≈ $0,18 nếu cache còn, $1,8–3,6 nếu hết, tuỳ model) **trước khi bấm**.
3. **Dựng gói bàn giao** bằng code từ nguồn sự thật: đường dẫn snapshot + MANIFEST, nhánh/commit, câu hỏi/bước kế lấy từ tin nhắn cuối của phiên cũ. Không tóm tắt bằng AI.
4. **Mở phiên mới** cùng thư mục, cùng loại (Claude/Codex), tên `<tên>-2`, gõ sẵn lời nhắc (không tự Enter):
   > Đọc theo thứ tự: `<snapshot>`, `<MANIFEST>`. Không dựng lại từ trí nhớ. Đối chiếu `git status` với snapshot; nếu lệch thì hỏi tôi trước khi làm. Việc kế tiếp: `<bước kế>`.
5. **Xác nhận rồi mới dọn**: phiên cũ **không bị dừng tự động**. Sau khi phiên mới trả lời đúng trạng thái, nút *"Dừng phiên cũ"* (hai bước, như hiện nay) mới sáng lên.

## 5. Bảo vệ chất lượng và độ chính xác

- Nguồn sự thật là **file và git**, không phải trí nhớ của model: lời nhắc buộc đọc file trước, và buộc **đối chiếu với `git status`**.
- **Chặn khi snapshot cũ**: nút chính chuyển thành "Ghi snapshot trước", không cho mở phiên mới "mù".
- **Không mất việc dở**: phiên cũ còn nguyên cho đến khi bạn xác nhận. Crew đang chạy vẫn gắn pane cũ; phiên mới chỉ đọc MANIFEST, không điều phối chồng.
- Cảnh báo rõ khi: có shell nền/crew đang chạy, có thay đổi chưa commit, có câu hỏi đang chờ bạn trả lời.
- Chọn model/độ sâu cho phiên mới theo `55` §2b; không mặc định 1M.

## 6. Giao diện (xem mockup)

- Thẻ phiên từ 70%: giữ "Nên mở phiên mới" + nút **"Mở phiên mới…"** (và "Nhắc sau" như hiện nay).
- Hộp thoại 3 mục: *Kiểm tra* (xanh/vàng/đỏ từng dòng) → *Gói bàn giao* (xem trước lời nhắc, sửa được) → *Mở*.
- Nút phụ trong menu "⋯": *Làm mới tại chỗ (`/clear`)*, *Nén (`/compact`)* kèm cảnh báo.

## 7. Cần bạn quyết

1. Mặc định **D** (phiên mới) và **C** (tại chỗ) chỉ khi không có shell nền — đồng ý?
2. Cho phép Termnest **gõ lời nhắc vào phiên cũ** để ghi snapshot (một lệnh cố định, có xác nhận) — đồng ý?
3. Phiên mới tên `<tên>-2`, hay giữ cùng tên và đổi tên phiên cũ thành `<tên>-cũ`?
4. Ngưỡng cảnh báo: 70% (hiện tại) hay thấp hơn vì quy tắc không dùng 1M mặc định (ví dụ 200k tuyệt đối)?
5. Có bật cả `/compact` làm phương án phụ không, hay bỏ hẳn vì rủi ro mất chi tiết?

## 8. Kế hoạch (nếu duyệt)

| Pha | Nội dung | Kiểm thử |
|---|---|---|
| 1 | Kiểm tra trước khi mở: tìm snapshot/tracker, độ tươi, git, crew, shell nền | test trên thư mục mẫu + tmux thật |
| 2 | Dựng gói bàn giao + lời nhắc, tạo phiên mới cùng thư mục, gõ sẵn | test tạo phiên, tên, không Enter |
| 3 | "Nhờ phiên cũ ghi snapshot" + ước tính chi phí | test gửi đúng một lệnh cố định |
| 4 | Giao diện hộp thoại, "Làm mới tại chỗ", dừng phiên cũ sau xác nhận | Chrome thật + CI 4 nền tảng |

Mỗi pha tách riêng được; pha 1 + 2 đã cho giá trị chính.
