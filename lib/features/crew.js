'use strict';
const { tr } = require('../i18n-server');
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
  // The session's Claude transcript: the file named after its id when Termnest created it; otherwise the one in the folder
  // that contains the most lines currently on the session's screen. A tie or a single weak hit is "unknown", never a guess.
  async function transcript(base, cwd, claudeId, needles) {
    let dirs = []; try { dirs = (await fs.promises.readdir(base)).filter((d) => /^\.claude(-[\w.-]+)?$/.test(d)); } catch { /* no home */ }
    const files = [];
    for (const d of dirs) {
      const projects = path.join(base, d, 'projects');
      if (claudeId) { let subs = []; try { subs = await fs.promises.readdir(projects); } catch { continue; }
        for (const sub of subs) { const f = path.join(projects, sub, claudeId + '.jsonl'); if (await exists(f)) return { text: await json(f, 3 * 1024 * 1024), how: 'exact' }; } }
      const dir = path.join(projects, cwd.replace(/[^A-Za-z0-9]/g, '-'));
      try { for (const e of await fs.promises.readdir(dir)) { if (!/\.jsonl$/.test(e)) continue; const f = path.join(dir, e), st = await fs.promises.stat(f); if (Date.now() - st.mtimeMs < 24 * 3600 * 1000) files.push({ f, at: st.mtimeMs }); } } catch { /* no project folder */ }
    }
    if (!needles || !needles.length) return null;
    files.sort((a, b) => b.at - a.at);
    const scored = [];
    for (const c of files.slice(0, 12)) {
      const text = await json(c.f, 3 * 1024 * 1024);
      scored.push({ name: path.basename(c.f), at: c.at, text, score: needles.filter((n) => text.includes(n) || text.includes(JSON.stringify(n).slice(1, -1))).length });
    }
    scored.sort((a, b) => b.score - a.score);
    const ok = scored.length && scored[0].score >= 2 && (scored.length === 1 || scored[0].score > scored[1].score);
    return ok ? { text: scored[0].text, how: 'match', evidence: { hits: scored[0].score, runnerUp: scored[1] ? scored[1].score : 0, needles: needles.length, files: scored.slice(0, 4).map((x) => ({ file: x.name.slice(0, 8), hits: x.score, at: new Date(x.at).toISOString().slice(11, 16) })) } } : null;
  }
  return async function read({ cwd, limit, claudeId, home, needles, session, socket }) {
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
    let said = '', linked = 'none', evidence = null;
    if (!needles && typeof session === 'string' && session) {
      // Sentences from the session's own scrollback (joined, so wrapped lines are whole), minus the CLI's status chrome.
      const CHROME = /auto mode|shells?\b|esc to|shift\+tab|for shortcuts|Sautéed|Crunched|Churned|Baked|Cooked|✻|⏵|─|╭|╰|│|new task\?|ctrl\+|to cycle|Background|active shell|^❯|\s{2,}running$/i;
      let text = ''; try { text = require('child_process').execFileSync('tmux', (socket ? ['-L', socket] : []).concat(['capture-pane', '-p', '-J', '-S', '-300', '-t', '=' + session + ':']), { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 4 * 1024 * 1024 }); } catch { /* no tmux */ }
      needles = [...new Set(text.split('\n').map((l) => l.trim()).filter((l) => l.length >= 24 && /[A-Za-zÀ-ỹ]{4}/.test(l) && !CHROME.test(l)).map((l) => l.slice(0, 100)))].slice(-40);
    }
    try { const t = await transcript(typeof home === 'string' && home ? home : os.homedir(), path.resolve(cwd), claudeId, needles); if (t) { said = t.text; linked = t.how; evidence = t.evidence || null; } } catch { /* no transcript */ }
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
      // "Worked on" means it ran crew commands for the task (crew-task.sh / crew-dispatch.sh ... <task>), not merely read about it.
      const count = said ? (said.match(new RegExp('crew-[a-z-]+\\.sh[^\\n"]{0,240}' + f.name, 'g')) || []).length : 0, mentioned = count >= 1;
      if (!tracks.length || (!mentioned && !live && now - f.at > 2 * 3600 * 1000)) continue;
      tasks.push({ task: f.name, mentioned, mentions: count, title: get('title') || f.name, status, updated: get('updated'), tracks: tracks.slice(0, 40) });
      if (tasks.length >= (limit || 8)) break;
    }
    // State files the session itself worked with (snapshot, tracker, index, status): paths found in its log that exist below the root.
    const stateFiles = [];
    if (said) {
      const counts = new Map();
      for (const m of said.slice(-1.5 * 1024 * 1024).matchAll(/[A-Za-z0-9_.\/-]{3,200}\.md/g)) if (/(CONTEXT-SNAPSHOT|IMPLEMENTATION-TRACKING|TRACKING|SNAPSHOT|00-INDEX|STATUS|MANIFEST)/i.test(m[0])) counts.set(m[0], (counts.get(m[0]) || 0) + 1);
      const seen = new Set();
      for (const [p0, n] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
        for (const cand of [p0, path.join('docs', p0)]) {
          const abs = path.resolve(root, cand), rel = path.relative(root, abs);
          if (rel.startsWith('..') || path.isAbsolute(rel) || seen.has(rel)) continue;
          try { const st = await fs.promises.stat(abs); if (st.isFile()) { seen.add(rel); stateFiles.push({ path: rel.split(path.sep).join('/'), at: st.mtimeMs, mentions: n }); break; } } catch { /* not there */ }
        }
        if (stateFiles.length >= 8) break;
      }
      stateFiles.sort((a, b) => b.at - a.at);
    }
    return { root, tasks, linked, evidence, stateFiles };
  };
}

// Lines worth matching against a transcript: real sentences from the pane, not the CLI's own status chrome.
const CHROME = /auto mode|shells?\b|esc to|shift\+tab|for shortcuts|Sautéed|Crunched|Churned|Baked|Cooked|✻|⏵|─|╭|╰|│|new task\?|ctrl\+|to cycle|Background|active shell|^❯|\s{2,}running$/i;
function needlesOf(backend, session) {
  const s = backend.snapshot && Array.isArray(backend.snapshot.sessions) ? backend.snapshot.sessions.find((x) => x.name === session) : null;
  return ((s && s.lines) || []).map((l) => String(l).trim()).filter((l) => l.length >= 24 && l.length <= 160 && /[A-Za-zÀ-ỹ]{4}/.test(l) && !CHROME.test(l)).slice(-10);
}

// One uncached read of what a session has worked on (used by the hand-over check as well as the panel).
async function fetchCrew(backend, session) {
  const cwd = await sessionCwd(backend, session);
  return runOnHost(backend, crewRuntime, { cwd, limit: 8, claudeId: claudeSessionId(cwd, session), session, socket: backend.socket || '' });
}

module.exports = {
  name: 'crew', needlesOf, crewRuntime, COMPONENT, fetchCrew,
  register(host) {
    const cache = new Map();
    async function data(backend, serverId, session) {
      const key = serverId + '|' + session, hit = cache.get(key);
      if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
      const cwd = await sessionCwd(backend, session);
      const value = await runOnHost(backend, crewRuntime, { cwd, limit: 8, claudeId: claudeSessionId(cwd, session), session, socket: backend.socket || '' });
      cache.set(key, { at: Date.now(), value }); if (cache.size > 60) cache.delete(cache.keys().next().value);
      return value;
    }
    host.route('GET', '/data', async ({ res, url }) => {
      const serverId = url.searchParams.get('server') || '', session = url.searchParams.get('session') || '', backend = host.backendOf(serverId);
      if (!backend || !session || session.length > 128) { host.fail(res, 400, tr('srv.handoff.chua_chon_phien_hop_le')); return; }
      try { host.send(res, 200, await data(backend, serverId, session)); } catch (e) { host.fail(res, 400, e.message); }
    });
    host.route('GET', '/log', async ({ res, url }) => {
      const q = (k) => url.searchParams.get(k) || '', backend = host.backendOf(q('server')), task = q('task'), track = q('track'), session = q('session');
      if (!backend || !session || session.length > 128 || !COMPONENT.test(task) || !COMPONENT.test(track)) { host.fail(res, 400, tr('srv.server.ten_task_hoac_track_chua')); return; }
      if (backend.mode === 'powershell') { host.fail(res, 400, tr('srv.crew.may_nay_chua_ho_tro')); return; }
      try {
        const info = await data(backend, q('server'), session);
        if (!info.root || !info.tasks.some((t) => t.task === task && t.tracks.some((x) => x.id === track))) { host.fail(res, 404, tr('srv.crew.khong_thay_track_nay')); return; }
        const out = await backend.exec(`sh -c ${shq(logScript({ cwd: info.root, task, track }))}`, 15000, 2 * 1024 * 1024);
        if (out.code !== 0) { host.fail(res, 400, tr('srv.backend.khong_doc_duoc_log_an')); return; }
        const at = out.out.indexOf('\n'), result = at < 0 ? out.out : out.out.slice(0, at);
        host.send(res, 200, { result: ['DONE', 'FAILED'].includes(result) ? result : 'unknown', text: at < 0 ? '' : out.out.slice(at + 1) });
      } catch (e) { host.fail(res, 400, e.message); }
    });
  },
};
