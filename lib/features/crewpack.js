'use strict';
const { tr } = require('../i18n-server');
const { runOnHost } = require('../file-viewer');
const { keysScript } = require('../keys');
const detect = require('../crew-detect');

// Optional "Xspire Crew" pack. It turns itself on only for sessions whose working folder sits under a `_crew/tasks` folder, and
// only reads files the crew kit writes: `_crew/nudge.conf` (tmux pane ↔ task), each task's MANIFEST.md front matter, its
// tracks' ROUNDS.tsv and its `watch/heartbeat`. It runs no crew script and copies no crew rule; with no `_crew` it shows nothing.
// The ops-audit button appears only when Claude Code reports the skill enabled for that folder (see the plugins feature).
const EVERY_MS = 2 * 60 * 1000, FINAL = ['done', 'closed', 'abandoned', 'archived', 'merged'], OPEN_TRACK = ['pending', 'queued', 'dispatched', 'running', 'fix', 'review', 'blocked'];
const AUDIT_SESSION = 'tn-ops-audit', AUDIT_SKILL = 'xspire-crew-ops-audit';

// Runs on the host (locally or over SSH through node). Reads only; returns small summaries.
function crewRuntime() {
  const fs = require('fs'), path = require('path');
  const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
  const read = (p, n) => { try { const fd = fs.openSync(p, 'r'); try { const b = Buffer.alloc(n), k = fs.readSync(fd, b, 0, n, 0); return b.toString('utf8', 0, k); } finally { fs.closeSync(fd); } } catch { return ''; } };
  return async function scan({ cwds, days }) {
    const roots = new Set();
    for (const cwd of cwds || []) {
      let dir = path.resolve(String(cwd || '/'));
      for (let i = 0; i < 8; i++) { if (exists(path.join(dir, '_crew', 'tasks'))) { roots.add(dir); break; } const up = path.dirname(dir); if (up === dir) break; dir = up; }
    }
    const out = [];
    for (const root of roots) {
      const crew = path.join(root, '_crew'), nudge = [];
      for (const line of read(path.join(crew, 'nudge.conf'), 65536).split('\n')) { const f = line.trim().split(/\s+/); if (f.length >= 2 && /^%\d+$/.test(f[0]) && /^[A-Za-z0-9][\w-]{0,127}$/.test(f[1])) nudge.push([f[0], f[1]]); }
      const enrolled = new Set(nudge.map((x) => x[1])), tasks = [];
      let names = []; try { names = fs.readdirSync(path.join(crew, 'tasks')).filter((n) => /^[A-Za-z0-9][\w-]{0,127}$/.test(n)); } catch { /* none */ }
      for (const name of names) {
        const dir = path.join(crew, 'tasks', name), mf = path.join(dir, 'MANIFEST.md');
        let st; try { st = fs.statSync(mf); } catch { continue; }
        if (!enrolled.has(name) && Date.now() - st.mtimeMs > days * 86400000) continue;
        const head = read(mf, 16384), front = (head.split(/^---\s*$/m)[1] || '');
        const val = (k) => { const m = new RegExp('^' + k + ':\\s*(.*)$', 'm').exec(front); return m ? m[1].trim().replace(/^"(.*)"$/, '$1') : ''; };
        const tracks = [];
        for (const m of (val('tracks') || '').matchAll(/\{\s*id:\s*([\w-]+)\s*,\s*state:\s*([\w-]+)/g)) {
          const rounds = read(path.join(dir, 'tracks', m[1], 'ROUNDS.tsv'), 65536).split('\n').filter((l) => /^\d+\t/.test(l));
          const last = rounds.length ? rounds[rounds.length - 1].split('\t') : [];
          tracks.push({ id: m[1], state: m[2], rounds: rounds.length, fixRounds: rounds.filter((l) => l.split('\t')[6] === 'fix').length, lastEnd: Date.parse(last[2] || '') || 0 });
        }
        const hb = read(path.join(dir, 'watch', 'heartbeat'), 512), hm = /pid=(\d+)/.exec(hb), at = /at=(\S+)/.exec(hb);
        let alive = false; if (hm) { try { process.kill(Number(hm[1]), 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; } }
        const budget = /max_fix_rounds:\s*(\d+)/.exec(front);
        let title = val('title'); try { title = JSON.parse('"' + title.replace(/"/g, '\\"') + '"'); } catch { /* as written */ }
        tasks.push({ id: name, title: title.slice(0, 160), status: val('status'), updated: Date.parse(val('updated')) || Math.round(st.mtimeMs), blocked: /^(null|~|)$/.test(val('blocked')) ? '' : val('blocked').slice(0, 200),
          maxFix: budget ? Number(budget[1]) : 0, tracks, heartbeat: { armed: !!hm, alive, at: at ? Date.parse(at[1]) || 0 : 0 } });
      }
      out.push({ root, nudge, tasks });
    }
    return { roots: out };
  };
}

// Findings with the ops-audit categories: BLOCKER (work cannot go on), WASTE (resources held for nothing), DRIFT (the crew's
// own discipline slipped), INFO. Pure: crew data + the machine's sessions (pane ids and the agent's own status).
function classify(crew, sessions, now, opts = {}) {
  const idleMin = opts.idleMin || 20, out = [];
  const byPane = new Map(); for (const s of sessions || []) for (const p of s.paneIds || []) byPane.set(p, s);
  for (const root of crew.roots || []) {
    const owner = new Map(); for (const [pane, task] of root.nudge) if (byPane.has(pane)) owner.set(task, byPane.get(pane));
    for (const t of root.tasks) {
      const s = owner.get(t.id), enrolled = root.nudge.some((x) => x[1] === t.id), final = FINAL.includes(t.status);
      const add = (cat, code, params) => out.push({ key: root.root + '|' + t.id + '|' + code, cat, code, task: t.id, title: t.title, root: root.root, session: s ? s.name : '', params: params || [] });
      if (final) { if (enrolled) add('WASTE', 'done_enrolled'); continue; }
      if (t.blocked) add('BLOCKER', 'blocked', [t.blocked]);
      for (const k of t.tracks) {
        if (k.state === 'failed') add('BLOCKER', 'track_failed', [k.id]);
        else if (t.maxFix && k.fixRounds >= t.maxFix && OPEN_TRACK.includes(k.state)) add('BLOCKER', 'out_of_rounds', [k.id, k.fixRounds, t.maxFix]);
      }
      const open = t.tracks.filter((k) => OPEN_TRACK.includes(k.state));
      const st = s && s.aiStatus, idleFor = st && st.status === 'idle' && !st.parked ? Math.round((now - st.at) / 60000) : 0;
      if (s && open.length && idleFor >= idleMin) add('BLOCKER', 'leader_asleep', [s.name, idleFor, open.length]);
      if (s && open.length && idleFor >= idleMin && !(t.heartbeat.armed && t.heartbeat.alive)) add('DRIFT', 'no_heartbeat', [s.name]);
      if (!enrolled && open.length) add('DRIFT', 'not_enrolled', [open.length]);
      if (open.length && !out.some((f) => f.task === t.id && f.root === root.root)) add('INFO', 'running', [open.length, t.tracks.length]);
    }
  }
  const rank = { BLOCKER: 0, WASTE: 1, DRIFT: 2, INFO: 3 };
  return out.sort((a, b) => rank[a.cat] - rank[b.cat]);
}

module.exports = {
  name: 'crewpack', crewRuntime, classify, AUDIT_SKILL,
  register(host) {
    const state = new Map(), running = new Set(), pendingAudit = new Map();
    const settings = () => { try { return host.settings.get(); } catch { return {}; } };
    const save = (patch) => host.settings.set({ ...settings(), ...patch });
    const cwds = (r) => [...new Set(((r.snapshot && r.snapshot.sessions) || []).map((s) => s.aiCwd || s.path).filter((c) => typeof c === 'string' && c.length < 400))].slice(0, 30);
    async function scan(r) {
      const id = r.cfg.id; if (running.has(id) || r.mode === 'powershell' || settings().off) return; running.add(id);
      try {
        const res = await runOnHost(r, crewRuntime, { cwds: cwds(r), days: 3 }, { timeout: 20000 });
        state.set(id, { at: Date.now(), roots: res.roots || [] }); detect.mark(id, (res.roots || []).length > 0);
      } catch (e) { state.set(id, { at: Date.now(), roots: [], error: e.message }); }
      finally { running.delete(id); }
    }
    host.onSnapshot((r) => {
      const id = r.cfg && r.cfg.id; if (!id) return;
      const st = state.get(id); if (!st || Date.now() - st.at > EVERY_MS) scan(r);
      // An audit session asked for: type the skill call once Claude reports idle in it (it just started).
      const want = pendingAudit.get(id);
      if (want) {
        const s = ((r.snapshot && r.snapshot.sessions) || []).find((x) => x.name === AUDIT_SESSION);
        if (s && s.aiStatus && s.aiStatus.tool === 'claude' && s.aiStatus.status === 'idle' && !s.aiStatus.parked) {
          pendingAudit.delete(id);
          r.exec(keysScript(`=${AUDIT_SESSION}:`, want.prompt, true)).then(() => {
            const log = (settings().audits || []).concat([{ at: Date.now(), server: id, root: want.root, why: want.why }]).slice(-30); save({ audits: log });
          }).catch((e) => host.log(`ops-audit prompt failed: ${e.message}`));
        } else if (Date.now() - want.at > 10 * 60 * 1000) pendingAudit.delete(id);
      }
      // Scheduled audit: every N hours when switched on, never while one is still open.
      const every = Number(settings().auditHours) || 0;
      if (every > 0 && st && st.roots.length && !pendingAudit.has(id)) {
        const last = (settings().audits || []).filter((a) => a.server === id).map((a) => a.at).sort().pop() || 0;
        const open = ((r.snapshot && r.snapshot.sessions) || []).some((x) => x.name === AUDIT_SESSION);
        if (!open && Date.now() - last > every * 3600000) startAudit(r, st.roots[0].root, 'schedule').catch((e) => host.log(`scheduled ops-audit failed: ${e.message}`));
      }
    });
    async function startAudit(r, root, why) {
      if (!((r.snapshot && r.snapshot.sessions) || []).some((x) => x.name === AUDIT_SESSION)) await host.sessions.start(r, { name: AUDIT_SESSION, dir: root, run: 'claude' });
      pendingAudit.set(r.cfg.id, { at: Date.now(), root, why, prompt: '/xspire-devkit:' + AUDIT_SKILL });
    }
    host.route('GET', '/data', ({ res }) => {
      const servers = [];
      for (const r of host.remotes()) {
        if (!r.cfg) continue; const st = state.get(r.cfg.id); if (!st || !st.roots.length) continue;
        servers.push({ id: r.cfg.id, local: !!r.cfg.local, name: r.cfg.name || r.cfg.host || r.cfg.id, scanned: st.at, roots: st.roots.map((x) => ({ root: x.root, tasks: x.tasks.length, enrolled: x.nudge.length })),
          findings: classify(st, (r.snapshot && r.snapshot.sessions) || [], Date.now()), auditOpen: ((r.snapshot && r.snapshot.sessions) || []).some((x) => x.name === AUDIT_SESSION), auditPending: pendingAudit.has(r.cfg.id) });
      }
      host.send(res, 200, { servers, auditHours: Number(settings().auditHours) || 0, audits: (settings().audits || []).slice(-10).reverse(), skill: AUDIT_SKILL });
    });
    // Start the ops-audit skill in a visible Claude session in the crew root. The page shows the button only when Claude Code
    // reports the skill enabled there; the session itself is the result (watch it, answer it, read its report).
    host.route('POST', '/audit', async ({ req, res }) => {
      const b = await host.readJson(req), r = host.backendOf(String(b.server || '')), st = r && state.get(r.cfg.id);
      const root = st && st.roots.find((x) => x.root === b.root);
      if (!r || !root) { host.fail(res, 404, tr('srv.server.khong_tim_thay')); return; }
      try { await startAudit(r, root.root, 'manual'); } catch (e) { host.fail(res, 400, e.message); return; }
      host.send(res, 200, { session: AUDIT_SESSION });
    });
    host.route('POST', '/schedule', async ({ req, res }) => { const b = await host.readJson(req), h = Math.max(0, Math.min(48, Number(b.hours) || 0)); save({ auditHours: h }); host.send(res, 200, { auditHours: h }); });
  },
};
