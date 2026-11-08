'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const child = require('node:child_process');
const crewpack = require('../lib/features/crewpack');
const ops = require('../lib/features/ops');
const { CrewSupervisor, TIMEOUT_MS } = require('../lib/crew-supervisor');
const { createFeatures } = require('../lib/features');
const { guardRuntime } = require('../lib/ops-action-guard');
const policy = require('../lib/supervision-state');
const clone = v => JSON.parse(JSON.stringify(v));
const settle = () => new Promise(resolve => setImmediate(resolve));
const linux = { skip: process.platform !== 'linux' };

function fixture(t, options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tn-policy-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = 1800000000000, serial = 0, failSave = false, readiness = options.readiness || 'audit_ready', queued;
  const taskDir = path.join(root, '_crew/tasks/task'); fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'MANIFEST.md'), '---\nstatus: executing\nblocked: null\ntracks: [{ id: W1, state: pending }]\n---\n');
  fs.writeFileSync(path.join(root, '_crew/nudge.conf'), '%7 task\n');
  const s = { name: 'leader', id: '$1', created: 17, paneIds: ['%7'], path: root, aiPid: 701,
    aiStatus: { tool: 'claude', status: 'idle', at: now - 600000, startedAt: now - 3600000, cfg: '.claude-work' } };
  const sent = [], commands = [], services = new Map(), timers = [], snapshots = [], routes = new Map();
  const r = { cfg: { id: 'vm', name: 'VM', auth: options.passwordOnly ? 'password' : 'key' }, ready: true, lastPoll: now,
    snapshot: { bootId: 'boot-1', workers: [], sessions: [s] }, polls: 0, poll() { this.polls++; this.lastPoll = now; },
    exec() { throw Error('unfenced_exec_forbidden'); } };
  const registration = () => ({ serverId: 'vm', root, session: s.name, taskIds: ['task'], identity: { ...policy.liveIdentity(r, s), processStart: '23' } });
  const vault = options.vault || { crewpack: { enabled: true, autoRecovery: true, intervalMinutes: 30,
    workspaces: [{ serverId: 'vm', root, auditConfig: '.claude-work', auditAccount: 'a'.repeat(64) }], leaders: [registration()] },
    ops: { pack: { rules: { dormant: { level: options.genericAuto ? 'auto' : 'suggest', after: 0 } }, auto: { quietFrom: '00:00', quietTo: '00:00', perHour: 10 } } } };
  function host(name) { return { name,
    settings: { get: () => clone(vault[name] || {}), set: value => { if (failSave && name === 'crewpack') throw Error('disk'); vault[name] = clone(value); } },
    provide: (key, value) => { assert.equal(services.has(key), false); services.set(key, value); }, service: key => services.get(key),
    remotes: () => [r], backendOf: id => id === 'vm' && r.ready ? r : null, onSnapshot: fn => snapshots.push(fn),
    route: (method, url, fn) => routes.set(name + ' ' + method + ' ' + url, fn), log() {},
    readJson: async req => req.body, send: (res, status, body) => Object.assign(res, { status, body }),
    fail: (res, status, error, extra) => Object.assign(res, { status, body: { error, ...extra } }),
  }; }
  const runtime = guardRuntime({ now: () => now, readiness: (root, config, account) => ({ code: config && account ? readiness : 'audit_account_required', quota: 'unknown' }),
    inspect: (i, name, idle = true) => {
      const current = r.snapshot.sessions.find(x => x.name === name && policy.sameIdentity(i, policy.liveIdentity(r, x)));
      if (!current || i.processStart && i.processStart !== '23' || idle && (current.aiStatus.status !== 'idle' || current.asking || current.aiStatus.parked)) throw Error('identity mismatch');
      return { processStart: '23', idleAt: current.aiStatus.at, cwd: current.path };
    },
    cp: { execFileSync(file, args, opts) {
      if (file === 'flock') return child.execFileSync(file, args, opts);
      assert.equal(file, 'tmux'); commands.push(args);
      if (args[0] === 'has-session') throw Object.assign(Error('absent'), { status: 1 });
      if (args[0] === 'new-session') {
        const name = args[args.indexOf('-s') + 1]; r.snapshot.sessions.push({ ...clone(s), name, id: '$9', paneIds: ['%90'], aiPid: 990,
          aiStatus: { ...s.aiStatus, startedAt: now, status: 'idle', at: now } });
      }
      if (args[0] === 'send-keys' && args.includes('-l')) {
        sent.push({ pane: args[args.indexOf('-t') + 1], text: args.at(-1) });
        if (options.partialSend) throw Object.assign(Error('partial typed input'), { status: 1 });
      }
      return '';
    } },
  });
  const guard = async (remote, action) => {
    if (queued && action.kind === 'recovery_send') { const wait = queued; queued = null; await wait; }
    return runtime(action);
  };
  const clock = { now: () => now, setInterval: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; }, clearInterval() {} };
  let runningOps = ops.register(host('ops'), clock);
  let running = crewpack.register(host('crewpack'), { ...clock, guard,
    newId: () => 'tn-' + (++serial).toString(16).padStart(32, '0'), runOnHost: async (r, factory, args) => factory()(args) });
  t.after(() => { running.stop(); runningOps.stop(); });
  return { root, r, s, vault, sent, commands, services, registration, timers,
    get supervisor() { return running.supervisor; }, get now() { return now; },
    tick: () => running.tick(),
    advance(ms, fresh = true) { now += ms; if (fresh) r.lastPoll = now; },
    setReadiness(code) { readiness = code; }, failSave(value = true) { failSave = value; },
    queueRecovery(promise) { queued = promise; },
    stopCoordinator() { running.stop(); runningOps.stop(); },
    secondCoordinator() {
      const local = clone(vault), registry = new Map();
      const secondHost = name => ({ ...host(name), provide: (key, value) => registry.set(key, value), service: key => registry.get(key),
        settings: { get: () => clone(local[name]), set: value => { local[name] = clone(value); } } });
      const generic = ops.register(secondHost('ops'), clock);
      const team = crewpack.register(secondHost('crewpack'), { ...clock, guard,
        newId: () => 'tn-' + (++serial).toString(16).padStart(32, '0'), runOnHost: async (r, factory, args) => factory()(args) });
      t.after(() => { generic.stop(); team.stop(); });
      return { ...team, vault: local };
    },
    snapshot: () => snapshots.forEach(fn => fn(r)), genericTick: () => runningOps.run(r),
    async route(method, url, body, feature = 'ops') { const res = {}; await routes.get(feature + ' ' + method + ' ' + url)({ req: { body }, res }); return res; },
    restart() {
      running.stop(); runningOps.stop(); services.clear(); snapshots.length = 0;
      runningOps = ops.register(host('ops'), clock); running = crewpack.register(host('crewpack'), { ...clock, guard,
        newId: () => 'tn-' + (++serial).toString(16).padStart(32, '0'), runOnHost: async (r, factory, args) => factory()(args) });
    },
  };
}

test('combined GET/POST facade preserves generic settings, reports readiness/identity and refuses partial persistence success', linux, async t => {
  const f = fixture(t, { passwordOnly: true }), original = clone(f.vault.ops.pack);
  const before = await f.route('GET', '/supervision'); assert.equal(before.body.enabled, true); assert.equal(before.body.autoRecovery, true);
  assert.equal(before.body.runtime.quota, 'unknown'); assert.equal(before.body.runtime.passwordOnlyAccounts[0].code, 'persistent_ssh_identity_required');
  assert.equal(before.body.runtime.validatedAuditCompletion, false); assert.equal(before.body.runtime.observationsFresh, false);
  assert.deepEqual(before.body.registrationCandidates[0].identity, policy.liveIdentity(f.r, f.s));
  for (const body of [{ enabled: true, autoRecovery: 'yes' }, { enabled: true, leaders: [{ ...f.registration(), identity: { ...f.registration().identity, bootId: 'old' } }] },
    { enabled: true, leaders: [{ ...f.registration(), session: 'tn-ops-audit' }] }, { enabled: true, command: 'arbitrary' }]) {
    assert.equal((await f.route('POST', '/supervision', body)).status, 400);
  }
  const second = clone(f.s); second.id = '$2'; second.name = 'second-leader'; second.paneIds = ['%8']; second.aiPid = 702; f.r.snapshot.sessions.push(second);
  assert.equal((await f.route('POST', '/supervision', { enabled: true, leaders: [f.registration(), { ...f.registration(), session: second.name, identity: policy.liveIdentity(f.r, second) }] })).status, 400,
    'two leaders cannot both be registered as authority over the same managed task');
  assert.equal((await f.route('POST', '/supervision', { enabled: true, autoRecovery: true, leaders: [f.registration()] })).status, 200);
  assert.deepEqual(f.vault.ops.pack, original);
  f.failSave(); assert.equal((await f.route('POST', '/supervision', { enabled: true, autoRecovery: true })).status, 503);
  assert.equal((await f.route('GET', '/supervision')).body.enabled, false);
  await f.tick(); assert.equal(f.sent.length, 0);
});

test('first snapshot is baseline; exact enrolled idle leader recovers once and generic pending nudges share the reservation', linux, async t => {
  const f = fixture(t, { genericAuto: true });
  f.genericTick(); await settle(); assert.equal(f.commands.length, 0, 'stored managed authority suppresses generic auto before the first supervisor scan');
  await f.tick(); assert.equal(f.sent.filter(x => x.pane === '%7').length, 0);
  f.genericTick(); await settle(); assert.equal(f.sent.filter(x => x.pane === '%7').length, 0, 'generic auto cannot race managed registration');
  f.advance(15000); await f.tick();
  const recoveries = f.sent.filter(x => x.pane === '%7'); assert.equal(recoveries.length, 2, 'one bounded two-line prompt');
  assert.ok(recoveries[0].text.includes('Managed supervision check')); assert.ok(recoveries[1].text.includes('Do not answer approval dialogs'));
  assert.equal(f.vault.ops.log.filter(x => x.why === 'supervision').length, 1); assert.equal(f.vault.ops.log[0].delivery, 'delivered');
  assert.equal(f.vault.ops.log.some(x => /^tn-ops-audit/.test(x.session)), false, 'generic Ops never auto-types into internal audits');
  for (let i = 0; i < 3; i++) { await f.tick(); f.genericTick(); } await settle();
  assert.equal(f.sent.filter(x => x.pane === '%7').length, 2);
});

test('a generic delivered or unresolved reservation prevents an independent recovery prompt for that idle', linux, async t => {
  for (const delivery of ['pending', 'delivered', 'uncertain']) {
    const f = fixture(t), stamp = JSON.stringify([f.r.snapshot.bootId, f.s.created, f.s.aiPid, '', f.s.aiStatus.startedAt]);
    const key = JSON.stringify(['vm', 'leader']); f.vault.ops.intents = { [key]: { id: delivery, key, server: 'vm', session: 'leader', delivery,
      identity: stamp, idleAt: f.s.aiStatus.at, at: f.now - 1 } };
    await f.tick(); f.advance(15000); await f.tick();
    assert.equal(f.sent.filter(x => x.pane === '%7').length, 0, delivery);
    assert.equal(Object.values(f.vault.crewpack.supervisor.hosts.vm.recoveries)[0].code, 'ops_idle_reserved');
  }
});

test('two independent feature hosts on one remote elect one owner and transfer without duplicate audit or recovery input', linux, async t => {
  const f = fixture(t), other = f.secondCoordinator();
  await f.tick(); await other.tick();
  assert.equal(other.supervisor.status([f.r]).servers[0].coordination[0].code, 'coordination_owned');
  f.advance(15000); await f.tick(); await other.tick();
  const recoveryCount = f.sent.filter(x => x.pane === '%7').length; assert.equal(recoveryCount, 2);
  const auditCount = f.sent.filter(x => x.pane === '%90').length; assert.ok(auditCount > 0);
  f.stopCoordinator(); f.advance(45001); await other.tick();
  const rec = Object.values(other.vault.crewpack.supervisor.hosts.vm.recoveries)[0];
  assert.equal(rec.code, 'action_duplicate'); assert.equal(rec.delivery, 'delivered');
  assert.equal(f.sent.filter(x => x.pane === '%7').length, recoveryCount);
  assert.equal(f.sent.filter(x => x.pane === '%90').length, auditCount);
  assert.equal(other.supervisor.ownership.values().next().value.token.epoch, 2);
});

test('legacy pane reuse after reboot, changed process start, and missing worker observations never grant recovery authority', linux, async t => {
  for (const fault of ['boot', 'created', 'session-id', 'pane', 'startedAt', 'pid', 'config', 'worker', 'workers-unknown', 'process-start']) {
    const f = fixture(t); await f.tick();
    if (fault === 'boot') f.r.snapshot.bootId = 'boot-2';
    if (fault === 'created') f.s.created++;
    if (fault === 'session-id') f.s.id = '$2';
    if (fault === 'pane') f.s.paneIds = ['%8'];
    if (fault === 'startedAt') f.s.aiStatus.startedAt++;
    if (fault === 'pid') f.s.aiPid++;
    if (fault === 'config') f.s.aiStatus.cfg = '.claude-other';
    if (fault === 'worker') f.r.snapshot.workers = [{ task: 'task', owner: { name: 'leader', created: 17 } }];
    if (fault === 'workers-unknown') delete f.r.snapshot.workers;
    if (fault === 'process-start') f.vault.crewpack.leaders[0].identity.processStart = 'other-process';
    f.restart(); assert.equal(f.supervisor.validated.size, 0); f.advance(30000); await f.tick(); f.advance(15000); await f.tick();
    assert.equal(f.sent.filter(x => x.pane === '%7' || x.pane === '%8').length, 0, fault);
  }
});

test('busy, owner prompts, parked, unknown and blocked tasks hold all recovery input', linux, async t => {
  for (const fault of ['busy', 'waiting', 'asking', 'parked', 'unknown', 'blocked', 'live-worker']) {
    const f = fixture(t); await f.tick();
    if (['busy', 'waiting', 'unknown'].includes(fault)) f.s.aiStatus.status = fault;
    if (fault === 'asking') f.s.asking = true;
    if (fault === 'parked') f.s.aiStatus.parked = true;
    if (fault === 'blocked') fs.writeFileSync(path.join(f.root, '_crew/tasks/task/MANIFEST.md'), '---\nstatus: executing\nblocked: owner\ntracks: [{ id: W1, state: pending }]\n---');
    if (fault === 'live-worker') f.r.snapshot.workers = [{ task: 'task' }];
    f.advance(30000); await f.tick(); assert.equal(f.sent.filter(x => x.pane === '%7').length, 0, fault);
  }
});

test('disable revokes an asynchronous queued send before tmux and stays off across restart', linux, async t => {
  const f = fixture(t); await f.tick(); let release;
  f.queueRecovery(new Promise(r => { release = r; })); f.advance(15000); const sending = f.tick();
  for (let i = 0; i < 100 && !f.vault.ops.log?.some(x => x.why === 'supervision'); i++) await settle();
  assert.equal(f.vault.ops.log.some(x => x.why === 'supervision'), true, 'recovery is queued after durable reservation');
  const off = await f.route('POST', '/supervision', { enabled: false, autoRecovery: false });
  assert.equal(off.status, 200); assert.equal(off.body.enabled, false); release(); await sending;
  assert.equal(f.sent.filter(x => x.pane === '%7').length, 0);
  f.restart(); f.advance(30000); await f.tick(); assert.equal(f.sent.filter(x => x.pane === '%7').length, 0);
  assert.equal((await f.route('GET', '/supervision')).body.enabled, false);
});

test('OFF supersedes an older enable waiting for identity validation; identity changes during registration are rejected', linux, async t => {
  const f = fixture(t); let release;
  const original = f.supervisor.io.validateLeader;
  f.supervisor.io.validateLeader = async (...args) => { await new Promise(r => { release = r; }); return original(...args); };
  const enable = f.route('POST', '/supervision', { enabled: true, autoRecovery: true, leaders: [f.registration()] });
  while (!release) await settle();
  assert.equal((await f.route('POST', '/supervision', { enabled: false })).body.enabled, false);
  release(); assert.equal((await enable).body.enabled, false); assert.equal(f.vault.crewpack.enabled, false);
  f.supervisor.io.validateLeader = async () => { f.s.created++; return { processStart: '23' }; };
  assert.equal((await f.route('POST', '/supervision', { enabled: true, leaders: [f.registration()] })).status, 400);
  assert.equal(f.vault.crewpack.enabled, false);
});

test('incomplete remote reconfiguration stays OFF on restart, and OFF revokes the prior process coordinator', linux, async t => {
  const f = fixture(t); await f.tick(); const old = f.supervisor.coordinatorId;
  assert.ok(f.vault.crewpack.coordinatorIds.includes(old));
  f.restart(); const revocations = [], revoke = f.supervisor.io.revoke;
  f.supervisor.io.revoke = async (rs, id) => { revocations.push(id); return revoke(rs, id); };
  assert.equal((await f.route('POST', '/supervision', { enabled: false })).status, 200);
  assert.ok(revocations.includes(old), 'a reboot does not forget the remote authority that could still have queued input');
  f.supervisor.io.revoke = async () => { throw Error('offline'); };
  assert.equal((await f.route('POST', '/supervision', { enabled: true })).status, 503);
  assert.equal(f.vault.crewpack.configurationPending, true); f.restart();
  assert.equal((await f.route('GET', '/supervision')).body.enabled, false);
  assert.ok((await f.route('GET', '/supervision')).body.errors.some(e => e.code === 'configuration_incomplete'));
});

test('partial send plus engine restart preserves uncertain intent and never types another prompt', linux, async t => {
  const f = fixture(t, { partialSend: true }); await f.tick(); f.advance(15000); await f.tick();
  assert.equal(f.sent.filter(x => x.pane === '%7').length, 1);
  assert.equal(Object.values(f.vault.crewpack.supervisor.hosts.vm.recoveries)[0].delivery, 'uncertain');
  f.restart(); f.advance(60000); await f.tick(); f.advance(15000); await f.tick();
  assert.equal(f.sent.filter(x => x.pane === '%7').length, 1);
});

test('busy is response only; no-progress deadline escalates once and requests a bounded audit', linux, async t => {
  const f = fixture(t); await f.tick(); f.advance(15000); await f.tick(); f.s.aiStatus.status = 'busy'; f.advance(15000); await f.tick();
  let rec = Object.values(f.vault.crewpack.supervisor.hosts.vm.recoveries)[0]; assert.equal(rec.responded, true); assert.equal(rec.progress, 'unknown');
  f.advance(TIMEOUT_MS); await f.tick(); rec = Object.values(f.vault.crewpack.supervisor.hosts.vm.recoveries)[0];
  assert.equal(rec.code, 'recovery_no_progress'); assert.equal(rec.requiresOwner, true); assert.equal(rec.auditRequested, true);
  f.s.aiStatus.status = 'idle'; f.s.aiStatus.at = f.now; f.advance(60000); await f.tick();
  assert.equal(f.sent.filter(x => x.pane === '%7').length, 2);
});

test('account mismatch/missing skill are explicit owner states, corrupt reports never verify success', linux, async t => {
  for (const state of ['audit_account_mismatch', 'audit_skill_missing', 'audit_account_unavailable', 'audit_quota_unavailable']) {
    const f = fixture(t, { readiness: state }); f.s.aiStatus.status = 'busy'; await f.tick();
    assert.equal(f.commands.length, 0); const audit = f.supervisor.host('vm').active;
    assert.equal(audit.reason.code, state); assert.equal(audit.requiresOwner, true); assert.equal(audit.verification, 'unverified');
  }
  const f = fixture(t); f.s.aiStatus.status = 'busy'; await f.tick(); await f.tick();
  const audit = f.supervisor.host('vm').active, reportDir = path.join(f.root, '_crew/termnest-ops/reports');
  fs.mkdirSync(reportDir, { recursive: true }); fs.writeFileSync(path.join(reportDir, audit.runId + '.json'), '{corrupt');
  await f.tick(); assert.equal(f.supervisor.host('vm').active.reportCode, 'report_invalid');
  assert.equal((await f.route('GET', '/supervision')).body.runtime.validatedAuditCompletion, false);
});

test('no browser timer samples within freshness; offline observations remain unknown', linux, async t => {
  const f = fixture(t); let browserRequests = 0;
  for (let i = 0; i < 8; i++) { f.advance(15000, false); policy.pollUnattended([f.r], true, true); await f.tick(); }
  assert.equal(f.r.polls >= 8, true); assert.equal(browserRequests, 0);
  assert.equal(f.supervisor.status([f.r]).servers[0].online, true);
  f.r.ready = false; f.advance(60001, false); await f.tick();
  assert.equal(f.supervisor.status([f.r]).servers[0].teams[0].status, 'unknown');
  const before = f.r.polls; policy.pollUnattended([f.r], false, true); policy.pollUnattended([f.r], true, false); assert.equal(f.r.polls, before);
  assert.match(fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8'), /pollUnattended[\s\S]*?15000/);
});

test('feature host service registry and failed settings save are isolated across backend instances', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-host-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'probe.js'), "module.exports={name:'probe',register(host){host.provide('probe',{settings:host.settings});}};");
  const one = { data: { features: { probe: { before: true } } } }, two = { data: { features: {} } };
  const make = (vault, save) => createFeatures({ libDir: dir, publicDir: dir, log: { log() {}, error() {} }, deps: { vault: () => vault, save, remotes: () => new Map() } });
  const a = make(one, () => { throw Error('disk'); }), b = make(two, () => {}); a.load(); b.load();
  assert.notEqual(a.service('probe'), b.service('probe'));
  assert.throws(() => a.service('probe').settings.set({ enabled: true })); assert.deepEqual(one.data.features.probe, { before: true });
  b.service('probe').settings.set({ enabled: false }); assert.deepEqual(two.data.features.probe, { enabled: false });
});

test('corrupt coordinator authority history cannot be replaced with a healthy empty registry', linux, async t => {
  const f = fixture(t, { genericAuto: true }); f.vault.crewpack.coordinatorIds = { invalid: true };
  await f.tick(); const status = await f.route('GET', '/supervision');
  f.genericTick(); await settle();
  assert.equal(status.body.enabled, false); assert.equal(status.body.errors[0].code, 'storage_corrupt'); assert.equal(f.commands.length, 0);
});
