# Đối chiếu Termnest với yêu cầu điều hành nhiều team 24/7

Rà soát ngày 08/11/2026 từ mã nguồn working tree, test và định nghĩa skill ops-audit. Đây là đánh giá khả năng sản phẩm, chưa phải kiểm chứng vận hành thực tế 3 VM × 3 team trong 24 giờ. Không chấm phần trăm vì chưa có bộ tiêu chí và phép đo tải tương ứng.

## Kết luận

Termnest có nền tảng giám sát và hỗ trợ điều hành nhiều VM: SSH/tmux, nhiều phiên, trạng thái agent/worker, tài nguyên máy, cảnh báo, nhắc phiên idle và cơ chế gọi audit theo lịch. Chưa đủ bằng chứng khẳng định đã đạt “6–9 team, vài chục worker tự chạy liên tục 24/7”.

Phần còn thiếu là vòng điều hành bền vững: phát hiện không tiến triển → xác minh nguyên nhân → chọn hành động được phép → kiểm tra kết quả → xử lý tiếp nếu chưa thành công. Việc hiển thị MANIFEST, lease, track hoặc mở một phiên audit chưa tạo thành vòng điều hành này.

Theo yêu cầu người dùng, bản này bỏ tab Crew, liên kết cảnh báo Crew trong Vận hành và panel task Crew trong chi tiết terminal; frontend ngừng gọi API Crew/crew-board. Giữ Vận hành và Plugin & skill. Việc bỏ giao diện không tự đổi cấu hình lịch audit backend, đóng task hoặc dừng worker.

## Yêu cầu của sếp và khả năng hiện có

| Tiêu chí | Hiện có | Giới hạn |
| --- | --- | --- |
| Một nơi quản lý nhiều VM, mỗi VM nhiều leader | Backend SSH riêng theo máy, nhiều tmux session, terminal và số liệu tài nguyên | Có cơ chế; chưa có số đo dài hạn đúng tải 3 VM, 6–9 leader, vài chục worker. |
| Theo dõi leader và worker | Đọc trạng thái agent, cây tiến trình và worker gắn với session | Termnest quan sát; phân rã task và dispatch vẫn thuộc Crew kit. Một tiến trình còn sống chưa chứng minh công việc tiến triển. |
| Phát hiện đứng chờ, lỗi, mất máy | Agent Ops nhận diện idle/waiting/aborted/unknown, mất session, mất kết nối và quá tải | Có phân loại theo dữ liệu đọc được. Thiếu dữ liệu phải là chưa rõ, không được coi là khỏe. |
| Tự nhắc team tiếp tục | Rule dormant hỗ trợ lời nhắc và mức auto, có giới hạn và nhật ký | Mặc định là suggest sau 30 phút. Auto chỉ gửi khi agent báo idle, mặc định tối đa 2 lần/giờ/phiên, mỗi lượt idle một lần, có giờ yên lặng 23:00–07:00. Chưa phải policy 24/7 đã bật. |
| Một tầng audit toàn bộ team | Backend crewpack có auditHours; mở `tn-ops-audit`, gọi `/xspire-devkit:xspire-crew-ops-audit` | Có cầu nối gọi skill. Lịch mặc định tắt; lần rà soát này chưa xác minh lịch đang bật của các máy. |
| Audit chạy lặp ổn định | Scheduler hoạt động theo snapshot backend | Session `tn-ops-audit` còn tồn tại thì scheduler bỏ qua lượt mới, dù audit cũ đã xong. Tự chạy chỉ chọn workspace đầu tiên. Chưa có hợp đồng kết quả để chứng minh mọi team đã được kiểm tra. |
| Gỡ đúng nguyên nhân đứng chờ | Skill yêu cầu kiểm tra gate thực, chủ sở hữu, việc độc lập và hướng xử lý | Có quy trình trong skill; Termnest chưa triển khai đầy đủ vòng xử lý và xác minh. Skill mặc định đọc; thay đổi theo quyết định phù hợp. Gọi skill không chứng minh đã gỡ được blocker. |
| Khôi phục sau mất kết nối/session | SSH reconnect/backoff; có autoRestoreLocal/Remote và resume hội thoại đã biết | Tùy cấu hình. Auto restore thử một lần mỗi boot; lỗi còn lại cần retry. Không phải phục hồi mọi lần leader/worker crash. |
| Hoạt động khi máy người dùng ngủ hoặc app dừng | tmux giúp việc đã chạy trên VM tiếp tục độc lập với cửa sổ terminal | Chưa có bằng chứng supervisor Termnest được triển khai làm dịch vụ luôn sống trên VM. Backend Termnest dừng/mất kết nối thì logic backend không tiếp tục điều hành máy đó. Watcher của Crew kit là cơ chế khác. |
| Quản lý capacity và quota | Theo dõi CPU/RAM, tiến trình, token/quota; gợi ý tài khoản khác | Chưa có scheduler chia capacity giữa các team hoặc tự đổi tài khoản. Quota trong Agent Ops được tổng hợp ở frontend, không phải vòng điều hành quota nền độc lập. |
| Biết hành động đã giúp công việc chạy tiếp | Sau lời nhắc, verify nhận busy hoặc timestamp trạng thái đổi; khoảng 3 phút không đổi thì báo chưa có tác dụng | Xác nhận agent phản ứng, chưa xác nhận commit/test/MR/task tiến triển. Chưa có metric end-to-end về thời gian bị chặn/phục hồi. |

## Các khoảng trống đáng ưu tiên

1. **Lịch audit phụ thuộc sự tồn tại của session.** Điều kiện hiện tại là không có session tên `tn-ops-audit`, không phải không có audit đang chạy. Phiên đã kết thúc lượt nhưng còn mở có thể chặn các chu kỳ sau. Cần phân biệt đang chạy, đã xong, lỗi, quá hạn và xác minh kết quả trước chu kỳ kế tiếp.
2. **Chưa chứng minh bao phủ đủ team.** Mỗi máy có một audit session cố định; lịch tự động chọn `st.roots[0]`. Skill có thể tự kiểm tra nhiều máy nhưng Termnest chưa nhận kết quả theo VM/team để xác định có bỏ sót không.
3. **Nhắc rồi busy chưa đủ.** Cần bằng chứng tiến triển và hạn kiểm tra lại. Không lấy màu xanh, tiến trình còn sống hay việc gửi prompt thành công làm tiêu chí hoàn tất.
4. **Chưa có control loop độc lập với máy cá nhân.** Cần nơi chạy bền vững, giám sát chính supervisor, lưu trạng thái, retry sau lỗi mạng/restart và chống hai supervisor cùng tác động một phiên.
5. **Chờ quyết định là trạng thái hợp lệ.** Phiên xin quyền, hết quota hoặc chờ phụ thuộc thật không được giải quyết bằng gõ “continue” liên tục. Cần định tuyến tới đúng người; chỉ tự làm các hành động đã được phép.
6. **Dữ liệu kỹ thuật phải được xác minh.** Lỗi trước đây đếm issue `crew-lease` còn mở thành số lease đang giữ cho thấy bản ghi không tương đương trạng thái thật. Issue tài nguyên có thể tái sử dụng, tuổi issue không phải thời gian giữ khóa.

## Hướng nâng cấp bám nhu cầu thực

Màn vận hành chỉ cần trả lời: **team nào cần chú ý → mắc ở đâu → hệ thống đã làm gì → còn cần người quyết định gì**. Không cần đưa MANIFEST, rounds hay lease ra mặc định.

Các bước dưới đây là đề xuất, chưa triển khai trong thay đổi bỏ giao diện Crew:

1. Supervisor chạy bền vững, có danh sách VM/team và lần quan sát cuối; thiếu dữ liệu hiện chưa rõ; tiếp tục được sau restart.
2. Audit có chu kỳ và kết quả: phạm vi, bắt đầu/kết thúc, phát hiện, người phụ trách, hạn kiểm lại; không mất lịch chỉ vì session cũ vẫn mở.
3. Xử lý có kiểm chứng: nhắc idle hợp lệ, xác minh dependency/capacity, khôi phục theo quy trình được phép, chuyển việc cần quyết định tới người; kiểm tra kết quả và tránh lặp vô ích.
4. Đợt chạy thật tối thiểu 24 giờ với 3 VM × 2–3 team: thử mất SSH, restart supervisor, leader crash, quota, phụ thuộc chờ và audit treo. Ghi thời gian phát hiện/phục hồi, khoảng dừng vô cớ, số lần cần người, bằng chứng đầu ra. Chưa qua phép thử này thì chưa gắn nhãn đảm bảo 24/7.

Mục tiêu là không có team dừng vô cớ hoặc bị bỏ quên, thay vì mọi session luôn busy hay màu xanh.

## Bằng chứng nguồn

- `lib/remote.js`: reconnect/backoff SSH.
- `server.js`, `onPoll`: auto restore tùy cấu hình, thử một lần mỗi boot.
- `lib/ops.js`: CORE_RULES, CORE_AUTO, autoGate, canSend, verify.
- `lib/features/ops.js`: đánh giá snapshot, gửi nhắc, nhật ký và xác minh.
- `lib/features/crewpack.js`: auditHours, AUDIT_SESSION/AUDIT_SKILL, điều kiện session tồn tại, workspace đầu tiên và timeout pending 10 phút. Nhật ký đã gửi prompt không phải kết quả audit hoàn tất.
- `lib/features/watchdog.js`: lấy mẫu khoảng 20 giây, cảnh báo tiến trình; freeze/resume/stop theo thao tác rõ ràng. Không tự sửa nguyên nhân business của task.
- Định nghĩa skill đối chiếu, tính từ gốc workspace: `docs/hqsoft.abp.docs/workspace-setup/xspire-devkit-plugin/xspire-devkit/skills/xspire-crew-ops-audit/SKILL.md`. Đọc để hiểu hợp đồng skill, không chạy một đợt audit hoặc gửi chỉ đạo tới các phiên trong lần rà soát này.
- `test/ops.test.js`, test feature và `test/ops-tabs-browser.cjs`: kiểm chứng logic và giao diện, không thay thế đợt chạy tải/soak 24 giờ.

Bản này không tự bật auto, đổi lịch audit đã lưu, trả lời prompt, restart agent hay điều phối công việc các team.

## Kiểm tra thay đổi giao diện

- npm test: 481 đạt, 1 bỏ qua, không lỗi.
- Chrome 1440/390: không có tab/panel Crew, frontend không gọi API Crew; Vận hành và Plugin & skill vẫn hoạt động, không tràn ngang.
- Đã cập nhật tệp UI bản Mac có sao lưu và tạo lại `implementation/termnest-update-test.tar.gz`; kiểm tra 159 tệp trong gói khớp mã nguồn.
