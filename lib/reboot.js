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

// What a reboot would interrupt: agents at work in a session, and folders with changes not committed or commits not pushed.
// Read-only; one shell call for all session folders (at most 30).
async function rebootCheck(backend, shq) {
  if (!backend || !backend.ready) throw new Error(tr('srv.server.may_chu_chua_ket_noi'));
  const sessions = backend.snapshot?.sessions || [];
  const agents = sessions.filter((s) => s.aiTool || /claude|codex|^\d+\.\d+\.\d+$/i.test(s.cmd || '')).map((s) => ({ name: s.name, state: s.state }));
  const dirs = [...new Set(sessions.map((s) => s.path).filter((d) => typeof d === 'string' && d.startsWith('/') && !/[\x00-\x1f]/.test(d)))].slice(0, 30);
  const changed = [];
  if (dirs.length) {
    const script = dirs.map((d) => `d=${shq(d)}; if git -C "$d" rev-parse --show-toplevel >/dev/null 2>&1; then printf '%s\\t%s\\t%s\\n' "$(git -C "$d" status --porcelain 2>/dev/null | wc -l)" "$(git -C "$d" rev-list --count '@{u}..HEAD' 2>/dev/null || echo -)" "$(git -C "$d" rev-parse --show-toplevel)"; fi`).join('\n');
    try {
      const out = await backend.exec(`sh -c ${shq(script)}`, 20000);
      const seen = new Set();
      for (const line of String(out.out || '').split('\n')) {
        const m = line.match(/^\s*(\d+)\t(\d+|-)\t(\/.*)$/);
        if (!m || seen.has(m[3])) continue;
        seen.add(m[3]);
        const changes = Number(m[1]), ahead = m[2] === '-' ? 0 : Number(m[2]);
        if (changes || ahead) changed.push({ dir: m[3], changes, ahead });
      }
    } catch { /* the check is a help, never a blocker */ }
  }
  return { agents, changed };
}

module.exports = { rebootServer, rebootCheck };
