'use strict';

// The transport is injected by the saved backend; tests never contact a real host.
async function rebootServer(backend, name) {
  if (!backend) throw new Error('Không thấy máy chủ này.');
  if (backend.cfg.local) throw new Error('Không cho phép khởi động lại Máy này.');
  if (!backend.ready) throw new Error('Máy chủ chưa kết nối.');
  if (backend.rebooting) throw new Error('Máy chủ đang khởi động lại.');
  if (name !== backend.publicView().name) throw new Error('Nhập chính xác tên máy chủ để xác nhận.');
  if (!backend.snapshot?.sys?.rebootRequired) throw new Error('Máy chủ chưa yêu cầu khởi động lại.');
  if (!backend.snapshot.bootId) throw new Error('Chưa đọc được mã khởi động của máy chủ. Hãy thử lại.');
  backend.rebooting = { bootId: backend.snapshot.bootId };
  try {
    // Let SSH return success before reboot closes the connection. Check sudo first.
    const command = backend.cfg.user === 'root'
      ? '(sleep 1; reboot) </dev/null >/dev/null 2>&1 &'
      : 'sudo -n -l reboot >/dev/null 2>&1 || exit 1; (sleep 1; sudo -n reboot) </dev/null >/dev/null 2>&1 &';
    const result = await backend.exec(command);
    if (result.code !== 0) throw new Error('permission');
  } catch {
    backend.rebooting = null;
    throw new Error('Không thể khởi động lại. Tài khoản SSH cần quyền root hoặc quyền sudo reboot không cần mật khẩu.');
  }
  return { ok: true };
}

module.exports = { rebootServer };
