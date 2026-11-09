'use strict';
const { tr } = require('../i18n-server');
const { runOnHost, sessionCwd, transferReadRuntime, hostErrorExtra } = require('../file-viewer');
const crypto = require('crypto');

// Drag/paste a file onto a session: the bytes go to a private temp folder on the session's host and the client types the path.
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_TRANSFER = 20 * 1024 * 1024;   // a file moved between two machines travels as base64 through the app: keep it smaller than an upload
// Any file can be sent: the bytes land in a private temp folder (mode 700, files 600, never executable) and only the path is typed.
// Pictures and PDFs must really be what their extension says, text must not hold binary data, Office/zip files must be zip containers;
// everything else is passed through. Programs that run by themselves are refused.
const TEXT = new Set(['txt', 'md', 'log', 'json', 'jsonl', 'csv', 'tsv', 'html', 'htm', 'xml', 'yaml', 'yml', 'css', 'js', 'ts', 'tsx', 'jsx', 'py', 'sh', 'sql', 'toml', 'ini', 'conf', 'cfg', 'env', 'rtf', 'svg', 'cs', 'java', 'go', 'rs', 'rb', 'php', 'c', 'h', 'cpp', 'razor', 'dart', 'kt', 'swift', 'ps1']);
const ZIPPED = new Set(['docx', 'xlsx', 'pptx', 'zip', 'odt', 'ods', 'odp', 'epub']);
const BLOCKED = new Set(['exe', 'dll', 'msi', 'com', 'scr', 'bat', 'cmd', 'app', 'dmg', 'pkg', 'apk', 'ipa']);
const MAGIC = {
  png: (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47,
  jpg: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8, jpeg: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8,
  gif: (b) => b.length > 6 && b.toString('latin1', 0, 4) === 'GIF8',
  webp: (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
  pdf: (b) => b.length > 5 && b.toString('latin1', 0, 5) === '%PDF-',
};
const kindOf = (ext) => (MAGIC[ext] && ext !== 'pdf' ? 'image' : ext === 'pdf' ? 'pdf' : TEXT.has(ext) ? 'text' : ZIPPED.has(ext) ? 'archive' : 'file');

function extOf(name) { const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; }
// Rejects blocked programs, wrong content, empty or oversized data. Returns the validated extension ('dat' when the name has none).
function check(name, bytes) {
  const ext = extOf(name);
  if (BLOCKED.has(ext)) throw new Error(tr('srv.drop.loai_file_nay_chua_duoc'));
  if (!bytes.length) throw new Error(tr('srv.drop.file_rong'));
  if (bytes.length > MAX_BYTES) throw new Error(tr('srv.drop.file_qua_lon_toi_da'));
  if (MAGIC[ext] && !MAGIC[ext](bytes)) throw new Error(tr('srv.drop.noi_dung_file_khong_dung'));
  if (ZIPPED.has(ext) && !(bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b)) throw new Error(tr('srv.drop.noi_dung_file_khong_dung'));
  if (TEXT.has(ext) && bytes.includes(0)) throw new Error(tr('srv.drop.file_van_ban_chua_du'));
  return ext || 'dat';
}
// Stdin is the file body, so nothing user-controlled reaches the shell. Files older than the chosen days (Settings → Clean-up,
// default one day; 0 keeps them) are removed on each upload.
function storeScript(file, days = 1) {
  const n = Number.isInteger(days) && days > 0 ? days - 1 : -1;
  return `d="\${TMPDIR:-/tmp}/termnest-drop-$(id -u)"; mkdir -p "$d" && chmod 700 "$d" && ${n >= 0 ? `find "$d" -type f -mtime +${n} -delete 2>/dev/null; ` : ''}umask 077; cat > "$d/${file}" && printf '%s\\n' "$d/${file}"`;
}

module.exports = {
  name: 'drop', MAX_BYTES, check, storeScript, extOf,
  register(host) {
    // Writes validated bytes into the private drop folder of a machine and returns the stored path.
    const storeOn = async (backend, name, bytes) => {
      const ext = check(name, bytes);
      const file = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(5).toString('hex')}.${ext}`;
      const out = await backend.exec(`sh -c ${host.shq(storeScript(file, require('./browse').cleanupSettings().tempDays))}`, 60000, 64 * 1024, bytes);
      const path = out.out.trim();
      if (out.code !== 0 || !path.startsWith('/')) throw new Error(tr('srv.drop.khong_luu_duoc_file_tren'));
      return { path, kind: kindOf(ext), size: bytes.length };
    };
    host.route('POST', '/upload', async ({ req, res, url }) => {
      const backend = host.backendOf(url.searchParams.get('server') || '');
      // No backend means the machine is unknown or not connected right now (an SSH link that dropped): say so, rather than "not supported".
      if (!backend) { host.fail(res, 400, tr('srv.server.may_chu_chua_ket_noi')); return; }
      if (backend.mode === 'powershell') { host.fail(res, 400, tr('srv.drop.may_nay_chua_ho_tro')); return; }
      try {
        const bytes = await host.readBody(req, MAX_BYTES + 1024);
        host.send(res, 200, await storeOn(backend, url.searchParams.get('name'), bytes));
      } catch (e) { host.fail(res, 400, e.message === 'too large' ? tr('srv.drop.file_qua_lon_toi_da') : e.message); }
    });
    // Take a file from the session folder of ANOTHER connected machine and put it on the machine of the open session.
    const READ_ERRORS = { invalid: 'srv.drop.chua_chon_nguon', outside: 'srv.drop.nguon_ngoai_thu_muc', notfile: 'srv.drop.nguon_khong_phai_tep', toolarge: 'srv.drop.nguon_qua_lon', notfound: 'srv.drop.nguon_khong_thay', failed: 'srv.drop.khong_doc_nguon' };
    host.route('POST', '/transfer', async ({ req, res }) => {
      let b; try { b = await host.readJson(req); } catch { host.fail(res, 400, tr('srv.drop.chua_chon_nguon')); return; }
      const f = b && b.from, t = b && b.to;
      const str = (v) => (typeof v === 'string' && v && v.length <= 4096 ? v : '');
      if (!f || !t || !str(f.server) || !str(f.session) || !str(f.path) || !str(t.server) || !str(t.session) || f.session.length > 128 || t.session.length > 128) { host.fail(res, 400, tr('srv.drop.chua_chon_nguon')); return; }
      const source = host.backendOf(f.server), target = host.backendOf(t.server);
      if (!source || !target) { host.fail(res, 400, tr('srv.server.may_chu_chua_ket_noi')); return; }
      if (target.mode === 'powershell') { host.fail(res, 400, tr('srv.drop.may_nay_chua_ho_tro')); return; }
      try {
        const got = await runOnHost(source, transferReadRuntime, { cwd: await sessionCwd(source, f.session), path: f.path, max: MAX_TRANSFER }, { timeout: 120000, maxBuffer: Math.ceil(MAX_TRANSFER * 1.4) + 4096 });
        if (got.code) { host.fail(res, 400, tr(READ_ERRORS[got.code] || READ_ERRORS.failed)); return; }
        // A program must not travel just because it has a harmless name on the other side: the target applies its own checks.
        const bytes = Buffer.from(got.b64, 'base64');
        await sessionCwd(target, t.session);   // the target session must exist and be connected
        host.send(res, 200, { ...(await storeOn(target, got.name, bytes)), name: got.name });
      } catch (e) { host.fail(res, 400, e.message, hostErrorExtra(e, source)); }
    });
  },
};
