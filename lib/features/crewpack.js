'use strict';
const { runOnHost } = require('../file-viewer');
const { keysScript } = require('../keys');
const detect = require('../crew-detect');
const { CrewSupervisor, reportRuntime, online, idle, identity } = require('../crew-supervisor');

// Optional "Xspire Crew" pack. Supervision is explicitly enabled; it discovers/retains workspace roots and
// reads the crew kit files: `_crew/nudge.conf` (tmux pane ↔ task), each task's MANIFEST.md front matter, its
// tracks' ROUNDS.tsv and its `watch/heartbeat`. It runs no crew script and copies no crew rule; with no `_crew` it shows nothing.
// The ops-audit button appears only when Claude Code reports the skill enabled for that folder (see the plugins feature).
const FINAL = ['done', 'closed', 'abandoned', 'archived', 'merged'], OPEN_TRACK = ['pending', 'queued', 'dispatched', 'running', 'fix', 'review', 'blocked'];
const AUDIT_SESSION = 'tn-ops-audit', AUDIT_SKILL = 'xspire-crew-ops-audit';

// Runs on the host (locally or over SSH through node). Reads only; returns small summaries.
function crewRuntime() {
  const fs = require('fs'), path = require('path');
  const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
  const read = (p, n, tail = false) => { try { const fd = fs.openSync(p, 'r'); try { const at = tail ? Math.max(0, fs.fstatSync(fd).size - n) : 0, b = Buffer.alloc(n), k = fs.readSync(fd, b, 0, n, at), text = b.toString('utf8', 0, k); return at ? text.slice(text.indexOf('\n') + 1) : text; } finally { fs.closeSync(fd); } } catch { return ''; } };
  const remotes = new Map();
  function remoteOf(dir) {
    if (remotes.has(dir)) return remotes.get(dir);
    let v = ''; try { v = require('child_process').execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* not a repo */ }
    // Never pass on credentials a remote may carry (https://user:token@host/…).
    v = v.replace(/^(\w+:\/\/)[^@/]+@/, '$1');
    remotes.set(dir, v); return v;
  }
  return async function scan({ cwds, roots: registered = [], days }) {
    const roots = new Set(registered.filter((r) => typeof r === 'string' && path.isAbsolute(r) && exists(path.join(r, '_crew', 'tasks'))));
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
        const head = read(mf, 16384), front = (head.split(/^---\s*$/m)[1] || '');
        const val = (k) => { const m = new RegExp('^' + k + ':\\s*(.*)$', 'm').exec(front); return m ? m[1].trim().replace(/^"(.*)"$/, '$1') : ''; };
        // An old mtime never hides an open task. Only final history has a lookback window.
        if (!enrolled.has(name) && ['done', 'closed', 'abandoned', 'archived', 'merged'].includes(val('status')) && Date.now() - st.mtimeMs > (days || 3) * 86400000) continue;
        const tracks = [];
        for (const m of (val('tracks') || '').matchAll(/\{\s*id:\s*([\w-]+)\s*,\s*state:\s*([\w-]+)/g)) {
          const roundsFile = path.join(dir, 'tracks', m[1], 'ROUNDS.tsv');
          const rounds = read(roundsFile, 65536).split('\n').filter((l) => /^\d+\t/.test(l));
          // Keep observing the latest result even after the bounded legacy round summary fills up.
          const tail = read(roundsFile, 65536, true).split('\n').filter((l) => /^\d+\t/.test(l));
          const last = tail.length ? tail[tail.length - 1].split('\t') : [];
          // The track's repo and branch, as crew wrote them in tracks/<id>/BASE (repo=…, branch=…).
          const base = read(path.join(dir, 'tracks', m[1], 'BASE'), 2048), bv = (k) => { const x = new RegExp('^' + k + '=(.*)$', 'm').exec(base); return x ? x[1].trim() : ''; };
          const repo = /^[\w./-]{1,200}$/.test(bv('repo')) && !bv('repo').includes('..') ? bv('repo') : '', branch = /^[\w./-]{1,200}$/.test(bv('branch')) ? bv('branch') : '';
          tracks.push({ id: m[1], state: m[2], rounds: rounds.length, fixRounds: rounds.filter((l) => l.split('\t')[6] === 'fix').length, lastEnd: Date.parse(last[2] || '') || 0, lastRound: last.length ? { round: last[0], endedAt: last[2] || '', result: last[4] || '', kind: last[6] || '' } : null, repo, branch, remote: repo ? remoteOf(path.join(root, repo)) : '' });
        }
        const hb = read(path.join(dir, 'watch', 'heartbeat'), 512), hm = /pid=(\d+)/.exec(hb), at = /at=(\S+)/.exec(hb);
        let alive = false; if (hm) { try { process.kill(Number(hm[1]), 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; } }
        const budget = /max_fix_rounds:\s*(\d+)/.exec(front);
        let title = val('title'); try { title = JSON.parse('"' + title.replace(/"/g, '\\"') + '"'); } catch { /* as written */ }
        tasks.push({ id: name, title: title.slice(0, 160), status: val('status'), updated: Date.parse(val('updated')) || Math.round(st.mtimeMs), blocked: /^(null|~|)$/.test(val('blocked')) ? '' : val('blocked').slice(0, 200),
          maxFix: budget ? Number(budget[1]) : 0, tracks, heartbeat: { armed: !!hm, alive, at: at ? Date.parse(at[1]) || 0 : 0 } });
      }
      // Crew kit version on this machine: the commit of scripts/crew (empty when it is not a git checkout).
      let kit = { commit: '', at: 0 };
      try { const v = require('child_process').execFileSync('git', ['-C', path.join(root, 'scripts', 'crew'), 'log', '-1', '--format=%h|%cI'], { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('|');
        if (/^[0-9a-f]{7,12}$/.test(v[0])) kit = { commit: v[0], at: Date.parse(v[1]) || 0 }; } catch { /* not a git checkout */ }
      // Where crew-upstream keeps its mailboxes and leases (GitLab project path), from _crew/crew.config.
      const bm = /^CREW_BOARD_PROJECT=([\w./-]{1,200})\s*$/m.exec(read(path.join(crew, 'crew.config'), 65536));
      out.push({ root, nudge, tasks, kit, board: bm ? bm[1] : '' });
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
      // One line per task, naming its tracks (a task with 11 failed tracks is one problem, not eleven).
      const failed = t.tracks.filter((k) => k.state === 'failed').map((k) => k.id);
      if (failed.length) add('BLOCKER', 'track_failed', [failed.join(', '), failed.length]);
      const spent = t.maxFix ? t.tracks.filter((k) => k.fixRounds >= t.maxFix && OPEN_TRACK.includes(k.state)).map((k) => k.id) : [];
      if (spent.length) add('BLOCKER', 'out_of_rounds', [spent.join(', '), t.maxFix, spent.length]);
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
  register(host, options = {}) {
    const now = options.now || Date.now, run = options.runOnHost || runOnHost;
    const supervisor = new CrewSupervisor({ now, newId: options.newId,
      // Feature-host settings already scope all writes to vault.data.features.crewpack.
      load: () => host.settings.get(), save: (value) => host.settings.set(value),
      io: {
        scan: async (r, config) => {
          const data = await run(r, crewRuntime, config, { timeout: 20000 });
          detect.mark(r.cfg.id, (data.roots || []).length > 0); return data;
        },
        report: (r, audit) => run(r, reportRuntime, { root: audit.root, runId: audit.runId }, { timeout: 10000, maxBuffer: 100000 }),
        open: async (r, audit) => {
          if (!supervisor.enabled() || !online(r, now()) || (r.snapshot?.sessions || []).some((s) => s.name === audit.session)) {
            throw Object.assign(Error('open_precondition'), { noSideEffect: true });
          }
          await host.sessions.start(r, { name: audit.session, dir: audit.root, run: 'claude' });
        },
        send: async (r, s, prompt) => {
          const current = (r.snapshot?.sessions || []).find((v) => identity(r, v) === identity(r, s));
          if (!supervisor.enabled() || !online(r, now()) || !idle(current)) throw Object.assign(Error('send_precondition'), { noSideEffect: true });
          // Address the verified pane, never an arbitrary active window in a named session.
          const out = await r.exec(keysScript(current.paneIds[0], prompt, true));
          if (out.code !== 0) throw Error('send_uncertain');
        },
      },
    });
    const tick = () => supervisor.tick(host.remotes()).catch(() => host.log('crew_supervisor_failed'));
    host.onSnapshot((r) => supervisor.tick([r]).catch(() => host.log('crew_supervisor_failed')));
    const timer = (options.setInterval || setInterval)(tick, 5000); timer.unref?.();
    const daysOf = () => [1, 3, 7, 14].includes(Number(supervisor.state?.days)) ? Number(supervisor.state.days) : 3;
    host.route('GET', '/status', ({ res }) => host.send(res, 200, supervisor.status(host.remotes())));
    host.route('POST', '/control', async ({ req, res }) => {
      const body = await host.readJson(req);
      try { host.send(res, 200, await supervisor.control(body, host.remotes())); }
      catch (e) { host.fail(res, /^invalid_/.test(e.message) ? 400 : 503, /^invalid_/.test(e.message) ? e.message : 'storage_failed'); }
    });
    host.route('GET', '/data', ({ res }) => {
      const status = supervisor.status(host.remotes()), servers = [];
      for (const r of host.remotes()) {
        if (!r.cfg) continue; const st = supervisor.host(r.cfg.id); if (!st) continue;
        const roots = Object.values(st.roots), snap = r.snapshot || {};
        servers.push({ id: r.cfg.id, local: !!r.cfg.local, name: snap.hostname || r.cfg.name || r.cfg.host || r.cfg.id,
          scanned: st.scannedAt, boards: roots.map((x) => ({ root: x.root, board: x.board || '' })), kit: roots.map((x) => ({ root: x.root, ...(x.kit || {}) })),
          workers: (snap.workers || []).filter((w) => w.task).map((w) => ({ kind: w.kind || '', task: w.task, track: w.track, elapsed: w.elapsed || 0, owner: w.owner?.name || '' })),
          roots: roots.map((x) => ({ root: x.root, tasks: x.tasks.length, enrolled: x.nudge.length })),
          tasks: roots.flatMap((x) => x.tasks.map((t) => { const pane = x.nudge.find((n) => n[1] === t.id), s = pane && (snap.sessions || []).find((q) => q.paneIds?.includes(pane[0]));
            return { id: t.id, title: t.title, status: t.status, updated: t.updated, root: x.root, session: s?.name || '', tracks: t.tracks.map((k) => ({ id: k.id, state: k.state, fixRounds: k.fixRounds, branch: k.branch || '', remote: k.remote || '' })) };
          })).sort((a, b) => b.updated - a.updated),
          findings: classify({ roots }, snap.sessions || [], now()), auditOpen: (snap.sessions || []).some((s) => s.name === AUDIT_SESSION || s.name.startsWith(AUDIT_SESSION + '-')),
          auditPending: !!st.active });
      }
      const s = supervisor.state || {};
      host.send(res, 200, { servers, days: daysOf(), auditHours: status.enabled ? status.intervalMinutes / 60 : 0,
        audits: Object.values(s.supervisor?.hosts || {}).flatMap((h) => [...h.history, ...(h.active ? [h.active] : [])]).sort((a, b) => b.createdAt - a.createdAt).slice(0, 10).map((a) => ({ at: a.createdAt, server: a.serverId, root: a.root, why: a.reason.code })), skill: AUDIT_SKILL });
    });
    host.route('POST', '/audit', async ({ req, res }) => {
      const b = await host.readJson(req), r = host.remotes().find((v) => v.cfg?.id === b.server);
      if (!r) { host.fail(res, 404, 'server_unknown'); return; }
      try { host.send(res, 200, await supervisor.request(r, b.root)); }
      catch (e) { host.fail(res, 409, e.message); }
    });
    host.route('POST', '/days', async ({ req, res }) => {
      const b = await host.readJson(req), d = [1, 3, 7, 14].includes(Number(b.days)) ? Number(b.days) : 3;
      await supervisor.change((s) => { s.days = d; for (const h of Object.values(s.supervisor.hosts)) h.scannedAt = 0; });
      host.send(res, 200, { days: d });
    });
    host.route('POST', '/schedule', async ({ req, res }) => {
      const b = await host.readJson(req), h = Math.max(0, Math.min(48, Number(b.hours) || 0));
      try { await supervisor.control({ enabled: h > 0, intervalMinutes: h > 0 ? Math.max(1, Math.min(1440, Math.round(h * 60))) : supervisor.state?.intervalMinutes || 30 }, host.remotes()); }
      catch { host.fail(res, 503, 'storage_failed'); return; }
      host.send(res, 200, { auditHours: h > 0 ? supervisor.state.intervalMinutes / 60 : 0 });
    });
    return { supervisor, tick, stop: () => { (options.clearInterval || clearInterval)(timer); supervisor.stop(); } };
  },
};
