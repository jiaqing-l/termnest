'use strict';

// Serialized verbatim by runOnHost. Only these operations are executable; data never supplies shell commands.
// Linux flock is attached to an inherited open-file description. The parent keeps it until all state writes
// AND tmux calls finish. Kernel cleanup on death needs no age-based PID-file deletion or stale-lock unlink.
function guardRuntime(injected = {}) {
  const fs = injected.fs || require('node:fs'), path = require('node:path'), os = injected.os || require('node:os'), crypto = require('node:crypto');
  const cp = injected.cp || require('node:child_process'), nowOf = injected.now || Date.now;
  const platform = injected.platform || process.platform;
  const hash = v => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
  const code = (code, more = {}) => ({ code, ...more, ...(more.receipt ? { remoteNow: nowOf() } : {}) });
  const fail = c => { throw Object.assign(Error(c), { code: c }); };
  const exec = (file, args, options = {}) => cp.execFileSync(file, args, { encoding: 'utf8', timeout: 8000,
    maxBuffer: 262144, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  const rootOK = p => typeof p === 'string' && p.startsWith('/') && p.length <= 1024 && path.normalize(p) === p && !/[\x00-\x1f\x7f]/.test(p);
  function walk(p, create = false) {
    let current = '/';
    for (const part of p.split('/').filter(Boolean)) {
      current = path.join(current, part);
      if (create) { try { fs.mkdirSync(current, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; } }
      const s = fs.lstatSync(current);
      if (!s.isDirectory() || s.isSymbolicLink()) fail('coordination_unsafe_path');
    }
    if (fs.realpathSync(p) !== p) fail('coordination_unsafe_path');
  }
  function protectedFile(file, max, optional = false, privateMode = false) {
    let fd;
    try {
      const before = fs.lstatSync(file);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== process.getuid() || before.size > max || !(before.mode & 0o400) || privateMode && before.mode & 0o077) fail('coordination_unsafe_file');
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const s = fs.fstatSync(fd);
      if (!s.isFile() || s.dev !== before.dev || s.ino !== before.ino || s.size > max) fail('coordination_unsafe_file');
      const b = Buffer.alloc(max + 1), n = fs.readSync(fd, b, 0, b.length, 0), after = fs.fstatSync(fd), named = fs.lstatSync(file);
      if (n > max || n !== s.size || after.mtimeMs !== s.mtimeMs || after.ctimeMs !== s.ctimeMs || named.ino !== s.ino || named.dev !== s.dev) fail('coordination_changing_file');
      return JSON.parse(b.toString('utf8', 0, n));
    } catch (e) { if (optional && e.code === 'ENOENT') return null; throw e; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  const boot = () => fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  function proc(pid) {
    if (!Number.isSafeInteger(pid) || pid < 1) fail('process_identity_unknown');
    const raw = fs.readFileSync('/proc/' + pid + '/stat', 'utf8'), end = raw.lastIndexOf(')'), f = raw.slice(end + 2).split(' ');
    return { parent: Number(f[1]), start: f[19], uid: fs.statSync('/proc/' + pid).uid, comm: raw.slice(raw.indexOf('(') + 1, end) };
  }
  function descendant(pid, parent) {
    for (let n = 0; n < 64 && pid > 1; n++) { if (pid === parent) return true; pid = proc(pid).parent; }
    return false;
  }
  function inspect(i, session, requireIdle = true) {
    if (!i || !/^%\d+$/.test(i.pane) || !/^\$\d+$/.test(i.sessionId) || !/^\d+$/.test(String(i.created)) || Number(i.created) <= 0 ||
        !Number.isSafeInteger(i.agentStartedAt) || i.agentStartedAt <= 0 ||
        !/^\.claude(?:-[a-zA-Z0-9_.-]{1,60})?$/.test(i.config) || boot() !== i.bootId) fail('live_identity_mismatch');
    const line = exec('tmux', ['display-message', '-p', '-t', i.pane,
      '#{session_id}|#{session_created}|#{pane_id}|#{pane_pid}|#{session_name}']).trim().split('|');
    if (line[0] !== i.sessionId || line[1] !== String(i.created) || line[2] !== i.pane || line[4] !== session) fail('live_identity_mismatch');
    const p = proc(i.agentPid);
    if (p.uid !== process.getuid() || !/claude/i.test(p.comm) || !descendant(i.agentPid, Number(line[3])) ||
        i.processStart && p.start !== i.processStart) fail('process_identity_mismatch');
    const config = path.join(os.homedir(), i.config); walk(config); walk(path.join(config, 'sessions'));
    const st = protectedFile(path.join(config, 'sessions', i.agentPid + '.json'), 65536);
    if (st.startedAt !== i.agentStartedAt || st.kind === 'bg' || st.parkedJobId ||
        requireIdle && (st.status !== 'idle' || st.waitingFor)) fail('agent_not_idle');
    if (typeof st.cwd !== 'string' || fs.realpathSync('/proc/' + i.agentPid + '/cwd') !== fs.realpathSync(st.cwd)) fail('live_identity_mismatch');
    return { processStart: p.start, idleAt: st.statusUpdatedAt, cwd: st.cwd, status: st.status, panePid: Number(line[3]) };
  }
  function auditReadiness(root, config, account) {
    if (!/^\.claude(?:-[a-zA-Z0-9_.-]{1,60})?$/.test(config || '')) return code('audit_account_required', { quota: 'unknown' });
    const dir = path.join(os.homedir(), config);
    try { walk(dir); } catch { return code('audit_config_unavailable', { quota: 'unknown' }); }
    if (['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'].some(k => Object.hasOwn(process.env, k))) return code('audit_account_override', { quota: 'unknown' });
    const env = { ...process.env, CLAUDE_CONFIG_DIR: dir };
    let auth, plugins;
    try { auth = JSON.parse(exec('claude', ['auth', 'status', '--json'], { cwd: root, env })); }
    catch { return code('audit_account_unavailable', { quota: 'unknown' }); }
    if (auth.loggedIn !== true || !(auth.email || auth.accountId)) return code('audit_account_unavailable', { quota: 'unknown' });
    const accountRef = hash([config, auth.email || auth.accountId, auth.orgId || '', auth.authMethod || '']);
    if (account && account !== accountRef) return code('audit_account_mismatch', { accountRef, quota: 'unknown' });
    try { plugins = JSON.parse(exec('claude', ['plugin', 'list', '--json'], { cwd: root, env })); }
    catch { return code('audit_skill_unknown', { accountRef, quota: 'unknown' }); }
    const list = Array.isArray(plugins) ? plugins : plugins.installed;
    if (!Array.isArray(list)) return code('audit_skill_unknown', { accountRef, quota: 'unknown' });
    const found = Array.isArray(list) && list.some(p => {
      if (!/^xspire-devkit@/.test(p.id || '') || p.enabled === false || p.projectEnabled === false) return false;
      const folder = p.readFromFolder || p.installPath;
      if (!rootOK(folder)) return false;
      try { walk(folder); const file = path.join(folder, 'skills', 'xspire-crew-ops-audit', 'SKILL.md');
        walk(path.dirname(file)); const st = fs.lstatSync(file); return st.isFile() && !st.isSymbolicLink() && st.size > 0; } catch { return false; }
    });
    if (!found) return code('audit_skill_missing', { accountRef, quota: 'unknown' });
    return code(account ? 'audit_ready' : 'audit_account_registration_required', { accountRef, quota: 'unknown' });
  }
  return async function operation(a) {
    if (platform !== 'linux') return code('coordination_platform_unavailable');
    let lock, stateFile, dir;
    try {
      if (!a || !rootOK(a.root)) return code('coordination_invalid');
      walk(a.root);
      if (a.op === 'inspect') return code('identity_valid', (injected.inspect || inspect)(a.identity, a.session, false));
      if (a.op === 'readiness') return (injected.readiness || auditReadiness)(a.root, a.config, a.account);
      if (!/^[a-f0-9-]{16,100}$/.test(a.coordinatorId || '')) return code('coordination_invalid');
      dir = path.join(a.root, '_crew', 'termnest-ops', 'coordination'); walk(dir, true);
      const ds = fs.lstatSync(dir);
      if (ds.uid !== process.getuid() || (ds.mode & 0o077)) return code('coordination_unsafe_permissions');
      const lockFile = path.join(dir, 'guard.lock');
      lock = fs.openSync(lockFile, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
      const ls = fs.fstatSync(lock), named = fs.lstatSync(lockFile);
      if (!ls.isFile() || ls.size !== 0 || ls.uid !== process.getuid() || ls.nlink !== 1 || ls.mode & 0o077 || ls.ino !== named.ino || ls.dev !== named.dev) fail('coordination_unsafe_lock');
      try { exec('flock', ['-n', '3'], { stdio: ['ignore', 'pipe', 'pipe', lock] }); }
      catch (e) { return code(e.status === 1 ? 'coordination_busy' : 'coordination_unavailable'); }
      // Interrupted atomic writes are never removed based on age. Bound orphan storage and require inspection instead.
      const entries = fs.opendirSync(dir); let count = 0;
      try { while (entries.readSync()) if (++count > 34) return code('coordination_capacity'); }
      finally { entries.closeSync(); }
      stateFile = path.join(dir, 'state.json');
      let state = protectedFile(stateFile, 2 * 1024 * 1024, true, true) || { version: 1, epoch: 0, lease: null, receipts: {}, scopes: {}, revoked: [] };
      if (state.version !== 1 || !Number.isSafeInteger(state.epoch) || state.epoch < 0 || !Array.isArray(state.revoked) ||
          !state.receipts || typeof state.receipts !== 'object' || Array.isArray(state.receipts) ||
          Object.keys(state.receipts).length > 4096 || state.revoked.length > 512 ||
          state.revoked.some(id => !/^[a-f0-9-]{16,100}$/.test(id)) ||
          state.lease !== null && (!state.lease || !/^[a-f0-9-]{16,100}$/.test(state.lease.coordinatorId) ||
            state.lease.epoch !== state.epoch || !Number.isSafeInteger(state.lease.expiresAt) || state.lease.expiresAt < 0) ||
          Object.entries(state.receipts).some(([id, r]) => !/^[a-f0-9]{64}$/.test(id) || !r || r.eventId !== id ||
            !['audit_open', 'audit_send', 'recovery_send'].includes(r.kind) || !Number.isSafeInteger(r.epoch) || r.epoch < 1 || r.epoch > state.epoch ||
            !Number.isSafeInteger(r.at) || !['pending', 'delivered', 'uncertain', 'cancelled'].includes(r.delivery) ||
            r.scopeId && r.kind === 'recovery_send' && (!/^[a-f0-9]{64}$/.test(r.progressToken || '') || !Number.isSafeInteger(r.deadline) || r.deadline !== r.at + 600000 ||
              !Number.isSafeInteger(r.windowStartedAt) || !Number.isInteger(r.attempts) || r.attempts < 1 || r.attempts > 3))) fail('coordination_corrupt');
      if (state.scopes === undefined) state.scopes = {}; // v1 files written before idle watermark compaction remain reserved.
      if (typeof state.scopes !== 'object' || Array.isArray(state.scopes) || Object.keys(state.scopes).length > 2048 ||
          Object.entries(state.scopes).some(([key, value]) => !/^[a-f0-9]{64}$/.test(key) || !Number.isSafeInteger(value?.idleAt) || value.idleAt <= 0 ||
            !value.receipt || value.receipt.scopeId !== key || value.receipt.idleAt !== value.idleAt ||
            JSON.stringify(state.receipts[value.receipt.eventId]) !== JSON.stringify(value.receipt) ||
            !['pending', 'delivered', 'uncertain', 'cancelled'].includes(value.receipt.delivery))) fail('coordination_corrupt');
      const intact = () => {
        walk(dir); const d = fs.lstatSync(dir), named = fs.lstatSync(lockFile);
        if (d.ino !== ds.ino || d.dev !== ds.dev || named.isSymbolicLink() || named.ino !== ls.ino || named.dev !== ls.dev) fail('coordination_unsafe_path');
      };
      const write = () => {
        const data = JSON.stringify(state); if (Buffer.byteLength(data) > 2 * 1024 * 1024) fail('coordination_capacity');
        const temp = path.join(dir, 'write-' + crypto.randomUUID()); let fd;
        try { fd = fs.openSync(temp, 'wx', 0o600); fs.writeFileSync(fd, data); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
          intact(); fs.renameSync(temp, stateFile); const d = fs.openSync(dir, 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } }
        finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch {} }
      };
      const now = nowOf();
      if (a.op === 'revoke') {
        if (!state.revoked.includes(a.coordinatorId)) {
          if (state.revoked.length >= 512) fail('coordination_capacity'); state.revoked.push(a.coordinatorId);
        }
        if (state.lease?.coordinatorId === a.coordinatorId) state.lease.expiresAt = 0;
        write(); return code('coordination_revoked');
      }
      if (state.revoked.includes(a.coordinatorId)) return code('coordination_revoked');
      if (a.op === 'lease') {
        if (state.lease && state.lease.expiresAt > now && state.lease.coordinatorId !== a.coordinatorId) return code('coordination_owned');
        if (!state.lease || state.lease.coordinatorId !== a.coordinatorId || state.lease.expiresAt <= now) {
          if (state.epoch >= Number.MAX_SAFE_INTEGER) fail('coordination_capacity'); state.epoch++;
        }
        state.lease = { coordinatorId: a.coordinatorId, epoch: state.epoch, expiresAt: now + 45000 };
        write(); return code('coordination_owner', { token: state.lease });
      }
      const validToken = () => state.lease && a.token?.coordinatorId === a.coordinatorId && state.lease.coordinatorId === a.coordinatorId &&
        a.token.epoch === state.epoch && state.lease.epoch === state.epoch && state.lease.expiresAt > nowOf();
      if (!validToken()) return code('coordination_fenced');
      if (a.op !== 'action' || !['audit_open', 'audit_send', 'recovery_send'].includes(a.kind) || !/^[a-f0-9]{64}$/.test(a.eventId || '') ||
          typeof a.session !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(a.session)) return code('coordination_invalid');
      if (state.receipts[a.eventId]) return code('action_duplicate', { receipt: state.receipts[a.eventId] });
      const scopeId = a.kind === 'audit_open' ? null : hash([a.kind, a.identity?.bootId, a.identity?.sessionId, String(a.identity?.created),
        a.identity?.pane, a.identity?.agentPid, a.identity?.agentStartedAt, a.identity?.config, a.session]);
      const prior = scopeId && state.scopes[scopeId];
      // Timestamp churn or a coordinator transfer cannot erase an unresolved typed prompt. Never replay old idle events.
      if (prior && (['pending', 'uncertain'].includes(prior.receipt.delivery) || a.idleAt <= prior.idleAt)) return code('action_duplicate', { receipt: prior.receipt });
      if (a.kind === 'recovery_send') {
        if (!/^[a-f0-9]{64}$/.test(a.progressToken || '')) return code('task_evidence_unknown');
        if (prior?.receipt.progressToken === a.progressToken) return code('action_duplicate', { receipt: prior.receipt });
        if (prior && now - prior.receipt.windowStartedAt < 3600000 && prior.receipt.attempts >= 3) return code('recovery_rate_limited');
      }
      const legacyUncertain = Object.values(state.receipts).find(r => !r.scopeId && r.kind === a.kind && r.session === a.session && ['pending', 'uncertain'].includes(r.delivery));
      if (legacyUncertain) return code('action_duplicate', { receipt: legacyUncertain });
      if (scopeId && !prior && Object.keys(state.scopes).length >= 2048) return code('coordination_capacity');
      let observed, workers = () => null;
      if (a.kind === 'audit_open') {
        if (!/^tn-ops-audit-[a-f0-9]{16}$/.test(a.session) || !a.account) return code('audit_account_required');
        const ready = (injected.readiness || auditReadiness)(a.root, a.config, a.account);
        if (ready.code !== 'audit_ready') return ready;
        try { exec('tmux', ['has-session', '-t', '=' + a.session]); return code('audit_session_exists'); }
        catch (e) { if (e.status !== 1) return code('tmux_unavailable'); }
      } else {
        if (typeof a.prompt !== 'string' || !a.prompt || Buffer.byteLength(a.prompt) > 16384 || /[\x00-\x09\x0b-\x1f\x7f]/.test(a.prompt)) return code('prompt_invalid');
        if (a.kind === 'recovery_send' && /^tn-ops-audit(?:-|$)/.test(a.session)) return code('leader_missing');
        observed = (injected.inspect || inspect)(a.identity, a.session);
        const scopeOK = cwd => typeof cwd === 'string' && path.normalize(cwd) === cwd && (cwd === a.root || a.kind === 'recovery_send' && cwd.startsWith(a.root + '/'));
        if (observed.idleAt !== a.idleAt || !scopeOK(observed.cwd)) return code('live_identity_mismatch');
        if (a.kind === 'audit_send') {
          if (a.identity.config !== a.config) return code('audit_account_mismatch');
          const ready = (injected.readiness || auditReadiness)(a.root, a.config, a.account);
          if (ready.code !== 'audit_ready') return ready;
        } else {
          if (!Array.isArray(a.taskIds) || !a.taskIds.length || a.taskIds.length > 100) return code('managed_task_missing');
          for (const id of a.taskIds) {
            if (!/^[A-Za-z0-9][\w-]{0,127}$/.test(id)) return code('managed_task_missing');
            const taskDir = path.join(a.root, '_crew', 'tasks', id); walk(taskDir);
            const file = path.join(taskDir, 'MANIFEST.md'), st = fs.lstatSync(file);
            if (!st.isFile() || st.isSymbolicLink() || st.size > 65536) return code('managed_task_unknown');
            const text = fs.readFileSync(file, 'utf8'), front = text.split(/^---\s*$/m)[1] || '';
            const status = /^status:\s*([^\n]*)/m.exec(front)?.[1]?.trim(), blocked = /^blocked:\s*([^\n]*)/m.exec(front)?.[1]?.trim();
            if (!status || /done|closed|abandoned|archived|merged|approval|waiting_owner|awaiting_owner|blocked/.test(status) ||
                blocked === undefined || !/^(null|~|)$/.test(blocked) || /state:\s*(blocked|failed)/.test(front) ||
                !/state:\s*(pending|queued|dispatched|running|fix|review)/.test(front)) return code('managed_task_blocked');
          }
          // Fresh remote process metadata also covers detached dispatchers, outside the leader's ancestry.
          // Raw argv stays on this host and is never included in a result or a receipt.
          workers = () => {
            if (injected.inspect) return null;
            let table;
            try { table = exec('ps', ['-eo', 'pid=,ppid=,args=']); } catch { return code('workers_unknown'); }
            let sawLeader = false;
            for (const line of table.split('\n')) {
              const m = /^\s*(\d+)\s+\d+\s+(.*)$/.exec(line); if (!m) continue;
              const pid = Number(m[1]), args = m[2]; if (pid === a.identity.agentPid) { sawLeader = true; continue; } if (pid === process.pid) continue;
              try {
                const p = proc(pid); if (p.uid !== process.getuid()) continue;
                if (/claude|codex/i.test(p.comm) && descendant(pid, observed.panePid)) return code('live_worker');
                if (/(?:^|[\s/])crew-dispatch\.sh(?:\s|$)/.test(args)) {
                  const task = /(?:^|\s)--task(?:=|\s+)([A-Za-z0-9][\w-]*)(?:\s|$)/.exec(args)?.[1];
                  if (!task) return code('workers_unknown');
                  if (a.taskIds.includes(task)) return code('live_worker');
                }
              } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ESRCH') return code('workers_unknown'); }
            }
            if (!sawLeader) return code('workers_unknown');
            return null;
          };
          const problem = workers(); if (problem) return problem;
        }
      }
      // Intent survives any command failure/crash. It is NEVER removed or retried based on elapsed time.
      const receipt = { kind: a.kind, eventId: a.eventId, epoch: state.epoch, at: now, delivery: 'pending', runId: a.runId || '', session: a.session,
        ...(scopeId ? { scopeId, idleAt: a.idleAt } : {}),
        ...(a.kind === 'recovery_send' ? { progressToken: a.progressToken, deadline: now + 600000,
          windowStartedAt: prior && now - prior.receipt.windowStartedAt < 3600000 ? prior.receipt.windowStartedAt : now,
          attempts: prior && now - prior.receipt.windowStartedAt < 3600000 ? prior.receipt.attempts + 1 : 1 } : {}) };
      if (scopeId) {
        if (!Number.isSafeInteger(a.idleAt) || a.idleAt <= 0) return code('idle_unknown');
        // Compact acknowledged older events only behind a durable monotonic idle watermark for the exact live identity.
        for (const [key, r] of Object.entries(state.receipts)) if (r.scopeId === scopeId && r.delivery === 'delivered') delete state.receipts[key];
        state.scopes[scopeId] = { idleAt: a.idleAt, receipt };
      }
      if (Object.keys(state.receipts).length >= 4096) return code('coordination_capacity');
      state.receipts[a.eventId] = receipt; write();
      intact();
      if (!validToken()) { receipt.delivery = 'cancelled'; write(); return code('coordination_fenced', { receipt }); }
      let sideEffectStarted = false;
      try {
        if (a.kind === 'audit_open') {
          if (!validToken()) fail('coordination_fenced');
          sideEffectStarted = true;
          exec('tmux', ['new-session', '-d', '-s', a.session, '-c', a.root,
            '-e', 'CLAUDE_CONFIG_DIR=' + path.join(os.homedir(), a.config), 'claude']);
        }
        else {
          // Revalidate after fsync and immediately beside the side effect while retaining the ownership lock.
          const latest = (injected.inspect || inspect)(a.identity, a.session);
          if (latest.idleAt !== a.idleAt || !(latest.cwd === a.root || a.kind === 'recovery_send' && typeof latest.cwd === 'string' && latest.cwd.startsWith(a.root + '/'))) fail('live_identity_mismatch');
          const problem = workers(); if (problem) fail(problem.code);
          intact(); if (!validToken()) fail('coordination_fenced');
          sideEffectStarted = true;
          const lines = a.prompt.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (i) exec('tmux', ['send-keys', '-t', a.identity.pane, 'C-j']);
            if (lines[i]) exec('tmux', ['send-keys', '-l', '-t', a.identity.pane, '--', lines[i]]);
          }
          exec('tmux', ['send-keys', '-t', a.identity.pane, 'Enter']);
        }
        receipt.delivery = 'delivered'; receipt.deliveredAt = nowOf(); write();
        return code('action_delivered', { receipt });
      } catch (e) {
        receipt.delivery = sideEffectStarted ? 'uncertain' : 'cancelled'; try { write(); } catch {}
        const held = /^(coordination_|live_identity|agent_|workers_)/.test(e.code || '') ? e.code : 'live_identity_unknown';
        return code(sideEffectStarted ? 'action_uncertain' : held, { receipt });
      }
    } catch (e) { return code(e.code?.startsWith('coordination_') || /identity|idle/.test(e.code || '') ? e.code : 'coordination_unavailable'); }
    finally { if (lock !== undefined) fs.closeSync(lock); }
  };
}

module.exports = { guardRuntime };
