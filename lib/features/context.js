'use strict';
const { runOnHost } = require('../file-viewer');

// How full each AI session's context window is, read from the CLI logs on the session's host (no AI involved):
// Claude logs usage on every assistant message, Codex logs token_count events with the model's window size.
const EVERY_MS = 45000, MAX_SESSIONS = 40, FRESH_MS = 12 * 3600 * 1000, TAIL = 400 * 1024;

// Self-contained so it runs on the session's host (see lib/file-viewer.js runOnHost).
function contextRuntime() {
  const fs = require('fs'), path = require('path'), os = require('os');
  const FRESH = 12 * 3600 * 1000, TAIL_BYTES = 400 * 1024;
  async function tail(file) {
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
  async function claude(home, cwd, now) {
    let best = null;
    let dirs = []; try { dirs = (await fs.promises.readdir(home)).filter((d) => /^\.claude(-[\w.-]+)?$/.test(d)); } catch { /* no home */ }
    for (const d of dirs) {
      const c = await newest(path.join(home, d, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-')), /\.jsonl$/);
      if (c && now - c.at < FRESH && (!best || c.at > best.at)) best = c;
    }
    if (!best) return null;
    const lines = await tail(best.file);
    for (let i = lines.length - 1; i >= 0; i--) {
      const o = json(lines[i]); const m = o && o.type === 'assistant' && o.message;
      if (!m || !m.usage || !m.model || m.model === '<synthetic>') continue;
      const u = m.usage, ctx = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      if (ctx > 0) return { tool: 'claude', ctx, window: ctx > 200000 ? 1000000 : 200000, model: String(m.model).replace(/^claude-/, ''), at: best.at };
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
        if (ctx > 0 && info.model_context_window > 0) return { tool: 'codex', ctx, window: info.model_context_window, model: '', at: f.at };
      }
    }
    return null;
  }
  return async function read({ sessions, home }) {
    const now = Date.now(), base = typeof home === 'string' && home ? home : os.homedir(), files = await codexFiles(base, now), out = {};
    for (const s of sessions) {
      if (!s || typeof s.name !== 'string' || typeof s.path !== 'string' || !s.path) continue;
      const found = [await claude(base, s.path, now), await codex(files, s.path, now)].filter(Boolean).sort((a, b) => b.at - a.at)[0];
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
      runOnHost(remote, contextRuntime, { sessions })
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
