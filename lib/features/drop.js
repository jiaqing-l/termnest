'use strict';
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
  if (!KINDS[ext]) throw new Error('Loại file này chưa được hỗ trợ (ảnh, txt, md, log, json, csv, pdf).');
  if (!bytes.length) throw new Error('File rỗng.');
  if (bytes.length > MAX_BYTES) throw new Error('File quá lớn (tối đa 10 MB).');
  if (MAGIC[ext] && !MAGIC[ext](bytes)) throw new Error('Nội dung file không đúng với phần đuôi.');
  if (KINDS[ext] === 'text' && bytes.includes(0)) throw new Error('File văn bản chứa dữ liệu nhị phân.');
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
      if (!backend || backend.mode === 'powershell') { host.fail(res, 400, 'Máy này chưa hỗ trợ nhận file kéo thả.'); return; }
      try {
        const bytes = await host.readBody(req, MAX_BYTES + 1024), ext = check(url.searchParams.get('name'), bytes);
        const file = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(5).toString('hex')}.${ext}`;
        const out = await backend.exec(`sh -c ${host.shq(storeScript(file))}`, 60000, 64 * 1024, bytes);
        const path = out.out.trim();
        if (out.code !== 0 || !path.startsWith('/')) { host.fail(res, 400, 'Không lưu được file trên máy xa.'); return; }
        host.send(res, 200, { path, kind: KINDS[ext], size: bytes.length });
      } catch (e) { host.fail(res, 400, e.message === 'too large' ? 'File quá lớn (tối đa 10 MB).' : e.message); }
    });
  },
};
