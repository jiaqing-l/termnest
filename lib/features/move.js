'use strict';
const { tr } = require('../i18n-server');
const { runOnHost, hostErrorExtra } = require('../file-viewer');

// "Chuyển phiên": carry a Claude/Codex conversation to another connected machine and resume it there.
// Nothing about the other machine is assumed: each side finds its own config folder (HOME, CLAUDE_CONFIG_DIR, CODEX_HOME),
// the working folder on the target is found by the git repository it belongs to (same origin URL), and the old folder
// path inside the conversation is rewritten to the new one. Only the same Claude/Codex account may receive it.

const MAX_BYTES = 40 * 1024 * 1024;
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;

// Serialized as one closed runtime so source, recent, account and write share the same path rules.
function profileRuntime(operation) {
  const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
  const F = fs.promises, HOME = os.homedir(), CAP = 40 * 1024 * 1024;
  const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
  const clean = p => typeof p === 'string' && p.startsWith('/') && p.length <= 1024 && path.normalize(p) === p && !/[\x00-\x1f\x7f]/.test(p);
  const fail = code => { throw Object.assign(new Error(code), { code }); };
  async function directory(p, create = false) {
    if (!clean(p)) fail('unsafe');
    let d = '/';
    for (const n of p.split('/').filter(Boolean)) {
      d = path.join(d, n);
      if (create) await F.mkdir(d, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
      const st = await F.lstat(d); if (!st.isDirectory() || st.isSymbolicLink()) fail('unsafe');
    }
  }
  async function read(file, max) {
    await directory(path.dirname(file));
    const h = await F.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const st = await h.stat();
      if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid()) fail('unsafe');
      if (st.size > max) fail('toolarge');
      const b = Buffer.alloc(st.size + 1); let n = 0;
      while (n < b.length) { const r = await h.read(b, n, b.length - n, n); if (!r.bytesRead) break; n += r.bytesRead; }
      const after = await h.stat(), named = await F.lstat(file);
      if (n !== st.size || st.ino !== named.ino || st.dev !== named.dev || after.size !== st.size || after.mtimeMs !== st.mtimeMs || after.ctimeMs !== st.ctimeMs) fail('changed');
      return b.subarray(0, n);
    } finally { await h.close(); }
  }
  async function profiles(tool, selected) {
    const base = tool === 'claude' ? '.claude' : '.codex', env = process.env[tool === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'];
    const defaultPath = env ? path.resolve(env) : path.join(HOME, base);
    const names = (await F.readdir(HOME, { withFileTypes: true })).filter(e => e.name.startsWith(base) && /^[A-Za-z0-9_.-]+$/.test(e.name)).map(e => e.name);
    if (names.length > 64) fail('scanlimit');
    const dirs = [...new Set([defaultPath, ...names.sort().map(n => path.join(HOME, n))])];
    const all = [];
    for (const p of dirs) { try { await directory(p); all.push(p); } catch (e) { if (p === defaultPath && e.code === 'ENOENT') all.push(p); } }
    if (selected !== undefined && selected !== '') {
      if (!clean(selected) && !/^\.(?:claude|codex)[A-Za-z0-9_.-]*$/.test(selected)) fail('profile');
      const p = clean(selected) ? selected : path.join(HOME, selected);
      if (!all.includes(p)) fail('profile');
      return { all: [p], defaultPath };
    }
    return { all, defaultPath };
  }
  const profileMode = (tool, p) => tool === 'claude' && p === path.join(HOME, '.claude') ? 'default' : 'config';
  async function account(tool, profile) {
    const { all, defaultPath } = await profiles(tool, profile); const p = profile ? all[0] : defaultPath;
    if (!all.includes(p)) fail('profile');
    // No discovery operation reads auth. Only the selected profile reaches this function.
    const mode = profileMode(tool, p);
    async function emailAt(file) {
      try {
        const j = JSON.parse((await read(file, 1024 * 1024)).toString('utf8'));
        let email = j?.oauthAccount?.emailAddress;
        if (tool === 'codex') { const t = j?.tokens?.id_token; email = typeof t === 'string' ? JSON.parse(Buffer.from(t.split('.')[1] || '', 'base64url').toString('utf8')).email : ''; }
        if (typeof email === 'string' && email.length <= 320 && /^[^\s@]+@[^\s@]+$/.test(email)) return email.toLowerCase();
      } catch { /* no verified identity here */ }
      return '';
    }
    // The normal CLI reads HOME/.claude.json only when CLAUDE_CONFIG_DIR is unset.
    // Never use the nested file as a fallback, or silently choose between conflicting accounts.
    const email = await emailAt(mode === 'default' ? path.join(HOME, '.claude.json') : path.join(p, tool === 'claude' ? '.claude.json' : 'auth.json'));
    if (mode === 'default') {
      const nested = await emailAt(path.join(p, '.claude.json'));
      if (email && nested && email !== nested) fail('account');
    }
    return { email, profile: p, mode };
  }
  async function chats(tool, selected, id, dir) {
    const { all } = await profiles(tool, selected), out = []; let visited = 0;
    const deadline = Date.now() + 5000;
    async function entries(d) {
      if (++visited > 10000 || Date.now() > deadline) fail('scanlimit');
      try { await directory(d); const es = await F.readdir(d, { withFileTypes: true }); visited += es.length; if (visited > 10000) fail('scanlimit'); return es; }
      catch (e) { if (['ENOENT', 'ENOTDIR', 'EACCES', 'unsafe'].includes(e.code)) return []; throw e; }
    }
    async function add(file, profile, rel, match) {
      if (++visited > 10000 || Date.now() > deadline) fail('scanlimit');
      if (!match || id && match[1].toLowerCase() !== id.toLowerCase()) return;
      const st = await F.lstat(file).catch(() => null);
      if (!st?.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== process.getuid()) return;
      out.push({ id: match[1], profile, rel, f: file, size: st.size, at: st.mtimeMs, fingerprint: [st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs].join(':') });
    }
    const re = /(?:^|-)([a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})\.jsonl$/i;
    for (const profile of all) {
      if (tool === 'claude') {
        const root = path.join(profile, 'projects');
        const folders = id ? (await entries(root)).filter(e => e.isDirectory()).map(e => e.name) : [dir, await F.realpath(dir).catch(() => dir)].map(d => d.replace(/[^A-Za-z0-9]/g, '-'));
        for (const d of new Set(folders)) {
          const folder = path.join(root, d);
          if (id) { await directory(folder); await add(path.join(folder, id + '.jsonl'), profile, '', [null, id]); }
          else for (const e of await entries(folder)) if (e.isFile()) await add(path.join(folder, e.name), profile, '', e.name.match(re));
        }
      } else {
        for (const kind of ['sessions', 'archived_sessions']) {
          const root = path.join(profile, kind);
          async function walk(d, depth) {
            for (const e of await entries(d)) {
              const p = path.join(d, e.name);
              if (e.isDirectory() && depth < 4) await walk(p, depth + 1);
              else if (e.isFile()) await add(p, profile, path.relative(root, p).split(path.sep).join('/'), e.name.match(re));
            }
          }
          await walk(root, 0);
        }
      }
    }
    return out;
  }
  async function prefix(file, max) {
    await directory(path.dirname(file)); const h = await F.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try { const st = await h.stat(); if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid()) fail('unsafe'); const b = Buffer.alloc(Math.min(max, st.size)); const r = await h.read(b, 0, b.length, 0); return b.subarray(0, r.bytesRead).toString('utf8'); } finally { await h.close(); }
  }
  async function repo(dir) {
    for (let d = dir, i = 0; clean(d) && i < 40; i++) {
      try { const cfg = (await read(path.join(d, '.git', 'config'), 1024 * 1024)).toString('utf8'); const m = cfg.match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/); return { root: d, origin: m ? m[1] : '', sub: path.relative(d, dir).split(path.sep).join('/') }; } catch { /* ascend */ }
      const up = path.dirname(d); if (up === d) break; d = up;
    }
    return { root: '', origin: '', sub: '' };
  }
  return async function operationOnHost(a) {
    try {
      const { tool, profile } = a; if (!['claude', 'codex'].includes(tool)) return { code: 'invalid' };
      if (operation === 'account') return await account(tool, profile);
      if (operation === 'profiles') { const p = await profiles(tool, profile); const selected = profile ? p.all[0] : p.defaultPath; if (!p.all.includes(selected)) fail('profile'); return { profiles: p.all, profile: selected }; }
      if (operation === 'verify') {
        // Stopping the source needs a live target process with this exact id, cwd and profile.
        // A successful tmux send alone only proves delivery to a shell.
        if (process.platform !== 'linux' || !uuid.test(a.id || '') || !/^[A-Za-z0-9_-]{1,32}$/.test(a.name || '')) return { verified: false };
        const cp = require('child_process');
        const pane = Number(cp.execFileSync('tmux', ['display-message', '-p', '-t', '=' + a.name + ':', '#{pane_pid}'], { encoding: 'utf8', timeout: 3000, maxBuffer: 4096 }).trim());
        if (!Number.isSafeInteger(pane) || pane < 1) return { verified: false };
        const table = cp.execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8', timeout: 3000, maxBuffer: 262144 }).trim().split('\n').map(l => l.trim().split(/\s+/).map(Number));
        const parents = new Map(table);
        async function procPart(pid, name, max) {
          const h = await F.open('/proc/' + pid + '/' + name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
          try { const b = Buffer.alloc(max + 1); const r = await h.read(b, 0, b.length, 0); if (r.bytesRead > max) fail('unsafe'); return b.subarray(0, r.bytesRead).toString('utf8'); } finally { await h.close(); }
        }
        for (const [pid] of table) {
          let p = pid, related = false;
          for (let n = 0; n < 64 && p > 1; n++) { if (p === pane) { related = true; break; } p = parents.get(p) || 0; }
          if (!related || pid === pane) continue;
          try {
            if ((await F.stat('/proc/' + pid)).uid !== process.getuid()) continue;
            const args = (await procPart(pid, 'cmdline', 16384)).split('\0');
            const flag = tool === 'claude' ? '--resume' : 'resume', at = args.indexOf(flag);
            if (!args.slice(0, 2).some(v => path.basename(v) === tool) || at < 0 || args[at + 1] !== a.id) continue;
            if (await F.realpath('/proc/' + pid + '/cwd') !== a.dir) continue;
            const envName = tool === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
            const env = (await procPart(pid, 'environ', 131072)).split('\0'), value = env.find(v => v.startsWith(envName + '='));
            const mode = profileMode(tool, profile);
            if (a.mode && a.mode !== mode) continue;
            if (mode === 'default' ? (!value || value === envName + '=') && env.includes('HOME=' + HOME) : value === envName + '=' + profile) return { verified: true };
          } catch { /* process exited or identity cannot be proved */ }
        }
        return { verified: false };
      }
      if (operation === 'write') {
        if (!uuid.test(a.id || '') || !clean(a.dir)) fail('invalid');
        const who = await account(tool, profile); if (!who.email || who.email !== a.email) fail('account');
        if (a.mode && who.mode !== a.mode) fail('account');
        await directory(a.dir);
        const p = who.profile, rel = a.rel;
        if (tool === 'codex' && (typeof rel !== 'string' || !rel || rel.length > 240 || rel.split('/').some(n => !/^[A-Za-z0-9_.-]+$/.test(n) || n === '.' || n === '..') || !rel.endsWith('-' + a.id + '.jsonl'))) fail('invalid');
        const folder = tool === 'claude' ? path.join(p, 'projects', a.dir.replace(/[^A-Za-z0-9]/g, '-')) : path.dirname(path.join(p, 'sessions', rel));
        const file = tool === 'claude' ? path.join(folder, a.id + '.jsonl') : path.join(p, 'sessions', rel);
        const copies = await chats(tool, p, a.id, a.dir);
        if (copies.some(c => c.f !== file)) fail('collision');
        await directory(folder, true);
        const chunks = []; let length = 0;
        for await (const chunk of process.stdin) { length += chunk.length; if (length > CAP) fail('toolarge'); chunks.push(chunk); }
        const bytes = Buffer.concat(chunks, length);
        if (length !== a.size || crypto.createHash('sha256').update(bytes).digest('hex') !== a.digest) fail('changed');
        try {
          const existing = await read(file, CAP);
          if (existing.length >= bytes.length && existing.subarray(0, bytes.length).equals(bytes)) return { kept: true, verified: true, size: bytes.length };
          fail('collision');
        } catch (e) { if (e.code !== 'ENOENT') throw e; }
        const tmp = path.join(folder, '.move-' + crypto.randomBytes(12).toString('hex'));
        try {
          await F.writeFile(tmp, bytes, { mode: 0o600, flag: 'wx' });
          await directory(folder); await F.link(tmp, file); // exclusive publication: a racing existing chat is never replaced
        } finally { await F.unlink(tmp).catch(() => {}); }
        const saved = await read(file, CAP);
        if (!saved.equals(bytes)) fail('changed');
        return { kept: false, verified: true, size: saved.length };
      }
      if (!clean(a.dir) || operation === 'source' && !uuid.test(a.id || '')) return { code: 'invalid' };
      const hits = await chats(tool, profile, operation === 'source' ? a.id : null, a.dir);
      if (operation === 'source') {
        if (!hits.length) return { code: 'notfound', ...await repo(a.dir) };
        if (hits.length !== 1) return { code: 'ambiguous' };
        const c = hits[0], { f, ...value } = c;
        if (!a.max) return { ...value, ...await repo(a.dir) };
        const max = Math.min(CAP, a.max); if (c.size > max) return { code: 'toolarge', size: c.size };
        const bytes = await read(f, max);
        const st = await F.lstat(f); if ([st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs].join(':') !== c.fingerprint) fail('changed');
        return { ...value, b64: bytes.toString('base64'), ...await repo(a.dir) };
      }
      hits.sort((a, b) => b.at - a.at); const items = [];
      for (const c of hits.slice(0, tool === 'codex' ? 60 : 200)) {
        const text = await prefix(c.f, 262144).catch(() => '');
        if (tool === 'codex') { try { const first = JSON.parse(text.split('\n')[0]); if ((first.payload?.cwd || first.cwd) !== a.dir) continue; } catch { continue; } }
        let ask = '';
        for (const line of text.split('\n')) {
          let j; try { j = JSON.parse(line); } catch { continue; }
          const m = j.message || j.payload || {};
          if (j.type !== 'user' && m.role !== 'user' && m.type !== 'user_message') continue;
          let v = m.content === undefined ? m.message : m.content;
          if (Array.isArray(v)) v = v.map(x => x?.text || x?.input_text || '').join(' ');
          v = String(v || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          if (v && !/^(Caveat:|\/|<command|This session is being continued)/i.test(v)) { ask = v.slice(0, 160); break; }
        }
        const { f, fingerprint, ...value } = c; items.push({ ...value, ask }); if (items.length >= Math.min(12, a.limit || 8)) break;
      }
      return { items };
    } catch (e) { return { code: ['invalid', 'unsafe', 'profile', 'scanlimit', 'changed', 'toolarge', 'collision', 'account', 'EEXIST'].includes(e.code) ? e.code : 'unavailable' }; }
  };
}
// Each wrapper remains self-contained when runOnHost serializes it.
const runtime = op => new Function('return function ' + op + 'Runtime(){return (' + profileRuntime.toString() + ')(' + JSON.stringify(op) + ');}')();
const sourceRuntime = runtime('source'), recentRuntime = runtime('recent'), accountRuntime = runtime('account'), profilesRuntime = runtime('profiles'), writeRuntime = runtime('write'), verifyRuntime = runtime('verify');

// On the target: where should this conversation live? The same path if it exists; otherwise a git repository with the same
// origin (found among the session folders there and below the home folder, a few levels deep), plus the same sub-folder.
function placeRuntime() {
  const fs = require('fs'), path = require('path'), os = require('os');
  const SKIP = new Set(['node_modules', '.git', 'Library', '.cache', '.npm', '.cargo', '.rustup', 'snap', 'proc', 'sys', '.local', '.vscode-server', 'venv', '.venv']);
  const norm = (u) => String(u || '').trim().toLowerCase().replace(/^[a-z+]+:\/\//, '').replace(/^[^@/]+@/, '').replace(/^([^/:]+):(?!\d+\/)/, '$1/').replace(/:\d+\//, '/').replace(/\.git$/, '').replace(/\/+$/, '');
  const isDir = async (p) => { try { return (await fs.promises.stat(p)).isDirectory(); } catch { return false; } };
  async function originOf(root) {
    try { const m = (await fs.promises.readFile(path.join(root, '.git', 'config'), 'utf8')).match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/); return m ? m[1] : ''; } catch { return ''; }
  }
  return async function place({ dir, origin, sub, seeds }) {
    const out = [], seen = new Set();
    const add = async (p, why) => { if (p && !seen.has(p) && await isDir(p)) { seen.add(p); out.push({ path: p, why }); } };
    // The same repository comes first: a folder with the same path can be another project on that machine.
    const want = norm(origin);
    if (want) {
      const roots = new Set();
      const consider = async (p) => { if (roots.size < 2000 && p && await isDir(path.join(p, '.git'))) roots.add(p); };
      for (const s of Array.isArray(seeds) ? seeds.slice(0, 50) : []) {
        let d = s; for (let i = 0; i < 12 && typeof d === 'string' && d.startsWith('/'); i++) { await consider(d); const up = path.dirname(d); if (up === d) break; d = up; }
      }
      const started = Date.now();
      async function walk(d, depth) {
        if (depth > 4 || Date.now() - started > 4000) return;
        let entries; try { entries = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; }
        if (entries.some((e) => e.name === '.git')) roots.add(d);
        for (const e of entries) if (e.isDirectory() && !SKIP.has(e.name) && !(e.name.startsWith('.') && depth > 0)) await walk(path.join(d, e.name), depth + 1);
      }
      await walk(os.homedir(), 0);
      for (const r of roots) {
        if (norm(await originOf(r)) !== want) continue;
        const inner = sub ? path.join(r, ...String(sub).split('/').filter((x) => x && x !== '..')) : r;
        await add(await isDir(inner) ? inner : r, 'repo');
        if (out.length >= 6) break;
      }
    }
    if (typeof dir === 'string' && dir.startsWith('/') && (!want || !out.length || norm(await originOf(dir)) === want)) await add(dir, 'same');
    return { home: os.homedir(), places: out };
  };
}

// Bytes arrive only on stdin; the remote runtime enforces the cap and publishes without replacement.
function writeScript(tool, id, rel, dir, shq, profile, email, bytes, mode) {
  const a = { tool, id, rel, dir, profile, email, mode, size: bytes.length, digest: require('crypto').createHash('sha256').update(bytes).digest('hex') };
  return 'node -e ' + shq('(' + writeRuntime.toString() + ')()(' + JSON.stringify(a) + ').then(v=>{process.stdout.write(JSON.stringify(v));if(!v.verified)process.exitCode=5;}).catch(()=>process.exitCode=5);');
}

// Old folder → new folder inside the conversation, so the agent looks in the right place. JSON-escaped plain paths only.
function rewritePaths(text, from, to) {
  if (!from || !to || from === to || /["\\\n]/.test(from + to) || from.length < 2) return { text, count: 0 };
  const input = Buffer.from(text), old = Buffer.from(from), next = Buffer.from(to);
  let count = 0, offset = 0, at, length = input.length;
  while ((at = input.indexOf(old, offset)) !== -1) {
    count++; offset = at + old.length; length += next.length - old.length;
    if (length > MAX_BYTES) return { text: null, count, tooLarge: true };
  }
  const out = Buffer.alloc(length); let read = 0, written = 0;
  while ((at = input.indexOf(old, read)) !== -1) {
    written += input.copy(out, written, read, at); written += next.copy(out, written); read = at + old.length;
  }
  input.copy(out, written, read);
  return { text: out.toString('utf8'), count };
}

function freeName(base, taken) {
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) { const n = (base.slice(0, 29) + '-' + i); if (!taken.has(n)) return n; }
  return base.slice(0, 24) + '-' + Date.now().toString(36).slice(-6);
}

module.exports = {
  name: 'move', accountRuntime, sourceRuntime, recentRuntime, profilesRuntime, writeRuntime, verifyRuntime, placeRuntime, writeScript, rewritePaths, freeName, MAX_BYTES,
  register(host) {
    const bad = (res, key, params, extra) => { host.fail(res, 400, tr(key, params), extra); return null; };
    // Source session and target machine, both connected, both able to run the conversation.
    function pick(res, q) {
      const src = host.backendOf(String(q.server || '')), dst = host.backendOf(String(q.to || ''));
      if (!src || !dst) return bad(res, 'srv.server.may_chu_chua_ket_noi');
      if (src === dst) return bad(res, 'srv.move.chon_may_khac');
      if (src.mode === 'powershell' || dst.mode === 'powershell') return bad(res, 'srv.drop.may_nay_chua_ho_tro');
      const s = (src.snapshot?.sessions || []).find((x) => x.name === q.session);
      if (!s) return bad(res, 'srv.file.khong_thay_phien');
      const tool = s.aiTool || (/codex/i.test(s.cmd || '') ? 'codex' : /claude|^\d+\.\d+\.\d+$/i.test(s.cmd || '') ? 'claude' : '');
      if (!tool) return bad(res, 'srv.move.khong_phai_agent');
      // The id TERMNEST read from the running agent; else one the user picked from the folder's recent chats.
      const id = UUID.test(String(q.id || '')) ? String(q.id) : UUID.test(s.aiSessionId || '') ? s.aiSessionId : null;
      return { src, dst, s, tool, id };
    }
    const receipts = new Map();
    const identity = p => JSON.stringify([p.src.cfg.id, p.dst.cfg.id, p.s.name, p.s.path, p.s.created, p.s.aiPid, p.s.aiSessionId, p.s.aiStatus?.startedAt, p.s.aiStatus?.cfg]);
    async function survey(res, q) {
      const p = pick(res, q); if (!p) return null;
      try {
        const trusted = p.tool === 'claude' ? p.s.aiStatus?.cfg : undefined;
        const profile = trusted || q.profile || undefined;
        if (q.id && (!UUID.test(String(q.id)) || p.s.aiSessionId && q.id !== p.s.aiSessionId)) return bad(res, 'srv.move.khong_thay_tep_chat');
        if (!p.id && p.tool === 'claude') {
          const own = require('../parse').claudeSessionId(p.s.path, p.s.name), seen = await runOnHost(p.src, sourceRuntime, { tool: p.tool, id: own, dir: p.s.path, profile, max: 0 });
          if (!seen.code) p.id = own;
        }
        if (!p.id || q.id && !p.s.aiSessionId) {
          const r = await runOnHost(p.src, recentRuntime, { tool: p.tool, dir: p.s.path, profile, limit: 12 });
          if (r.code) return bad(res, 'srv.move.khong_thay_tep_chat', null, { code: r.code });
          if (!p.id) return { ...p, pickList: r.items || [] };
          if (!r.items.some(c => c.id === p.id && (!q.profile || c.profile === q.profile || c.profile.endsWith('/' + q.profile)))) return bad(res, 'srv.move.khong_thay_tep_chat');
        }
        const src = await runOnHost(p.src, sourceRuntime, { tool: p.tool, id: p.id, dir: p.s.path, profile, max: 0 });
        if (src.code) return bad(res, 'srv.move.khong_thay_tep_chat', null, { code: src.code });
        if (trusted && q.profile && q.profile !== src.profile && q.profile !== trusted) return bad(res, 'srv.move.khong_thay_tep_chat');
        const target = await runOnHost(p.dst, profilesRuntime, { tool: p.tool, profile: q.targetProfile || undefined });
        if (target.code) return bad(res, 'srv.move.khong_thay_tep_chat', null, { code: target.code });
        const [a, b] = await Promise.all([runOnHost(p.src, accountRuntime, { tool: p.tool, profile: src.profile }), runOnHost(p.dst, accountRuntime, { tool: p.tool, profile: target.profile })]);
        const seeds = (p.dst.snapshot?.sessions || []).map(x => x.path).filter(Boolean);
        const place = await runOnHost(p.dst, placeRuntime, { dir: p.s.path, origin: src.origin, sub: src.sub, seeds }, { timeout: 20000 });
        // The profile list carries names only, never credentials or identity from unselected profiles.
        const choices = await runOnHost(p.dst, profilesRuntime, { tool: p.tool });
        return { ...p, from: a.email || '', to: b.email || '', size: src.size, rel: src.rel, fingerprint: src.fingerprint,
          sourceMode: a.mode, targetMode: b.mode,
          profile: src.profile, targetProfile: target.profile, targetProfiles: choices.profiles || [], origin: src.origin, root: src.root, sub: src.sub, places: place.places, home: place.home };
      } catch (e) { return bad(res, 'srv.move.khong_doc_duoc', [''], hostErrorExtra(e, p.dst)); }
    }
    host.route('GET', '/check', async ({ res, url }) => {
      const q = Object.fromEntries(url.searchParams), v = await survey(res, q); if (!v) return;
      if (v.pickList) { host.send(res, 200, { tool: v.tool, pick: v.pickList, source: v.s.path }); return; }
      const receipt = require('crypto').randomBytes(24).toString('hex');
      for (const [k, v] of receipts) if (v.until < Date.now()) receipts.delete(k);
      if (receipts.size >= 100) receipts.delete(receipts.keys().next().value);
      receipts.set(receipt, { until: Date.now() + 300000, identity: identity(v), id: v.id, profile: v.profile, targetProfile: v.targetProfile, sourceMode: v.sourceMode, targetMode: v.targetMode, from: v.from, to: v.to, fingerprint: v.fingerprint });
      const taken = new Set((v.dst.snapshot?.sessions || []).map((x) => x.name));
      host.send(res, 200, { tool: v.tool, from: v.from, to: v.to, same: !!v.from && v.from === v.to, size: v.size, tooLarge: v.size > MAX_BYTES,
        source: v.s.path, id: v.id, profile: v.profile, targetProfile: v.targetProfile, sourceMode: v.sourceMode, targetMode: v.targetMode, targetProfiles: v.targetProfiles, receipt, repo: v.origin ? { origin: v.origin, sub: v.sub } : null, places: v.places, home: v.home, name: freeName(v.s.name, taken) });
    });
    host.route('POST', '/run', async ({ req, res }) => {
      let b; try { b = await host.readJson(req); } catch { host.fail(res, 400, tr('srv.move.khong_doc_duoc', [''])); return; }
      const v = await survey(res, b); if (!v) return;
      const sourceIdentity = identity(v);
      if ((b.profile || b.targetProfile) && !b.receipt) { bad(res, 'srv.move.khong_thay_tep_chat', null, { code: 'stale' }); return; }
      if (b.receipt) {
        const old = receipts.get(b.receipt);
        if (!old || old.until < Date.now() || old.identity !== identity(v) || ['id', 'profile', 'targetProfile', 'sourceMode', 'targetMode', 'from', 'to', 'fingerprint'].some(k => old[k] !== v[k])) { bad(res, 'srv.move.khong_thay_tep_chat', null, { code: 'stale' }); return; }
        receipts.delete(b.receipt);
      }
      if (v.pickList) { bad(res, 'srv.move.chua_biet_hoi_thoai'); return; }
      if (!v.from || !v.to) { bad(res, 'srv.move.chua_dang_nhap', [v.tool === 'codex' ? 'Codex' : 'Claude']); return; }
      if (v.from !== v.to) { bad(res, 'srv.move.khac_tai_khoan', [v.from, v.to]); return; }
      const dir = typeof b.dir === 'string' && b.dir.startsWith('/') && b.dir.length <= 1024 && !/[\x00-\x1f]/.test(b.dir) ? b.dir : '';
      if (!dir) { bad(res, 'srv.move.chon_thu_muc'); return; }
      const name = typeof b.name === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(b.name) ? b.name : '';
      if (!name) { bad(res, 'srv.server.ten_chi_dung_chu_khong'); return; }
      if ((v.dst.snapshot?.sessions || []).some((x) => x.name === name)) { bad(res, 'srv.server.ten_nay_da_co'); return; }
      try {
        const got = await runOnHost(v.src, sourceRuntime, { tool: v.tool, id: v.id, dir: v.s.path, profile: v.profile, max: MAX_BYTES }, { timeout: 90000, maxBuffer: MAX_BYTES * 2 });
        if (got.code === 'toolarge') { bad(res, 'srv.move.qua_lon', [Math.round(got.size / 1048576)]); return; }
        if (got.code || got.profile !== v.profile || got.fingerprint !== v.fingerprint) { bad(res, 'srv.move.khong_thay_tep_chat'); return; }
        // The old working folder (the repository root when there is one, else the session folder) becomes the new one.
        const inRepo = got.root && (!got.sub || dir.endsWith('/' + got.sub));
        const fromRoot = inRepo ? got.root : v.s.path, toRoot = inRepo && got.sub ? dir.slice(0, -(got.sub.length + 1)) : dir;
        const moved = b.rewrite === false ? { text: null, count: 0 } : rewritePaths(Buffer.from(got.b64, 'base64').toString('utf8'), fromRoot, toRoot);
        if (moved.tooLarge) { bad(res, 'srv.move.qua_lon', [40]); return; }
        const bytes = moved.text === null ? Buffer.from(got.b64, 'base64') : Buffer.from(moved.text, 'utf8');
        if (bytes.length > MAX_BYTES) { bad(res, 'srv.move.qua_lon', [Math.ceil(bytes.length / 1048576)]); return; }
        if ((v.dst.snapshot?.sessions || []).some(s => s.aiSessionId === v.id)) { bad(res, 'srv.move.khong_ghi_duoc'); return; }
        // Recheck both selected identities immediately before target side effects.
        const sourceAccount = await runOnHost(v.src, accountRuntime, { tool: v.tool, profile: v.profile });
        if (sourceAccount.email !== v.from || sourceAccount.profile !== v.profile || sourceAccount.mode !== v.sourceMode) { bad(res, 'srv.move.chua_dang_nhap', [v.tool]); return; }
        const out = await v.dst.exec(writeScript(v.tool, v.id, got.rel, dir, host.shq, v.targetProfile, v.to, bytes, v.targetMode), 90000, 65536, bytes);
        let saved; try { saved = JSON.parse(out.out); } catch { /* failed write */ }
        if (out.code !== 0 || !saved?.verified || saved.size !== bytes.length) { bad(res, 'srv.move.khong_ghi_duoc', null, { code: saved?.code || 'write' }); return; }
        const targetAccount = await runOnHost(v.dst, accountRuntime, { tool: v.tool, profile: v.targetProfile });
        if (targetAccount.email !== v.to || targetAccount.profile !== v.targetProfile || targetAccount.mode !== v.targetMode) { bad(res, 'srv.move.chua_dang_nhap', [v.tool]); return; }
        async function sourceUnchanged() {
          const who = await runOnHost(v.src, accountRuntime, { tool: v.tool, profile: v.profile });
          if (who.email !== v.from || who.profile !== v.profile || who.mode !== v.sourceMode) return false;
          const latest = await runOnHost(v.src, sourceRuntime, { tool: v.tool, id: v.id, dir: v.s.path, profile: v.profile, max: 0 });
          const current = (v.src.snapshot?.sessions || []).find(s => s.name === v.s.name);
          return !latest.code && latest.id === v.id && latest.profile === v.profile && latest.fingerprint === v.fingerprint && current && identity({ ...v, s: current }) === sourceIdentity;
        }
        const stale = () => bad(res, 'srv.move.khong_thay_tep_chat', null, { code: 'stale', incomplete: true, stopped: false });
        // A copy of an earlier prefix is not a complete move if the source continued during upload.
        if (!await sourceUnchanged()) { stale(); return; }
        // startSession has no config option. Bind the shell command to the exact verified account mode.
        await host.sessions.start(v.dst, { name, dir, run: 'shell', restoring: true });
        const env = v.tool === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
        const config = v.targetMode === 'default' ? `-u ${env}` : `${env}=${host.shq(v.targetProfile)}`;
        const command = `env ${config} ${v.tool} ${v.tool === 'claude' ? '--resume' : 'resume'} ${host.shq(v.id)}`;
        const launched = await v.dst.exec(`tmux send-keys -t ${host.shq('=' + name + ':')} ${host.shq(command)} Enter`);
        if (launched.code !== 0) { bad(res, 'srv.move.khong_ghi_duoc'); return; }
        let stopped = false;
        if (b.stop === true) {
          const proof = await runOnHost(v.dst, verifyRuntime, { tool: v.tool, id: v.id, name, dir, profile: v.targetProfile, mode: v.targetMode }).catch(() => ({}));
          // Recheck after the process proof too: source activity must never turn opt-in stop into data loss.
          if (!await sourceUnchanged()) { stale(); return; }
          if (proof.verified === true) stopped = await host.sessions.stop(v.src, v.s.name).catch(() => false);
        }
        host.send(res, 200, { ok: true, name, dir, bytes: bytes.length, rewritten: moved.count, kept: saved.kept, stopped });
      } catch (e) { bad(res, 'srv.move.khong_doc_duoc', [''], hostErrorExtra(e, v.dst)); }
    });
  },
};
