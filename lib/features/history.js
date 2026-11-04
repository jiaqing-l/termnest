'use strict';

const { tr } = require('../i18n-server');
// Clears a session's scrollback (tmux clear-history) after an explicit confirm in the UI. The visible screen is untouched.
module.exports = {
  name: 'history',
  register(host) {
    host.route('POST', '/clear', async ({ req, res }) => {
      const b = await host.readJson(req), backend = host.backendOf(String(b.server || '')), name = String(b.session || '');
      const known = backend && backend.snapshot && Array.isArray(backend.snapshot.sessions) && backend.snapshot.sessions.some((s) => s.name === name);
      if (!backend || backend.mode === 'powershell' || !known) { host.fail(res, 400, tr('srv.history.khong_tim_thay_phien_nay')); return; }
      try {
        const out = await backend.exec(`tmux clear-history -t ${host.shq(`=${name}:`)}`, 8000);
        if (out.code !== 0) { host.fail(res, 400, tr('srv.history.khong_xoa_duoc_lich_su')); return; }
        host.log(`cleared scrollback of ${name}`);
        host.send(res, 200, { ok: true });
      } catch (e) { host.fail(res, 400, e.message); }
    });
  },
};
