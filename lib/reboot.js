'use strict';

const { tr } = require('./i18n-server');
// The transport is injected by the saved backend; tests never contact a real host.
async function rebootServer(backend, name) {
  if (!backend) throw new Error(tr('srv.server.khong_thay_may_chu_nay'));
  if (backend.cfg.local) throw new Error(tr('srv.reboot.khong_cho_phep_khoi_dong'));
  if (!backend.ready) throw new Error(tr('srv.server.may_chu_chua_ket_noi'));
  if (backend.rebooting) throw new Error(tr('srv.reboot.may_chu_dang_khoi_dong'));
  if (name !== backend.publicView().name) throw new Error(tr('srv.reboot.nhap_chinh_xac_ten_may'));
  if (!backend.snapshot?.sys?.rebootRequired) throw new Error(tr('srv.reboot.may_chu_chua_yeu_cau'));
  if (!backend.snapshot.bootId) throw new Error(tr('srv.reboot.chua_doc_duoc_ma_khoi'));
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
    throw new Error(tr('srv.reboot.khong_the_khoi_dong_lai'));
  }
  return { ok: true };
}

module.exports = { rebootServer };
