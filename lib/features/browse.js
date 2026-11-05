'use strict';
const { tr } = require('../i18n-server');
const { runOnHost, sessionCwd } = require('../file-viewer');

// Lists the folders and viewable files below a session's own folder, for picking a file in the viewer instead of typing a path.
// The viewer only opens files inside that folder, so the browser never leaves it either.

// Self-contained so it runs on the session's host (see lib/file-viewer.js runOnHost).
function browseRuntime() {
  const fs = require('fs'), path = require('path');
  const VIEW = /\.(md|markdown|html?|txt|log|json|jsonl|ya?ml|csv|tsv|xml|css|js|mjs|cjs|ts|tsx|jsx|sh|bash|zsh|py|rb|go|rs|c|h|cpp|cs|razor|sql|toml|ini|conf|config|properties|svg|png|jpe?g|gif|webp)$/i;
  const NAMED = /^(README|LICENSE|Makefile|Dockerfile)/i, SKIP = new Set(['node_modules', '.git']);
  return async function list({ cwd, dir }) {
    if (typeof cwd !== 'string' || !cwd || (dir != null && (typeof dir !== 'string' || dir.length > 4096 || /[\x00-\x1f\x7f]/.test(dir)))) return { error: tr('srv.server.thu_muc_chua_dung') };
    let root, real;
    try { root = await fs.promises.realpath(path.resolve(cwd)); real = await fs.promises.realpath(dir ? path.resolve(root, dir) : root); } catch { return { error: tr('srv.server.khong_mo_duoc_thu_muc') }; }
    const rel = path.relative(root, real);
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return { error: tr('srv.browse.chi_duyet_trong_thu_muc') };
    let entries; try { entries = await fs.promises.readdir(real, { withFileTypes: true }); } catch { return { error: tr('srv.browse.khong_doc_duoc_thu_muc') }; }
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

// Finds viewable files below the session's folder whose NAME contains the text (any depth), newest first. Uses find, which prunes the
// heavy folders and never follows symlinks; where find is missing a bounded walk takes over. Self-contained like browseRuntime.
function searchRuntime() {
  const fs = require('fs'), path = require('path'), cp = require('child_process');
  const VIEW = /\.(md|markdown|html?|txt|log|json|jsonl|ya?ml|csv|tsv|xml|css|js|mjs|cjs|ts|tsx|jsx|sh|bash|zsh|py|rb|go|rs|c|h|cpp|cs|razor|sql|toml|ini|conf|config|properties|svg|png|jpe?g|gif|webp)$/i;
  const NAMED = /^(README|LICENSE|Makefile|Dockerfile)/i, HEAVY = ['node_modules', '.git', 'obj', 'bin', 'dist', 'target', '.next', '__pycache__', '.venv', 'venv', '_archive'], LIMIT = 50;
  return async function search({ cwd, q }) {
    if (typeof cwd !== 'string' || !cwd || typeof q !== 'string' || !q.trim() || q.length > 100 || /[\x00-\x1f\x7f]/.test(q)) return { error: 'bad request' };
    let root; try { root = await fs.promises.realpath(path.resolve(cwd)); } catch { return { error: 'bad folder' }; }
    q = q.trim().replace(/^\.\//, '');   // "./bien-the/x.csv" as printed by an AI
    if (!q) return { error: 'bad request' };
    const needle = q.toLowerCase();
    let rels = null;
    await new Promise((resolve) => {
      const glob = q.replace(/[\\*?\[\]]/g, (m) => '\\' + m);
      const args = [root, '-maxdepth', '14', '(', ...HEAVY.flatMap((n, i) => (i ? ['-o', '-name', n] : ['-name', n])), ')', '-prune', '-o', '-type', 'f', q.includes('/') ? '-ipath' : '-iname', '*' + glob + '*', '-print'];   // a typed path (folder/name) matches against the whole path
      try { cp.execFile('find', args, { timeout: 8000, maxBuffer: 4 << 20 }, (err, out) => { if (!(err && !out)) rels = String(out).split('\n').filter(Boolean).slice(0, 2000); resolve(); }); } catch { resolve(); }
    });
    if (rels === null) {   // no find: a bounded walk
      rels = []; const queue = [[root, 0]], stop = Date.now() + 3000; let visited = 0;
      while (queue.length && rels.length < 2000 && visited < 40000 && Date.now() < stop) {
        const [dir, depth] = queue.shift(); let entries; try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) { visited++; if (e.isSymbolicLink()) continue; const full = path.join(dir, e.name); if (e.isDirectory()) { if (depth < 14 && !HEAVY.includes(e.name)) queue.push([full, depth + 1]); } else if (e.isFile() && (needle.includes('/') ? full.toLowerCase().split(path.sep).join('/') : e.name.toLowerCase()).includes(needle)) rels.push(full); }
      }
    }
    const rows = [];
    for (const f of rels) {
      const name = path.basename(f); if (!VIEW.test(name) && !NAMED.test(name)) continue;
      try { const st = await fs.promises.stat(f); rows.push({ rel: path.relative(root, f).split(path.sep).join('/'), size: st.size, at: st.mtimeMs }); } catch { /* vanished */ }
    }
    rows.sort((a, b) => b.at - a.at);
    return { root, files: rows.slice(0, LIMIT).map((r) => ({ rel: r.rel, size: r.size })), more: rows.length > LIMIT };
  };
}

module.exports = {
  name: 'browse', browseRuntime, searchRuntime,
  register(host) {
    host.route('GET', '/search', async ({ res, url }) => {
      const backend = host.backendOf(url.searchParams.get('server') || ''), session = url.searchParams.get('session') || '', q = url.searchParams.get('q') || '';
      if (!backend || !session || session.length > 128 || !q.trim() || q.length > 100) { host.fail(res, 400, tr('srv.handoff.chua_chon_phien_hop_le')); return; }
      try {
        const out = await runOnHost(backend, searchRuntime, { cwd: await sessionCwd(backend, session), q });
        if (out.error) host.fail(res, 400, out.error); else host.send(res, 200, out);
      } catch (e) { host.fail(res, 400, e.message); }
    });
    host.route('GET', '/list', async ({ res, url }) => {
      const backend = host.backendOf(url.searchParams.get('server') || ''), session = url.searchParams.get('session') || '', dir = url.searchParams.get('path') || '';
      if (!backend || !session || session.length > 128) { host.fail(res, 400, tr('srv.handoff.chua_chon_phien_hop_le')); return; }
      try {
        const out = await runOnHost(backend, browseRuntime, { cwd: await sessionCwd(backend, session), dir });
        if (out.error) host.fail(res, 400, out.error); else host.send(res, 200, out);
      } catch (e) { host.fail(res, 400, e.message); }
    });
  },
};
