'use strict';
const { tr } = require('../i18n-server');
const crypto = require('crypto');

// Drag/paste a file onto a session: the bytes go to a private temp folder on the session's host and the client types the path.
const MAX_BYTES = 10 * 1024 * 1024;
const KINDS = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image',
  txt: 'text', md: 'text', log: 'text', json: 'text', csv: 'text', pdf: 'pdf',
};
const MAGIC = {
  png: (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47,
  jpg: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8, jpeg: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8,
  gif: (b) => b.length > 6 && b.toString('latin1', 0, 4) === 'GIF8',
  webp: (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
  pdf: (b) => b.length > 5 && b.toString('latin1', 0, 5) === '%PDF-',
};

function extOf(name) { const m = /\.([A-Za-z0-9]{1,5})$/.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; }
// Rejects wrong type, wrong content, empty or oversized data. Returns the validated extension.
function check(name, bytes) {
  const ext = extOf(name);
  if (!KINDS[ext]) throw new Error(tr('srv.drop.loai_file_nay_chua_duoc'));
  if (!bytes.length) throw new Error(tr('srv.drop.file_rong'));
  if (bytes.length > MAX_BYTES) throw new Error(tr('srv.drop.file_qua_lon_toi_da'));
  if (MAGIC[ext] && !MAGIC[ext](bytes)) throw new Error(tr('srv.drop.noi_dung_file_khong_dung'));
  if (KINDS[ext] === 'text' && bytes.includes(0)) throw new Error(tr('srv.drop.file_van_ban_chua_du'));
  return ext;
}
// Stdin is the file body, so nothing user-controlled reaches the shell. Files older than a day are removed on each upload.
function storeScript(file) {
  return `d="\${TMPDIR:-/tmp}/termnest-drop-$(id -u)"; mkdir -p "$d" && chmod 700 "$d" && find "$d" -type f -mtime +0 -delete 2>/dev/null; umask 077; cat > "$d/${file}" && printf '%s\\n' "$d/${file}"`;
}

module.exports = {
  name: 'drop', MAX_BYTES, check, storeScript, extOf,
  register(host) {
    host.route('POST', '/upload', async ({ req, res, url }) => {
      const backend = host.backendOf(url.searchParams.get('server') || '');
      // No backend means the machine is unknown or not connected right now (an SSH link that dropped): say so, rather than "not supported".
      if (!backend) { host.fail(res, 400, tr('srv.server.may_chu_chua_ket_noi')); return; }
      if (backend.mode === 'powershell') { host.fail(res, 400, tr('srv.drop.may_nay_chua_ho_tro')); return; }
      try {
        const bytes = await host.readBody(req, MAX_BYTES + 1024), ext = check(url.searchParams.get('name'), bytes);
        const file = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(5).toString('hex')}.${ext}`;
        const out = await backend.exec(`sh -c ${host.shq(storeScript(file))}`, 60000, 64 * 1024, bytes);
        const path = out.out.trim();
        if (out.code !== 0 || !path.startsWith('/')) { host.fail(res, 400, tr('srv.drop.khong_luu_duoc_file_tren')); return; }
        host.send(res, 200, { path, kind: KINDS[ext], size: bytes.length });
      } catch (e) { host.fail(res, 400, e.message === 'too large' ? tr('srv.drop.file_qua_lon_toi_da') : e.message); }
    });
  },
};
