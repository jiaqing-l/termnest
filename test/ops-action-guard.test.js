'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { guardRuntime } = require('../lib/ops-action-guard');
const { digest } = require('../lib/supervision-state');
const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const linux = { skip: process.platform !== 'linux' };
const posix = { skip: !['linux', 'darwin'].includes(process.platform) }; // flock: flock(1) on Linux, perl flock() on macOS
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tn-fence-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = 1800000000000, idleAt = 10, failure = false, calls = [], inspections = 0, onInspect;
  const runtime = guardRuntime({ now: () => now, inspect: () => { inspections++; onInspect?.(inspections); return { processStart: '23', cwd: root, idleAt }; },
    readiness: () => ({ code: 'audit_ready', quota: 'unknown' }),
    cp: { execFileSync(file, args, opts) {
      if (file === 'flock' || file === '/usr/bin/perl') return cp.execFileSync(file, args, opts);
      assert.equal(file, 'tmux'); calls.push(args);
      if (failure && args[0] === 'send-keys') throw Object.assign(Error('partial tmux'), { status: 1 });
      if (args[0] === 'has-session') throw Object.assign(Error('absent'), { status: 1 });
      return '';
    } },
  });
  const request = (op, extra = {}) => runtime({ op, root, coordinatorId: A, ...extra });
  const action = token => ({ token, kind: 'audit_send', eventId: digest('idle-one'), identity: { pane: '%7', config: '.claude' },
    idleAt, session: 'tn-ops-audit-0123456789abcdef', config: '.claude', account: 'a'.repeat(64), prompt: 'First line\nSecond line', runId: 'first-run' });
  return { root, runtime, request, action, get calls() { return calls; }, get inspections() { return inspections; },
    advance(ms) { now += ms; }, setIdle(at) { idleAt = at; }, setInspectHook(fn) { onInspect = fn; }, fail() { failure = true; }, get now() { return now; } };
}

test('two coordinators share one remote lease, transfer increments epoch, stale token cannot send or replay an idle receipt', posix, async t => {
  const f = fixture(t), one = await f.request('lease'); assert.equal(one.code, 'coordination_owner');
  assert.equal((await f.request('lease', { coordinatorId: B })).code, 'coordination_owned');
  const sent = await f.request('action', f.action(one.token)); assert.equal(sent.code, 'action_delivered');
  assert.equal(f.inspections, 2, 'identity checked again after durable reservation');
  const count = f.calls.length;
  f.advance(45001); const two = await f.request('lease', { coordinatorId: B }); assert.equal(two.token.epoch, one.token.epoch + 1);
  assert.equal((await f.request('action', { ...f.action(one.token), eventId: digest('another-idle') })).code, 'coordination_fenced');
  const duplicate = await f.request('action', { ...f.action(two.token), coordinatorId: B, runId: 'other-run' });
  assert.equal(duplicate.code, 'action_duplicate'); assert.equal(duplicate.receipt.runId, 'first-run');
  assert.equal(f.calls.length, count);
});

test('an inherited kernel lock remains held across tmux, and a contender cannot take over during a long side effect', posix, async t => {
  const f = fixture(t), lease = await f.request('lease'), marker = path.join(f.root, 'in-action');
  // A separate foreground-awaited process executes the REAL runtime and flock; only tmux/agent IO is simulated.
  const script = `const fs=require('node:fs'),cp=require('node:child_process'); const guard=(${guardRuntime.toString()})({now:()=>${f.now},
    inspect:()=>({cwd:${JSON.stringify(f.root)},idleAt:10}),readiness:()=>({code:'audit_ready'}),cp:{execFileSync(file,args,opts){
      if(file==='flock'||file==='/usr/bin/perl')return cp.execFileSync(file,args,opts);fs.writeFileSync(${JSON.stringify(marker)},'held');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,150);return '';}}});
    guard(${JSON.stringify({ op: 'action', root: f.root, coordinatorId: A, ...f.action(lease.token), prompt: 'one' })}).then(v=>process.stdout.write(JSON.stringify(v)));`;
  const child = cp.spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; child.stdout.on('data', b => { out += b; }); child.stderr.on('data', b => { err += b; });
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve(code)); });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise(r => setTimeout(r, 5));
  assert.equal(fs.existsSync(marker), true, err);
  f.advance(60000);
  assert.equal((await f.request('lease', { coordinatorId: B })).code, 'coordination_busy');
  assert.equal(await done, 0, err); assert.equal(JSON.parse(out).code, 'action_delivered');
  assert.equal((await f.request('lease', { coordinatorId: B })).code, 'coordination_owner');
});

test('partial tmux failure leaves a durable uncertain receipt; a fresh runtime and coordinator never replay it', posix, async t => {
  const f = fixture(t), lease = await f.request('lease'); f.fail();
  assert.equal((await f.request('action', f.action(lease.token))).code, 'action_uncertain');
  const count = f.calls.length;
  const state = JSON.parse(fs.readFileSync(path.join(f.root, '_crew/termnest-ops/coordination/state.json')));
  assert.equal(state.receipts[digest('idle-one')].delivery, 'uncertain');
  f.advance(45001); const next = await f.request('lease', { coordinatorId: B });
  const fresh = guardRuntime({ now: () => f.now });
  const result = await fresh({ op: 'action', root: f.root, coordinatorId: B, ...f.action(next.token) });
  assert.equal(result.code, 'action_duplicate'); assert.equal(result.receipt.delivery, 'uncertain'); assert.equal(f.calls.length, count);
  f.setIdle(11);
  const churn = await fresh({ op: 'action', root: f.root, coordinatorId: B, ...f.action(next.token), eventId: digest('new-idle-after-partial') });
  assert.equal(churn.code, 'action_duplicate'); assert.equal(churn.receipt.delivery, 'uncertain'); assert.equal(f.calls.length, count);
});

test('remote helper death releases only its kernel lock and preserves a pending cross-event uncertainty barrier', posix, async t => {
  const f = fixture(t), lease = await f.request('lease'), marker = path.join(f.root, 'entered-send');
  const lockFile = path.join(f.root, '_crew/termnest-ops/coordination/guard.lock'), inode = fs.statSync(lockFile).ino;
  const script = `const fs=require('node:fs'),cp=require('node:child_process');const guard=(${guardRuntime.toString()})({now:()=>${f.now},
    inspect:()=>({cwd:${JSON.stringify(f.root)},idleAt:10}),readiness:()=>({code:'audit_ready'}),cp:{execFileSync(file,args,opts){
      if(file==='flock'||file==='/usr/bin/perl')return cp.execFileSync(file,args,opts);fs.writeFileSync(${JSON.stringify(marker)},'pending');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5000);return '';}}});
    guard(${JSON.stringify({ op: 'action', root: f.root, coordinatorId: A, ...f.action(lease.token), prompt: 'one' })}).then(v=>process.stdout.write(JSON.stringify(v)));`;
  const proc = cp.spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] }); let err = '';
  proc.stderr.on('data', b => { err += b; }); const done = new Promise(resolve => proc.on('close', (code, signal) => resolve({ code, signal })));
  t.after(() => { if (proc.exitCode === null && !proc.killed) proc.kill(); });
  const deadline = Date.now() + 5000; while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise(r => setTimeout(r, 5));
  assert.equal(fs.existsSync(marker), true, err); proc.kill('SIGKILL'); assert.equal((await done).signal, 'SIGKILL');
  f.advance(45001); const next = await f.request('lease', { coordinatorId: B }); assert.equal(next.code, 'coordination_owner');
  f.setIdle(11); const duplicate = await f.request('action', { ...f.action(next.token), eventId: digest('changed-idle'), coordinatorId: B });
  assert.equal(duplicate.code, 'action_duplicate'); assert.equal(duplicate.receipt.delivery, 'pending'); assert.equal(f.calls.length, 0);
  assert.equal(fs.statSync(lockFile).ino, inode, 'a live or dead helper never unlinks the kernel lock file based on age');
});

test('acknowledged idle events compact behind an exact-identity watermark without permitting old event replay', posix, async t => {
  const f = fixture(t), lease = await f.request('lease');
  for (let at = 10; at < 40; at++) {
    f.setIdle(at); assert.equal((await f.request('action', { ...f.action(lease.token), eventId: digest(at) })).code, 'action_delivered');
  }
  const file = path.join(f.root, '_crew/termnest-ops/coordination/state.json'), state = JSON.parse(fs.readFileSync(file));
  assert.equal(Object.keys(state.receipts).length, 1); assert.equal(Object.keys(state.scopes).length, 1);
  const count = f.calls.length;
  f.setIdle(10); const replay = await f.request('action', { ...f.action(lease.token), eventId: digest(10) });
  assert.equal(replay.code, 'action_duplicate'); assert.equal(f.calls.length, count);
  const entry = Object.values(state.scopes)[0]; entry.receipt.delivery = 'pending'; fs.writeFileSync(file, JSON.stringify(state));
  assert.equal((await f.request('lease')).code, 'coordination_corrupt', 'inconsistent watermark cannot silently reopen a receipt');
});

test('remote revocation fences actions already prepared or delayed in a channel, and even delayed lease acquisition', posix, async t => {
  const f = fixture(t), lease = await f.request('lease');
  assert.equal((await f.request('revoke')).code, 'coordination_revoked');
  assert.equal((await f.request('action', f.action(lease.token))).code, 'coordination_revoked');
  assert.equal((await f.request('lease')).code, 'coordination_revoked'); assert.equal(f.calls.length, 0);
  assert.equal((await f.request('lease', { coordinatorId: B })).token.epoch, lease.token.epoch + 1);
});

test('lease expiry during final live validation cancels before the first tmux input', posix, async t => {
  const f = fixture(t), lease = await f.request('lease');
  f.setInspectHook(call => { if (call === 2) f.advance(45001); });
  const result = await f.request('action', f.action(lease.token));
  assert.equal(result.code, 'coordination_fenced'); assert.equal(result.receipt.delivery, 'cancelled'); assert.equal(f.calls.length, 0);
});

test('recovery progress fingerprint, original deadline and bounded attempts survive coordinator transfer', posix, async t => {
  const f = fixture(t), taskDir = path.join(f.root, '_crew/tasks/managed'); fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'MANIFEST.md'), '---\nstatus: executing\nblocked: null\ntracks: [{ id: W1, state: pending }]\n---');
  let lease = await f.request('lease');
  const action = (n, token) => ({ ...f.action(token), kind: 'recovery_send', session: 'leader', taskIds: ['managed'],
    prompt: 'Bounded recovery', eventId: digest('recovery-' + n), progressToken: digest('evidence-' + n) });
  const first = await f.request('action', action(0, lease.token)); assert.equal(first.code, 'action_delivered');
  const deadline = first.receipt.deadline; f.advance(45001); f.setIdle(11);
  lease = await f.request('lease', { coordinatorId: B });
  const noProgress = await f.request('action', { ...action(0, lease.token), eventId: digest('idle-churn'), coordinatorId: B });
  assert.equal(noProgress.code, 'action_duplicate'); assert.equal(noProgress.receipt.deadline, deadline);
  assert.equal(noProgress.receipt.attempts, 1);
  for (let n = 1; n <= 2; n++) {
    f.setIdle(11 + n); const result = await f.request('action', { ...action(n, lease.token), coordinatorId: B });
    assert.equal(result.code, 'action_delivered'); assert.equal(result.receipt.attempts, n + 1);
  }
  const count = f.calls.length; f.setIdle(14);
  assert.equal((await f.request('action', { ...action(3, lease.token), coordinatorId: B })).code, 'recovery_rate_limited');
  assert.equal(f.calls.length, count);
  f.advance(3600000); lease = await f.request('lease', { coordinatorId: B });
  assert.equal((await f.request('action', { ...action(3, lease.token), coordinatorId: B })).receipt.attempts, 1);
});

test('symlinks, unreadable/corrupt state, malformed epochs and capacity limits fail closed without deleting locks or receipts', posix, async t => {
  for (const mode of ['symlink-lock', 'symlink-state', 'symlink-dir', 'unreadable', 'corrupt', 'bad-lease', 'full', 'lock-content', 'orphans']) {
    const f = fixture(t), lease = await f.request('lease'), dir = path.join(f.root, '_crew/termnest-ops/coordination'), stateFile = path.join(dir, 'state.json');
    if (mode === 'symlink-lock') { fs.unlinkSync(path.join(dir, 'guard.lock')); fs.symlinkSync(stateFile, path.join(dir, 'guard.lock')); }
    if (mode === 'symlink-state') { fs.renameSync(stateFile, stateFile + '.old'); fs.symlinkSync(stateFile + '.old', stateFile); }
    if (mode === 'symlink-dir') { fs.renameSync(dir, dir + '.old'); fs.symlinkSync(dir + '.old', dir); }
    if (mode === 'unreadable') fs.chmodSync(stateFile, 0);
    if (mode === 'corrupt') fs.writeFileSync(stateFile, '{');
    if (mode === 'lock-content') fs.writeFileSync(path.join(dir, 'guard.lock'), 'unexpected lock content');
    if (mode === 'orphans') for (let i = 0; i < 35; i++) fs.writeFileSync(path.join(dir, 'write-orphan-' + i), 'retained evidence');
    if (mode === 'bad-lease' || mode === 'full') {
      const s = JSON.parse(fs.readFileSync(stateFile));
      if (mode === 'bad-lease') s.lease.expiresAt = 'unknown';
      else for (let i = 0; i < 4096; i++) { const id = digest(i); s.receipts[id] = { eventId: id, kind: 'audit_send', epoch: 1, at: f.now, delivery: 'pending' }; }
      fs.writeFileSync(stateFile, JSON.stringify(s));
    }
    const result = await f.request('action', f.action(lease.token));
    assert.match(result.code, /^coordination_(unsafe|unavailable|corrupt|capacity)/, mode); assert.equal(f.calls.length, 0, mode);
  }
});

test('audit open and an already existing idle audit both require a pinned account and installed skill', posix, async t => {
  const f = fixture(t), home = path.join(f.root, 'home'), config = path.join(home, '.claude-work');
  fs.mkdirSync(config, { recursive: true, mode: 0o700 });
  const plugin = path.join(f.root, 'plugin'), skillDir = path.join(plugin, 'skills/xspire-crew-ops-audit');
  let auth = { loggedIn: true, email: 'fixture@example.invalid', orgId: 'fixture' }, pluginList = [];
  const calls = [];
  const env = Object.fromEntries(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'].map(k => [k, process.env[k]]));
  for (const k of Object.keys(env)) delete process.env[k];
  t.after(() => { for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const runtime = guardRuntime({ os: { homedir: () => home }, now: () => f.now, inspect: () => ({ cwd: f.root, idleAt: 10 }),
    cp: { execFileSync(file, args, opts) {
      if (file === 'flock' || file === '/usr/bin/perl') return cp.execFileSync(file, args, opts);
      if (file === 'claude') { assert.equal(opts.env.CLAUDE_CONFIG_DIR, config); return JSON.stringify(args[0] === 'auth' ? auth : pluginList); }
      calls.push(args); if (args[0] === 'has-session') throw Object.assign(Error('absent'), { status: 1 }); return '';
    } },
  });
  const request = extra => runtime({ root: f.root, coordinatorId: A, ...extra });
  assert.equal((await request({ op: 'readiness' })).code, 'audit_account_required');
  assert.equal((await request({ op: 'readiness', config: '.claude-missing' })).code, 'audit_config_unavailable');
  let result = await request({ op: 'readiness', config: '.claude-work' }); assert.equal(result.code, 'audit_skill_missing');
  const account = result.accountRef; assert.equal(result.label, 'fixture@example.invalid');
  auth.token = 'synthetic-do-not-return'; assert.doesNotMatch(JSON.stringify(result), /synthetic-do-not-return/);
  const email = auth.email; delete auth.email; auth.accountId = 'a'.repeat(64);
  assert.equal((await request({ op: 'readiness', config: '.claude-work' })).code, 'audit_account_identity_unavailable', 'an opaque account id never becomes a display label');
  auth.email = email;
  fs.mkdirSync(skillDir, { recursive: true }); fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'synthetic installed skill');
  pluginList = [{ id: 'xspire-devkit@fixture', enabled: true, installPath: plugin }];
  assert.equal((await request({ op: 'readiness', config: '.claude-work', account })).code, 'audit_ready');
  const lease = await request({ op: 'lease' });
  const action = { op: 'action', ...f.action(lease.token), config: '.claude-work', account, identity: { pane: '%7', config: '.claude-wrong' } };
  assert.equal((await request(action)).code, 'audit_account_mismatch'); assert.equal(calls.length, 0);
  action.identity.config = '.claude-work'; auth.email = 'different@example.invalid';
  assert.equal((await request(action)).code, 'audit_account_mismatch'); assert.equal(calls.length, 0);
  auth.loggedIn = false;
  assert.equal((await request({ ...action, kind: 'audit_open' })).code, 'audit_account_unavailable'); assert.equal(calls.length, 0);
  auth.loggedIn = true; auth.email = 'fixture@example.invalid'; pluginList[0].enabled = false;
  assert.equal((await request(action)).code, 'audit_skill_missing'); assert.equal(calls.length, 0);
});

test('unsupported hosts explicitly report unavailable', async () => {
  assert.equal((await guardRuntime({ platform: 'win32' })({ op: 'lease', root: '/workspace' })).code, 'coordination_platform_unavailable');
});

test('production identity inspector checks boot, tmux creation/pane, process start and ancestry, and agent start/config/cwd', linux, async t => {
  const f = fixture(t), home = path.join(f.root, 'home'), config = path.join(home, '.claude-work/sessions');
  fs.mkdirSync(config, { recursive: true, mode: 0o700 });
  const statusFile = path.join(config, '501.json');
  const state = { boot: 'boot-one', created: '17', pane: '%7', parent: 100, processStart: '77', cwd: f.root, processTable: '', sends: 0,
    agent: { kind: 'inter', startedAt: 1000, status: 'idle', statusUpdatedAt: 99, cwd: f.root } };
  const write = () => fs.writeFileSync(statusFile, JSON.stringify(state.agent), { mode: 0o600 }); write();
  const identity = { bootId: 'boot-one', sessionId: '$1', created: 17, pane: '%7', agentPid: 501, agentStartedAt: 1000, config: '.claude-work', processStart: '77' };
  const fakeFS = { ...fs,
    readFileSync(file, ...args) {
      if (file === '/proc/sys/kernel/random/boot_id') return state.boot;
      if (file === '/proc/501/stat') { const fields = Array(24).fill('0'); fields[0] = 'S'; fields[1] = String(state.parent); fields[19] = state.processStart; return '501 (claude) ' + fields.join(' '); }
      if (file === '/proc/100/stat') { const fields = Array(24).fill('0'); fields[0] = 'S'; fields[1] = '1'; fields[19] = '55'; return '100 (bash) ' + fields.join(' '); }
      if (file === '/proc/901/stat') { const fields = Array(24).fill('0'); fields[0] = 'S'; fields[1] = '1'; fields[19] = '88'; return '901 (bash) ' + fields.join(' '); }
      return fs.readFileSync(file, ...args);
    },
    statSync(file, ...args) { if (/^\/proc\/\d+$/.test(file)) return { uid: process.getuid() }; return fs.statSync(file, ...args); },
    realpathSync(file, ...args) { if (file === '/proc/501/cwd') return state.cwd; return fs.realpathSync(file, ...args); },
  };
  const runtime = guardRuntime({ fs: fakeFS, os: { homedir: () => home }, now: () => f.now,
    readiness: () => ({ code: 'audit_ready' }), cp: { execFileSync(file, args, opts) {
      if (file === 'flock' || file === '/usr/bin/perl') return cp.execFileSync(file, args, opts);
      if (file === 'ps') return state.processTable;
      if (args[0] === 'display-message') return '$1|' + state.created + '|' + state.pane + '|100|leader';
      if (args[0] === 'send-keys') { state.sends++; return ''; }
      throw Error('no sends expected');
    } },
  });
  const request = extra => runtime({ op: 'inspect', root: f.root, session: 'leader', identity, ...extra });
  assert.equal((await request()).code, 'identity_valid');
  for (const [field, value] of [['boot', 'boot-two'], ['created', '18'], ['pane', '%8'], ['parent', 1], ['processStart', '78'], ['cwd', home]]) {
    const before = state[field]; state[field] = value;
    assert.match((await request()).code, /identity_mismatch/, field); state[field] = before;
  }
  state.agent.startedAt++; write(); assert.equal((await request()).code, 'agent_not_idle'); state.agent.startedAt--; write();
  assert.notEqual((await request({ identity: { ...identity, config: '.claude-other' } })).code, 'identity_valid');
  state.agent.parkedJobId = 'held'; write(); assert.equal((await request()).code, 'agent_not_idle'); delete state.agent.parkedJobId; write();
  const lease = await runtime({ op: 'lease', root: f.root, coordinatorId: A });
  for (const status of ['busy', 'waiting', 'unknown']) {
    state.agent.status = status; write();
    const result = await runtime({ op: 'action', kind: 'audit_send', root: f.root, coordinatorId: A, token: lease.token, identity,
      idleAt: 99, session: 'leader', config: '.claude-work', account: 'a'.repeat(64), prompt: 'bounded audit', eventId: digest(status) });
    assert.equal(result.code, 'agent_not_idle', status);
  }
  state.agent.status = 'idle'; write();
  const taskDir = path.join(f.root, '_crew/tasks/managed'); fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'MANIFEST.md'), '---\nstatus: executing\nblocked: null\ntracks: [{ id: W1, state: pending }]\n---');
  const recovery = () => runtime({ op: 'action', kind: 'recovery_send', root: f.root, coordinatorId: A, token: lease.token, identity,
    idleAt: 99, session: 'leader', prompt: 'Bounded recovery', eventId: digest('recovery'), taskIds: ['managed'], progressToken: digest('progress') });
  assert.equal((await recovery()).code, 'workers_unknown', 'empty ps is unavailable, never proof of no workers');
  state.processTable = '501 100 claude\n901 1 bash /trusted/crew-dispatch.sh --task managed --track W1\n';
  assert.equal((await recovery()).code, 'live_worker', 'detached managed worker blocks input'); assert.equal(state.sends, 0);
  state.processTable = '501 100 claude\n'; assert.equal((await recovery()).code, 'action_delivered'); assert.equal(state.sends, 2);
});

test('production audit retirement requires exact tmux and process death, retains failed evidence and refuses unavailable/partial proof', linux, async t => {
  const f = fixture(t), runId = 'tn-' + '1'.repeat(32), identity = { bootId: 'boot-one', sessionId: '$9', created: 70, pane: '%90', agentPid: 501, config: '.claude', agentStartedAt: 1 };
  let processState = 'live', table = '$9|70\n', unavailable = false;
  const fakeFS = { ...fs, readFileSync(file, ...args) {
    if (file === '/proc/501/stat') {
      if (processState === 'denied') throw Object.assign(Error('denied'), { code: 'EACCES' });
      if (processState === 'dead') throw Object.assign(Error('dead'), { code: 'ENOENT' });
      const fields = Array(24).fill('0'); fields[0] = 'S'; fields[1] = '1'; fields[19] = processState === 'reused' ? '24' : '23'; return '501 (claude) ' + fields.join(' ');
    }
    return fs.readFileSync(file, ...args);
  }, statSync(file, ...args) { return file === '/proc/501' ? { uid: process.getuid() } : fs.statSync(file, ...args); } };
  const runtime = guardRuntime({ fs: fakeFS, boot: () => 'boot-one', now: () => f.now, inspect: () => ({ cwd: f.root, idleAt: 10, processStart: '23' }), readiness: () => ({ code: 'audit_ready' }),
    cp: { execFileSync(file, args, opts) {
      if (file === 'flock' || file === '/usr/bin/perl') return cp.execFileSync(file, args, opts);
      if (args[0] === 'has-session') throw Object.assign(Error('absent'), { status: 1 });
      if (args[0] === 'new-session') return '$9|70|%90|501\n';
      if (args[0] === 'list-sessions') { if (unavailable) throw Object.assign(Error('tmux failed'), { status: 1, stderr: 'permission denied' }); return table; }
      return '';
    } } });
  const request = extra => runtime({ root: f.root, coordinatorId: A, ...extra });
  const lease = await request({ op: 'lease' });
  const opened = await request({ op: 'action', ...f.action(lease.token), kind: 'audit_open', eventId: digest('open'), runId });
  assert.equal(opened.code, 'action_delivered'); assert.deepEqual(opened.receipt.identity, { bootId: 'boot-one', sessionId: '$9', created: 70, pane: '%90', agentPid: 501, processStart: '23' });
  assert.equal((await request({ op: 'action', ...f.action(lease.token), identity, runId })).code, 'action_delivered');
  const retire = { op: 'retire_audit', token: lease.token, session: f.action(lease.token).session, runId };
  processState = 'dead'; assert.equal((await request(retire)).code, 'audit_identity_live', 'a surviving exact session blocks retirement');
  table = '$10|71\n'; processState = 'live'; assert.equal((await request(retire)).code, 'audit_identity_live', 'detached old process still lives');
  processState = 'denied'; assert.equal((await request(retire)).code, 'audit_death_unverified');
  processState = 'dead'; unavailable = true; assert.equal((await request(retire)).code, 'audit_death_unverified');
  unavailable = false; processState = 'reused'; const result = await request(retire); assert.equal(result.code, 'audit_retired'); assert.equal(result.proof, 'session_and_process_superseded');
  const file = path.join(f.root, '_crew/termnest-ops/coordination/state.json');
  let state = JSON.parse(fs.readFileSync(file)); assert.equal(state.receipts[digest('idle-one')].retirement, 'failed_unverified');
  // A partial receipt is a barrier even after authoritative identity death and across different run ids.
  state.receipts[digest('idle-one')].delivery = 'uncertain'; Object.values(state.scopes)[0].receipt.delivery = 'uncertain'; fs.writeFileSync(file, JSON.stringify(state));
  assert.equal((await request(retire)).code, 'audit_retirement_uncertain');
  const opening = await request({ op: 'action', token: lease.token, kind: 'audit_open', session: retire.session, runId: 'tn-' + '2'.repeat(32), config: '.claude', account: 'a'.repeat(64), eventId: digest('new-run') });
  assert.equal(opening.code, 'audit_retirement_uncertain', 'a fresh run cannot bypass the prior partial receipt');
});

test('SIMULATION: 4200 successful audit-session replacements and coordinator resets stay bounded without replay or revocation loss', posix, async t => {
  const f = fixture(t), file = path.join(f.root, '_crew/termnest-ops/coordination/state.json');
  let sequence = 0, sends = 0;
  // This serialized long-run fixture simulates process/tmux/flock IO; real kernel lock contention is tested above.
  const runtime = guardRuntime({ now: () => f.now, boot: () => 'sim-boot', fs: { ...fs, fsyncSync() {} },
    inspect: () => ({ cwd: f.root, idleAt: sequence + 10, processStart: '23' }), readiness: () => ({ code: 'audit_ready' }),
    proveAuditDead: () => ({ code: 'audit_identity_dead', proof: 'simulated_exact_death' }),
    cp: { execFileSync(file, args) { if (file === 'flock' || file === '/usr/bin/perl') return ''; if (args[0] === 'has-session') throw Object.assign(Error('absent'), { status: 1 }); if (args[0] === 'send-keys' && args.includes('-l')) sends++; return ''; } } });
  const firstId = digest('coordinator-0').slice(0, 32), firstEvent = digest('open-0');
  for (sequence = 0; sequence < 4200; sequence++) {
    const coordinatorId = digest('coordinator-' + sequence).slice(0, 32), runId = 'tn-' + sequence.toString(16).padStart(32, '0');
    const request = extra => runtime({ root: f.root, coordinatorId, ...extra });
    const lease = await request({ op: 'lease' }); assert.equal(lease.code, 'coordination_owner', 'lease ' + sequence);
    const session = 'tn-ops-audit-0123456789abcdef', common = { op: 'action', session, runId, token: lease.token, config: '.claude', account: 'a'.repeat(64) };
    const identity = { bootId: 'sim-boot', sessionId: '$' + sequence, created: sequence + 1, pane: '%7', agentPid: 501, agentStartedAt: sequence + 1, config: '.claude' };
    assert.equal((await request({ ...common, kind: 'audit_open', eventId: digest('open-' + sequence) })).code, 'action_delivered', 'open ' + sequence);
    assert.equal((await request({ ...common, kind: 'audit_send', identity, idleAt: sequence + 10, prompt: 'bounded', eventId: digest('send-' + sequence) })).code, 'action_delivered');
    assert.equal((await request({ op: 'ack_audit', runId, token: lease.token })).code, 'audit_acknowledged');
    // Alternate explicit retirement with normal between-run death: audit_open must also collect proven-dead, reported identities.
    if (sequence % 2 === 0) assert.equal((await request({ op: 'retire_audit', runId, session, token: lease.token, reported: true })).code, 'audit_retired');
    assert.equal((await request({ op: 'revoke' })).code, 'coordination_revoked');
    if (sequence % 128 === 0) {
      const state = JSON.parse(fs.readFileSync(file)); assert.ok(Object.keys(state.receipts).length <= 2); assert.ok(Object.keys(state.scopes).length <= 1); assert.ok(state.revoked.length <= 64); assert.ok(fs.statSync(file).size < 300000);
    }
  }
  assert.equal(sends, 4200);
  assert.equal((await runtime({ op: 'lease', root: f.root, coordinatorId: firstId })).code, 'coordination_revoked');
  const coordinatorId = digest('final-coordinator').slice(0, 32), lease = await runtime({ op: 'lease', root: f.root, coordinatorId });
  assert.equal((await runtime({ op: 'action', kind: 'audit_open', root: f.root, coordinatorId, token: lease.token, session: 'tn-ops-audit-0123456789abcdef', runId: 'tn-' + '0'.repeat(32), eventId: firstEvent })).code, 'action_duplicate');
  assert.equal(sends, 4200, 'compacted events never replay after transfer');
});

test('exhausted tombstones freeze remote authority across restart while OFF still revokes queued tokens; malformed ledger fails closed', posix, async t => {
  const f = fixture(t), lease = await f.request('lease'), file = path.join(f.root, '_crew/termnest-ops/coordination/state.json');
  const state = JSON.parse(fs.readFileSync(file)); state.safetyFilter = '0'.repeat(262144); state.safetyCount = 65536; fs.writeFileSync(file, JSON.stringify(state));
  assert.equal((await f.request('action', f.action(lease.token))).code, 'coordination_capacity_tombstones');
  assert.equal((await f.request('revoke')).code, 'coordination_revoked');
  assert.equal((await f.request('lease', { coordinatorId: B })).code, 'coordination_capacity_tombstones'); assert.equal(f.calls.length, 0);
  const frozen = JSON.parse(fs.readFileSync(file)); assert.equal(frozen.lease.expiresAt, 0); delete frozen.safetyFilter; fs.writeFileSync(file, JSON.stringify(frozen));
  assert.equal((await f.request('lease')).code, 'coordination_corrupt');
});

// macOS: real boot id (sysctl), process table (ps), cwd (lsof) and tmux on an isolated tmux server.
test('macOS identity inspector verifies a real tmux pane and agent process', { skip: process.platform !== 'darwin' || !(() => { try { cp.execFileSync('tmux', ['-V']); return true; } catch { return false; } })() }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tn-mac-'))), home = path.join(root, 'home'), sock = path.join(root, 'tmux');
  fs.mkdirSync(path.join(home, '.claude-test/sessions'), { recursive: true, mode: 0o700 }); fs.mkdirSync(sock, { mode: 0o700 });
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin); fs.symlinkSync(process.execPath, path.join(bin, 'claude')); // macOS kills copied system binaries; ps shows the link name
  const saved = { TMUX_TMPDIR: process.env.TMUX_TMPDIR, TMUX: process.env.TMUX };
  process.env.TMUX_TMPDIR = sock; delete process.env.TMUX;
  t.after(() => { try { cp.execFileSync('tmux', ['kill-server']); } catch {} Object.assign(process.env, saved); if (saved.TMUX === undefined) delete process.env.TMUX; if (saved.TMUX_TMPDIR === undefined) delete process.env.TMUX_TMPDIR; fs.rmSync(root, { recursive: true, force: true }); });
  cp.execFileSync('tmux', ['new-session', '-d', '-s', 'leader', '-c', root, path.join(bin, 'claude'), '-e', 'setTimeout(()=>{},60000)']);
  const [sessionId, created, pane, panePid] = cp.execFileSync('tmux', ['display-message', '-p', '-t', 'leader', '#{session_id}|#{session_created}|#{pane_id}|#{pane_pid}'], { encoding: 'utf8' }).trim().split('|');
  const agentPid = Number(panePid), startedAt = Date.now();
  fs.writeFileSync(path.join(home, '.claude-test/sessions', agentPid + '.json'), JSON.stringify({ kind: 'inter', startedAt, status: 'idle', statusUpdatedAt: startedAt, cwd: root }), { mode: 0o600 });
  const bootId = cp.execFileSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { encoding: 'utf8' }).trim();
  const identity = { bootId, sessionId, created: Number(created), pane, agentPid, agentStartedAt: startedAt, config: '.claude-test' };
  const runtime = guardRuntime({ os: { homedir: () => home } });
  const ok = await runtime({ op: 'inspect', root, session: 'leader', identity });
  assert.equal(ok.code, 'identity_valid', JSON.stringify(ok)); assert.match(ok.processStart, /^\d+$/); assert.equal(ok.panePid, agentPid);
  assert.equal((await runtime({ op: 'inspect', root, session: 'leader', identity: { ...identity, processStart: ok.processStart } })).code, 'identity_valid');
  for (const bad of [{ bootId: 'other-boot' }, { pane: '%999' }, { processStart: '1' }])
    assert.match((await runtime({ op: 'inspect', root, session: 'leader', identity: { ...identity, ...bad } })).code, /identity_mismatch|live_identity|process_identity/, JSON.stringify(bad));
  // A real lease on macOS: the perl flock holds the root for one coordinator.
  const lease = await runtime({ op: 'lease', root, coordinatorId: A });
  assert.equal(lease.code, 'coordination_owner'); assert.equal((await runtime({ op: 'lease', root, coordinatorId: B })).code, 'coordination_owned');
});
