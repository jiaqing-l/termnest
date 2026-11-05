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
    const dirs = [], files = [], wanted = [];
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      // Folders that start with a dot (.mobile, .github, .claude) are real project folders: shown. Only .git is skipped, and dot-files stay hidden.
      if (e.isDirectory()) { if (!SKIP.has(e.name)) dirs.push(e.name); }
      else if (e.isFile() && !e.name.startsWith('.') && (VIEW.test(e.name) || NAMED.test(e.name))) wanted.push(e.name);
    }
    const byName = (a, b) => (a.name || a).toLowerCase().localeCompare((b.name || b).toLowerCase());
    dirs.sort(byName); wanted.sort(byName);
    // Sizes of the files shown, 64 at a time (one after another is slow on a network or WSL disk).
    const shown = wanted.slice(0, 500);
    for (let i = 0; i < shown.length; i += 64) {
      const part = await Promise.all(shown.slice(i, i + 64).map((name) => fs.promises.stat(path.join(real, name)).then((st) => ({ name, size: st.size }), () => null)));
      for (const f of part) if (f) files.push(f);
    }
    return { root, path: real, rel: rel.split(path.sep).join('/'), parent: rel ? path.dirname(real) : null, dirs: dirs.slice(0, 500), files, truncated: dirs.length > 500 || wanted.length > 500 };
  };
}

// Creates a folder or an (optionally filled) text file below the session's folder, on the session's host. Never overwrites, never leaves
// the session folder (every parent is checked with realpath, symlinks are not followed). Self-contained like the other runtimes:
// it returns a CODE and the server turns it into a message in the user's language.
function createRuntime() {
  const fs = require('fs'), path = require('path');
  const BAD = /[\x00-\x1f\x7f<>:"|?*\\]/, MAX_CONTENT = 200000;
  const inside = (root, p) => { const rel = path.relative(root, p); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); };
  return async function create({ cwd, dir, name, kind, content }) {
    if (typeof cwd !== 'string' || !cwd || typeof name !== 'string' || !name || name.length > 1000 || (kind !== 'folder' && kind !== 'file')) return { code: 'invalid' };
    if (dir != null && (typeof dir !== 'string' || dir.length > 4096 || /[\x00-\x1f\x7f]/.test(dir))) return { code: 'invalid' };
    if (name.startsWith('/') || name.endsWith('/')) return { code: 'invalid' };   // names are relative to the folder shown
    const parts = name.split('/').map((x) => x.trim()).filter(Boolean);
    if (!parts.length || parts.length > 8 || parts.some((x) => x.length > 255 || x === '.' || x === '..' || BAD.test(x))) return { code: 'invalid' };
    let text = '';
    if (kind === 'file' && content != null) { if (typeof content !== 'string' || content.length > MAX_CONTENT || content.includes('\0')) return { code: 'invalid' }; text = content; }
    let root, base;
    try { root = await fs.promises.realpath(path.resolve(cwd)); base = await fs.promises.realpath(dir ? path.resolve(root, dir) : root); } catch { return { code: 'outside' }; }
    if (!inside(root, base)) return { code: 'outside' };
    try {
      let cur = base;
      for (let i = 0; i < parts.length - 1; i++) {   // parent folders, one by one, each checked
        const next = path.join(cur, parts[i]);
        let st = null; try { st = await fs.promises.lstat(next); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        if (st && (st.isSymbolicLink() || !st.isDirectory())) return { code: 'invalid' };
        if (!st) await fs.promises.mkdir(next);
        cur = await fs.promises.realpath(next);
        if (!inside(root, cur)) return { code: 'outside' };
      }
      const target = path.join(cur, parts[parts.length - 1]);
      if (kind === 'folder') await fs.promises.mkdir(target);
      else await fs.promises.writeFile(target, text, { flag: 'wx' });   // wx: fail rather than overwrite
      return { path: target, kind };
    } catch (e) {
      if (e && e.code === 'EEXIST') return { code: 'exists' };
      if (e && (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EROFS')) return { code: 'denied' };
      return { code: 'failed' };
    }
  };
}

// File search runs in two steps, so typing stays instant even on a slow disk (a Windows folder seen from WSL, a far SSH host):
//  1) indexRuntime lists every viewable file below the session's folder ONCE (path + modified time), on the session's host;
//  2) the server keeps that list for a while and filterIndex answers each keystroke from memory, newest first.
// Self-contained like browseRuntime (it runs on the host). find does the walk where it exists and is the right kind (GNU find on
// Linux/WSL also prints the time, so nothing is stat'ed one by one); elsewhere a bounded walk takes over.
const INDEX_MAX = 60000, SEARCH_LIMIT = 50, INDEX_TTL_MS = 45000;
function indexRuntime() {
  const fs = require('fs'), path = require('path'), cp = require('child_process');
  const VIEW = /\.(md|markdown|html?|txt|log|json|jsonl|ya?ml|csv|tsv|xml|css|js|mjs|cjs|ts|tsx|jsx|sh|bash|zsh|py|rb|go|rs|c|h|cpp|cs|razor|sql|toml|ini|conf|config|properties|svg|png|jpe?g|gif|webp)$/i;
  const NAMED = /^(README|LICENSE|Makefile|Dockerfile)/i, HEAVY = ['node_modules', '.git', 'obj', 'bin', 'dist', 'target', '.next', '__pycache__', '.venv', 'venv', '_archive'];
  const keep = (name) => VIEW.test(name) || NAMED.test(name);
  return async function index({ cwd }) {
    if (typeof cwd !== 'string' || !cwd) return { error: 'bad folder' };
    let root; try { root = await fs.promises.realpath(path.resolve(cwd)); } catch { return { error: 'bad folder' }; }
    let rows = null;
    if (process.platform === 'linux') {
      rows = await new Promise((resolve) => {
        const args = [root, '-maxdepth', '14', '(', ...HEAVY.flatMap((n, i) => (i ? ['-o', '-name', n] : ['-name', n])), ')', '-prune', '-o', '-type', 'f', '-printf', '%T@\t%p\n'];
        try {
          cp.execFile('find', args, { timeout: 20000, maxBuffer: 64 << 20 }, (err, out) => {
            if (err && !out) return resolve(null);
            const list = [];
            for (const line of String(out).split('\n')) {
              const tab = line.indexOf('\t'); if (tab < 0) continue;
              const full = line.slice(tab + 1); if (!full.startsWith(root + path.sep) || !keep(path.basename(full))) continue;
              list.push({ rel: full.slice(root.length + 1), at: Math.round(Number(line.slice(0, tab)) * 1000) || 0 });
              if (list.length >= INDEX_MAX) break;
            }
            resolve(list);
          });
        } catch { resolve(null); }
      });
    }
    if (rows === null) {   // no GNU find: a bounded walk, stat'ing only the files it keeps
      const found = [], queue = [[root, 0]], stop = Date.now() + 15000; let visited = 0;
      while (queue.length && found.length < INDEX_MAX && visited < 200000 && Date.now() < stop) {
        const [dir, depth] = queue.shift(); let entries; try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) { visited++; if (e.isSymbolicLink()) continue; const full = path.join(dir, e.name); if (e.isDirectory()) { if (depth < 14 && !HEAVY.includes(e.name)) queue.push([full, depth + 1]); } else if (e.isFile() && keep(e.name)) found.push(full); }
      }
      rows = [];
      for (let i = 0; i < found.length; i += 64) {   // 64 at a time: a stat per file one after another is what makes a slow disk crawl
        const part = await Promise.all(found.slice(i, i + 64).map((f) => fs.promises.stat(f).then((st) => ({ rel: path.relative(root, f).split(path.sep).join('/'), at: st.mtimeMs }), () => null)));
        for (const r of part) if (r) rows.push(r);
      }
    }
    return { root, rows, capped: rows.length >= INDEX_MAX };
  };
}

// Pure and fast: the text is matched against the file name, or against the whole path when it contains a slash; newest first.
function filterIndex(rows, query, limit = SEARCH_LIMIT) {
  let q = String(query || '').trim().replace(/^\.\//, '').toLowerCase();
  if (!q || q.length > 100 || /[\x00-\x1f\x7f]/.test(q)) return { files: [], more: false, bad: true };
  const byPath = q.includes('/'), hits = [];
  for (const r of rows) { const hay = byPath ? r.rel.toLowerCase() : r.rel.slice(r.rel.lastIndexOf('/') + 1).toLowerCase(); if (hay.includes(q)) hits.push(r); }
  hits.sort((a, b) => b.at - a.at);
  return { files: hits.slice(0, limit).map((r) => ({ rel: r.rel })), more: hits.length > limit, bad: false };
}

module.exports = {
  name: 'browse', browseRuntime, indexRuntime, filterIndex, createRuntime,
  register(host) {
    const indexes = new Map();   // server + folder -> { at, promise }: one walk of the disk serves every keystroke for a while
    host.route('GET', '/search', async ({ res, url }) => {
      const id = url.searchParams.get('server') || '', backend = host.backendOf(id), session = url.searchParams.get('session') || '', q = url.searchParams.get('q') || '';
      if (!backend || !session || session.length > 128 || !q.trim() || q.length > 100) { host.fail(res, 400, tr('srv.handoff.chua_chon_phien_hop_le')); return; }
      try {
        const cwd = await sessionCwd(backend, session), key = id + '\0' + cwd;
        let entry = indexes.get(key);
        if (!entry || Date.now() - entry.at > INDEX_TTL_MS) {
          entry = { at: Date.now(), promise: runOnHost(backend, indexRuntime, { cwd }) };
          indexes.set(key, entry);
          entry.promise.then((r) => { if (r.error) indexes.delete(key); }, () => indexes.delete(key));
          if (indexes.size > 20) indexes.delete(indexes.keys().next().value);
        }
        const idx = await entry.promise;
        if (idx.error) { host.fail(res, 400, idx.error); return; }
        const out = filterIndex(idx.rows, q);
        if (out.bad) { host.fail(res, 400, tr('srv.handoff.chua_chon_phien_hop_le')); return; }
        host.send(res, 200, { root: idx.root, files: out.files, more: out.more, capped: idx.capped });
      } catch (e) { host.fail(res, 400, e.message); }
    });
    const CREATE_ERRORS = { invalid: 'srv.browse.ten_khong_hop_le', exists: 'srv.browse.da_co_ten_nay', outside: 'srv.browse.chi_tao_trong_thu_muc', denied: 'srv.browse.khong_co_quyen_tao', failed: 'srv.browse.khong_tao_duoc' };
    host.route('POST', '/create', async ({ req, res }) => {
      let b; try { b = await host.readJson(req); } catch { host.fail(res, 400, tr(CREATE_ERRORS.invalid)); return; }
      const id = typeof b.server === 'string' ? b.server : '', backend = host.backendOf(id), session = typeof b.session === 'string' ? b.session : '';
      if (!backend || !session || session.length > 128 || typeof b.name !== 'string') { host.fail(res, 400, tr('srv.handoff.chua_chon_phien_hop_le')); return; }
      try {
        const out = await runOnHost(backend, createRuntime, { cwd: await sessionCwd(backend, session), dir: typeof b.dir === 'string' ? b.dir : '', name: b.name, kind: b.kind, content: b.content });
        if (out.code) { host.fail(res, 400, tr(CREATE_ERRORS[out.code] || CREATE_ERRORS.failed)); return; }
        for (const k of [...indexes.keys()]) if (k.startsWith(id + '\0')) indexes.delete(k);   // the search index is out of date now
        host.send(res, 200, out);
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
