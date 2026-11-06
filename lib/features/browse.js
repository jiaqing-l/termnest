'use strict';
const { tr } = require('../i18n-server');
const { runOnHost, sessionCwd, hostErrorExtra } = require('../file-viewer');

// Lists the folders and viewable files below a session's own folder, for picking a file in the viewer instead of typing a path.
// The viewer only opens files inside that folder, so the browser never leaves it either.

// Self-contained so it runs on the session's host (see lib/file-viewer.js runOnHost).
function browseRuntime() {
  const fs = require('fs'), path = require('path');
  const VIEW = /\.(md|markdown|html?|txt|log|json|jsonl|ya?ml|csv|tsv|xml|css|js|mjs|cjs|ts|tsx|jsx|sh|bash|zsh|py|rb|go|rs|c|h|cpp|cs|razor|sql|toml|ini|conf|config|properties|svg|png|jpe?g|gif|webp)$/i;
  const NAMED = /^(README|LICENSE|Makefile|Dockerfile)/i, SKIP = new Set(['node_modules', '.git', '.termnest-trash']);
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

// Rename, move to the trash, list the trash and restore: one runtime, run on the session's host. Nothing is ever deleted for good: the
// trash is a hidden folder INSIDE the session folder (so a move never crosses a disk), made invisible to git by a .gitignore of its own.
// Every path is resolved with realpath and must stay below the session folder; the folder itself and the trash cannot be touched.
function fsopRuntime() {
  const fs = require('fs'), path = require('path');
  const BAD = /[\x00-\x1f\x7f<>:"|?*\\/]/, TRASH = '.termnest-trash';
  const inside = (root, p) => { const rel = path.relative(root, p); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); };
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const posix = (p) => p.split(path.sep).join('/');
  const exists = async (p) => { try { await fs.promises.lstat(p); return true; } catch { return false; } };
  async function entry(root, p) {
    if (typeof p !== 'string' || !p || p.length > 4096 || /[\x00-\x1f\x7f]/.test(p)) return { code: 'invalid' };
    const abs = path.resolve(root, p);
    try { if (abs === root || await fs.promises.realpath(abs) === root) return { code: 'root' }; } catch { /* does not exist: handled below */ }
    let parent; try { parent = await fs.promises.realpath(path.dirname(abs)); } catch { return { code: 'notfound' }; }   // also resolves an alias such as /var -> /private/var
    if (!inside(root, parent)) return { code: 'outside' };
    const full = path.join(parent, path.basename(abs));
    if (full === root) return { code: 'root' };
    if (full === path.join(root, TRASH) || full.startsWith(path.join(root, TRASH) + path.sep)) return { code: 'invalid' };
    let st; try { st = await fs.promises.lstat(full); } catch { return { code: 'notfound' }; }
    return { full, parent, st };
  }
  // Size of what one trash slot holds (links are not followed), bounded so a huge folder cannot stall the listing.
  async function bytesOf(p, budget = { left: 20000 }) {
    let st; try { st = await fs.promises.lstat(p); } catch { return 0; }
    if (!st.isDirectory()) return st.size;
    let n = 0, names = []; try { names = await fs.promises.readdir(p); } catch { return 0; }
    for (const x of names) { if (--budget.left < 0) break; n += await bytesOf(path.join(p, x), budget); }
    return n;
  }
  // Only a slot TERMNEST made (an id folder with info.json inside the trash) is ever removed for good.
  async function ownSlot(trash, id) {
    if (typeof id !== 'string' || !/^[a-z0-9]{6,30}$/.test(id)) return '';
    const home = path.join(trash, id);
    try { const st = await fs.promises.lstat(home); if (!st.isDirectory()) return ''; await fs.promises.access(path.join(home, 'info.json')); return home; } catch { return ''; }
  }
  const fail = (e) => ({ code: e && (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EROFS') ? 'denied' : e && e.code === 'EEXIST' ? 'exists' : 'failed' });
  return async function op({ cwd, op: kind, path: p, name, id, days }) {
    if (typeof cwd !== 'string' || !cwd) return { code: 'invalid' };
    let root; try { root = await fs.promises.realpath(path.resolve(cwd)); } catch { return { code: 'outside' }; }
    const trash = path.join(root, TRASH);
    try {
      if (kind === 'rename') {
        const e = await entry(root, p); if (e.code) return e;
        if (typeof name !== 'string') return { code: 'invalid' };
        const to = name.trim();
        if (!to || to.length > 255 || to === '.' || to === '..' || BAD.test(to)) return { code: 'invalid' };
        const target = path.join(e.parent, to);
        if (target === e.full) return { path: e.full };
        if (path.basename(target) === TRASH) return { code: 'invalid' };
        if (await exists(target)) {   // the same file under another letter case is a rename, not a clash
          const a = await fs.promises.lstat(target); if (!(a.ino && a.ino === e.st.ino && a.dev === e.st.dev)) return { code: 'exists' };
        }
        await fs.promises.rename(e.full, target);
        return { path: target };
      }
      if (kind === 'trash') {
        const e = await entry(root, p); if (e.code) return e;
        const slot = newId(), home = path.join(trash, slot);
        await fs.promises.mkdir(path.join(home, 'data'), { recursive: true });
        try { await fs.promises.writeFile(path.join(trash, '.gitignore'), '*\n', { flag: 'wx' }); } catch { /* already there */ }
        const base = path.basename(e.full);
        await fs.promises.rename(e.full, path.join(home, 'data', base));
        await fs.promises.writeFile(path.join(home, 'info.json'), JSON.stringify({ name: base, rel: posix(path.relative(root, e.full)), at: Date.now(), kind: e.st.isDirectory() ? 'folder' : 'file' }));
        return { id: slot, name: base };
      }
      if (kind === 'list') {
        let slots = []; try { slots = await fs.promises.readdir(trash, { withFileTypes: true }); } catch { return { items: [] }; }
        const items = [];
        for (const d of slots) {
          if (!d.isDirectory()) continue;
          try { const info = JSON.parse(await fs.promises.readFile(path.join(trash, d.name, 'info.json'), 'utf8')); items.push({ id: d.name, name: String(info.name), rel: String(info.rel), at: Number(info.at) || 0, kind: info.kind === 'folder' ? 'folder' : 'file', bytes: await bytesOf(path.join(trash, d.name, 'data')) }); } catch { /* not ours */ }
        }
        items.sort((a, b) => b.at - a.at);
        return { items: items.slice(0, 200), count: items.length, bytes: items.reduce((n, it) => n + it.bytes, 0) };
      }
      if (kind === 'restore') {
        if (typeof id !== 'string' || !/^[a-z0-9]{6,30}$/.test(id)) return { code: 'invalid' };
        const home = path.join(trash, id); let info;
        try { info = JSON.parse(await fs.promises.readFile(path.join(home, 'info.json'), 'utf8')); } catch { return { code: 'notfound' }; }
        const target = path.resolve(root, String(info.rel || ''));
        if (!inside(root, target) || target === root || typeof info.name !== 'string' || BAD.test(info.name)) return { code: 'outside' };
        if (await exists(target)) return { code: 'exists' };
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        if (!inside(root, await fs.promises.realpath(path.dirname(target)))) return { code: 'outside' };
        await fs.promises.rename(path.join(home, 'data', info.name), target);
        await fs.promises.rm(home, { recursive: true, force: true });
        return { path: target, name: info.name };
      }
      if (kind === 'purge') {   // delete one item for good: asked for item by item, after a confirmation on the page
        const home = await ownSlot(trash, id); if (!home) return { code: 'notfound' };
        await fs.promises.rm(home, { recursive: true, force: true });
        return { ok: true };
      }
      if (kind === 'empty' || kind === 'expire') {   // empty the whole trash, or only what has been there longer than the chosen days
        if (kind === 'expire' && !(Number.isInteger(days) && days > 0 && days <= 3650)) return { code: 'invalid' };
        const before = kind === 'expire' ? Date.now() - days * 86400000 : Infinity;
        let slots = []; try { slots = await fs.promises.readdir(trash); } catch { return { removed: 0 }; }
        let removed = 0;
        for (const x of slots) {
          const home = await ownSlot(trash, x); if (!home) continue;
          let at = 0; try { at = Number(JSON.parse(await fs.promises.readFile(path.join(home, 'info.json'), 'utf8')).at) || 0; } catch { continue; }
          if (at < before) { await fs.promises.rm(home, { recursive: true, force: true }); removed++; }
        }
        return { removed };
      }
      return { code: 'invalid' };
    } catch (e) { return fail(e); }
  };
}

// The private folder where "Send file" stores what it received on a machine (see drop.js storeScript): list it and clean it.
// Self-contained so it runs on that machine. Only plain files directly inside that folder are touched.
function tempRuntime() {
  const fs = require('fs'), path = require('path');
  const dir = path.join(process.env.TMPDIR || '/tmp', 'termnest-drop-' + (process.getuid ? process.getuid() : 0));
  const NAME = /^[A-Za-z0-9._-]{1,120}$/;
  async function files() {
    let names = []; try { names = await fs.promises.readdir(dir); } catch { return []; }
    const out = [];
    for (const name of names) {
      if (!NAME.test(name)) continue;
      try { const st = await fs.promises.lstat(path.join(dir, name)); if (st.isFile()) out.push({ name, bytes: st.size, at: st.mtimeMs }); } catch { /* gone meanwhile */ }
    }
    return out.sort((a, b) => b.at - a.at);
  }
  return async function temp({ op, names, days }) {
    try {
      if (op === 'list') { const all = await files(); return { dir, items: all.slice(0, 500), count: all.length, bytes: all.reduce((n, f) => n + f.bytes, 0) }; }
      let pick;
      if (op === 'delete') {
        if (!Array.isArray(names) || !names.length || names.length > 500 || names.some((n) => typeof n !== 'string' || !NAME.test(n))) return { code: 'invalid' };
        const want = new Set(names); pick = (f) => want.has(f.name);
      } else if (op === 'all') pick = () => true;
      else if (op === 'expire') {
        if (!(Number.isInteger(days) && days > 0 && days <= 3650)) return { code: 'invalid' };
        const before = Date.now() - days * 86400000; pick = (f) => f.at < before;
      } else return { code: 'invalid' };
      let removed = 0;
      for (const f of await files()) if (pick(f)) { try { await fs.promises.unlink(path.join(dir, f.name)); removed++; } catch { /* already gone */ } }
      return { removed };
    } catch { return { code: 'failed' }; }
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
  const NAMED = /^(README|LICENSE|Makefile|Dockerfile)/i, HEAVY = ['node_modules', '.git', 'obj', 'bin', 'dist', 'target', '.next', '__pycache__', '.venv', 'venv', '_archive', '.termnest-trash'];
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

// How long "Send file" keeps what it stored (days, 0 = until removed by hand) and how long the trash keeps items (0 = forever).
const CLEANUP_DEFAULT = { tempDays: 1, trashDays: 0 };
const TEMP_CHOICES = [0, 1, 3, 7, 30], TRASH_CHOICES = [0, 7, 14, 30, 90];
function cleanupOf(v) {
  return { tempDays: TEMP_CHOICES.includes(v?.tempDays) ? v.tempDays : CLEANUP_DEFAULT.tempDays,
    trashDays: TRASH_CHOICES.includes(v?.trashDays) ? v.trashDays : CLEANUP_DEFAULT.trashDays };
}
// Read when needed, never at load: the store is still locked while features load.
let settingsOf = () => ({});
const currentCleanup = () => { try { return cleanupOf(settingsOf()); } catch { return { ...CLEANUP_DEFAULT }; } };
const SWEEP_MS = 60 * 60 * 1000;

module.exports = {
  name: 'browse', browseRuntime, indexRuntime, filterIndex, createRuntime, fsopRuntime, tempRuntime, CLEANUP_DEFAULT, cleanupOf, cleanupSettings: () => currentCleanup(),
  register(host) {
    settingsOf = () => host.settings.get();
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
      } catch (e) { host.fail(res, 400, e.message, hostErrorExtra(e, backend)); }
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
      } catch (e) { host.fail(res, 400, e.message, hostErrorExtra(e, backend)); }
    });
    const FSOP_ERRORS = { invalid: 'srv.browse.ten_khong_hop_le', exists: 'srv.browse.da_co_ten_nay', outside: 'srv.browse.chi_tao_trong_thu_muc', denied: 'srv.browse.khong_co_quyen_tao', failed: 'srv.browse.khong_tao_duoc', notfound: 'srv.browse.khong_thay_muc', root: 'srv.browse.khong_thao_tac_goc' };
    const fsop = async (host_, res, id, session, args, failKey) => {
      const backend = host_.backendOf(id);
      if (!backend || !session || session.length > 128) { host_.fail(res, 400, tr('srv.handoff.chua_chon_phien_hop_le')); return null; }
      try {
        const out = await runOnHost(backend, fsopRuntime, { cwd: await sessionCwd(backend, session), ...args });
        if (out.code) { host_.fail(res, 400, tr(out.code === 'failed' && failKey ? failKey : (FSOP_ERRORS[out.code] || FSOP_ERRORS.failed))); return null; }
        for (const k of [...indexes.keys()]) if (k.startsWith(id + '\0')) indexes.delete(k);   // the search index is out of date now
        return out;
      } catch (e) { host_.fail(res, 400, e.message, hostErrorExtra(e, backend)); return null; }
    };
    const body = async (host_, req, res) => { try { return await host_.readJson(req); } catch { host_.fail(res, 400, tr(FSOP_ERRORS.invalid)); return null; } };
    host.route('POST', '/rename', async ({ req, res }) => {
      const b = await body(host, req, res); if (!b) return;
      const out = await fsop(host, res, String(b.server || ''), String(b.session || ''), { op: 'rename', path: b.path, name: b.name }, 'srv.browse.khong_doi_ten_duoc'); if (out) host.send(res, 200, out);
    });
    host.route('POST', '/trash', async ({ req, res }) => {
      const b = await body(host, req, res); if (!b) return;
      const out = await fsop(host, res, String(b.server || ''), String(b.session || ''), { op: 'trash', path: b.path }, 'srv.browse.khong_chuyen_duoc'); if (out) host.send(res, 200, out);
    });
    host.route('POST', '/restore', async ({ req, res }) => {
      const b = await body(host, req, res); if (!b) return;
      const out = await fsop(host, res, String(b.server || ''), String(b.session || ''), { op: 'restore', id: b.id }, 'srv.browse.khong_khoi_phuc_duoc'); if (out) host.send(res, 200, out);
    });
    host.route('POST', '/purge', async ({ req, res }) => {
      const b = await body(host, req, res); if (!b) return;
      const out = await fsop(host, res, String(b.server || ''), String(b.session || ''), { op: 'purge', id: b.id }, 'srv.browse.khong_xoa_duoc'); if (out) host.send(res, 200, out);
    });
    host.route('POST', '/empty', async ({ req, res }) => {
      const b = await body(host, req, res); if (!b) return;
      const out = await fsop(host, res, String(b.server || ''), String(b.session || ''), { op: 'empty' }, 'srv.browse.khong_xoa_duoc'); if (out) host.send(res, 200, out);
    });
    // File tạm: per machine, not per session.
    const temp = async (res, id, args) => {
      const backend = host.backendOf(id);
      if (!backend) { host.fail(res, 400, tr('srv.server.may_chu_chua_ket_noi')); return null; }
      if (backend.mode === 'powershell') { host.fail(res, 400, tr('srv.drop.may_nay_chua_ho_tro')); return null; }
      try {
        const out = await runOnHost(backend, tempRuntime, args);
        if (out.code) { host.fail(res, 400, tr(out.code === 'invalid' ? FSOP_ERRORS.invalid : 'srv.browse.khong_xoa_duoc')); return null; }
        return out;
      } catch (e) { host.fail(res, 400, e.message, hostErrorExtra(e, backend)); return null; }
    };
    host.route('GET', '/temp', async ({ res, url }) => { const out = await temp(res, url.searchParams.get('server') || '', { op: 'list' }); if (out) host.send(res, 200, out); });
    host.route('POST', '/temp', async ({ req, res }) => {
      const b = await body(host, req, res); if (!b) return;
      const out = await temp(res, String(b.server || ''), b.all === true ? { op: 'all' } : { op: 'delete', names: b.names }); if (out) host.send(res, 200, out);
    });
    host.route('GET', '/cleanup', async ({ res }) => host.send(res, 200, currentCleanup()));
    host.route('POST', '/cleanup', async ({ req, res }) => {
      const b = await body(host, req, res); if (!b) return;
      const next = cleanupOf({ ...currentCleanup(), ...b });
      if ((b.tempDays !== undefined && next.tempDays !== b.tempDays) || (b.trashDays !== undefined && next.trashDays !== b.trashDays)) { host.fail(res, 400, tr(FSOP_ERRORS.invalid)); return; }
      host.settings.set(next); host.send(res, 200, next);
    });
    // Once an hour, on every connected machine: temp files and trash items older than the chosen days go. Failures stay quiet
    // (a machine without Node.js is cleaned of temp files by the next upload instead, see drop.js).
    const sweep = async () => {
      const { tempDays, trashDays } = currentCleanup();
      if (!tempDays && !trashDays) return;
      for (const r of host.remotes()) {
        if (!r.ready || r.mode === 'powershell') continue;
        try {
          if (tempDays) await runOnHost(r, tempRuntime, { op: 'expire', days: tempDays });
          if (trashDays) for (const dir of new Set((r.snapshot?.sessions || []).map((s) => s.path).filter(Boolean))) await runOnHost(r, fsopRuntime, { cwd: dir, op: 'expire', days: trashDays });
        } catch { /* next hour */ }
      }
    };
    setTimeout(sweep, 5 * 60 * 1000).unref?.(); setInterval(sweep, SWEEP_MS).unref?.();
    host.route('GET', '/trash', async ({ res, url }) => {
      const out = await fsop(host, res, url.searchParams.get('server') || '', url.searchParams.get('session') || '', { op: 'list' }); if (out) host.send(res, 200, out);
    });
    host.route('GET', '/list', async ({ res, url }) => {
      const backend = host.backendOf(url.searchParams.get('server') || ''), session = url.searchParams.get('session') || '', dir = url.searchParams.get('path') || '';
      if (!backend || !session || session.length > 128) { host.fail(res, 400, tr('srv.handoff.chua_chon_phien_hop_le')); return; }
      try {
        const out = await runOnHost(backend, browseRuntime, { cwd: await sessionCwd(backend, session), dir });
        if (out.error) host.fail(res, 400, out.error); else host.send(res, 200, out);
      } catch (e) { host.fail(res, 400, e.message, hostErrorExtra(e, backend)); }
    });
  },
};
