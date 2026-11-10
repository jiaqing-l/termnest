'use strict';
const { shq } = require('./parse');

// Windows drives as WSL sees them (/mnt/c, /mnt/d …), so the folder browser can leave C: for another drive.
async function wslDrives(r) {
  const out = await r.exec(`sh -c ${shq('for d in /mnt/?; do [ -d "$d" ] && [ -r "$d" ] && printf "%s\\n" "$d"; done')}`).catch(() => ({ code: 1 }));
  if (out.code !== 0) return [];
  return String(out.out).split('\n').filter((p) => /^\/mnt\/[a-z]$/.test(p)).map((p) => ({ label: p.slice(-1).toUpperCase() + ':', path: p }));
}
// A Windows path (from the system folder dialog, or typed) on a WSL machine → its WSL form: D:\work → /mnt/d/work.
async function wslPath(r, dir) {
  const out = await r.exec(`wslpath -u ${shq(dir)}`).catch(() => ({ code: 1 }));
  const p = out.code === 0 ? String(out.out).trim() : '';
  return p.startsWith('/') ? p : '/mnt/' + dir[0].toLowerCase() + dir.slice(2).replace(/\\/g, '/').replace(/\/+$/, '');
}

module.exports = { wslDrives, wslPath };
