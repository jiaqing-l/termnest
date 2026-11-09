'use strict';

// Serialized verbatim by runOnHost. Only these operations are executable; data never supplies shell commands.
// flock is attached to an inherited open-file description. The parent keeps it until all state writes
// AND tmux calls finish. Kernel cleanup on death needs no age-based PID-file deletion or stale-lock unlink.
// Linux reads /proc and uses flock(1); macOS uses sysctl, ps, lsof and perl's flock() on the same descriptor.
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
  const darwin = platform === 'darwin';
  const boot = injected.boot || (() => darwin ? exec('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']).trim() : fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim());
  // macOS: one process-table read per operation (ps per pid would be slow). Start = launch time in epoch seconds.
  let table = null;
  function darwinTable() {
    if (table) return table;
    table = new Map();
    const out = exec('/bin/ps', ['-axo', 'pid=,ppid=,uid=,lstart=,comm='], { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, maxBuffer: 8 << 20 });
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.*)$/.exec(line); if (!m) continue;
      const at = Date.parse(m[4].replace(/\s+/g, ' ') + ' UTC'); if (!Number.isFinite(at)) continue;
      table.set(Number(m[1]), { parent: Number(m[2]), uid: Number(m[3]), start: String(at / 1000), comm: path.basename(m[5].trim()) });
    }
    return table;
  }
  function proc(pid) {
    if (!Number.isSafeInteger(pid) || pid < 1) fail('process_identity_unknown');
    if (darwin) { const p = darwinTable().get(pid); if (!p) throw Object.assign(Error('no such process'), { code: 'ESRCH' }); return p; }
    const raw = fs.readFileSync('/proc/' + pid + '/stat', 'utf8'), end = raw.lastIndexOf(')'), f = raw.slice(end + 2).split(' ');
    return { parent: Number(f[1]), start: f[19], uid: fs.statSync('/proc/' + pid).uid, comm: raw.slice(raw.indexOf('(') + 1, end) };
  }
  function cwdOf(pid) {
    if (!darwin) return fs.realpathSync('/proc/' + pid + '/cwd');
    const n = exec('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']).split('\n').find(l => l.startsWith('n/'));
    if (!n) fail('live_identity_mismatch');
    return fs.realpathSync(n.slice(1));
  }
  // Locks fd 3 (the inherited lock description) without blocking; exit 1 = held by someone else.
  function lockInherited(lock) {
    const stdio = ['ignore', 'pipe', 'pipe', lock];
    if (!darwin) return exec('flock', ['-n', '3'], { stdio });
    return exec('/usr/bin/perl', ['-e', 'use Fcntl qw(:flock); open(my $f, "+<&=", 3) or exit 2; flock($f, LOCK_EX|LOCK_NB) or exit 1; exit 0'], { stdio });
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
    if (typeof st.cwd !== 'string' || cwdOf(i.agentPid) !== fs.realpathSync(st.cwd)) fail('live_identity_mismatch');
    return { processStart: p.start, idleAt: st.statusUpdatedAt, cwd: st.cwd, status: st.status, panePid: Number(line[3]) };
  }
  // Absence in a browser snapshot is never death proof. Query exact remote tmux AND /proc identities.
  function proveAuditDead(i) {
    if (!i || typeof i.bootId !== 'string' || !i.bootId) return code('audit_death_unverified');
    if (boot() !== i.bootId) return code('audit_identity_dead', { proof: 'boot_superseded' });
    if (!/^\$\d+$/.test(i.sessionId || '') || !/^\d+$/.test(String(i.created)) || !Number.isSafeInteger(i.agentPid) || !/^\d+$/.test(i.processStart || '')) return code('audit_death_unverified');
    let table;
    try { table = exec('tmux', ['list-sessions', '-F', '#{session_id}|#{session_created}']); }
    catch (e) {
      if (e.status !== 1 || !/^(?:no server running on [^\n]+|no sessions|error connecting to [^\n]+ \(No such file or directory\))\s*$/.test(String(e.stderr || '').trim())) return code('audit_death_unverified');
      table = '';
    }
    const lines = table.trim() ? table.trim().split('\n') : [];
    if (lines.some(line => !/^\$\d+\|\d+$/.test(line))) return code('audit_death_unverified');
    if (lines.includes(i.sessionId + '|' + i.created)) return code('audit_identity_live');
    try { if (proc(i.agentPid).start === i.processStart) return code('audit_identity_live'); }
    catch (e) { if (!['ENOENT', 'ESRCH'].includes(e.code)) return code('audit_death_unverified'); }
    return code('audit_identity_dead', { proof: 'session_and_process_superseded' });
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
    if (auth.loggedIn !== true || typeof (auth.email || auth.accountId) !== 'string' || (auth.email || auth.accountId).length > 320) return code('audit_account_unavailable', { quota: 'unknown' });
    // Only a readable own identity crosses the boundary. Never return raw auth/plugin output or env.
    const label = typeof auth.email === 'string' ? auth.email.trim() : '';
    if (!label || label.length > 160 || !/^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+$/.test(label)) return code('audit_account_identity_unavailable', { quota: 'unknown' });
    if (auth.orgId !== undefined && (typeof auth.orgId !== 'string' || auth.orgId.length > 320) || auth.authMethod !== undefined && (typeof auth.authMethod !== 'string' || auth.authMethod.length > 80)) return code('audit_account_identity_unavailable', { quota: 'unknown' });
    const accountRef = hash([config, label, auth.orgId || '', auth.authMethod || '']);
    const own = { accountRef, label, quota: 'unknown' };
    if (account && account !== accountRef) return code('audit_account_mismatch', own);
    try { plugins = JSON.parse(exec('claude', ['plugin', 'list', '--json'], { cwd: root, env })); }
    catch { return code('audit_skill_unknown', own); }
    const list = Array.isArray(plugins) ? plugins : plugins.installed;
    if (!Array.isArray(list)) return code('audit_skill_unknown', own);
    const found = Array.isArray(list) && list.some(p => {
      if (!/^xspire-devkit@/.test(p.id || '') || p.enabled === false || p.projectEnabled === false) return false;
      const folder = p.readFromFolder || p.installPath;
      if (!rootOK(folder)) return false;
      try { walk(folder); const file = path.join(folder, 'skills', 'xspire-crew-ops-audit', 'SKILL.md');
        walk(path.dirname(file)); const st = fs.lstatSync(file); return st.isFile() && !st.isSymbolicLink() && st.size > 0; } catch { return false; }
    });
    if (!found) return code('audit_skill_missing', own);
    return code(account ? 'audit_ready' : 'audit_account_registration_required', own);
  }
  return async function operation(a) {
    if (platform !== 'linux' && !darwin) return code('coordination_platform_unavailable');
    table = null; // fresh process facts for every operation
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
      try { lockInherited(lock); }
      catch (e) { return code(e.status === 1 ? 'coordination_busy' : 'coordination_unavailable'); }
      // Interrupted atomic writes are never removed based on age. Bound orphan storage and require inspection instead.
      const entries = fs.opendirSync(dir); let count = 0;
      try { while (entries.readSync()) if (++count > 34) return code('coordination_capacity_orphans'); }
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
      for (const value of Object.values(state.scopes)) value.receipt = state.receipts[value.receipt.eventId];
      // Conservative tombstones never forget a denial. False positives hold for owner review; no false negatives.
      // Keep recent diagnostic entries separately, with a fixed-size bitset for older revoked/event identities.
      if ((state.safetyFilter === undefined) !== (state.safetyCount === undefined)) fail('coordination_corrupt');
      if (state.safetyFilter !== undefined && (!/^[a-f0-9]{262144}$/.test(state.safetyFilter) || !Number.isSafeInteger(state.safetyCount) || state.safetyCount < 0 || state.safetyCount > 65536)) fail('coordination_corrupt');
      const bits = state.safetyFilter ? Buffer.from(state.safetyFilter, 'hex') : Buffer.alloc(131072);
      const indexes = key => { const b = crypto.createHash('sha256').update(key).digest(); return [0, 4, 8, 12, 16, 20].map(n => b.readUInt32LE(n) % (bits.length * 8)); };
      const denied = key => indexes(key).every(n => bits[n >>> 3] & (1 << (n & 7)));
      const deny = key => {
        if (denied(key)) return;
        if ((state.safetyCount || 0) >= 65536) fail('coordination_capacity_tombstones');
        for (const n of indexes(key)) bits[n >>> 3] |= 1 << (n & 7);
        state.safetyCount = (state.safetyCount || 0) + 1; state.safetyFilter = bits.toString('hex');
      };
      const intact = () => {
        walk(dir); const d = fs.lstatSync(dir), named = fs.lstatSync(lockFile);
        if (d.ino !== ds.ino || d.dev !== ds.dev || named.isSymbolicLink() || named.ino !== ls.ino || named.dev !== ls.dev) fail('coordination_unsafe_path');
      };
      const write = () => {
        const data = JSON.stringify(state); if (Buffer.byteLength(data) > 2 * 1024 * 1024) fail('coordination_capacity_storage');
        const temp = path.join(dir, 'write-' + crypto.randomUUID()); let fd;
        try { fd = fs.openSync(temp, 'wx', 0o600); fs.writeFileSync(fd, data); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
          intact(); fs.renameSync(temp, stateFile); const d = fs.openSync(dir, 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } }
        finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch {} }
      };
      const now = nowOf();
      // Exhaustion freezes this root durably. OFF can still confirm that every queued token is fenced.
      if (state.safetyCount === 65536) {
        if (state.lease) state.lease.expiresAt = 0;
        write(); return code(a.op === 'revoke' ? 'coordination_revoked' : 'coordination_capacity_tombstones');
      }
      if (a.op === 'revoke') {
        if (!state.revoked.includes(a.coordinatorId)) {
          for (const id of state.revoked) deny('coordinator:' + id);
          deny('coordinator:' + a.coordinatorId); state.revoked.push(a.coordinatorId); state.revoked = state.revoked.slice(-64);
        }
        if (state.lease?.coordinatorId === a.coordinatorId) state.lease.expiresAt = 0;
        write(); return code('coordination_revoked');
      }
      if (state.revoked.includes(a.coordinatorId) || denied('coordinator:' + a.coordinatorId)) return code('coordination_revoked');
      if (a.op === 'lease') {
        if (state.lease && state.lease.expiresAt > now && state.lease.coordinatorId !== a.coordinatorId) return code('coordination_owned');
        if (!state.lease || state.lease.coordinatorId !== a.coordinatorId || state.lease.expiresAt <= now) {
          if (state.epoch >= Number.MAX_SAFE_INTEGER) fail('coordination_capacity_epoch'); state.epoch++;
        }
        state.lease = { coordinatorId: a.coordinatorId, epoch: state.epoch, expiresAt: now + 45000 };
        write(); return code('coordination_owner', { token: state.lease });
      }
      const validToken = () => state.lease && a.token?.coordinatorId === a.coordinatorId && state.lease.coordinatorId === a.coordinatorId &&
        a.token.epoch === state.epoch && state.lease.epoch === state.epoch && state.lease.expiresAt > nowOf();
      if (!validToken()) return code('coordination_fenced');
      if (a.op === 'ack_audit') {
        if (!/^tn-[a-f0-9]{32}$/.test(a.runId || '')) return code('coordination_invalid');
        for (const r of Object.values(state.receipts)) if (r.runId === a.runId && /^audit_/.test(r.kind) && r.delivery === 'delivered') r.reported = true;
        write(); return code('audit_acknowledged');
      }
      if (a.op === 'retire_audit') {
        if (!/^tn-[a-f0-9]{32}$/.test(a.runId || '') || !/^tn-ops-audit(?:-[a-f0-9]{16})?$/.test(a.session || '')) return code('coordination_invalid');
        const receipts = Object.values(state.receipts).filter(r => r.runId === a.runId && r.session === a.session && /^audit_/.test(r.kind));
        if (!receipts.length || receipts.some(r => ['pending', 'uncertain'].includes(r.delivery))) return code('audit_retirement_uncertain');
        const prior = receipts.find(r => r.kind === 'audit_send' && r.delivery === 'delivered') || receipts.find(r => r.kind === 'audit_open' && r.delivery === 'delivered');
        if (!prior?.identity) return code('audit_death_unverified');
        const proof = (injected.proveAuditDead || proveAuditDead)(prior.identity);
        if (proof.code !== 'audit_identity_dead') return proof;
        // No previous helper can still execute: it must have released this same kernel lock and recorded delivery.
        // Refuse a partial/pending prompt for ANY run of the same session, even after a process disappears.
        if (Object.values(state.receipts).some(r => r.session === a.session && /^audit_/.test(r.kind) && ['pending', 'uncertain'].includes(r.delivery))) return code('audit_retirement_uncertain');
        if (!validToken()) return code('coordination_fenced');
        for (const r of receipts) { r.retiredAt = now; r.retirement = a.reported === true || r.reported === true ? 'reported' : 'failed_unverified'; if (a.reported === true) r.reported = true; }
        // Failed/uncertain history is preserved verbatim. Only acknowledged, reported receipts may compact.
        // A durable event tombstone protects old opens too, after the exact session/process is proven dead.
        for (const r of Object.values(state.receipts)) {
          const sameSession = r.session === a.session && r.identity?.bootId === prior.identity.bootId && r.identity?.sessionId && r.identity.sessionId === prior.identity.sessionId && String(r.identity.created) === String(prior.identity.created);
          if (r.delivery !== 'delivered' || r.reported !== true || !(receipts.includes(r) || sameSession)) continue;
          deny('event:' + r.eventId);
          if (r.scopeId) delete state.scopes[r.scopeId];
          delete state.receipts[r.eventId];
        }
        write(); return code('audit_retired', { runId: a.runId, proof: proof.proof, observedAt: now });
      }
      if (a.op !== 'action' || !['audit_open', 'audit_send', 'recovery_send'].includes(a.kind) || !/^[a-f0-9]{64}$/.test(a.eventId || '') ||
          typeof a.session !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(a.session)) return code('coordination_invalid');
      if (state.receipts[a.eventId]) return code('action_duplicate', { receipt: state.receipts[a.eventId] });
      if (denied('event:' + a.eventId)) return code('action_duplicate');
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
      if (scopeId && !prior && Object.keys(state.scopes).length >= 2048) return code('coordination_capacity_identities');
      let observed, workers = () => null;
      if (a.kind === 'audit_open') {
        if (!/^tn-ops-audit-[a-f0-9]{16}$/.test(a.session) || !a.account) return code('audit_account_required');
        const ready = (injected.readiness || auditReadiness)(a.root, a.config, a.account);
        if (ready.code !== 'audit_ready') return ready;
        try { exec('tmux', ['has-session', '-t', '=' + a.session]); return code('audit_session_exists'); }
        catch (e) { if (e.status !== 1) return code('tmux_unavailable'); }
        const old = Object.values(state.receipts).filter(r => r.session === a.session && /^audit_/.test(r.kind));
        if (old.some(r => ['pending', 'uncertain'].includes(r.delivery))) return code('audit_retirement_uncertain');
        const groups = new Map();
        for (const r of old.filter(r => !r.retiredAt)) { if (!groups.has(r.runId)) groups.set(r.runId, []); groups.get(r.runId).push(r); }
        for (const group of groups.values()) {
          const prior = group.find(r => r.kind === 'audit_send' && r.delivery === 'delivered') || group.find(r => r.kind === 'audit_open' && r.delivery === 'delivered');
          if (!prior) continue;
          const proof = (injected.proveAuditDead || proveAuditDead)(prior.identity);
          if (proof.code !== 'audit_identity_dead') return proof;
          for (const r of group) {
            r.retiredAt = now; r.retirement = r.reported ? 'reported' : 'failed_unverified';
            if (r.reported && r.delivery === 'delivered') { deny('event:' + r.eventId); if (r.scopeId) delete state.scopes[r.scopeId]; delete state.receipts[r.eventId]; }
          }
        }
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
      const receipt = { identity: a.kind === 'audit_open' ? { bootId: boot() } : { ...a.identity, processStart: observed?.processStart }, kind: a.kind, eventId: a.eventId, epoch: state.epoch, at: now, delivery: 'pending', runId: a.runId || '', session: a.session,
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
      if (Object.keys(state.receipts).length >= 4096) return code('coordination_capacity_receipts');
      state.receipts[a.eventId] = receipt; write();
      intact();
      if (!validToken()) { receipt.delivery = 'cancelled'; write(); return code('coordination_fenced', { receipt }); }
      let sideEffectStarted = false;
      try {
        if (a.kind === 'audit_open') {
          if (!validToken()) fail('coordination_fenced');
          sideEffectStarted = true;
          const opened = exec('tmux', ['new-session', '-d', '-P', '-F', '#{session_id}|#{session_created}|#{pane_id}|#{pane_pid}', '-s', a.session, '-c', a.root,
            '-e', 'CLAUDE_CONFIG_DIR=' + path.join(os.homedir(), a.config), 'claude']);
          const fields = String(opened).trim().split('|');
          if (/^\$\d+$/.test(fields[0]) && /^\d+$/.test(fields[1]) && /^%\d+$/.test(fields[2]) && /^\d+$/.test(fields[3])) {
            const pid = Number(fields[3]);
            try {
              const p = proc(pid);
              receipt.identity = { bootId: boot(), sessionId: fields[0], created: Number(fields[1]), pane: fields[2],
                ...(/claude/i.test(p.comm) ? { agentPid: pid, processStart: p.start } : { panePid: pid, paneStart: p.start }) };
              // A startup shell is not proof of the agent's identity. Same-boot retirement then needs a send receipt.
            } catch { /* Boot proof remains available; same-boot death is unverified. */ }
          }
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
