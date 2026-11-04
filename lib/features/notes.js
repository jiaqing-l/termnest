'use strict';
const { tr } = require('../i18n-server');
const { runOnHost, sessionCwd } = require('../file-viewer');

// Work notes and time-only reminders. Everything is stored in the encrypted vault under features.notes; the
// browser keeps the working copy and saves it here. "Append to file" only ever adds text to a file that exists.
const MAX_NOTES = 200, MAX_REMS = 300, MAX_TEXT = 200000, MAX_BODY = 1500000, MAX_APPEND = 60000;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const ID = /^[A-Za-z0-9_-]{1,40}$/;
const LINKS = ['note', 'sess', 'none'];
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
const PET = /^[a-z][a-z0-9-]{1,23}$/;

function clean(input) {
  const doc = input && typeof input === 'object' ? input : {};
  const notes = (Array.isArray(doc.notes) ? doc.notes : []).slice(0, MAX_NOTES).filter((n) => n && ID.test(n.id || '')).map((n) => ({
    id: n.id, title: str(n.title, 120), text: str(n.text, MAX_TEXT), pet: PET.test(n.pet || '') ? n.pet : '', session: str(n.session, 80), updatedAt: num(n.updatedAt) }));
  const ids = new Set(notes.map((n) => n.id));
  const reminders = (Array.isArray(doc.reminders) ? doc.reminders : []).slice(0, MAX_REMS)
    .filter((r) => r && ID.test(r.id || '') && TIME.test(r.time || '') && ids.has(r.noteId)).map((r) => ({
      id: r.id, noteId: r.noteId, time: r.time, title: str(r.title, 200), daily: !!r.daily, on: r.on !== false, link: LINKS.includes(r.link) ? r.link : 'note',
      createdAt: num(r.createdAt), lastFired: num(r.lastFired), ...(num(r.snoozeUntil) ? { snoozeUntil: num(r.snoozeUntil) } : {}) }));
  const s = doc.settings && typeof doc.settings === 'object' ? doc.settings : {};
  const settings = { bell: s.bell !== false, os: s.os !== false, sound: s.sound === true, quiet: s.quiet !== false,
    snooze: [tr('srv.notes.10_phut'), tr('srv.notes.1_gio'), tr('srv.notes.sang_mai_08_00')].includes(s.snooze) ? s.snooze : tr('srv.notes.10_phut'), current: ID.test(s.current || '') && ids.has(s.current) ? s.current : '' };
  return { notes, reminders, settings };
}

// Self-contained so it can run on the session's host (see lib/file-viewer.js). Never creates or overwrites a file.
function appendRuntime() {
  const fs = require('fs'), path = require('path');
  return async function append({ cwd, path: requested, text }) {
    const error = (message) => ({ error: message });
    if (typeof cwd !== 'string' || typeof requested !== 'string' || !requested || requested.length > 4096 || /[\x00-\x1f\x7f]/.test(requested)) return error(tr('srv.notes.duong_dan_tep_khong_hop'));
    if (typeof text !== 'string' || !text || Buffer.byteLength(text) > 60000) return error(tr('srv.notes.noi_dung_qua_dai_toi'));
    if (!/\.(md|markdown|txt)$/i.test(requested)) return error(tr('srv.notes.chi_noi_vao_tep_md'));
    try {
      const base = path.resolve(cwd), root = await fs.promises.realpath(base), target = path.resolve(base, requested);
      let real; try { real = await fs.promises.realpath(target); } catch { return error(tr('srv.notes.tep_chua_ton_tai_chi')); }
      const rel = path.relative(root, real);
      if (!rel || rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel)) return error(tr('srv.notes.khong_duoc_ghi_tep_ngoai'));
      const handle = await fs.promises.open(real, fs.constants.O_RDWR | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0));
      try {
        const stat = await handle.stat(); if (!stat.isFile()) return error(tr('srv.notes.chi_noi_vao_tep_thong'));
        let prefix = '';
        if (stat.size > 0) { const last = Buffer.alloc(1); await handle.read(last, 0, 1, stat.size - 1); if (last[0] !== 10) prefix = '\n'; }
        const data = Buffer.from(prefix + text + (text.endsWith('\n') ? '' : '\n'));
        await handle.write(data); return { ok: true, path: real, bytes: data.length };
      } finally { await handle.close(); }
    } catch { return error(tr('srv.notes.khong_ghi_duoc_tep')); }
  };
}

module.exports = {
  name: 'notes', clean, appendRuntime,
  register(host) {
    host.route('GET', '/data', ({ res }) => host.send(res, 200, clean(host.settings.get())));
    host.route('PUT', '/data', async ({ req, res }) => {
      const body = await host.readJson(req);
      if (JSON.stringify(body).length > MAX_BODY) { host.fail(res, 413, tr('srv.notes.du_lieu_ghi_chu_qua')); return; }
      const doc = clean(body); host.settings.set(doc); host.send(res, 200, { ok: true, notes: doc.notes.length, reminders: doc.reminders.length });
    });
    host.route('POST', '/append', async ({ req, res }) => {
      const b = await host.readJson(req);
      const backend = host.backendOf(String(b.server || ''));
      if (!backend || typeof b.session !== 'string' || b.session.length > 128) { host.fail(res, 400, tr('srv.handoff.chua_chon_phien_hop_le')); return; }
      try {
        const out = await runOnHost(backend, appendRuntime, { cwd: await sessionCwd(backend, b.session), path: b.path, text: b.text });
        if (out.error) { host.fail(res, 400, out.error); return; }
        host.send(res, 200, { ok: true, bytes: out.bytes });
      } catch (e) { host.fail(res, 400, e.message); }
    });
  },
};
