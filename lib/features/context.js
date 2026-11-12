'use strict';
const { runOnHost } = require('../file-viewer');

// How full each AI session's context window is, read from the CLI logs on the session's host (no AI involved):
// Claude logs usage on every assistant message, Codex logs token_count events with the model's window size.
const EVERY_MS = 45000, MAX_SESSIONS = 40, FRESH_MS = 12 * 3600 * 1000, TAIL = 400 * 1024;

// Self-contained so it runs on the session's host (see lib/file-viewer.js runOnHost).
function contextRuntime() {
  const fs = require('fs'), path = require('path'), os = require('os');
  const FRESH = 12 * 3600 * 1000, TAIL_BYTES = 400 * 1024;
  // One pass reads each log tail once, however many sessions share the folder.
  const tails = new Map();
  async function tail(file) {
    if (tails.has(file)) return tails.get(file);
    const lines = await tailRead(file); tails.set(file, lines); return lines;
  }
  async function tailRead(file) {
    const h = await fs.promises.open(file, 'r');
    try { const st = await h.stat(), n = Math.min(st.size, TAIL_BYTES), b = Buffer.alloc(n); await h.read(b, 0, n, st.size - n); return b.toString('utf8').split('\n'); }
    finally { await h.close(); }
  }
  async function head(file) {
    const h = await fs.promises.open(file, 'r');
    try { const b = Buffer.alloc(16384), r = await h.read(b, 0, b.length, 0); return b.toString('utf8', 0, r.bytesRead).split('\n')[0]; }
    finally { await h.close(); }
  }
  const json = (l) => { try { return JSON.parse(l); } catch { return null; } };
  async function newest(dir, re) {
    let best = null;
    try { for (const e of await fs.promises.readdir(dir)) { if (!re.test(e)) continue; const f = path.join(dir, e), st = await fs.promises.stat(f); if (st.isFile() && (!best || st.mtimeMs > best.at)) best = { file: f, at: st.mtimeMs }; } } catch { /* missing dir */ }
    return best;
  }
  // Sentences from the session's own tmux scrollback, minus the CLI's status chrome: used to tell sessions apart.
  const CHROME = /auto mode|shells?\b|esc to|shift\+tab|for shortcuts|Sautéed|Crunched|Churned|Baked|Cooked|✻|⏵|─|╭|╰|│|new task\?|ctrl\+|to cycle|Background|active shell|^❯|\s{2,}running$/i;
  function needlesOf(name, socket) {
    const run = (extra) => { try { return require('child_process').execFileSync('tmux', (socket ? ['-L', socket] : []).concat(['capture-pane', '-p', '-J'], extra, ['-t', '=' + name + ':']), { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 4 * 1024 * 1024 }); } catch { return ''; } };
    // A full-screen Claude lives on tmux's alternate screen: the normal screen then holds only the shell prompts it was started from,
    // so the conversation has to be read from the alternate screen (-a; it fails quietly when the pane has none).
    const text = run(['-S', '-300']) + '\n' + run(['-a']);
    return [...new Set(text.split('\n').map((l) => l.trim()).filter((l) => l.length >= 24 && /[A-Za-zÀ-ỹ]{4}/.test(l) && !CHROME.test(l)).map((l) => l.slice(0, 100)))].slice(-40);
  }
  async function claude(home, cwd, now, who) {
    let dirs = []; try { dirs = (await fs.promises.readdir(home)).filter((d) => /^\.claude(-[\w.-]+)?$/.test(d)); } catch { /* no home */ }
    const cands = [];
    for (const d of dirs) {
      const pdir = path.join(home, d, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
      try { for (const e of await fs.promises.readdir(pdir)) { if (!/\.jsonl$/.test(e)) continue; const f = path.join(pdir, e), st = await fs.promises.stat(f); if (st.isFile() && now - st.mtimeMs < FRESH) cands.push({ file: f, at: st.mtimeMs, dir: path.join(home, d) }); } } catch { /* no project folder */ }
    }
    if (!cands.length) return null;
    cands.sort((a, b) => b.at - a.at);
    let best = cands[0];
    // Several sessions share this folder: the newest log may belong to any of them. Pick the log that contains what this
    // session's screen shows; when no log stands out, show nothing rather than another session's numbers.
    if (who && who.shared > 1 && cands.length > 0) {
      const needles = needlesOf(who.name, who.socket), scored = [];
      for (const c of cands.slice(0, 30)) { const text = (await tail(c.file)).join('\n'); scored.push({ c, score: needles.filter((n) => text.includes(n) || text.includes(JSON.stringify(n).slice(1, -1))).length }); }
      scored.sort((a, b) => b.score - a.score);
      if (!scored.length || scored[0].score < 2 || (scored.length > 1 && scored[0].score === scored[1].score)) return null;
      best = scored[0].c;
    }
    const lines = await tail(best.file);
    // The window is a fact of the model, and Claude Code keeps its own model catalog on disk (cache/model-catalog/*.json, field
    // runtime.max_input_tokens per model id). Read it from the same config folder as the log; if the model is not in it, say so.
    const catalogs = new Map();
    async function catalogFor(file) {
      if (catalogs.has(file)) return catalogs.get(file);
      const found = new Map();
      try {
        const walk = (o, depth) => {
          if (!o || typeof o !== 'object' || depth > 9) return;
          if (Array.isArray(o)) { for (const x of o) walk(x, depth + 1); return; }
          const w = o.runtime && o.runtime.max_input_tokens != null ? o.runtime.max_input_tokens : o.max_input_tokens;
          if (typeof o.id === 'string' && /^claude-/.test(o.id) && Number.isFinite(w) && w > 0 && !found.has(o.id)) found.set(o.id, w);
          for (const k of Object.keys(o)) walk(o[k], depth + 1);
        };
        walk(JSON.parse(await fs.promises.readFile(file, 'utf8')), 0);
      } catch { /* unreadable catalog */ }
      catalogs.set(file, found); return found;
    }
    async function windowFor(model) {
      const cdir = path.join(best.dir, 'cache', 'model-catalog'), files = [];
      try { for (const e of await fs.promises.readdir(cdir)) if (/\.json$/.test(e) && !/floor/.test(e)) { const f = path.join(cdir, e); files.push({ f, at: (await fs.promises.stat(f)).mtimeMs }); } } catch { return { window: null, by: 'unknown' }; }
      files.sort((a, b) => b.at - a.at);
      for (const { f } of files) {
        const map = await catalogFor(f);
        if (map.has(model)) return { window: map.get(model), by: 'catalog' };
        // a dated id such as claude-opus-5-5-20261001 belongs to the catalog entry claude-opus-5-5
        const family = [...map.keys()].filter((id) => String(model).startsWith(id + '-')).sort((a, b) => b.length - a.length)[0];
        if (family) return { window: map.get(family), by: 'catalog' };
      }
      return { window: null, by: 'unknown' };
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      const o = json(lines[i]); const m = o && o.type === 'assistant' && o.message;
      if (!m || !m.usage || !m.model || m.model === '<synthetic>') continue;
      const u = m.usage, ctx = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      if (ctx > 0) { const w = await windowFor(String(m.model)); return { tool: 'claude', ctx, window: w.window, by: w.by, model: String(m.model).replace(/^claude-/, ''), at: best.at }; }
    }
    return null;
  }
  async function codexFiles(home, now) {
    const root = path.join(home, '.codex', 'sessions'), files = [];
    for (let back = 0; back < 3; back++) {
      const d = new Date(now - back * 86400000), dir = path.join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
      try { for (const e of await fs.promises.readdir(dir)) if (/^rollout-.*\.jsonl$/.test(e)) { const f = path.join(dir, e), st = await fs.promises.stat(f); files.push({ file: f, at: st.mtimeMs }); } } catch { /* no such day */ }
    }
    return files.sort((a, b) => b.at - a.at).slice(0, 60);
  }
  async function codex(files, cwd, now) {
    for (const f of files) {
      if (now - f.at > FRESH) break;
      const meta = json(await head(f.file)); if (!meta || !meta.payload || meta.payload.cwd !== cwd) continue;
      const lines = await tail(f.file);
      for (let i = lines.length - 1; i >= 0; i--) {
        const o = json(lines[i]), info = o && o.payload && o.payload.type === 'token_count' && o.payload.info;
        const ctx = info && info.last_token_usage && info.last_token_usage.total_tokens;
        if (ctx > 0 && info.model_context_window > 0) return { tool: 'codex', ctx, window: info.model_context_window, by: 'log', model: '', at: f.at };
      }
    }
    return null;
  }
  return async function read({ sessions, home, socket }) {
    const now = Date.now(), base = typeof home === 'string' && home ? home : os.homedir(), files = await codexFiles(base, now), out = {};
    for (const s of sessions) {
      if (!s || typeof s.name !== 'string' || typeof s.path !== 'string' || !s.path) continue;
      const shared = sessions.filter((x) => x && x.path === s.path).length;
      const found = [await claude(base, s.path, now, { name: s.name, socket, shared }), await codex(files, s.path, now)].filter(Boolean).sort((a, b) => b.at - a.at)[0];
      if (found) out[s.name] = found;
    }
    return out;
  };
}

module.exports = {
  name: 'context', contextRuntime,
  register(host) {
    const cache = new Map(); // serverId -> { at, byName }
    const running = new Set();
    host.onSnapshot((remote, snap) => {
      const id = remote.cfg && remote.cfg.id; if (!id || running.has(id)) return;
      const last = cache.get(id); if (last && Date.now() - last.at < EVERY_MS) return;
      const sessions = (snap.sessions || []).slice(0, MAX_SESSIONS).map((s) => ({ name: s.name, path: s.path }));
      if (!sessions.length || remote.mode === 'powershell') return;
      running.add(id);
      runOnHost(remote, contextRuntime, { sessions, socket: remote.socket || '' })
        .then((byName) => cache.set(id, { at: Date.now(), byName }))
        .catch(() => cache.set(id, { at: Date.now(), byName: (last && last.byName) || {} }))
        .finally(() => running.delete(id));
    });
    host.route('GET', '/data', ({ res }) => {
      const servers = {}; for (const [id, v] of cache) servers[id] = v.byName;
      host.send(res, 200, { at: Date.now(), servers });
    });
  },
};
