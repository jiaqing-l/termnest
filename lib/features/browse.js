'use strict';
const { runOnHost, sessionCwd } = require('../file-viewer');

// Lists the folders and viewable files below a session's own folder, for picking a file in the viewer instead of typing a path.
// The viewer only opens files inside that folder, so the browser never leaves it either.

// Self-contained so it runs on the session's host (see lib/file-viewer.js runOnHost).
function browseRuntime() {
  const fs = require('fs'), path = require('path');
  const VIEW = /\.(md|markdown|html?|txt|log|json|jsonl|ya?ml|csv|tsv|xml|css|js|mjs|cjs|ts|tsx|jsx|sh|bash|zsh|py|rb|go|rs|c|h|cpp|cs|razor|sql|toml|ini|conf|config|properties|svg|png|jpe?g|gif|webp)$/i;
  const NAMED = /^(README|LICENSE|Makefile|Dockerfile)/i, SKIP = new Set(['node_modules', '.git']);
  return async function list({ cwd, dir }) {
    if (typeof cwd !== 'string' || !cwd || (dir != null && (typeof dir !== 'string' || dir.length > 4096 || /[\x00-\x1f\x7f]/.test(dir)))) return { error: 'Thư mục chưa đúng.' };
    let root, real;
    try { root = await fs.promises.realpath(path.resolve(cwd)); real = await fs.promises.realpath(dir ? path.resolve(root, dir) : root); } catch { return { error: 'Không mở được thư mục này.' }; }
    const rel = path.relative(root, real);
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return { error: 'Chỉ duyệt trong thư mục của phiên.' };
    let entries; try { entries = await fs.promises.readdir(real, { withFileTypes: true }); } catch { return { error: 'Không đọc được thư mục này.' }; }
    const dirs = [], files = [];
    for (const e of entries) {
      if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (!SKIP.has(e.name)) dirs.push(e.name); }
      else if (e.isFile() && (VIEW.test(e.name) || NAMED.test(e.name))) { try { files.push({ name: e.name, size: (await fs.promises.stat(path.join(real, e.name))).size }); } catch { /* vanished */ } }
    }
    const byName = (a, b) => (a.name || a).toLowerCase().localeCompare((b.name || b).toLowerCase());
    dirs.sort(byName); files.sort(byName);
    return { root, path: real, rel: rel.split(path.sep).join('/'), parent: rel ? path.dirname(real) : null, dirs: dirs.slice(0, 500), files: files.slice(0, 500), truncated: dirs.length > 500 || files.length > 500 };
  };
}

module.exports = {
  name: 'browse', browseRuntime,
  register(host) {
    host.route('GET', '/list', async ({ res, url }) => {
      const backend = host.backendOf(url.searchParams.get('server') || ''), session = url.searchParams.get('session') || '', dir = url.searchParams.get('path') || '';
      if (!backend || !session || session.length > 128) { host.fail(res, 400, 'Chưa chọn phiên hợp lệ.'); return; }
      try {
        const out = await runOnHost(backend, browseRuntime, { cwd: await sessionCwd(backend, session), dir });
        if (out.error) host.fail(res, 400, out.error); else host.send(res, 200, out);
      } catch (e) { host.fail(res, 400, e.message); }
    });
  },
};
