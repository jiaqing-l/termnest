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
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tn-fence-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = 1800000000000, idleAt = 10, failure = false, calls = [], inspections = 0, onInspect;
  const runtime = guardRuntime({ now: () => now, inspect: () => { inspections++; onInspect?.(inspections); return { processStart: '23', cwd: root, idleAt }; },
    readiness: () => ({ code: 'audit_ready', quota: 'unknown' }),
    cp: { execFileSync(file, args, opts) {
      if (file === 'flock') return cp.execFileSync(file, args, opts);
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

test('two coordinators share one remote lease, transfer increments epoch, stale token cannot send or replay an idle receipt', linux, async t => {
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

test('an inherited kernel lock remains held across tmux, and a contender cannot take over during a long side effect', linux, async t => {
  const f = fixture(t), lease = await f.request('lease'), marker = path.join(f.root, 'in-action');
  // A separate foreground-awaited process executes the REAL runtime and flock; only tmux/agent IO is simulated.
  const script = `const fs=require('node:fs'),cp=require('node:child_process'); const guard=(${guardRuntime.toString()})({now:()=>${f.now},
    inspect:()=>({cwd:${JSON.stringify(f.root)},idleAt:10}),readiness:()=>({code:'audit_ready'}),cp:{execFileSync(file,args,opts){
      if(file==='flock')return cp.execFileSync(file,args,opts);fs.writeFileSync(${JSON.stringify(marker)},'held');
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

test('partial tmux failure leaves a durable uncertain receipt; a fresh runtime and coordinator never replay it', linux, async t => {
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

test('remote helper death releases only its kernel lock and preserves a pending cross-event uncertainty barrier', linux, async t => {
  const f = fixture(t), lease = await f.request('lease'), marker = path.join(f.root, 'entered-send');
  const lockFile = path.join(f.root, '_crew/termnest-ops/coordination/guard.lock'), inode = fs.statSync(lockFile).ino;
  const script = `const fs=require('node:fs'),cp=require('node:child_process');const guard=(${guardRuntime.toString()})({now:()=>${f.now},
    inspect:()=>({cwd:${JSON.stringify(f.root)},idleAt:10}),readiness:()=>({code:'audit_ready'}),cp:{execFileSync(file,args,opts){
      if(file==='flock')return cp.execFileSync(file,args,opts);fs.writeFileSync(${JSON.stringify(marker)},'pending');
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

test('acknowledged idle events compact behind an exact-identity watermark without permitting old event replay', linux, async t => {
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

test('remote revocation fences actions already prepared or delayed in a channel, and even delayed lease acquisition', linux, async t => {
  const f = fixture(t), lease = await f.request('lease');
  assert.equal((await f.request('revoke')).code, 'coordination_revoked');
  assert.equal((await f.request('action', f.action(lease.token))).code, 'coordination_revoked');
  assert.equal((await f.request('lease')).code, 'coordination_revoked'); assert.equal(f.calls.length, 0);
  assert.equal((await f.request('lease', { coordinatorId: B })).token.epoch, lease.token.epoch + 1);
});

test('lease expiry during final live validation cancels before the first tmux input', linux, async t => {
  const f = fixture(t), lease = await f.request('lease');
  f.setInspectHook(call => { if (call === 2) f.advance(45001); });
  const result = await f.request('action', f.action(lease.token));
  assert.equal(result.code, 'coordination_fenced'); assert.equal(result.receipt.delivery, 'cancelled'); assert.equal(f.calls.length, 0);
});

test('recovery progress fingerprint, original deadline and bounded attempts survive coordinator transfer', linux, async t => {
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

test('symlinks, unreadable/corrupt state, malformed epochs and capacity limits fail closed without deleting locks or receipts', linux, async t => {
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

test('audit open and an already existing idle audit both require a pinned account and installed skill', linux, async t => {
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
      if (file === 'flock') return cp.execFileSync(file, args, opts);
      if (file === 'claude') { assert.equal(opts.env.CLAUDE_CONFIG_DIR, config); return JSON.stringify(args[0] === 'auth' ? auth : pluginList); }
      calls.push(args); if (args[0] === 'has-session') throw Object.assign(Error('absent'), { status: 1 }); return '';
    } },
  });
  const request = extra => runtime({ root: f.root, coordinatorId: A, ...extra });
  assert.equal((await request({ op: 'readiness' })).code, 'audit_account_required');
  assert.equal((await request({ op: 'readiness', config: '.claude-missing' })).code, 'audit_config_unavailable');
  let result = await request({ op: 'readiness', config: '.claude-work' }); assert.equal(result.code, 'audit_skill_missing');
  const account = result.accountRef;
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
  assert.equal((await guardRuntime({ platform: 'darwin' })({ op: 'lease', root: '/workspace' })).code, 'coordination_platform_unavailable');
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
      if (file === 'flock') return cp.execFileSync(file, args, opts);
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
