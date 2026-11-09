# 37 — Gói luật JSON hoạt động thế nào · TERMNEST biết ops-audit đã cài bằng cách nào

> 07/11/2026 16:37 · Phần 1 đang có trong code (nút **Chỉnh luật → Xuất / Nhập gói JSON**). Phần 2 là thiết kế cho bước 3, chưa code.

## 1. Gói luật JSON

### Là gì
Một tệp `.json` chứa **cách TERMNEST theo dõi**: bật / tắt từng luật, sau bao nhiêu phút thì báo, câu nhắc dùng chữ gì, cộng thêm vài luật riêng của đội.
Nó là **cấu hình**, không phải code: không chạy được lệnh, không đọc được tệp nào.

### Ví dụ một đội tự viết
```json
{
  "name": "team-mobile",
  "rules": {
    "dormant":  { "level": "suggest", "after": 20 },
    "finished": { "level": "off" },
    "overload": { "cpu": 85, "ram": 85 },
    "bgjob":    { "days": 3 }
  },
  "templates": {
    "continue": "Làm tiếp task đang dở. Bị chặn thì ghi rõ đang chờ ai, chờ gì."
  },
  "custom": [
    { "id": "release", "title": "Đang chạy script phát hành", "match": "release\\.sh", "severity": "urgent" }
  ]
}
```

| Phần | Nghĩa | Ví dụ trên làm gì |
|---|---|---|
| `rules` | Chỉnh 11 luật có sẵn: `level` = `off` · `notify` (chỉ báo) · `suggest` (có nút nhắc); `after` = số phút | Nhắc sau 20 phút thay vì 30; tắt hẳn mục "Đã xong lượt"; báo quá tải từ 85%; chỉ hiện việc nền chờ bạn trong 3 ngày gần nhất |
| `templates` | Câu sẽ gõ vào phiên khi bấm "Gửi nhắc" | Đổi câu nhắc theo cách nói của đội |
| `custom` | Luật riêng: hiện một dòng khi chữ trên màn hình **khớp đúng** mẫu đội khai | Báo "Đang chạy script phát hành" khi màn hình có `release.sh` |

### Dùng thế nào
1. **Vận hành → Chỉnh luật**: chỉnh trên giao diện, bấm **Lưu**.
2. **Xuất gói JSON**: tải về tệp `termnest-ops-<tên>.json`, gửi cho người khác trong đội.
3. Người nhận vào **Nhập gói JSON** → chọn tệp. Muốn quay lại như ban đầu thì bấm **Về mặc định**.

### Giới hạn cứng, gói nào cũng không vượt qua được
- Luật "Đang chờ bạn" luôn **chỉ báo**, không bao giờ có nút gửi.
- Luật riêng (`custom`) chỉ được **báo**, không được gửi gì.
- Mẫu nhắc không được chứa ký tự điều khiển; mẫu tìm (`match`) phải hợp lệ và ngắn (≤ 200 ký tự).
- Khóa lạ bị bỏ, số vượt ngưỡng bị kẹp lại (ví dụ `after` tối đa 1440 phút).
- Không gói nào thêm được lệnh dừng, khởi động lại hay triển khai.

### Khác gì luật của devkit
Luật devkit (rule `102-core-rules/...`) là hướng dẫn cho **agent** làm việc. Gói JSON là cấu hình cho **TERMNEST** theo dõi. Hai thứ tách biệt: đội không có devkit vẫn viết gói của mình.

## 2. TERMNEST biết `xspire-crew-ops-audit` đã cài bằng cách nào (thiết kế bước 3)

### Không đoán, mà đọc đúng nơi Claude Code ghi
Trên mỗi máy, ở mỗi lần chụp chậm (khoảng 1 phút/lần), TERMNEST đọc:

1. `~/.claude*/plugins/installed_plugins.json`: danh sách plugin đã cài, kèm `installPath` (thư mục cài), `scope` (user / project) và `projectPath`.
2. Trong mỗi `installPath`, kiểm có `skills/xspire-crew-ops-audit/SKILL.md` hay không.
3. Thêm `~/.claude/skills/xspire-crew-ops-audit/SKILL.md` (cài lẻ) và `<thư mục dự án>/.claude/skills/...` (cài theo dự án).

Một skill được tính là **có** cho một phiên khi cả hai điều sau đều đúng:
- Tệp `SKILL.md` tồn tại.
- Plugin cài ở phạm vi **user**, hoặc ở phạm vi **project** mà `projectPath` chứa thư mục làm việc của phiên đó.

### Kiểm thật trên máy này (07/11/2026 16:33)
| Nơi | Kết quả |
|---|---|
| `installed_plugins.json` | `xspire-devkit@xspire-devkit-local` **0.6.2**, scope `project`, projectPath `…/xspire-workspaces` |
| `…/xspire-devkit/0.6.2/skills/` | có `xspire-crew`, `xspire-crew-audit`, `xspire-crew-board`… nhưng **không có** `xspire-crew-ops-audit` |
| Mã nguồn devkit (`hqsoft.abp.docs/workspace-setup/xspire-devkit-plugin/…/skills/xspire-crew-ops-audit`) | có |

⇒ Trên máy này TERMNEST sẽ báo **"Chưa cài ops-audit (devkit 0.6.2 chưa có skill này)"** và ẩn nút "Chạy ông trùm". Đây đúng là trường hợp nếu không kiểm mà vẫn gọi, lệnh sẽ không chạy được.

### Khi đã có skill
- Nút **"Chạy ông trùm"** hiện ở tab Vận hành, kèm phiên bản plugin đọc được.
- Bấm (hoặc tới lịch): TERMNEST mở một phiên Claude mới trong đúng thư mục dự án, rồi gõ lệnh gọi skill. Phiên chạy như mọi phiên khác, bạn xem được trực tiếp.
- Kết thúc phiên (Claude ghi `idle`): TERMNEST đọc tệp báo cáo skill ghi ra, hiện thành phiếu trong Vận hành, ghi vào sổ.
- Không có skill thì không có nút, không có lịch, không báo lỗi. Phần còn lại vẫn chạy.

### Máy / team khác
- Không cài devkit: bước 1 không thấy plugin, nên toàn bộ phần ops-audit tự ẩn.
- Một team khác có skill "ông trùm" của riêng họ: phần đọc plugin này dùng chung được, chỉ cần khai tên skill trong gói "Crew". Lõi không phải sửa gì.


## 3. Đính chính và cách làm đã chọn (07/11/2026 16:56)

- **Đính chính:** máy này **có** `xspire-crew-ops-audit`. Marketplace dạng "thư mục" được Claude Code nạp thẳng từ thư mục nguồn (`readFromFolder`, bản 0.6.8). Con số 0.6.2 trong `installed_plugins.json` chỉ là bản ghi lúc cài. Câu "devkit 0.6.2 chưa có skill" ở mục 2 là sai.
- **Cách nhận biết đã code** (commit 9d3eb98): hỏi chính Claude Code bằng `claude plugin list --json`.
  - Chạy bằng **đúng binary** của tiến trình Claude trong phiên. Shell đăng nhập trên máy này tìm ra bản cũ 2.1.226, trong khi các phiên chạy 2.1.311.
  - Chạy **trong đúng thư mục** của phiên, vì plugin theo dự án chỉ bật bên trong dự án.
- **Skill có cho một phiên** khi plugin chứa skill đó "enabled" trong câu trả lời cho thư mục và tài khoản của phiên.
- Danh sách skill của từng plugin: `claude plugin details <id>`. Bước 3 dùng lệnh này để bật / ẩn nút "Chạy ông trùm".
