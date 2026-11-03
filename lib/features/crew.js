'use strict';
const { runOnHost, sessionCwd } = require('../file-viewer');
const { logScript } = require('../crew');
const { shq, claudeSessionId } = require('../parse');

// Crew tracks of the workspace a session lives in, read-only from _crew/tasks on that host (MANIFEST + sentinel files).
const COMPONENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const TTL_MS = 10000;

// Self-contained so it runs on the session's host (see lib/file-viewer.js runOnHost).
function crewRuntime() {
  const fs = require('fs'), path = require('path');
  const FINISHED = ['done', 'closed', 'abandoned', 'archived', 'merged'];
  const exists = async (p) => { try { await fs.promises.access(p); return true; } catch { return false; } };
  async function head(file, n) { const h = await fs.promises.open(file, 'r'); try { const b = Buffer.alloc(n), r = await h.read(b, 0, n, 0); return b.toString('utf8', 0, r.bytesRead); } finally { await h.close(); } }
  const os = require('os');
  const json = async (f, n) => { const h = await fs.promises.open(f, 'r'); try { const st = await h.stat(), len = Math.min(st.size, n), b = Buffer.alloc(len); await h.read(b, 0, len, st.size - len); return b.toString('utf8'); } finally { await h.close(); } };
  // The session's Claude transcript: the file named after its id when Termnest created it, else the newest one in its folder.
  async function transcript(base, cwd, claudeId) {
    let dirs = []; try { dirs = (await fs.promises.readdir(base)).filter((d) => /^\.claude(-[\w.-]+)?$/.test(d)); } catch { /* no home */ }
    let guess = null;
    for (const d of dirs) {
      const projects = path.join(base, d, 'projects');
      if (claudeId) { let subs = []; try { subs = await fs.promises.readdir(projects); } catch { continue; }
        for (const sub of subs) { const f = path.join(projects, sub, claudeId + '.jsonl'); if (await exists(f)) return { file: f, exact: true }; } }
      const dir = path.join(projects, cwd.replace(/[^A-Za-z0-9]/g, '-'));
      try { for (const e of await fs.promises.readdir(dir)) { if (!/\.jsonl$/.test(e)) continue; const f = path.join(dir, e), st = await fs.promises.stat(f); if (Date.now() - st.mtimeMs < 24 * 3600 * 1000 && (!guess || st.mtimeMs > guess.at)) guess = { file: f, at: st.mtimeMs }; } } catch { /* no project folder */ }
    }
    return guess ? { file: guess.file, exact: false } : null;
  }
  return async function read({ cwd, limit, claudeId, home }) {
    if (typeof cwd !== 'string' || !cwd) return { root: '', tasks: [] };
    let dir = path.resolve(cwd), root = '';
    for (let i = 0; i < 8; i++) { if (await exists(path.join(dir, '_crew', 'tasks'))) { root = dir; break; } const up = path.dirname(dir); if (up === dir) break; dir = up; }
    if (!root) return { root: '', tasks: [] };
    const tdir = path.join(root, '_crew', 'tasks'), found = [];
    for (const name of await fs.promises.readdir(tdir)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(name)) continue;
      try { const st = await fs.promises.stat(path.join(tdir, name, 'MANIFEST.md')); found.push({ name, at: st.mtimeMs }); } catch { /* not a task */ }
    }
    found.sort((a, b) => b.at - a.at);
    const tasks = [], now = Date.now();
    let said = '', linked = 'none';
    try { const t = await transcript(typeof home === 'string' && home ? home : os.homedir(), path.resolve(cwd), claudeId); if (t) { said = await json(t.file, 3 * 1024 * 1024); linked = t.exact ? 'exact' : 'guess'; } } catch { /* no transcript */ }
    for (const f of found.slice(0, 60)) {
      const text = await head(path.join(tdir, f.name, 'MANIFEST.md'), 6000), fm = (text.match(/^---\n([\s\S]*?)\n---/) || [])[1] || '';
      const get = (k) => {
        const raw = ((fm.match(new RegExp('^' + k + ':\\s*(.*)$', 'm')) || [])[1] || '').trim();
        // Quoted values are JSON-style, so \u1ea3 escapes become the real character.
        if (raw.startsWith('"')) { try { return JSON.parse(raw); } catch { return raw.replace(/^"(.*)"$/, '$1'); } }
        return raw;
      };
      const status = get('status'), active = !FINISHED.includes(status);
      if (!active && now - f.at > 36 * 3600 * 1000) continue;
      const tracks = []; const re = /\{\s*id:\s*([\w-]+)\s*,\s*state:\s*([\w-]+)(?:\s*,\s*executor:\s*([\w./-]+))?[^}]*\}/g; let m;
      while ((m = re.exec(get('tracks')))) {
        const t = { id: m[1], state: m[2], executor: m[3] || '', reason: '' }, tp = path.join(tdir, f.name, 'tracks', m[1]);
        if (!['merged', 'done'].includes(t.state) && await exists(path.join(tp, 'QUEUED'))) { t.state = 'queued'; try { t.reason = ((await head(path.join(tp, 'QUEUED'), 400)).match(/reason=(.*)/) || [])[1] || ''; } catch { /* unreadable */ } }
        tracks.push(t);
      }
      // Only what is moving: a task with no tracks, or one that is idle and untouched for 2 h, is noise on a session panel.
      const live = tracks.some((t) => ['dispatched', 'queued', 'failed'].includes(t.state));
      const mentioned = !!said && said.includes(f.name);
      if (!tracks.length || (!mentioned && !live && now - f.at > 2 * 3600 * 1000)) continue;
      tasks.push({ task: f.name, mentioned, title: get('title') || f.name, status, updated: get('updated'), tracks: tracks.slice(0, 40) });
      if (tasks.length >= (limit || 8)) break;
    }
    return { root, tasks, linked };
  };
}

module.exports = {
  name: 'crew', crewRuntime, COMPONENT,
  register(host) {
    const cache = new Map();
    async function data(backend, serverId, session) {
      const key = serverId + '|' + session, hit = cache.get(key);
      if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
      const cwd = await sessionCwd(backend, session);
      const value = await runOnHost(backend, crewRuntime, { cwd, limit: 8, claudeId: claudeSessionId(cwd, session) });
      cache.set(key, { at: Date.now(), value }); if (cache.size > 60) cache.delete(cache.keys().next().value);
      return value;
    }
    host.route('GET', '/data', async ({ res, url }) => {
      const serverId = url.searchParams.get('server') || '', session = url.searchParams.get('session') || '', backend = host.backendOf(serverId);
      if (!backend || !session || session.length > 128) { host.fail(res, 400, 'Chưa chọn phiên hợp lệ.'); return; }
      try { host.send(res, 200, await data(backend, serverId, session)); } catch (e) { host.fail(res, 400, e.message); }
    });
    host.route('GET', '/log', async ({ res, url }) => {
      const q = (k) => url.searchParams.get(k) || '', backend = host.backendOf(q('server')), task = q('task'), track = q('track'), session = q('session');
      if (!backend || !session || session.length > 128 || !COMPONENT.test(task) || !COMPONENT.test(track)) { host.fail(res, 400, 'Tên task hoặc track chưa đúng.'); return; }
      if (backend.mode === 'powershell') { host.fail(res, 400, 'Máy này chưa hỗ trợ xem log crew.'); return; }
      try {
        const info = await data(backend, q('server'), session);
        if (!info.root || !info.tasks.some((t) => t.task === task && t.tracks.some((x) => x.id === track))) { host.fail(res, 404, 'Không thấy track này.'); return; }
        const out = await backend.exec(`sh -c ${shq(logScript({ cwd: info.root, task, track }))}`, 15000, 2 * 1024 * 1024);
        if (out.code !== 0) { host.fail(res, 400, 'Không đọc được log an toàn.'); return; }
        const at = out.out.indexOf('\n'), result = at < 0 ? out.out : out.out.slice(0, at);
        host.send(res, 200, { result: ['DONE', 'FAILED'].includes(result) ? result : 'unknown', text: at < 0 ? '' : out.out.slice(at + 1) });
      } catch (e) { host.fail(res, 400, e.message); }
    });
  },
};
