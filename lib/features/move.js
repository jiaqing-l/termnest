'use strict';
const { tr } = require('../i18n-server');
const { runOnHost, hostErrorExtra } = require('../file-viewer');

// "Chuyển phiên": carry a Claude/Codex conversation to another connected machine and resume it there.
// Nothing about the other machine is assumed: each side finds its own config folder (HOME, CLAUDE_CONFIG_DIR, CODEX_HOME),
// the working folder on the target is found by the git repository it belongs to (same origin URL), and the old folder
// path inside the conversation is rewritten to the new one. Only the same Claude/Codex account may receive it.

const MAX_BYTES = 40 * 1024 * 1024;
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;

// Self-contained runtimes (run on the machine through runOnHost).
// The signed-in account of a tool on this machine: Claude keeps it in .claude.json, Codex in the id token of auth.json.
function accountRuntime() {
  const fs = require('fs'), path = require('path'), os = require('os');
  return async function account({ tool }) {
    try {
      if (tool === 'claude') {
        const dir = process.env.CLAUDE_CONFIG_DIR;
        const files = dir ? [path.join(dir, '.claude.json')] : [path.join(os.homedir(), '.claude.json'), path.join(os.homedir(), '.claude', '.claude.json')];
        for (const f of files) {
          try { const j = JSON.parse(await fs.promises.readFile(f, 'utf8')); const e = j && j.oauthAccount && j.oauthAccount.emailAddress; if (typeof e === 'string' && e) return { email: e.toLowerCase() }; } catch { /* next */ }
        }
        return { email: '' };
      }
      if (tool === 'codex') {
        const f = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
        const j = JSON.parse(await fs.promises.readFile(f, 'utf8')), t = j && j.tokens && j.tokens.id_token;
        if (typeof t !== 'string') return { email: '' };
        const part = t.split('.')[1] || '', p = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
        return { email: typeof p.email === 'string' ? p.email.toLowerCase() : '' };
      }
    } catch { /* not signed in */ }
    return { email: '' };
  };
}

// The conversation file of a session, and where its folder sits in a git repository (to find the same place elsewhere).
// With max 0 only its size is read.
function sourceRuntime() {
  const fs = require('fs'), path = require('path'), os = require('os');
  async function find(tool, id) {
    if (tool === 'claude') {
      const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
      let best = null;
      for (const d of await fs.promises.readdir(root).catch(() => [])) {
        const f = path.join(root, d, id + '.jsonl');
        try { const st = await fs.promises.stat(f); if (st.isFile() && (!best || st.mtimeMs > best.st.mtimeMs)) best = { f, st, rel: '' }; } catch { /* not here */ }
      }
      return best;
    }
    const root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
    let best = null;
    async function walk(dir, depth) {
      if (depth > 4) return;
      for (const e of await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await walk(p, depth + 1);
        else if (e.isFile() && e.name.endsWith('-' + id + '.jsonl')) { const st = await fs.promises.stat(p); if (!best || st.mtimeMs > best.st.mtimeMs) best = { f: p, st, rel: path.relative(root, p).split(path.sep).join('/') }; }
      }
    }
    await walk(root, 0);
    return best;
  }
  async function repo(dir) {
    let d = dir;
    for (let i = 0; i < 40 && d; i++) {
      try {
        const cfg = await fs.promises.readFile(path.join(d, '.git', 'config'), 'utf8');
        const m = cfg.match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/);
        return { root: d, origin: m ? m[1] : '', sub: path.relative(d, dir).split(path.sep).join('/') };
      } catch { /* go up */ }
      const up = path.dirname(d); if (up === d) break; d = up;
    }
    return { root: '', origin: '', sub: '' };
  }
  return async function source({ tool, id, dir, max }) {
    if (!/^[a-f\d-]{36}$/i.test(id || '') || !['claude', 'codex'].includes(tool)) return { code: 'invalid' };
    const hit = await find(tool, id);
    const where = typeof dir === 'string' && dir.startsWith('/') ? await repo(dir) : { root: '', origin: '', sub: '' };
    if (!hit) return { code: 'notfound', ...where };
    if (!max) return { size: hit.st.size, rel: hit.rel, ...where };
    if (hit.st.size > max) return { code: 'toolarge', size: hit.st.size };
    return { size: hit.st.size, rel: hit.rel, b64: (await fs.promises.readFile(hit.f)).toString('base64'), ...where };
  };
}

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

// The conversation is written through the shell with the bytes on stdin, so its size never meets a command-line limit.
// An existing copy that is as long or longer (the target already went on with it) is kept.
function writeScript(tool, id, rel, dir, shq) {
  const keep = `t="$f.tmp.$$"; cat > "$t" || { rm -f "$t"; exit 5; }; if [ -f "$f" ] && [ "$(wc -c < "$f")" -ge "$(wc -c < "$t")" ]; then rm -f "$t"; echo KEPT; else mv "$t" "$f" && echo WROTE; fi`;
  if (tool === 'claude') {
    return [`d=$(cd ${shq(dir)} 2>/dev/null && pwd -P) || { echo NODIR; exit 3; }`, `c="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects"`,
      // Claude files a conversation under its folder with every character that is not a letter or digit turned into "-".
      `p="$c/$(printf '%s' "$d" | sed 's/[^A-Za-z0-9]/-/g')"`, `mkdir -p "$p" && chmod 700 "$c" "$p" 2>/dev/null; umask 077`, `f="$p/${id}.jsonl"`, keep].join('\n');
  }
  return [`[ -d ${shq(dir)} ] || { echo NODIR; exit 3; }`, `c="\${CODEX_HOME:-$HOME/.codex}/sessions"`, `f="$c/${rel}"`, `mkdir -p "$(dirname "$f")" && chmod 700 "$c" 2>/dev/null; umask 077`, keep].join('\n');
}

// Old folder → new folder inside the conversation, so the agent looks in the right place. JSON-escaped plain paths only.
function rewritePaths(text, from, to) {
  if (!from || !to || from === to || /["\\\n]/.test(from + to) || from.length < 2) return { text, count: 0 };
  let count = 0;
  const out = text.split(from).reduce((acc, part, i) => { if (i) count++; return i ? acc + to + part : part; }, '');
  return { text: out, count };
}

function freeName(base, taken) {
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) { const n = (base.slice(0, 29) + '-' + i); if (!taken.has(n)) return n; }
  return base.slice(0, 24) + '-' + Date.now().toString(36).slice(-6);
}

module.exports = {
  name: 'move', accountRuntime, sourceRuntime, placeRuntime, writeScript, rewritePaths, freeName, MAX_BYTES,
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
      if (!UUID.test(s.aiSessionId || '')) return bad(res, 'srv.move.chua_biet_hoi_thoai');
      return { src, dst, s, tool, id: s.aiSessionId };
    }
    async function survey(res, q) {
      const p = pick(res, q); if (!p) return null;
      try {
        const [a, b, src] = await Promise.all([runOnHost(p.src, accountRuntime, { tool: p.tool }), runOnHost(p.dst, accountRuntime, { tool: p.tool }),
          runOnHost(p.src, sourceRuntime, { tool: p.tool, id: p.id, dir: p.s.path, max: 0 })]);
        if (src.code === 'notfound') return bad(res, 'srv.move.khong_thay_tep_chat');
        const seeds = (p.dst.snapshot?.sessions || []).map((x) => x.path).filter(Boolean);
        const place = await runOnHost(p.dst, placeRuntime, { dir: p.s.path, origin: src.origin, sub: src.sub, seeds }, { timeout: 20000 });
        return { ...p, from: a.email, to: b.email, size: src.size, rel: src.rel, origin: src.origin, root: src.root, sub: src.sub, places: place.places, home: place.home };
      } catch (e) { return bad(res, 'srv.move.khong_doc_duoc', [e.message], hostErrorExtra(e, p.dst)); }
    }
    host.route('GET', '/check', async ({ res, url }) => {
      const q = Object.fromEntries(url.searchParams), v = await survey(res, q); if (!v) return;
      const taken = new Set((v.dst.snapshot?.sessions || []).map((x) => x.name));
      host.send(res, 200, { tool: v.tool, from: v.from, to: v.to, same: !!v.from && v.from === v.to, size: v.size, tooLarge: v.size > MAX_BYTES,
        source: v.s.path, repo: v.origin ? { origin: v.origin, sub: v.sub } : null, places: v.places, home: v.home, name: freeName(v.s.name, taken) });
    });
    host.route('POST', '/run', async ({ req, res }) => {
      let b; try { b = await host.readJson(req); } catch { host.fail(res, 400, tr('srv.move.khong_doc_duoc', [''])); return; }
      const v = await survey(res, b); if (!v) return;
      if (!v.from || !v.to) { bad(res, 'srv.move.chua_dang_nhap', [v.tool === 'codex' ? 'Codex' : 'Claude']); return; }
      if (v.from !== v.to) { bad(res, 'srv.move.khac_tai_khoan', [v.from, v.to]); return; }
      const dir = typeof b.dir === 'string' && b.dir.startsWith('/') && b.dir.length <= 1024 && !/[\x00-\x1f]/.test(b.dir) ? b.dir : '';
      if (!dir) { bad(res, 'srv.move.chon_thu_muc'); return; }
      const name = typeof b.name === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(b.name) ? b.name : '';
      if (!name) { bad(res, 'srv.server.ten_chi_dung_chu_khong'); return; }
      if ((v.dst.snapshot?.sessions || []).some((x) => x.name === name)) { bad(res, 'srv.server.ten_nay_da_co'); return; }
      try {
        const got = await runOnHost(v.src, sourceRuntime, { tool: v.tool, id: v.id, dir: v.s.path, max: MAX_BYTES }, { timeout: 90000, maxBuffer: MAX_BYTES * 2 });
        if (got.code === 'toolarge') { bad(res, 'srv.move.qua_lon', [Math.round(got.size / 1048576)]); return; }
        if (got.code) { bad(res, 'srv.move.khong_thay_tep_chat'); return; }
        // The old working folder (the repository root when there is one, else the session folder) becomes the new one.
        const inRepo = got.root && (!got.sub || dir.endsWith('/' + got.sub));
        const fromRoot = inRepo ? got.root : v.s.path, toRoot = inRepo && got.sub ? dir.slice(0, -(got.sub.length + 1)) : dir;
        const moved = b.rewrite === false ? { text: null, count: 0 } : rewritePaths(Buffer.from(got.b64, 'base64').toString('utf8'), fromRoot, toRoot);
        const bytes = moved.text === null ? Buffer.from(got.b64, 'base64') : Buffer.from(moved.text, 'utf8');
        const out = await v.dst.exec(`sh -c ${host.shq(writeScript(v.tool, v.id, got.rel, dir, host.shq))}`, 90000, 64 * 1024, bytes);
        if (/NODIR/.test(out.out || '')) { bad(res, 'srv.server.khong_thay_thu_muc_nay'); return; }
        if (out.code !== 0) { bad(res, 'srv.move.khong_ghi_duoc'); return; }
        await host.sessions.start(v.dst, { name, dir, run: v.tool, restoring: true, resume: v.id });
        let stopped = false;
        if (b.stop === true) stopped = await host.sessions.stop(v.src, v.s.name).catch(() => false);
        host.send(res, 200, { ok: true, name, dir, bytes: bytes.length, rewritten: moved.count, kept: /KEPT/.test(out.out || ''), stopped });
      } catch (e) { bad(res, 'srv.move.khong_doc_duoc', [e.message], hostErrorExtra(e, v.dst)); }
    });
  },
};
