# 36 — Màn "Vận hành": lấy dữ liệu từ đâu, chính xác tới đâu

> Cập nhật 07/11/2026 12:38 · commit `1424870`.
> Từ bản này, Vận hành **chỉ kết luận theo dữ kiện**. Không đoán theo chữ trên màn hình. Không có dữ kiện thì ghi rõ "chưa rõ".

## 1. Bốn nguồn dữ kiện (nhãn hiện ngay trên từng dòng)

| Nhãn | Nguồn | Do ai ghi | Cho biết |
|---|---|---|---|
| **Trạng thái agent** | Claude: `~/.claude/sessions/<pid>.json` (trường `status`, `statusUpdatedAt`, `waitingFor`, `parkedJobId`, `kind`) | Claude Code tự ghi mỗi khi đổi trạng thái | `busy` = đang làm · `idle` = xong lượt, chờ lệnh · `waiting` = đang chờ bạn (lý do ở `waitingFor`) · đã chuyển hội thoại xuống nền |
| | Codex: sự kiện cuối trong tệp `rollout-*.jsonl` | Codex tự ghi | `task_started` = đang làm · `task_complete` = xong lượt · `turn_aborted` = bị ngắt |
| **Tiến trình** | bảng tiến trình + tmux | hệ điều hành | agent đã thoát khỏi phiên, pane đã chết |
| **Đo máy** | lần chụp sẵn có của TERMNEST | đo trực tiếp | CPU, RAM, máy mất kết nối, phiên mất sau khởi động lại |
| **Khớp chữ** | chỉ khi đội tự thêm luật trong gói JSON | người viết luật | khớp đúng chuỗi đội đã khai, có ghi nhãn để biết đây không phải trạng thái agent |

Mỗi lần chụp (vài giây/lần, mỗi máy), server đọc lại các tệp trên. Vì là tệp trên chính máy chạy agent, nên máy chủ Ubuntu qua SSH được đọc y như máy Mac.

## 2. Luật và dữ kiện tương ứng

| Luật | Bật khi | Nguồn |
|---|---|---|
| Đang chờ bạn | Claude ghi `waiting` (phiên trong tmux hoặc phiên nền) | Trạng thái agent |
| Đã xong lượt | ghi `idle`, chưa quá ngưỡng | Trạng thái agent |
| Xong lâu chưa có việc | `idle` liên tục ≥ 30 phút, tính từ `statusUpdatedAt` | Trạng thái agent |
| Bị ngắt | Codex ghi `turn_aborted` | Trạng thái agent |
| Chưa rõ trạng thái | có agent trong phiên nhưng không có tệp trạng thái để đọc | — |
| Agent thoát | tiến trình agent từng có trong pane, giờ không còn | Tiến trình |
| Máy quá tải · Mất kết nối · Mất sau khởi động lại | số đo / danh sách khôi phục | Đo máy |
| Nhắc không có phản hồi | sau khi gửi nhắc, trạng thái agent không đổi trong 3 phút | Trạng thái agent |

Đã **bỏ** các luật đoán theo chữ: báo lỗi, hết lượt, ngữ cảnh, lặp việc. Hai thông tin hết lượt và ngữ cảnh đã có số chính thức ở tab Token AI và ô "Ngữ cảnh phiên".

**Gửi nhắc** chỉ được phép khi agent tự ghi `idle` tại dấu nhắc của chính nó. Các trường hợp còn lại server đều từ chối:
- đang chờ bạn;
- đang làm;
- chưa rõ trạng thái;
- hội thoại đã chuyển xuống nền.

Lời nhắc chỉ được tính là **đã nhận** khi tệp trạng thái đổi sau lúc gửi.

## 3. Kiểm trên máy thật (07/11/2026 12:37:45)

| Phiên | Lệnh | Tệp trạng thái | Kết luận | Cho gửi nhắc |
|---|---|---|---|---|
| PG-App | claude | `idle` từ 12:29:15 | Đã xong lượt (Trạng thái agent) | có |
| GPS-Integrity | zsh | không có | không xét (không phải agent) | không |
| Vifon-SV | zsh | không có | không xét | không |
| Phiên nền "Lỗi nghiệp vụ PG cũ" | — | `idle` | không báo (chỉ báo phiên nền khi `waiting`) | — |

Trước đó (12:28), cũng phiên PG-App đang ở bảng phiên nền của Claude. Tệp ghi `idle` từ thứ Sáu 2:01 PM kèm cờ `parkedJobId`, nên kết luận đúng là "không chạy gì ở đây". Bản đọc màn hình cũ đã báo nhầm "Đã xong".

## 4. Những gì CHƯA có dữ kiện (nói thẳng)

- **Codex xin quyền chạy lệnh:** Codex không ghi yêu cầu xin quyền vào rollout. Lúc đó tệp vẫn ghi `task_started`, nên Vận hành hiện "đang làm" và không cho gửi nhắc: không sai hành động, nhưng không báo được là "chờ bạn". Muốn có thì phải đọc qua giao thức `codex app-server`, việc làm sau.
- **Codex trên macOS:** đường dẫn rollout lấy qua `/proc` chỉ có trên Linux, nên Codex chạy trên Mac sẽ hiện "Chưa rõ trạng thái".
- **Claude bản cũ:** không ghi trường `status` thì cũng hiện "Chưa rõ trạng thái".

## 5. Kiểm chứng

- `test/ops.test.js`: 10 test, gồm "chữ trên màn hình không bao giờ tạo kết luận", "chỉ gửi khi agent ghi idle", phiên đã chuyển nền, phiên nền đang chờ, Codex bị ngắt.
- `test/parse.test.js`: đọc dòng `claudestat` / `codexstat`, gắn đúng phiên.
- `npm test` 456/456.
- Đã chạy thật trên tmux của máy này như bảng mục 3.
