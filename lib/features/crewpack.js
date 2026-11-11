'use strict';
const { runOnHost } = require('../file-viewer');
const { guardRuntime } = require('../ops-action-guard');
const policy = require('../supervision-state');
const detect = require('../crew-detect');
const { CrewSupervisor, reportRuntime, online, idle, identity, validRoot } = require('../crew-supervisor');

// Optional "Xspire Crew" pack. Supervision is explicitly enabled; it discovers/retains workspace roots and
// reads the crew kit files: `_crew/nudge.conf` and each task's `orchestrator.json` (tmux pane ↔ task), each task's MANIFEST.md front matter, its
// tracks' ROUNDS.tsv and its `watch/heartbeat`. It runs no crew script and copies no crew rule; with no `_crew` it shows nothing.
// The ops-audit button appears only when Claude Code reports the skill enabled for that folder (see the plugins feature).
const FINAL = ['done', 'closed', 'abandoned', 'archived', 'merged'], OPEN_TRACK = ['pending', 'queued', 'dispatched', 'running', 'fix', 'review', 'blocked'];
const AUDIT_SESSION = 'tn-ops-audit', AUDIT_SKILL = 'xspire-crew-ops-audit';
const DORMANT_MS = 48 * 3600000; // same threshold as the supervisor's dormant tasks

// Runs on the host (locally or over SSH through node). Reads only; returns small summaries.
// Runs on the host. Which live Claude chats drive which crew tasks: a chat that ran "crew-task.sh init <task>" created it;
// one that ran crew scripts with the task id (dispatch, watch, xqa, enroll …) works on it. Reads only the transcripts of the
// given session ids under the account folders, first and last 8 MB; returns counts, never chat text.
function leaderEvidenceRuntime() {
  return async function evidence(a) {
    const fs = require('fs'), path = require('path'), os = require('os');
    const home = os.homedir(), out = {}, ids = (a.taskIds || []).filter((t) => /^[A-Za-z0-9][\w-]{0,127}$/.test(t)).slice(0, 50);
    const esc = (t) => t.replace(/[-]/g, '\\-');
    const transcript = (cfg, sid) => {
      const bases = [path.join(home, cfg), path.join(home, '.config', cfg), process.env.CLAUDE_CONFIG_DIR || ''].filter(Boolean);
      for (const b of bases) {
        let dirs = []; try { dirs = fs.readdirSync(path.join(b, 'projects')); } catch { continue; }
        for (const d of dirs) { const f = path.join(b, 'projects', d, sid + '.jsonl'); try { if (fs.statSync(f).isFile()) return f; } catch { /* next */ } }
      }
      return '';
    };
    const MB = 8 * 1048576;
    for (const s of (a.sessions || []).slice(0, 40)) {
      if (!/^[0-9a-fA-F-]{8,64}$/.test(String(s.sessionId)) || !/^\.?[\w.-]{1,60}$/.test(String(s.config || '.claude'))) continue;
      const f = transcript(String(s.config || '.claude'), s.sessionId); if (!f) continue;
      let text = '';
      try {
        const fd = fs.openSync(f, 'r'), size = fs.fstatSync(fd).size, read = (pos, len) => { const b = Buffer.alloc(len); const n = fs.readSync(fd, b, 0, len, pos); return b.subarray(0, n).toString('utf8'); };
        text = size <= 2 * MB ? read(0, size) : read(0, MB) + '\n' + read(size - MB, MB);
        fs.closeSync(fd);
      } catch { continue; }
      for (const id of ids) {
        const e = esc(id);
        const init = new RegExp('crew-task\\.sh\\s+init\\s+' + e + '(?![\\w-])').test(text);
        const used = (text.match(new RegExp('crew-(?:task|dispatch|watch|xqa|build|board)\\.sh[^"\\n]{0,400}?' + e + '(?![\\w-])', 'g')) || []).length;
        if (init || used) (out[id] ||= {})[s.name] = { init, used };
      }
    }
    return { evidence: out };
  };
}

function crewRuntime() {
  const fs = require('fs'), path = require('path');
  const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
  const read = (p, n, tail = false) => { try { const fd = fs.openSync(p, 'r'); try { const at = tail ? Math.max(0, fs.fstatSync(fd).size - n) : 0, b = Buffer.alloc(n), k = fs.readSync(fd, b, 0, n, at), text = b.toString('utf8', 0, k); return at ? text.slice(text.indexOf('\n') + 1) : text; } finally { fs.closeSync(fd); } } catch { return ''; } };
  const remotes = new Map();
  function statusOf(file) {
    let at = 0; try { at = Math.round(fs.statSync(file).mtimeMs); } catch { return null; }
    const head = read(file, 4096).split('\n').slice(0, 10), line = head.find((l) => /\b(DONE|BLOCKED|FAILED|PARTIAL)\b/.test(l));
    if (!line) return null;
    return { at, status: /\bBLOCKED\b/.test(line) ? 'blocked' : /\bFAILED\b/.test(line) ? 'failed' : /\bPARTIAL\b/.test(line) ? 'partial' : 'done', line: line.replace(/^#+\s*/, '').replace(/[*`_]/g, '').trim().slice(0, 160) };
  }
  // dotnet test ("Failed: 1, Passed: 2167"), flutter test ("+87: All tests passed!" / "+85 -2: Some tests failed"), "rc=N".
  function verifyOf(folder, pattern = /^(orch|orchestrator)[\w.-]*\.log$|verify[\w.-]*\.log$/i) {
    let files = [];
    try { files = fs.readdirSync(folder).filter((n) => pattern.test(n)).map((n) => ({ n, t: fs.statSync(path.join(folder, n)).mtimeMs })).sort((a, b) => b.t - a.t); } catch { return null; }
    // The newest log that actually holds a result (a 38-byte stub or an interrupted run does not count).
    for (const f of files.slice(0, 6)) { const v = parseVerify(folder, f); if (v) return v; }
    return null;
  }
  function parseVerify(folder, f) {
    const text = read(path.join(folder, f.n), 262144, true);
    let failed = 0, passed = 0, any = false;
    for (const x of text.matchAll(/Failed:\s+(\d+),\s+Passed:\s+(\d+)/g)) { failed += Number(x[1]); passed += Number(x[2]); any = true; }
    const fl = [...text.matchAll(/\+(\d+)(?:\s+~\d+)?(?:\s+-(\d+))?:\s+(All tests passed|Some tests failed)/g)].pop();
    if (fl) { passed += Number(fl[1]); failed += Number(fl[2] || 0); any = true; }
    const rcs = [...text.matchAll(/\brc=(\d+)\b/g)], rc = rcs.length ? Number(rcs[rcs.length - 1][1]) : null;
    if (rc === null && !any) return null;
    return { file: f.n, at: Math.round(f.t), rc, failed, passed, ok: rc !== null ? rc === 0 && failed === 0 : failed === 0 && passed > 0 };
  }
  // One word for what a track really is. Exit 7 means "code committed, the dispatcher refused the evidence", so the
  // worker's own STATUS and the leader's verification decide. A newer passing task-level integration run counts too.
  // The newest evidence wins: a worker's BLOCKED written before the leader verified the code is history, not state.
  function verdictOf(state, exit, report, verify, task, endedAt) {
    const exit7 = state === 'failed' && exit === '7', blocked = report && report.status === 'blocked' && ['failed', 'blocked', 'running', 'fix'].includes(state);
    // A track the leader did by hand (never dispatched, so the manifest still says pending/queued): its own STATUS.md
    // or a verification log in tracks/<id>/ is the evidence; without either it stays "not run".
    const handDone = ['pending', 'queued', 'ready', 'planned'].includes(state) && (report && report.status === 'done' || verify && verify.ok);
    if (!exit7 && !blocked && !handDone) return { code: '', proof: null };
    const v = [verify, task && task.at > endedAt ? task : null].filter(Boolean).sort((a, b) => b.at - a.at)[0];
    const proof = v ? { file: (v === task ? '' : 'tracks/') + v.file, at: v.at, passed: v.passed, failed: v.failed, rc: v.rc } : report ? { file: 'STATUS.md', at: report.at, line: report.line } : null;
    const code = v && (!report || v.at >= report.at) ? (v.ok ? 'verified' : 'verify_failed') : blocked ? 'blocked' : v ? (v.ok ? 'verified' : 'verify_failed') : report && report.status === 'done' ? 'coded' : 'unverified';
    return { code, proof: code === 'blocked' || code === 'coded' ? (report ? { file: 'STATUS.md', at: report.at, line: report.line } : null) : proof };
  }
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
        const tracks = [], taskVerify = verifyOf(dir, /^int-verify[\w.-]*\.log$/i);
        for (const m of (val('tracks') || '').matchAll(/\{\s*id:\s*([\w-]+)\s*,\s*state:\s*([\w-]+)/g)) {
          const roundsFile = path.join(dir, 'tracks', m[1], 'ROUNDS.tsv');
          const rounds = read(roundsFile, 65536).split('\n').filter((l) => /^\d+\t/.test(l));
          // Keep observing the latest result even after the bounded legacy round summary fills up.
          const tail = read(roundsFile, 65536, true).split('\n').filter((l) => /^\d+\t/.test(l));
          const last = tail.length ? tail[tail.length - 1].split('\t') : [];
          // The track's repo and branch, as crew wrote them in tracks/<id>/BASE (repo=…, branch=…).
          const base = read(path.join(dir, 'tracks', m[1], 'BASE'), 2048), bv = (k) => { const x = new RegExp('^' + k + '=(.*)$', 'm').exec(base); return x ? x[1].trim() : ''; };
          const repo = /^[\w./-]{1,200}$/.test(bv('repo')) && !bv('repo').includes('..') ? bv('repo') : '', branch = /^[\w./-]{1,200}$/.test(bv('branch')) ? bv('branch') : '';
          // What really happened, beyond the dispatcher's state: the worker's STATUS.md verdict and the newest verification
          // log the leader ran (orch-verify, VERIFY-ONLY, …: test totals and exit code).
          const tdir = path.join(dir, 'tracks', m[1]), report = statusOf(path.join(tdir, 'STATUS.md')), verify = verifyOf(tdir);
          const vd = verdictOf(m[2], last[4] || '', report, verify, taskVerify, Date.parse(last[2] || '') || 0);
          tracks.push({ id: m[1], state: m[2], report, verify, verdict: vd.code, proof: vd.proof, rounds: rounds.length, fixRounds: rounds.filter((l) => l.split('\t')[6] === 'fix').length, lastEnd: Date.parse(last[2] || '') || 0, lastRound: last.length ? { round: last[0], endedAt: last[2] || '', result: last[4] || '', kind: last[6] || '' } : null, repo, branch, remote: repo ? remoteOf(path.join(root, repo)) : '' });
        }
        // The crew kit's current leader registration ("crew-task.sh orchestrator-register <task>", run at crew start/resume
        // inside the leader's tmux pane): _crew/tasks/<task>/orchestrator.json names that pane. Counts like a nudge.conf line.
        try { const o = JSON.parse(read(path.join(dir, 'orchestrator.json'), 65536) || 'null'); const pane = o && o.tmux && o.tmux.pane;
          if (typeof pane === 'string' && /^%\d+$/.test(pane) && !nudge.some((x) => x[1] === name)) nudge.push([pane, name]); } catch { /* not registered */ }
        const hb = read(path.join(dir, 'watch', 'heartbeat'), 512), hm = /pid=(\d+)/.exec(hb), at = /at=(\S+)/.exec(hb);
        let alive = false; if (hm) { try { process.kill(Number(hm[1]), 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; } }
        const budget = /max_fix_rounds:\s*(\d+)/.exec(front);
        let title = val('title'); try { title = JSON.parse('"' + title.replace(/"/g, '\\"') + '"'); } catch { /* as written */ }
        // Last sign of life: the manifest, the newest round, the watcher heartbeat. Used only to set dormant tasks apart.
        const activeAt = Math.max(Math.round(st.mtimeMs), Date.parse(val('updated')) || 0, ...tracks.map((k) => k.lastEnd || 0), at ? Date.parse(at[1]) || 0 : 0);
        tasks.push({ id: name, title: title.slice(0, 160), status: val('status'), updated: Date.parse(val('updated')) || Math.round(st.mtimeMs), activeAt, blocked: /^(null|~|)$/.test(val('blocked')) ? '' : val('blocked').slice(0, 200),
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

// One track's own files, read on its host for the side panel popup: rounds, why it failed or is blocked, the worker's last
// message and report, and the tail of its newest log. Bounded, inside _crew/tasks/<task>/tracks/<id> only, tokens masked.
function trackRuntime() {
  const fs = require('fs'), path = require('path');
  const read = (p, n, tail) => { try { const fd = fs.openSync(p, 'r'); try { const size = fs.fstatSync(fd).size, at = tail ? Math.max(0, size - n) : 0, b = Buffer.alloc(Math.min(n, size)); const k = fs.readSync(fd, b, 0, b.length, at); return b.toString('utf8', 0, k); } finally { fs.closeSync(fd); } } catch { return ''; } };
  const mask = (t) => t.replace(/(glpat-|ghp_|gho_|github_pat_|sk-ant-|sk-|xox[abp]-)[A-Za-z0-9_\-]{8,}/g, '$1••••').replace(/((?:password|pwd|token|secret)\s*[=:]\s*)[^\s;'"]+/gi, '$1••••');
  // A Codex worker log is "<time> <line>" with marker lines: exec (a command, then "succeeded|exited N in Xms:"), codex (what
  // the worker says), apply patch (files it edits), tokens used. Turn its tail into a short activity feed; nothing is run.
  const MARK = /^(exec|codex|apply patch|user|thinking|tokens used)$/;
  function feed(text) {
    const lines = text.split('\n').map((l) => { const m = /^(\d{4}-\d\d-\d\dT[\d:]+[+-]\d{4}) ?(.*)$/.exec(l); return m ? { at: Date.parse(m[1].replace(/([+-]\d\d)(\d\d)$/, '$1:$2')), t: m[2] } : null; }).filter(Boolean);
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const { at, t } = lines[i];
      if (!MARK.test(t)) continue;
      const block = []; let j = i + 1;
      for (; j < lines.length && !MARK.test(lines[j].t) && block.length < 60; j++) block.push(lines[j].t);
      if (t === 'exec') {
        const cmd = (block[0] || '').replace(/ in \/\S+$/, '').replace(/^\/bin\/(?:z|ba)?sh -lc /, '').replace(/^"(.*)"$/, '$1');
        const res = block.map((b) => /^ ?(succeeded|exited (-?\d+)|failed) in (\d+)ms:/.exec(b)).find(Boolean);
        out.push({ kind: 'exec', at, text: cmd.slice(0, 240), ok: res ? res[1] === 'succeeded' : null, code: res && res[2] ? Number(res[2]) : res ? 0 : null, ms: res ? Number(res[3]) : null });
      } else if (t === 'codex' || t === 'thinking') {
        const say = block.filter((b) => b.trim()).join(' ').trim();
        if (say) out.push({ kind: t === 'codex' ? 'say' : 'think', at, text: say.slice(0, 500) });
      } else if (t === 'apply patch') {
        // "patch: completed" then one absolute path per edited file, then the diff; show the last two path parts.
        const files = [...new Set(block.filter((b) => /^\/\S+$/.test(b.trim())).map((b) => b.trim().split('/').slice(-2).join('/')))];
        out.push({ kind: 'patch', at, text: files.slice(0, 8).join(', ') || 'apply patch', ok: !block.some((b) => /^patch: (?:failed|rejected)/.test(b)) });
      } else if (t === 'tokens used') out.push({ kind: 'tokens', at, text: (block[0] || '').trim() });
      i = j - 1;
    }
    return out.slice(-25);
  }
  return async function track({ root, task, id, live }) {
    const dir = path.join(root, '_crew', 'tasks', task, 'tracks', id);
    try { const real = fs.realpathSync(dir); if (!real.startsWith(fs.realpathSync(path.join(root, '_crew', 'tasks')) + path.sep)) return { error: 'outside' }; } catch { return { error: 'missing' }; }
    const rounds = read(path.join(dir, 'ROUNDS.tsv'), 65536, true).split('\n').filter((l) => /^\d+\t/.test(l)).slice(-12).map((l) => {
      const f = l.split('\t'); return { round: f[0], startedAt: f[1], endedAt: f[2], seconds: Number(f[3]) || 0, exit: f[4], tokens: Number(f[5]) || 0, kind: f[6], executor: f[7], model: f[8], effort: f[9] };
    });
    const files = {};
    for (const name of ['FAILED', 'BLOCKED.md', 'EVIDENCE-FAILED.md', 'DISPATCH-REFUSED.md', 'CORRECTION-REFUSED.md', 'STATUS.md', 'last-message.md']) {
      const t = read(path.join(dir, name), 6000, false); if (!t.trim()) continue;
      let at = 0; try { at = Math.round(fs.statSync(path.join(dir, name)).mtimeMs); } catch { /* gone */ }
      files[name] = { text: mask(t), at };
    }
    let log = '', logName = '';
    try {
      const logs = fs.readdirSync(path.join(dir, 'logs')).filter((n) => /\.log$/.test(n)).map((n) => ({ n, m: fs.statSync(path.join(dir, 'logs', n)).mtimeMs })).sort((a, b) => b.m - a.m);
      if (logs[0]) { logName = logs[0].n; log = mask(read(path.join(dir, 'logs', logs[0].n), 6000, true)); }
    } catch { /* no logs */ }
    if (live) {
      // Live view: only the newest log's activity feed and how fresh it is (polled every few seconds while the popup is open).
      let feedOut = [], at = 0, name = '';
      try {
        const logs = fs.readdirSync(path.join(dir, 'logs')).filter((n) => /\.log$/.test(n)).map((n) => ({ n, m: fs.statSync(path.join(dir, 'logs', n)).mtimeMs })).sort((a, b) => b.m - a.m);
        if (logs[0]) { name = logs[0].n; at = Math.round(logs[0].m); feedOut = feed(mask(read(path.join(dir, 'logs', logs[0].n), 48000, true))); }
      } catch { /* no logs */ }
      return { live: true, logName: name, logAt: at, feed: feedOut };
    }
    const out = mask(read(path.join(dir, 'dispatch.out'), 3000, true));
    // What the worker changed: its commits and the files it touched, from git (read only), base_sha..branch from BASE.
    const base = read(path.join(dir, 'BASE'), 2048, false), bv = (k) => (new RegExp('^' + k + '=(.*)$', 'm').exec(base) || [])[1] || '';
    const changes = { commits: [], stat: '', branch: bv('branch'), repo: bv('repo') };
    const safe = (v) => /^[\w./-]{1,200}$/.test(v) && !v.includes('..');
    if (safe(changes.branch) && /^[0-9a-f]{7,40}$/.test(bv('base_sha'))) {
      const dirs = [bv('worktree'), bv('repo')].filter(safe).flatMap((d) => [path.join(root, d), path.join(root, 'platform', d), path.join(root, 'modules', d), path.join(root, 'mobile', d), path.join(root, 'tools', d), path.join(root, 'docs', d)]);
      const repoDir = dirs.find((d) => { try { return fs.statSync(path.join(d, '.git')) && true; } catch { return false; } });
      if (repoDir) {
        const git = (args) => { try { return require('child_process').execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', timeout: 8000, maxBuffer: 1 << 20, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; } };
        const range = bv('base_sha') + '..' + changes.branch;
        changes.commits = git(['log', '--format=%h%x09%ad%x09%s', '--date=format:%d/%m %H:%M', '-n', '20', range]).split('\n').filter(Boolean).map((l) => { const [sha, at, ...m] = l.split('\t'); return { sha, at, subject: m.join(' ').slice(0, 160) }; });
        changes.stat = git(['diff', '--stat=120', bv('base_sha') + '...' + changes.branch]).split('\n').slice(-40).join('\n').trim();
      }
    }
    // What this track is for: the packet's own heading ("# TRACK W0 — Shared contracts …").
    const packet = read(path.join(root, '_crew', 'tasks', task, 'packets', id + '.md'), 16384, false);
    const heading = ((/^# +(.+)$/m.exec(packet.replace(/^---[\s\S]*?\n---\n/, '')) || [])[1] || '').replace(/^TRACK\s+[\w-]+\s*[—:-]\s*/i, '').slice(0, 200);
    return { rounds, files, log, logName, dispatch: out, changes, goal: heading };
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
      // A task nobody leads and nobody touched for two days is dormant, not something to act on now.
      if (!enrolled && t.activeAt && now - t.activeAt > DORMANT_MS) continue;
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
  name: 'crewpack', crewRuntime, leaderEvidenceRuntime, trackRuntime, classify, AUDIT_SKILL,
  register(host, options = {}) {
    const now = options.now || Date.now, run = options.runOnHost || runOnHost;
    // Always isolate the synchronous remote helper, including on the local backend. Auth/tmux IO must not block
    // HTTP, polling or OFF processing in the supervisor process. This transport exposes only exec to runOnHost.
    const guard = options.guard || ((r, a) => r.mode === 'powershell' ? Promise.resolve({ code: 'coordination_platform_unavailable' }) :
      run({ cfg: { local: false }, exec: (...args) => r.exec(...args) }, guardRuntime, a, { timeout: 30000, maxBuffer: 100000 }));
    const workspace = (r, root) => supervisor.state?.workspaces.find(w => w.serverId === r.cfg.id && w.root === root);
    const auditConfig = (r, root) => { const w = workspace(r, root); return { config: w?.auditConfig, account: w?.auditAccount }; };
    const readinessCache = new Map(), READINESS_TTL = 30000, CACHE_MAX = 200;
    let readinessInflight = 0;
    const readinessKey = (r, w) => JSON.stringify([r.cfg.id, r.cfg.host, r.cfg.port, r.cfg.username, r.cfg.user, r.cfg.local, r.mode, r.snapshot?.bootId, w.root, w.config, w.account]);
    const unavailable = (code, observedAt = 0) => ({ code, observedAt, quota: 'unknown' });
    const readReady = (r, w, { fresh = false, probe = true } = {}) => {
      if (!online(r, now()) || !r.snapshot?.bootId || host.backendOf && host.backendOf(r.cfg.id) !== r) return Promise.resolve(unavailable('host_unavailable'));
      const key = readinessKey(r, w), entry = readinessCache.get(key), stamp = now();
      if (!fresh && entry?.remote === r && entry.value && stamp >= entry.checkedAt && stamp - entry.checkedAt < READINESS_TTL) return Promise.resolve(entry.value);
      if (!fresh && entry?.remote === r && entry.pending && probe) return entry.pending;
      // Disabled status never waits for SSH/auth/plugin commands, including an already running probe.
      if (!probe) return Promise.resolve(unavailable(entry?.value ? 'audit_readiness_stale' : 'audit_readiness_unavailable', entry?.value?.observedAt || 0));
      if (readinessInflight >= 4) return Promise.resolve(unavailable('audit_readiness_busy'));
      if (!readinessCache.has(key) && readinessCache.size >= CACHE_MAX) {
        const victim = [...readinessCache].find(([, v]) => !v.pending);
        if (!victim) return Promise.resolve(unavailable('audit_readiness_busy'));
        readinessCache.delete(victim[0]);
      }
      const current = { remote: r, value: entry?.value }; readinessCache.set(key, current); readinessInflight++;
      current.pending = (async () => {
        let value;
        try {
          const v = await guard(r, { op: 'readiness', root: w.root, config: w.config, account: w.account });
          if (readinessKey(r, w) !== key || !online(r, now()) || host.backendOf && host.backendOf(r.cfg.id) !== r) value = unavailable('audit_readiness_stale', current.value?.observedAt || 0);
          else {
            value = { code: typeof v?.code === 'string' && /^[a-z_]{1,80}$/.test(v.code) ? v.code : 'audit_readiness_unknown', observedAt: now(), quota: 'unknown' };
            if (/^[a-f0-9]{64}$/.test(v?.accountRef || '')) value.accountRef = v.accountRef;
            if (typeof v?.label === 'string' && v.label.length <= 160 && /^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+$/.test(v.label)) value.label = v.label;
            if (['audit_ready', 'audit_account_registration_required'].includes(value.code) && (!value.accountRef || !value.label)) value = unavailable('audit_account_identity_unavailable', value.observedAt);
          }
        } catch { value = unavailable('audit_readiness_unavailable', current.value?.observedAt || 0); }
        current.value = value; current.checkedAt = now(); return value;
      })().finally(() => { current.pending = null; readinessInflight--; });
      return current.pending;
    };
    // The crew kit's own enroll writes _crew/nudge.conf (one locked writer); Termnest never edits that file.
    const enrollPane = async (r, root, taskId, s) => {
      const q = v => "'" + String(v).replace(/'/g, "'\\''") + "'";
      const out = await r.exec('cd ' + q(root) + ' && bash scripts/crew/crew-task.sh enroll --task ' + q(taskId) + ' --pane ' + q(s.paneIds[0]) + ' 2>&1');
      const text = String(out?.out || '') + String(out?.err || '');
      if (out?.code === 0 && text.includes('enrolled ' + s.paneIds[0] + ' ' + taskId)) {
        const h = supervisor.host(r.cfg.id); if (h) h.scannedAt = 0; // rescan on the next tick
        return { code: 'bind_done', serverId: r.cfg.id, root, session: s.name, taskId, pane: s.paneIds[0] };
      }
      if (out?.code === 3) throw Error('bind_session_missing');
      if (out?.code === 4) throw Error('bind_task_closed');
      if (/unknown (command|subcommand)|usage|not found|No such file/i.test(text) || out?.code === 127) throw Error('bind_kit_outdated');
      throw Error('bind_failed');
    };
    const guardedAction = async (r, action) => {
      if (!supervisor.enabled() || action.coordinatorId !== supervisor.coordinatorId || !online(r, now())) return { code: 'supervisor_disabled' };
      let owned;
      try { owned = await guard(r, { op: 'lease', root: action.root, coordinatorId: action.coordinatorId }); }
      catch { return { code: 'coordination_unavailable' }; }
      if (owned.code !== 'coordination_owner') return owned;
      if (!supervisor.enabled() || action.coordinatorId !== supervisor.coordinatorId || !online(r, now())) return { code: 'supervisor_disabled' };
      return guard(r, { ...action, token: owned.token });
    };
    const actionResult = result => {
      if (result.code === 'action_delivered') return;
      // A duplicate intent belongs to the original run, not this new run; never fabricate its delivery/report identity.
      const error = Object.assign(Error(result.code), { code: result.code, receipt: result.receipt });
      if (!['action_uncertain', 'action_duplicate'].includes(result.code)) error.noSideEffect = true;
      throw error;
    };
    const healthOf = status => ({
      observationsFresh: status.servers.length > 0 && status.servers.every(s => s.online && s.freshness.taskEvidenceFresh),
      validatedAuditCompletion: status.servers.length > 0 && status.servers.every(s => s.audits.at(-1)?.verification === 'reported'),
    });
    const supervisor = new CrewSupervisor({ now, newId: options.newId,
      // Feature-host settings already scope all writes to vault.data.features.crewpack.
      load: () => host.settings.get(), save: (value) => host.settings.set(value),
      io: {
        coordinate: (r, root, coordinatorId) => guard(r, { op: 'lease', root, coordinatorId }),
        // The Ops hub owns audits now: rule reports every 30 min (0 token) and, only when the owner turns on its Ops session,
        // one AI audit for the whole fleet. The older per-team audit (a "tn-ops-audit-…" Claude session per team, every
        // interval) is not started while the hub is present: it surprised owners and spent tokens twice.
        hubAudits: () => { try { return !!host.service?.('opshub'); } catch { return false; } },
        revoke: async (remotes, coordinatorId) => {
          const results = await Promise.allSettled(remotes.flatMap(r => [...new Set([...Object.keys(supervisor.host(r.cfg.id)?.roots || {}), ...supervisor.state.workspaces.filter(w => w.serverId === r.cfg.id).map(w => w.root), ...supervisor.state.leaders.filter(l => l.serverId === r.cfg.id).map(l => l.root)])].map(root =>
            guard(r, { op: 'revoke', root, coordinatorId }))));
          // A host that cannot grant a lease (macOS, Windows) holds nothing to revoke.
          if (results.some(v => v.status !== 'fulfilled' || !['coordination_revoked', 'coordination_platform_unavailable'].includes(v.value.code))) throw Error('remote_revocation_unconfirmed');
        },
        retireAudit: (r, audit) => guardedAction(r, { op: 'retire_audit', root: audit.root, session: audit.session, runId: audit.runId,
          reported: audit.verification === 'reported', coordinatorId: audit.coordinatorId }),
        auditReported: (r, audit) => guardedAction(r, { op: 'ack_audit', root: audit.root, runId: audit.runId, coordinatorId: audit.coordinatorId }),
        validateLeader: async (r, l) => {
          const v = await guard(r, { op: 'inspect', root: l.root, session: l.session, identity: l.identity });
          return v.code === 'identity_valid' ? v : null;
        },
        auditReady: (r, audit) => {
          const session = (r.snapshot?.sessions || []).find(s => s.name === audit.session);
          if (/quota|rate_limit|credits/i.test(session?.aiStatus?.waitingFor || '')) return { code: 'audit_quota_unavailable' };
          return readReady(r, { root: audit.root, ...(audit.confirmation ? { config: audit.config, account: audit.account } : auditConfig(r, audit.root)) }, { fresh: true });
        },
        recover: async (r, s, l, record, token, coordinatorId) => {
          if (!supervisor.recoveryTarget(r, s).eligible) return { code: 'recovery_gated' };
          const generic = host.service?.('ops-runtime');
          if (!generic) return { code: 'ops_runtime_unavailable' };
          const reservation = generic.reserveExternal(r, s);
          if (!reservation) return { code: 'ops_idle_reserved' };
          let result;
          try {
            // Disable may have arrived during persistence/SSH preparation. The remote token is revoked by OFF too.
            if (!supervisor.recoveryTarget(r, s).eligible || host.backendOf(r.cfg.id) !== r) { result = { code: 'recovery_gated' }; return result; }
            result = await guardedAction(r, { op: 'action', kind: 'recovery_send', root: l.root, session: l.session, identity: l.identity,
              taskIds: l.taskIds, progressToken: policy.digest(l.taskIds.map(id => [id, supervisor.host(r.cfg.id)?.progress[JSON.stringify([l.root, id])]?.fingerprint])),
              prompt: policy.recoveryPrompt(l), idleAt: record.idleAt, eventId: record.eventId, token, coordinatorId });
            return result;
          } finally { generic.completeExternal(reservation, result); }
        },
        leaderEvidence: async (r, config) => (await run(r, leaderEvidenceRuntime, config, { timeout: 20000, maxBuffer: 200000 }))?.evidence || {},
        scan: async (r, config) => {
          const data = await run(r, crewRuntime, config, { timeout: 20000 });
          detect.mark(r.cfg.id, (data.roots || []).length > 0); return data;
        },
        report: (r, audit) => run(r, reportRuntime, { root: audit.root, runId: audit.runId }, { timeout: 10000, maxBuffer: 100000 }),
        open: async (r, audit) => {
          if (!supervisor.enabled() || !online(r, now()) || (r.snapshot?.sessions || []).some((s) => s.name === audit.session)) {
            throw Object.assign(Error('open_precondition'), { noSideEffect: true });
          }
          actionResult(await guardedAction(r, { op: 'action', kind: 'audit_open', root: audit.root, session: audit.session,
            ...auditConfig(r, audit.root), token: audit.token, coordinatorId: audit.coordinatorId, runId: audit.runId,
            eventId: policy.digest(['audit-open/v2', r.snapshot.bootId, audit.root, audit.session, audit.runId]) }));
          await r.poll?.();
        },
        send: async (r, s, prompt, audit) => {
          const current = (r.snapshot?.sessions || []).find((v) => identity(r, v) === identity(r, s));
          if (!supervisor.enabled() || !online(r, now()) || !idle(current)) throw Object.assign(Error('send_precondition'), { noSideEffect: true });
          actionResult(await guardedAction(r, { op: 'action', kind: 'audit_send', root: audit.root, session: current.name,
            identity: policy.liveIdentity(r, current), idleAt: current.aiStatus.at, prompt, ...auditConfig(r, audit.root),
            token: audit.token, coordinatorId: audit.coordinatorId, runId: audit.runId,
            eventId: policy.digest(['audit-idle/v1', policy.liveIdentity(r, current), current.aiStatus.at]) }));
        },
      },
    });
    const facade = {
      enabled: () => { try { supervisor.ensure(); return supervisor.enabled(); } catch { return false; } },
      managed: (r, s) => {
        let leaders;
        try { supervisor.ensure(); leaders = supervisor.state.leaders; }
        catch { try { leaders = host.settings.get().leaders || []; } catch { return true; } }
        if (!Array.isArray(leaders)) return true;
        if (leaders.some(l => l?.serverId === r.cfg.id && l.session === s?.name && policy.sameIdentity(l.identity, policy.liveIdentity(r, s)))) return true;
        // An auto-enrolled leader is managed only where the supervisor really holds authority for its root; elsewhere
        // (e.g. a Windows host without WSL, which has no tmux) the ordinary idle reminder stays in charge.
        try {
          const auto = supervisor.leadersFor(r.cfg.id).find(l => l.auto && l.session === s?.name && policy.sameIdentity(l.identity, policy.liveIdentity(r, s)));
          return !!auto && supervisor.enabled() && supervisor.ownership.get(JSON.stringify([r.cfg.id, auto.root]))?.code === 'coordination_owner';
        } catch { return false; }
      },
      recoveryTarget: (r, s) => supervisor.recoveryTarget(r, s),
      // Read-only: the crew roots last scanned on one machine (tasks, tracks, nudge.conf) for the Ops hub.
      crew: (id) => supervisor.rootsWithLeaders(id),
      scannedAt: (id) => supervisor.host(id)?.scannedAt || 0,
      // "Refresh" in the Ops hub: forget when each machine was last scanned and scan now (read-only, like the timer).
      rescan: async () => { await supervisor.change((st) => { for (const h of Object.values(st.supervisor.hosts)) h.scannedAt = 0; }, { memory: true }).catch(() => {}); await tick(); },
      control: body => supervisor.control(body, host.remotes()),
      account: async body => {
        supervisor.ensure();
        if (!body || Array.isArray(body) || Object.keys(body).length !== 3 || Object.keys(body).some(k => !['serverId', 'root', 'auditConfig'].includes(k)) ||
            typeof body.serverId !== 'string' || !body.serverId || body.serverId.length > 128 || !validRoot(body.root) || typeof body.auditConfig !== 'string' || !policy.CONFIG.test(body.auditConfig)) throw Error('invalid_account_scope');
        const w = supervisor.state.workspaces.find(w => w.serverId === body.serverId && w.root === body.root);
        if (!w) throw Error('invalid_account_scope');
        const r = host.remotes().find(r => r.cfg.id === body.serverId);
        const value = r ? await readReady(r, { root: body.root, config: body.auditConfig, account: w.auditConfig === body.auditConfig ? w.auditAccount : undefined }, { fresh: true }) : unavailable('host_unavailable');
        if (!supervisor.state.workspaces.some(w => w.serverId === body.serverId && w.root === body.root)) throw Error('invalid_account_scope');
        return { serverId: body.serverId, root: body.root, auditConfig: body.auditConfig, ...value };
      },
      // Bind a live single-pane session as the leader of an open task. The crew kit itself writes _crew/nudge.conf
      // (one locked writer); Termnest never edits that file. The next scan picks the binding up.
      bind: async body => {
        if (!body || Array.isArray(body) || Object.keys(body).length !== 4 || Object.keys(body).some(k => !['serverId', 'root', 'session', 'taskId'].includes(k)) ||
            typeof body.serverId !== 'string' || !validRoot(body.root) || typeof body.session !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(body.session) ||
            typeof body.taskId !== 'string' || !/^[A-Za-z0-9][\w-]{0,127}$/.test(body.taskId)) throw Error('invalid_bind');
        const r = host.remotes().find(r => r.cfg?.id === body.serverId);
        if (!r || !online(r, now())) throw Error('bind_host_offline');
        if (r.mode === 'powershell') throw Error('bind_platform_unavailable');
        const s = (r.snapshot?.sessions || []).find(s => s.name === body.session);
        if (!s || s.dead) throw Error('bind_session_missing');
        if (s.paneIds?.length !== 1 || !/^%\d+$/.test(s.paneIds[0])) throw Error('bind_pane_ambiguous');
        const root = supervisor.host(r.cfg.id)?.roots?.[body.root];
        const task = root?.tasks?.find(t => t.id === body.taskId);
        if (!task || FINAL.includes(task.status)) throw Error('bind_task_closed');
        return enrollPane(r, body.root, body.taskId, s);
      },
      pending: () => supervisor.gates.size,
      stop: () => supervisor.stop(),
      health: () => {
        return healthOf(supervisor.status(host.remotes()));
      },
      status: async () => {
        let status = supervisor.status(host.remotes());
        const runtime = host.service?.('ops-runtime')?.status?.() || { monitoring: false, code: 'ops_runtime_unavailable' };
        let platform = host.service?.('platform-supervisor');
        if (!platform) {
          try { const optional = require('../platform-supervisor'); if (typeof optional.platformRuntimeInfo === 'function') platform = optional; }
          catch { /* W5 is optional until integrated; absence or load failure is explicitly unavailable. */ }
        }
        let platformReadiness = { code: 'platform_provider_unavailable' };
        try { if (typeof platform?.platformRuntimeInfo === 'function') platformReadiness = platform.platformRuntimeInfo(); else if (platform?.status) platformReadiness = await platform.status(); } catch { platformReadiness = { code: 'platform_provider_unavailable' }; }
        let workspaces = supervisor.state?.workspaces || [];
        const auditReadiness = [], scopeKey = w => JSON.stringify([w.serverId, w.root, w.auditConfig, w.auditAccount]);
        auditReadiness.push(...await Promise.all(workspaces.map(async w => {
          const r = host.remotes().find(r => r.cfg.id === w.serverId);
          const value = r ? await readReady(r, { root: w.root, config: w.auditConfig, account: w.auditAccount }, { probe: status.enabled }) : unavailable('host_unavailable');
          return { serverId: w.serverId, root: w.root, ...value, requiresOwner: value.code !== 'audit_ready' };
        })));
        // A slow status probe must not publish the old ON policy after OFF/configuration has completed.
        const readings = new Map(workspaces.map((w, n) => [scopeKey(w), auditReadiness[n]]));
        status = supervisor.status(host.remotes()); workspaces = supervisor.state?.workspaces || [];
        auditReadiness.splice(0, auditReadiness.length, ...workspaces.map(w => {
          const r = host.remotes().find(r => r.cfg.id === w.serverId);
          return online(r, now()) && readings.has(scopeKey(w)) ? readings.get(scopeKey(w)) :
            { serverId: w.serverId, root: w.root, ...unavailable(online(r, now()) ? 'audit_readiness_unavailable' : 'host_unavailable'), requiresOwner: true };
        }));
        return { ...status, autoRecovery: status.enabled && supervisor.state?.autoRecovery === true,
          workspaces, leaders: supervisor.state?.leaders || [], auditReadiness, autoEnroll: supervisor.state?.autoEnroll === true, excluded: supervisor.state?.excluded || [],
          runtime: { processAlive: true, unlocked: status.errors.every(e => e.code !== 'storage_locked'), monitoring: runtime.monitoring,
            ...healthOf(status),
            quota: 'unknown', platform: platformReadiness,
            passwordOnlyAccounts: host.remotes().filter(r => !r.cfg.local && r.cfg.auth === 'password').map(r => ({ serverId: r.cfg.id, code: 'persistent_ssh_identity_required', requiresOwner: true })) },
          registrationCandidates: host.remotes().filter(r => online(r, now())).flatMap(r => (r.snapshot?.sessions || []).filter(s =>
            !/^tn-ops(?:-audit)?(?:-|$)/.test(s.name) && policy.validIdentity(policy.liveIdentity(r, s))).map(s => ({ serverId: r.cfg.id, session: s.name,
              root: s.aiCwd || s.path, identity: policy.liveIdentity(r, s), code: 'explicit_registration_required' }))),
        };
      },
    };
    host.provide?.('supervision', facade);
    const tick = () => supervisor.tick(host.remotes()).catch(() => host.log('crew_supervisor_failed'));
    // Startup must retire prior authority on the whole fleet before forgetting its IDs, even on one VM's snapshot.
    host.onSnapshot(tick);
    const timer = (options.setInterval || setInterval)(tick, 5000); timer.unref?.();
    const daysOf = () => [1, 3, 7, 14].includes(Number(supervisor.state?.days)) ? Number(supervisor.state.days) : 3;
    host.route('GET', '/status', ({ res }) => host.send(res, 200, supervisor.status(host.remotes())));
    host.route('GET', '/track', async ({ res, url }) => {
      const q = (k) => String(url.searchParams.get(k) || ''), r = host.remotes().find((x) => x.cfg?.id === q('server'));
      const root = q('root'), task = q('task'), id = q('track'), live = q('live') === '1';
      // Only a root the supervisor already watches on that machine, and plain crew names.
      if (!r || !supervisor.host(r.cfg.id)?.roots?.[root] || !/^[A-Za-z0-9][\w-]{0,127}$/.test(task) || !/^[A-Za-z0-9][\w-]{0,40}$/.test(id) || r.mode === 'powershell') {
        host.fail(res, 400, 'invalid_track'); return;
      }
      try { host.send(res, 200, await run(r, trackRuntime, { root, task, id, live }, { timeout: 15000, maxBuffer: 262144 })); }
      catch { host.fail(res, 503, 'track_unavailable'); }
    });
    host.route('POST', '/control', async ({ req, res }) => {
      const body = await host.readJson(req);
      try { host.send(res, 200, await supervisor.control(body, host.remotes())); }
      catch (e) { host.fail(res, /^invalid_/.test(e.message) ? 400 : 503, /^invalid_/.test(e.message) ? e.message : 'storage_failed'); }
    });
    host.route('GET', '/data', ({ res }) => {
      const status = supervisor.status(host.remotes()), servers = [];
      for (const r of host.remotes()) {
        if (!r.cfg) continue; const st = supervisor.host(r.cfg.id); if (!st) continue;
        const roots = supervisor.rootsWithLeaders(r.cfg.id), snap = r.snapshot || {};
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
    return { supervisor, facade, tick, stop: () => { (options.clearInterval || clearInterval)(timer); supervisor.stop(); } };
  },
};
