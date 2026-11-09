'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CrewSupervisor, reportRuntime, validateReport, auditPrompt, auditSession, identity, TIMEOUT_MS, STALL_MS, HISTORY_MAX } = require('../lib/crew-supervisor');
const { liveIdentity } = require('../lib/supervision-state');

const copy = (v) => JSON.parse(JSON.stringify(v));
function task(id = 't', state = 'running') {
  return { id, title: id, status: 'executing', updated: 1, blocked: '', maxFix: 3, heartbeat: {}, tracks: [{ id: 'W1', state, rounds: 1, fixRounds: 0, lastRound: { round: '1', endedAt: '', result: '', kind: 'new' } }] };
}
function session(name, pane, root, status = 'idle', extra = {}) {
  return { id: '$' + pane, created: 5, name, path: root, paneIds: ['%' + pane], aiPid: 1000 + pane,
    aiStatus: { tool: 'claude', status, at: 1, startedAt: 10, cfg: '.claude' }, ...extra };
}
function fixture({ hosts = 1, teams = 1, roots = 1, initial = {}, io = {} } = {}) {
  let clock = 1800000000000, serial = 0, disk = { enabled: true, intervalMinutes: 1, ...initial }, failSave = false;
  const calls = { scan: [], open: [], send: [], report: [] }, reports = new Map();
  const remotes = Array.from({ length: hosts }, (_, host) => ({ cfg: { id: 'vm' + host, name: 'VM ' + host }, ready: true, lastPoll: clock,
    snapshot: { bootId: 'boot', workers: [], sessions: Array.from({ length: teams }, (_, i) => session('leader' + i, i + 1, '/work' + (i % roots), 'busy')) } }));
  disk.leaders ||= remotes.flatMap(r => r.snapshot.sessions.map((s, i) => ({ serverId: r.cfg.id, session: s.name, root: s.path,
    taskIds: ['t' + i], identity: { ...liveIdentity(r, s), processStart: '1' } })));
  const data = new Map(remotes.map((r) => [r.cfg.id, { roots: Array.from({ length: roots }, (_, root) => ({ root: '/work' + root,
    nudge: Array.from({ length: teams }, (_, i) => i % roots === root ? ['%' + (i + 1), 't' + i] : null).filter(Boolean),
    tasks: Array.from({ length: teams }, (_, i) => i % roots === root ? task('t' + i) : null).filter(Boolean) })) }]));
  const adapters = {
    coordinate: async () => ({ code: 'coordination_owner', token: { epoch: 1 } }),
    validateLeader: async () => ({ processStart: '1' }), auditReady: async () => ({ code: 'audit_ready' }),
    scan: async (r, config) => { calls.scan.push({ id: r.cfg.id, config: copy(config) }); return copy(data.get(r.cfg.id)); },
    open: async (r, run) => { calls.open.push(copy(run)); r.snapshot.sessions.push(session(run.session, 80, run.root)); },
    send: async (r, s, prompt) => { calls.send.push({ id: r.cfg.id, session: copy(s), prompt }); },
    report: async (r, run) => { calls.report.push(run.runId); return reports.get(run.runId) || { code: 'report_missing' }; }, ...io,
  };
  const construct = () => new CrewSupervisor({ load: () => copy(disk), save: (s) => { if (failSave) throw Error('disk'); disk = copy(s); },
    io: adapters, now: () => clock, newId: () => 'tn-' + (++serial).toString(16).padStart(32, '0') });
  let core = construct();
  return { remotes, data, calls, reports, adapters, get core() { return core; }, get disk() { return disk; },
    get now() { return clock; }, setFailSave(v) { failSave = v; }, restart() { core = construct(); },
    async tick() { await core.tick(remotes); },
    advance(ms, fresh = true) { clock += ms; if (fresh) for (const r of remotes) r.lastPoll = clock; },
    active(i = 0) { return core.host('vm' + i)?.active; },
    audit(i = 0) { return remotes[i].snapshot.sessions.find((s) => s.name.startsWith('tn-ops-audit')); },
    report(run, overrides = {}) { reports.set(run.runId, { text: JSON.stringify({ schemaVersion: 1, runId: run.runId, serverId: run.serverId, root: run.root, teamId: run.teamId,
      startedAt: run.createdAt, completedAt: clock, coverage: { taskIds: run.taskIds }, result: 'completed', findings: [], ...overrides }) }); },
  };
}

async function delivered(f) { await f.tick(); await f.tick(); assert.equal(f.active().phase, 'delivered'); }
async function complete(f, i = 0) {
  const run = f.active(i); f.advance(1); f.report(run); await f.tick(); f.advance(1); await f.tick();
}

test('3 VMs × 3 teams across 3 roots are covered fairly and independently of UI calls', async () => {
  const f = fixture({ hosts: 3, teams: 3, roots: 3 });
  for (let cycle = 0; cycle < 3; cycle++) {
    await f.tick(); await f.tick();
    assert.equal(f.calls.send.length, (cycle + 1) * 3);
    for (let i = 0; i < 3; i++) { const run = f.active(i); f.advance(1); f.report(run); }
    await f.tick(); f.advance(1); await f.tick();
  }
  for (const r of f.remotes) {
    const h = f.core.host(r.cfg.id);
    assert.equal(new Set(h.history.map((a) => a.root)).size, 3);
    assert.equal(new Set(h.history.map((a) => a.teamId)).size, 3);
    assert.equal(h.active, null);
  }
});

test('duplicate snapshots and overlapping ticks set a gate before awaited persistence/open/send', async () => {
  const f = fixture(); let release;
  f.adapters.open = async (r, run) => { f.calls.open.push(copy(run)); await new Promise((resolve) => { release = resolve; }); r.snapshot.sessions.push(session(run.session, 80, run.root)); };
  const pending = f.tick();
  while (!release) await new Promise((r) => setImmediate(r));
  assert.equal(f.disk.supervisor.hosts.vm0.active.phase, 'opening');
  await Promise.all(Array.from({ length: 10 }, () => f.tick()));
  assert.equal(f.calls.open.length, 1); release(); await pending;
  await Promise.all(Array.from({ length: 10 }, () => f.tick()));
  assert.equal(f.calls.send.length, 1);
  assert.equal(f.active().phase, 'delivered');
});

test('an existing idle legacy audit is reused and receives explicit scope and evidence contract', async () => {
  const f = fixture(); f.remotes[0].snapshot.sessions.push(session('tn-ops-audit', 70, '/work0'));
  await f.tick();
  assert.equal(f.calls.open.length, 0); assert.equal(f.calls.send.length, 1);
  const run = f.active(), prompt = f.calls.send[0].prompt;
  assert.ok(prompt.startsWith('/xspire-devkit:xspire-crew-ops-audit\n'));
  for (const expected of [run.runId, run.teamId, run.serverId, run.root, `_crew/termnest-ops/reports/${run.runId}.json`, 'schemaVersion', 'coverage']) assert.ok(prompt.includes(expected));
});

for (const status of ['busy', 'waiting', 'unknown', 'parked', 'asking', 'multipane']) {
  test(`an existing ${status} audit is held without typing or creating another session`, async () => {
    const f = fixture(); const s = session('tn-ops-audit', 70, '/work0', ['busy', 'waiting', 'unknown'].includes(status) ? status : 'idle');
    if (status === 'parked') s.aiStatus.parked = true;
    if (status === 'asking') s.asking = true;
    if (status === 'multipane') s.paneIds.push('%71');
    f.remotes[0].snapshot.sessions.push(s); await f.tick(); await f.tick();
    assert.equal(f.calls.open.length + f.calls.send.length, 0);
    assert.equal(f.active().requiresOwner, true);
    f.advance(TIMEOUT_MS + 1); await f.tick();
    assert.ok(f.active(), 'timeout cannot free a live/unknown audit reservation');
  });
}

test('a busy audit at another root blocks a new audit on the same host', async () => {
  const f = fixture(); f.remotes[0].snapshot.sessions.push(session(auditSession('/other'), 70, '/other', 'busy'));
  await f.tick(); assert.equal(f.active().reason.code, 'host_audit_held'); assert.equal(f.calls.open.length, 0);
});

test('offline and stale hosts are not scanned, opened or sent; exact freshness is explicit', async () => {
  const f = fixture({ hosts: 3 }); f.remotes[0].ready = false; f.remotes[1].lastPoll -= 60001;
  await f.tick(); assert.deepEqual(f.calls.scan.map((v) => v.id), ['vm2']);
  assert.deepEqual(f.core.status(f.remotes).servers.map((v) => v.online), [false, false, true]);
  f.advance(60001, false); await f.tick(); assert.equal(f.calls.send.length, 0);
});

test('freshness and off are checked again after awaited open/scan/persistence', async () => {
  const f = fixture(); let release;
  f.adapters.scan = async (r) => { await new Promise((resolve) => { release = resolve; }); return f.data.get(r.cfg.id); };
  const pending = f.tick(); while (!release) await new Promise((r) => setImmediate(r));
  await f.core.control({ enabled: false }, f.remotes); release(); await pending;
  assert.equal(f.calls.open.length + f.calls.send.length, 0);
  await f.tick(); assert.equal(f.disk.enabled, false);
});

test('disabled persists across restart and snapshots do not turn it on', async () => {
  const f = fixture({ initial: { enabled: false, auditHours: 1 } }); await f.tick();
  // Off still observes (read-only scan, owner 09/11) but never leases, sends or opens anything.
  assert.equal(f.calls.send.length, 0); assert.equal(f.calls.open.length, 0);
  assert.equal((f.calls.coordinate || []).length, 0);
  await f.core.control({ enabled: true }, f.remotes); await f.tick();
  await f.core.control({ enabled: false }, f.remotes); f.restart(); await f.tick();
  assert.equal(f.core.status(f.remotes).enabled, false); assert.equal(f.calls.send.length, 0);
});

test('a durable sending intent is visible before send; restart never resends it', async () => {
  const f = fixture(); await f.tick();
  f.adapters.send = async () => { assert.equal(f.disk.supervisor.hosts.vm0.active.phase, 'sending'); throw Error('SSH disconnected after Enter'); };
  await f.tick(); assert.equal(f.active().phase, 'uncertain');
  const run = copy(f.active()); f.restart(); await f.tick();
  assert.equal(f.calls.send.length, 0); assert.equal(f.active().runId, run.runId);
  f.advance(1); f.report(run); await f.tick(); assert.equal(f.active().verification, 'reported');
});

test('restart of a persisted sending phase reconciles a report and never resends', async () => {
  const f = fixture(); await delivered(f);
  const store = copy(f.disk); store.supervisor.hosts.vm0.active.phase = 'sending';
  const g = fixture({ initial: store }); g.remotes[0].snapshot.sessions.push(session(f.active().session, 80, '/work0'));
  await g.tick(); assert.equal(g.active().phase, 'uncertain'); assert.equal(g.calls.send.length + g.calls.open.length, 0);
});

test('restart of an opening intent reconciles an existing session but never creates a missing one twice', async () => {
  const f = fixture(); f.adapters.open = async () => { throw Error('open acknowledgement lost'); };
  await f.tick(); f.restart(); await f.tick();
  assert.equal(f.active().phase, 'opening'); assert.equal(f.calls.open.length, 0);
  f.remotes[0].snapshot.sessions.push(session(f.active().session, 80, '/work0')); await f.tick();
  assert.equal(f.calls.send.length, 1);
});

for (const action of ['open', 'send']) {
  test(`definitely rejected ${action} retries with bounded exponential backoff`, async () => {
    const f = fixture(); let attempts = 0;
    f.adapters[action] = async () => { attempts++; throw Object.assign(Error('definite rejection'), { noSideEffect: true }); };
    if (action === 'send') f.remotes[0].snapshot.sessions.push(session('tn-ops-audit', 80, '/work0'));
    await f.tick(); await f.tick(); assert.equal(attempts, 1);
    f.advance(1000); await f.tick(); assert.equal(attempts, 2);
    f.advance(1999); await f.tick(); assert.equal(attempts, 2);
    f.advance(1); await f.tick(); assert.equal(attempts, 3);
    assert.equal(f.active(), null); assert.equal(f.core.host('vm0').history[0].phase, 'failed');
    await f.tick(); assert.equal(attempts, 3);
  });
}

test('save failure before an action fails closed and keeps coverage/intent recoverable', async () => {
  const f = fixture(); await delivered(f); await complete(f);
  f.advance(60000); f.setFailSave(true); await f.tick();
  assert.equal(f.calls.send.length, 1); assert.equal(f.core.status(f.remotes).enabled, false);
  assert.equal(f.core.status(f.remotes).errors[0].code, 'storage_failed');
  assert.ok(f.core.host('vm0').roots['/work0']);
  await f.tick(); assert.equal(f.calls.send.length, 1);
});

test('save failure after a send leaves durable intent and restart cannot duplicate delivery', async () => {
  const f = fixture(); await f.tick();
  f.adapters.send = async () => { f.calls.send.push({}); f.setFailSave(true); };
  await f.tick(); assert.equal(f.disk.supervisor.hosts.vm0.active.phase, 'sending');
  f.setFailSave(false); f.restart(); await f.tick(); assert.equal(f.calls.send.length, 1); assert.equal(f.active().phase, 'uncertain');
});

test('idle/busy acknowledges delivery but does not complete an audit; timeout holds a live busy session', async () => {
  const f = fixture(); await delivered(f); f.advance(1); await f.tick();
  assert.equal(f.active().verification, 'unverified');
  f.audit().aiStatus.status = 'busy'; f.advance(1); await f.tick(); assert.equal(f.active().phase, 'running');
  f.advance(TIMEOUT_MS); await f.tick(); assert.equal(f.active().phase, 'timeout'); assert.ok(f.active());
  f.audit().aiStatus.status = 'idle'; f.advance(1); await f.tick();
  assert.equal(f.active(), null); assert.equal(f.core.host('vm0').history[0].verification, 'unverified');
});

test('a valid bounded report completes with reported evidence; busy still holds host concurrency', async () => {
  const f = fixture(); await delivered(f); f.audit().aiStatus.status = 'busy'; f.advance(1); f.report(f.active());
  await f.tick(); assert.equal(f.active().phase, 'completed'); assert.equal(f.active().verification, 'reported');
  f.advance(1); await f.tick(); assert.equal(f.calls.open.length, 1);
  f.audit().aiStatus.status = 'idle'; await f.tick(); assert.equal(f.active(), null);
  assert.equal(f.core.host('vm0').history[0].reason.code, 'report_valid');
});

test('read failures and malformed reports stay unverified and expire truthfully', async () => {
  const f = fixture(); await delivered(f); f.reports.set(f.active().runId, { text: '{bad' });
  f.advance(1); await f.tick(); assert.equal(f.active().reportCode, 'report_invalid');
  f.adapters.report = async () => { throw Error('ssh'); }; f.advance(TIMEOUT_MS + 1); await f.tick();
  assert.equal(f.core.host('vm0').history[0].phase, 'timeout');
});

test('task evidence, rather than mtime/heartbeat/tokens/busy, measures progress and long busy stalls', async () => {
  const f = fixture(); await delivered(f);
  let team = f.core.status(f.remotes).servers[0].teams[0]; assert.equal(team.lastProgressAt, null); assert.equal(team.status, 'unknown');
  const t = f.data.get('vm0').roots[0].tasks[0]; t.updated++; t.heartbeat = { alive: true, at: f.now }; t.tokens = 200;
  // A bounded legacy counter can shift when a token column changes width; the actual latest record is identical.
  t.tracks[0].rounds = 99;
  t.tracks[0].lastRound.endedAt = '2099-01-01T00:00:00Z';
  f.advance(30000); await f.tick(); assert.equal(f.core.status(f.remotes).servers[0].teams[0].lastProgressAt, null);
  t.tracks[0].state = 'review'; f.advance(30000); await f.tick();
  team = f.core.status(f.remotes).servers[0].teams[0]; assert.equal(team.lastProgressAt, f.now); assert.equal(team.status, 'progressing');
  f.advance(STALL_MS); await f.tick(); assert.equal(f.core.status(f.remotes).servers[0].teams[0].status, 'stalled');
  assert.equal(f.calls.send.length, 1, 'never type into the busy leader');
});

test('same-name owners are grouped by actual pane/session identity, and unowned work has no invented leader', async () => {
  const f = fixture({ teams: 3 }); f.remotes[0].snapshot.sessions.forEach((s) => { s.name = 'same'; });
  f.disk.leaders.forEach(l => { l.session = 'same'; }); f.disk.leaders.pop();
  f.data.get('vm0').roots[0].nudge.pop(); await f.tick();
  const teams = f.core.status(f.remotes).servers[0].teams;
  assert.equal(new Set(teams.map((t) => t.id)).size, 3);
  const unknown = teams.find((t) => t.session === ''); assert.deepEqual(unknown.taskIds, ['t2']); assert.equal(unknown.reason.code, 'registration_required');
});

test('all seven team states distinguish owner waits, blocks, stale and completion', async () => {
  const f = fixture(); await f.tick(); const t = f.data.get('vm0').roots[0].tasks[0], s = f.remotes[0].snapshot.sessions[0];
  const state = () => f.core.status(f.remotes).servers[0].teams[0].status;
  s.aiStatus.status = 'idle'; assert.equal(state(), 'idle');
  s.aiStatus.status = 'waiting'; assert.equal(state(), 'waiting_owner');
  s.aiStatus.status = 'busy'; t.blocked = 'slot'; f.advance(30000); await f.tick(); assert.equal(state(), 'blocked');
  t.blocked = ''; t.status = 'done'; f.advance(30000); await f.tick(); assert.equal(state(), 'completed');
  f.remotes[0].ready = false; assert.equal(state(), 'unknown');
});

test('registered and discovered roots survive missing sessions and disappeared task folders', async () => {
  const f = fixture({ roots: 2, teams: 2, initial: { workspaces: [{ serverId: 'vm0', root: '/configured' }] } });
  await f.tick(); assert.ok(f.calls.scan[0].config.roots.includes('/configured'));
  f.remotes[0].snapshot.sessions = []; f.data.set('vm0', { roots: [] }); f.advance(30000); await f.tick();
  assert.ok(f.calls.scan.at(-1).config.roots.includes('/work0')); assert.ok(f.calls.scan.at(-1).config.roots.includes('/work1'));
  const teams = f.core.status(f.remotes).servers[0].teams;
  assert.ok(teams.some((t) => t.root === '/work0' && t.taskIds.includes('t0')));
  assert.ok(teams.every((t) => t.status === 'unknown'));
  f.restart(); f.advance(30000); await f.tick(); assert.ok(f.calls.scan.at(-1).config.roots.includes('/work1'));
});

test('bounded history cannot reset per-team coverage or starve later teams', async () => {
  const f = fixture({ teams: HISTORY_MAX + 3 }); await f.tick();
  for (let i = 0; i < HISTORY_MAX + 3; i++) { await f.tick(); await complete(f); if (i < HISTORY_MAX + 2) await f.tick(); }
  assert.equal(f.calls.send.length, HISTORY_MAX + 3);
  assert.equal(f.core.host('vm0').history.length, HISTORY_MAX);
  assert.equal(Object.keys(f.core.host('vm0').coverage).length, HISTORY_MAX + 3);
});

test('control validates workspace registration and intervals without accepting shell expressions', async () => {
  const f = fixture();
  for (const b of [{ enabled: 1 }, { enabled: true, intervalMinutes: 0 }, { enabled: true, intervalMinutes: 1441 },
    { enabled: true, workspaces: [{ serverId: 'missing', root: '/work' }] },
    ...['relative', '/a/../b', '/a\n', '/a;evil', '/a$(evil)', '/'].map((root) => ({ enabled: true, workspaces: [{ serverId: 'vm0', root }] }))]) {
    await assert.rejects(() => f.core.control(b, f.remotes), /invalid_/);
  }
  const result = await f.core.control({ enabled: true, intervalMinutes: 1440, workspaces: [{ serverId: 'vm0', root: '/a space' }] }, f.remotes);
  assert.equal(result.intervalMinutes, 1440); assert.equal(f.disk.workspaces[0].root, '/a space');
});

test('reports cannot change identity, coverage, timestamps, schema or inject executable commands', async () => {
  const f = fixture(); await delivered(f); f.advance(1); const run = f.active();
  const invalid = [ { runId: '../escape' }, { serverId: 'vm2' }, { root: '/elsewhere' }, { teamId: 'other' }, { schemaVersion: 2 },
    { coverage: { taskIds: [] } }, { completedAt: f.now + 1 }, { startedAt: run.createdAt - 1 }, { result: 'green' },
    { command: 'touch /tmp/PWN' }, { findings: [{ code: 'a', severity: 'info', command: 'bad' }] }, { findings: [{ code: 'a', severity: 'info', taskId: 'other' }] } ];
  for (const patch of invalid) { f.report(run, patch); const v = validateReport(f.reports.get(run.runId), run, f.now); assert.notEqual(v.code, 'report_valid', JSON.stringify(patch)); }
  f.report(run); assert.equal(validateReport(f.reports.get(run.runId), run, f.now).code, 'report_valid');
  assert.equal(validateReport({ text: ' '.repeat(65537) }, run, f.now).code, 'report_invalid');
  assert.ok(auditPrompt(run).includes('do not answer owner prompts'));
});

test('host report reader rejects path tricks, symlinks, oversized and nonregular files', { skip: process.platform === 'win32' && 'crew roots are POSIX paths' }, async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tn-report-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, '_crew', 'termnest-ops', 'reports'); fs.mkdirSync(dir, { recursive: true });
  const runId = 'tn-' + '1'.repeat(32), file = path.join(dir, runId + '.json'), read = reportRuntime();
  assert.equal((await read({ root, runId: '../../x' })).code, 'report_path');
  assert.equal((await read({ root: root + '/../x', runId })).code, 'report_path');
  assert.equal((await read({ root, runId })).code, 'report_missing');
  fs.writeFileSync(file, '{}'); assert.equal((await read({ root, runId })).text, '{}');
  fs.writeFileSync(file, 'x'.repeat(65537)); assert.equal((await read({ root, runId })).code, 'report_oversize');
  fs.unlinkSync(file); fs.mkdirSync(file); assert.equal((await read({ root, runId })).code, 'report_not_regular'); fs.rmdirSync(file);
  const outside = path.join(root, 'outside'); fs.writeFileSync(outside, '{}'); fs.symlinkSync(outside, file); assert.equal((await read({ root, runId })).code, 'report_symlink');
  fs.unlinkSync(file); fs.renameSync(dir, dir + '-saved'); fs.symlinkSync(dir + '-saved', dir); assert.equal((await read({ root, runId })).code, 'report_symlink');
});

test('off wins overlapping asynchronous controls without a transient enabled emission window', async () => {
  const f = fixture({ initial: { enabled: false } }); const original = f.core.save;
  const releases = [];
  f.core.save = async (s) => { await new Promise((resolve) => releases.push(resolve)); original(s); };
  const enable = f.core.control({ enabled: true }, f.remotes);
  while (releases.length < 1) await new Promise((r) => setImmediate(r));
  const disable = f.core.control({ enabled: false }, f.remotes); releases.shift()();
  await enable;
  assert.equal(f.core.enabled(), false);
  while (releases.length < 1) await new Promise((r) => setImmediate(r));
  releases.shift()();
  // The second durable phase marks remote policy reconfiguration complete. OFF is suppressed throughout both saves.
  while (releases.length < 1) await new Promise((r) => setImmediate(r));
  assert.equal(f.core.enabled(), false); releases.shift()(); await disable; await f.tick(); assert.equal(f.calls.open.length, 0);
});

test('a changed boot identity during durable send intent is rejected before typing', async () => {
  const f = fixture(); await f.tick(); const original = f.core.save;
  f.core.save = async (s) => { original(s); if (s.supervisor.hosts.vm0.active?.phase === 'sending') f.remotes[0].snapshot.bootId = 'new-boot'; };
  await f.tick(); assert.equal(f.calls.send.length, 0); assert.equal(f.active().phase, 'retry_send');
});

test('an awaited live open keeps the gate beyond its deadline while status reports timeout', async () => {
  const f = fixture(); let release;
  f.adapters.open = async () => { await new Promise((resolve) => { release = resolve; }); };
  const active = f.tick(); while (!release) await new Promise((r) => setImmediate(r));
  f.advance(TIMEOUT_MS + 1); await f.tick();
  const audit = f.core.status(f.remotes).servers[0].audits[0];
  assert.equal(audit.phase, 'timeout'); assert.equal(audit.actionInFlight, true); assert.equal(audit.requiresOwner, true);
  assert.equal(f.core.gates.has('vm0'), true); assert.equal(f.calls.send.length, 0);
  release(); await active;
});

test('enrolled sessions remain represented when their manifest is missing; lastAction stays an action', async () => {
  const f = fixture(); const root = f.data.get('vm0').roots[0]; root.tasks = [];
  await delivered(f); f.advance(1); await f.tick();
  const team = f.core.status(f.remotes).servers[0].teams[0];
  assert.deepEqual(team.taskIds, ['t0']); assert.equal(team.status, 'unknown'); assert.equal(team.session, 'leader0');
  assert.equal(team.lastAction.code, 'prompt_delivered'); assert.equal(f.active().reason.code, 'report_missing');
});

test('scan failures back off, preserve known roots and recover without duplicate delivery', async () => {
  const f = fixture(); await delivered(f); const scan = f.adapters.scan; let attempts = 0;
  f.adapters.scan = async () => { attempts++; throw Error('offline IO'); };
  f.advance(30000); await f.tick(); await f.tick(); assert.equal(attempts, 1);
  assert.equal(f.core.status(f.remotes).servers[0].teams[0].reason.code, 'task_evidence_stale');
  f.advance(2000); await f.tick(); assert.equal(attempts, 2);
  f.adapters.scan = scan; f.advance(4000); await f.tick();
  assert.equal(f.core.host('vm0').scanError, ''); assert.equal(f.calls.send.length, 1);
});

test('round results and task phases qualify as progress while a report never advances measured progress', async () => {
  const f = fixture(); await delivered(f); const t = f.data.get('vm0').roots[0].tasks[0];
  t.tracks[0].lastRound = { round: '1', endedAt: '2026-11-08T10:00:00Z', result: '0', kind: 'new' };
  f.advance(30000); await f.tick(); let at = f.core.status(f.remotes).servers[0].teams[0].lastProgressAt; assert.equal(at, f.now);
  f.advance(1); f.report(f.active()); await f.tick(); assert.equal(f.core.status(f.remotes).servers[0].teams[0].lastProgressAt, at);
  t.status = 'verifying'; f.advance(30000); await f.tick(); at = f.core.status(f.remotes).servers[0].teams[0].lastProgressAt; assert.equal(at, f.now);
});

test('an unresolved crash/send ambiguity cannot be released just by age and repeated idle snapshots', async () => {
  const f = fixture(); await f.tick();
  f.adapters.send = async () => { f.calls.send.push({}); throw Error('maybe partially typed'); };
  await f.tick(); f.restart(); f.advance(TIMEOUT_MS + 1); await f.tick();
  assert.equal(f.active().phase, 'timeout'); assert.equal(f.active().deliveryUncertain, true);
  f.advance(TIMEOUT_MS); await f.tick(); assert.equal(f.calls.send.length, 1); assert.ok(f.active());
  // Busy then idle acknowledges that the old prompt ran and stopped; neither is success evidence.
  f.audit().aiStatus.status = 'busy'; f.advance(1); await f.tick();
  f.audit().aiStatus.status = 'idle'; f.advance(1); await f.tick();
  assert.equal(f.active(), null); assert.equal(f.core.host('vm0').history[0].verification, 'unverified');
});
