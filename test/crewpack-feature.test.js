'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const cp = require('../lib/features/crewpack');
const wd = require('../lib/features/watchdog');
const detect = require('../lib/crew-detect');
const { liveIdentity } = require('../lib/supervision-state');
// Crew workspace roots are POSIX paths on Linux, macOS or WSL hosts; a native Windows temp folder is never one.
const posixRoot = { skip: process.platform === 'win32' && 'crew roots are POSIX paths' };

const fixtureRoots = [];
test.after(() => { for (const root of fixtureRoots) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-crewpack-'));
  fixtureRoots.push(root);
  const task = (id, front, rounds) => {
    const d = path.join(root, '_crew', 'tasks', id); fs.mkdirSync(path.join(d, 'tracks', 'W1'), { recursive: true });
    fs.writeFileSync(path.join(d, 'MANIFEST.md'), `---\ntask_id: ${id}\ntitle: "Task ${id}"\n${front}\n---\n# body\n`);
    if (rounds) fs.writeFileSync(path.join(d, 'tracks', 'W1', 'ROUNDS.tsv'), rounds);
  };
  const fix = (n) => Array.from({ length: n }, (_, i) => `${i + 1}\t2026-11-05T12:00:00+07:00\t2026-11-05T12:30:00+07:00\t1800\t7\t100\t${i ? 'fix' : 'new'}\tcodex\tm\thigh\ttooling`).join('\n') + '\n';
  task('t-asleep', 'status: executing\nbudgets:  { max_fix_rounds: 3 }\ntracks: [{ id: W1, state: dispatched, executor: codex }]\nblocked: null');
  task('t-rounds', 'status: executing\nbudgets:  { max_fix_rounds: 2 }\ntracks: [{ id: W1, state: fix, executor: codex }]\nblocked: null', fix(3));
  task('t-blocked', 'status: executing\ntracks: [{ id: W1, state: pending }]\nblocked: "waiting for DB slot"');
  task('t-done', 'status: done\ntracks: [{ id: W1, state: merged }]\nblocked: null');
  fs.writeFileSync(path.join(root, '_crew', 'nudge.conf'), '%7 t-asleep\n%9 t-done\n# comment\nbad line\n');
  fs.mkdirSync(path.join(root, 'repo', 'src'), { recursive: true });
  return root;
}

test('reads crew files only from a workspace that has _crew/tasks, starting from a session folder below it', async () => {
  const root = fixture(), res = await cp.crewRuntime()({ cwds: [path.join(root, 'repo', 'src'), os.tmpdir()], days: 3 });
  assert.equal(res.roots.length, 1);
  const r = res.roots[0];
  assert.deepEqual(r.nudge, [['%7', 't-asleep'], ['%9', 't-done']]);
  const byId = Object.fromEntries(r.tasks.map((t) => [t.id, t]));
  assert.equal(byId['t-rounds'].tracks[0].fixRounds, 2);
  assert.equal(byId['t-blocked'].blocked, 'waiting for DB slot');
  assert.equal(byId['t-asleep'].maxFix, 3);
  assert.equal((await cp.crewRuntime()({ cwds: [os.tmpdir()], days: 3 })).roots.length, 0);
});

test('classifies BLOCKER / WASTE / DRIFT / INFO from crew files and the sessions\' own status', async () => {
  const root = fixture(), res = await cp.crewRuntime()({ cwds: [root], days: 3 }), now = Date.now();
  const leader = { name: 'SFA-B4', paneIds: ['%7'], aiStatus: { tool: 'claude', status: 'idle', at: now - 47 * 60000 } };
  const out = cp.classify(res, [leader], now).map((f) => [f.cat, f.code, f.task]);
  assert.deepEqual(out.filter((x) => x[2] === 't-asleep'), [['BLOCKER', 'leader_asleep', 't-asleep'], ['DRIFT', 'no_heartbeat', 't-asleep']]);
  assert.ok(out.some((x) => x[1] === 'out_of_rounds' && x[2] === 't-rounds'));
  assert.ok(out.some((x) => x[1] === 'blocked' && x[2] === 't-blocked'));
  assert.ok(out.some((x) => x[0] === 'WASTE' && x[2] === 't-done'));
  // A working leader is not asleep.
  const busy = cp.classify(res, [{ ...leader, aiStatus: { ...leader.aiStatus, status: 'busy' } }], now);
  assert.ok(!busy.some((f) => f.code === 'leader_asleep'));
});

test('the .NET / crew watchdog rules run only where the crew pack saw a _crew workspace', () => {
  for (const id of ['bare-build', 'ef-update', 'many-compilers']) assert.ok(wd.CREW_ONLY.has(id));
  assert.ok(!wd.CREW_ONLY.has('big-memory') && !wd.CREW_ONLY.has('hot-cpu'));
  detect.mark('m1', true); assert.equal(detect.has('m1'), true);
  detect.mark('m1', false); assert.equal(detect.has('m1'), false);
});

test('several failed tracks of one task are one finding that names them', () => {
  const crew = { roots: [{ root: '/w', nudge: [], tasks: [{ id: 't', title: 'T', status: 'executing', blocked: '', maxFix: 0, heartbeat: {}, tracks: ['A', 'B', 'C'].map((id) => ({ id, state: 'failed', fixRounds: 0 })) }] }] };
  const out = cp.classify(crew, [], Date.now()).filter((f) => f.code === 'track_failed');
  assert.deepEqual(out.map((f) => f.params), [['A, B, C', 3]]);
});

test('the crew kit version is the commit of scripts/crew, empty when that is not a git checkout', async () => {
  const root = fixture(), res = await cp.crewRuntime()({ cwds: [root], days: 3 });
  assert.deepEqual(res.roots[0].kit, { commit: '', at: 0 });
});

test('a track names its repo, branch and remote from BASE, with any credentials in the remote removed', async () => {
  const root = fixture(), cp2 = require('node:child_process');
  const repo = path.join(root, 'repo'); cp2.execFileSync('git', ['init', '-q', repo]); cp2.execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://bot:SECRET@gitlab.example.com/g/repo.git']);
  fs.writeFileSync(path.join(root, '_crew', 'tasks', 't-asleep', 'tracks', 'W1', 'BASE'), 'repo=repo\nbase_ref=main\nbranch=crew/t-asleep-w1\n');
  const res = await cp.crewRuntime()({ cwds: [root], days: 3 }), k = res.roots[0].tasks.find((t) => t.id === 't-asleep').tracks[0];
  assert.deepEqual([k.repo, k.branch, k.remote], ['repo', 'crew/t-asleep-w1', 'https://gitlab.example.com/g/repo.git']);
});

// Exercise the feature's real host adapters, runtime and registered HTTP handlers.
// Only tmux launch/typing is faked: no existing user sessions are touched.
function featureHost(t, options = {}) {
  const root = fs.realpathSync(fixture());
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let clock = 1800000000000, serial = 0;
  const vault = { features: { crewpack: { enabled: false, ...options.settings }, ops: { keep: 'untouched' } }, other: 'preserved' };
  const routes = new Map(), timers = [], sent = [], opened = [];
  const remote = { cfg: { id: 'vm', name: 'VM', local: true }, ready: true, lastPoll: clock,
    snapshot: { bootId: 'boot', workers: [], sessions: [{ id: '$1', name: 'team', created: 3, path: root, paneIds: ['%7'], aiPid: 701,
      aiStatus: { tool: 'claude', status: 'busy', at: clock, cfg: '.claude', startedAt: 10 } }] },
    exec: async (command) => { sent.push(command); return options.exec ? options.exec(command) : { code: 0, out: '' }; } };
  const host = {
    settings: { get: () => { if (options.locked) throw Error('locked'); return JSON.parse(JSON.stringify(vault.features.crewpack)); }, set: (s) => { vault.features.crewpack = s; } },
    remotes: () => [remote], backendOf: (id) => id === 'vm' ? remote : null, log() {}, provided: {}, provide(name, value) { this.provided[name] = value; },
    onSnapshot(fn) { this.snapshot = fn; }, route(method, route, fn) { routes.set(method + ' ' + route, fn); },
    readJson: async (req) => req.body, send: (res, code, data) => Object.assign(res, { code, data }), fail: (res, code, error) => Object.assign(res, { code, error }),
    sessions: { start: async (r, { name, dir, run }) => { opened.push({ name, dir, run }); r.snapshot.sessions.push({ id: '$9', name, created: 7, path: dir, paneIds: ['%90'], aiStatus: { tool: 'claude', status: 'idle', at: clock } }); } },
  };
  vault.features.crewpack.leaders ||= [{ serverId: 'vm', root, session: 'team', taskIds: ['t-asleep'], identity: { ...liveIdentity(remote, remote.snapshot.sessions[0]), processStart: '1' } }];
  const guard = async (r, a) => {
    if (a.op === 'lease') return { code: 'coordination_owner', token: { coordinatorId: a.coordinatorId, epoch: 1 } };
    if (a.op === 'inspect') return { code: 'identity_valid', processStart: '1' };
    if (a.op === 'revoke') return { code: options.revokeCode || 'coordination_revoked' };
    if (a.op === 'readiness') return { code: 'audit_ready', accountRef: 'a'.repeat(64), label: 'operator@example.test' };
    if (a.op === 'ack_audit') return { code: 'audit_acknowledged' };
    if (a.kind === 'audit_open') await host.sessions.start(r, { name: a.session, dir: a.root, run: 'claude' });
    else sent.push(a);
    return { code: 'action_delivered' };
  };
  const running = cp.register(host, { guard, now: () => clock, newId: () => 'tn-' + (++serial).toString(16).padStart(32, '0'), setInterval: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; }, clearInterval() {} });
  t.after(() => running.stop());
  return { root, vault, remote, host, sent, opened, timers, running,
    async route(method, url, body) { const res = {}; assert.ok(routes.has(method + ' ' + url)); await routes.get(method + ' ' + url)({ req: { body }, res }); return res; },
    async tick() { await timers[0].fn(); },
    advance(ms) { clock += ms; remote.lastPoll = clock; }, get now() { return clock; },
  };
}

test('feature status/control routes have stable contracts and settings remain within crewpack', posixRoot, async (t) => {
  const f = featureHost(t);
  let response = await f.route('GET', '/status');
  assert.deepEqual(Object.keys(response.data).sort(), ['autoEnroll', 'enabled', 'errors', 'excluded', 'intervalMinutes', 'servers']);
  assert.equal(response.data.enabled, false); assert.equal(response.data.intervalMinutes, 30);
  response = await f.route('POST', '/control', { enabled: true, workspaces: [{ serverId: 'vm', root: f.root }] });
  assert.equal(response.code, 200); assert.equal(response.data.intervalMinutes, 30);
  await f.tick(); response = await f.route('GET', '/status');
  const server = response.data.servers[0];
  for (const key of ['id', 'name', 'online', 'observedAt', 'teams', 'audits', 'freshness']) assert.ok(Object.hasOwn(server, key), key);
  for (const key of ['id', 'session', 'root', 'status', 'reason', 'lastProgressAt', 'lastAction', 'requiresOwner']) assert.ok(Object.hasOwn(server.teams[0], key), key);
  assert.ok(server.teams.every((s) => ['progressing', 'idle', 'waiting_owner', 'blocked', 'stalled', 'unknown', 'completed'].includes(s.status)));
  assert.ok(server.teams.every((s) => typeof s.reason.code === 'string' && s.reason.params.every((v) => ['string', 'number', 'boolean'].includes(typeof v))));
  assert.deepEqual(f.vault.features.ops, { keep: 'untouched' }); assert.equal(f.vault.other, 'preserved');
  assert.equal(f.timers[0].ms, 5000);
});

// macOS/Windows hosts cannot hold a lease, so turning supervision on or off must not fail on them.
test('control succeeds when a host reports that coordination is unavailable on its platform', posixRoot, async (t) => {
  const f = featureHost(t, { revokeCode: 'coordination_platform_unavailable' });
  const response = await f.route('POST', '/control', { enabled: true, autoEnroll: true, workspaces: [{ serverId: 'vm', root: f.root }] });
  assert.equal(response.code, 200); assert.equal(response.data.enabled, true);
  assert.equal((await f.route('POST', '/control', { enabled: false })).code, 200);
});

// "Gắn leader": the crew kit writes nudge.conf; Termnest only calls `crew-task.sh enroll` for a live single-pane session.
test('bind asks the crew kit to enroll the session pane and maps kit failures to clear codes', posixRoot, async (t) => {
  let reply = (cmd) => /crew-task\.sh enroll/.test(cmd) ? { code: 0, out: 'enrolled %7 t-blocked\n' } : { code: 0, out: '' };
  const f = featureHost(t, { settings: { enabled: true, autoEnroll: true }, exec: (cmd) => reply(cmd) });
  await f.tick();
  const body = { serverId: 'vm', root: f.root, session: 'team', taskId: 't-blocked' };
  const bind = (b) => f.host.provided.supervision.bind(b).then((v) => v, (e) => ({ error: e.message }));
  const ok = await bind(body);
  assert.equal(ok.code, 'bind_done', JSON.stringify(ok)); assert.equal(ok.pane, '%7');
  assert.ok(f.sent.some((c) => c === "cd '" + f.root + "' && bash scripts/crew/crew-task.sh enroll --task 't-blocked' --pane '%7' 2>&1"));
  reply = () => ({ code: 2, out: 'crew-task: unknown command: enroll\n' });
  assert.equal((await bind(body)).error, 'bind_kit_outdated');
  assert.equal((await bind({ ...body, taskId: 't-done' })).error, 'bind_task_closed');
  assert.equal((await bind({ ...body, session: 'ghost' })).error, 'bind_session_missing');
  assert.equal((await bind({ ...body, taskId: 'bad id;' })).error, 'invalid_bind');
  f.remote.snapshot.sessions[0].paneIds = ['%7', '%8'];
  assert.equal((await bind(body)).error, 'bind_pane_ambiguous');
});

test('the backend feature timer opens then sends to an idle audit without an HTTP request or snapshot event', posixRoot, async (t) => {
  const f = featureHost(t, { settings: { enabled: true } });
  await f.tick(); assert.equal(f.opened.length, 1); assert.equal(f.sent.length, 0);
  await f.tick(); assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].identity.pane, '%90'); assert.ok(f.sent[0].prompt.includes('/xspire-devkit:xspire-crew-ops-audit'));
  await f.host.snapshot(f.remote); await f.tick(); assert.equal(f.sent.length, 1);
  const status = (await f.route('GET', '/status')).data;
  assert.equal(status.servers[0].audits[0].verification, 'unverified');
});

test('feature report adapter requires the actual validated report file to complete', posixRoot, async (t) => {
  const f = featureHost(t, { settings: { enabled: true } }); await f.tick(); await f.tick();
  const run = f.running.supervisor.host('vm').active;
  const dir = path.join(f.root, '_crew', 'termnest-ops', 'reports'); fs.mkdirSync(dir, { recursive: true });
  f.advance(1);
  fs.writeFileSync(path.join(dir, run.runId + '.json'), JSON.stringify({ schemaVersion: 1, runId: run.runId, serverId: 'vm', root: f.root,
    teamId: run.teamId, startedAt: run.createdAt, completedAt: f.now, coverage: { taskIds: run.taskIds }, result: 'completed', findings: [] }));
  await f.tick(); f.advance(1); await f.tick();
  const audit = (await f.route('GET', '/status')).data.servers[0].audits[0];
  assert.equal(audit.phase, 'completed'); assert.equal(audit.active, false); assert.equal(audit.verification, 'reported');
  const manual = await f.route('POST', '/audit', { server: 'vm', root: f.root });
  assert.equal(manual.code, 200); assert.notEqual(manual.data.runId, run.runId);
  assert.equal(f.opened.length, 1); assert.equal(f.sent.length, 2);
});

test('legacy routes stay registered and off suppresses pending prompts and manual audit requests', posixRoot, async (t) => {
  const f = featureHost(t);
  assert.equal((await f.route('POST', '/days', { days: 7 })).data.days, 7);
  assert.equal((await f.route('POST', '/schedule', { hours: 0.5 })).data.auditHours, 0.5);
  await f.tick(); assert.equal(f.opened.length, 1);
  let data = (await f.route('GET', '/data')).data;
  assert.equal(data.days, 7); assert.equal(data.auditHours, 0.5); assert.equal(data.servers[0].auditPending, true);
  assert.ok(data.servers[0].findings.length > 0); assert.ok(data.servers[0].tasks.length > 0);
  await f.route('POST', '/schedule', { hours: 0 }); await f.tick(); await f.host.snapshot(f.remote);
  assert.equal(f.sent.length, 0);
  const response = await f.route('POST', '/audit', { server: 'vm', root: f.root });
  assert.equal(response.code, 409); assert.equal(response.error, 'supervisor_disabled');
  data = (await f.route('GET', '/data')).data; assert.equal(data.auditHours, 0);
});

test('feature route validation rejects bad roots/servers/intervals and fails closed while vault is locked', async (t) => {
  const f = featureHost(t);
  for (const body of [{ enabled: true, intervalMinutes: 1.5 }, { enabled: true, intervalMinutes: 1441 },
    { enabled: true, workspaces: [{ serverId: 'missing', root: '/work' }] }, { enabled: true, workspaces: [{ serverId: 'vm', root: '/a\ncommand' }] }]) {
    assert.equal((await f.route('POST', '/control', body)).code, 400);
  }
  assert.equal((await f.route('POST', '/audit', { server: 'missing', root: '/work' })).code, 404);
  const locked = featureHost(t, { locked: true }); await locked.tick();
  assert.equal((await locked.route('GET', '/status')).data.errors[0].code, 'storage_locked');
  assert.equal(locked.opened.length + locked.sent.length, 0);
});

test('configured workspace discovery works with no sessions and open tasks ignore old mtimes', posixRoot, async (t) => {
  const f = featureHost(t); f.remote.snapshot.sessions = [];
  const mf = path.join(f.root, '_crew', 'tasks', 't-blocked', 'MANIFEST.md');
  const old = new Date(Date.now() - 200 * 86400000); fs.utimesSync(mf, old, old);
  const res = await cp.crewRuntime()({ cwds: [], roots: [f.root], days: 1 });
  assert.ok(res.roots[0].tasks.some((t) => t.id === 't-blocked'));
  await f.route('POST', '/control', { enabled: true, workspaces: [{ serverId: 'vm', root: f.root }] }); await f.tick();
  const data = (await f.route('GET', '/status')).data;
  assert.ok(data.servers[0].teams.some((s) => s.taskIds.includes('t-blocked') && s.status === 'blocked' && s.session === ''));
  assert.ok(data.servers[0].teams.some((s) => s.taskIds.includes('t-asleep') && s.status === 'unknown'));
});

test('round evidence observes the tail after large legacy history and ignores token-only edits', async (t) => {
  const f = featureHost(t), file = path.join(f.root, '_crew', 'tasks', 't-asleep', 'tracks', 'W1', 'ROUNDS.tsv');
  const rows = Array.from({ length: 1500 }, (_, i) => `${i + 1}\t2026-11-01T01:00:00Z\t2026-11-01T02:00:00Z\t60\t0\t100\tnew\tcodex\tm\thigh\ttooling`).join('\n') + '\n';
  fs.writeFileSync(file, rows);
  const scan = () => cp.crewRuntime()({ roots: [f.root], cwds: [], days: 3 });
  let result = await scan(); let k = result.roots[0].tasks.find((t) => t.id === 't-asleep').tracks[0];
  assert.equal(k.lastRound.round, '1500'); const evidence = k.lastRound;
  fs.writeFileSync(file, rows.replaceAll('\t100\t', '\t999\t'));
  result = await scan(); k = result.roots[0].tasks.find((t) => t.id === 't-asleep').tracks[0];
  assert.deepEqual(k.lastRound, evidence);
  fs.appendFileSync(file, '1501\t2026-11-02T01:00:00Z\t2026-11-02T02:00:00Z\t60\t1\t100\tfix\tcodex\tm\thigh\ttooling\n');
  result = await scan(); k = result.roots[0].tasks.find((t) => t.id === 't-asleep').tracks[0];
  assert.equal(k.lastRound.round, '1501'); assert.equal(k.lastRound.result, '1');
});

test('local readiness/action helper uses an asynchronous isolated exec transport instead of blocking the backend event loop', async t => {
  const clock = Date.now(), commands = [];
  const remote = { cfg: { id: 'local', local: true }, ready: true, lastPoll: clock, snapshot: { bootId: 'boot-local', sessions: [] },
    exec: async command => { commands.push(command); return { code: 0, out: JSON.stringify({ code: 'audit_account_required', quota: 'unknown' }) }; } };
  const host = { settings: { get: () => ({ enabled: true, workspaces: [{ serverId: 'local', root: '/synthetic-workspace' }] }), set() {} },
    remotes: () => [remote], onSnapshot() {}, route() {}, log() {} };
  const running = cp.register(host, { setInterval: () => ({ unref() {} }), clearInterval() {} }); t.after(() => running.stop());
  const status = await running.facade.status(); assert.equal(status.auditReadiness[0].code, 'audit_account_required');
  assert.equal(commands.length, 1); assert.ok(commands[0].startsWith('node -e ')); assert.ok(commands[0].includes('coordination_platform_unavailable'));
});

test('track popup data: rounds, failure files with time, log tail; tokens masked; nothing outside the task', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tn-track-'))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, '_crew', 'tasks', 'T1', 'tracks', 'W0'); fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ROUNDS.tsv'), '1\t2026-11-09T11:43:06+07:00\t2026-11-09T11:44:11+07:00\t65\t7\t47240\tfix\tcodex\tgpt-6.1-sol\thigh\tbackend\n');
  fs.writeFileSync(path.join(dir, 'FAILED'), 'verify failed; token=glpat-abcdefghijklmnop');
  fs.writeFileSync(path.join(dir, 'logs', 'codex-1.log'), 'line\npassword=hunter22 end');
  const r = await cp.trackRuntime()({ root, task: 'T1', id: 'W0' });
  assert.equal(r.rounds[0].exit, '7'); assert.equal(r.rounds[0].kind, 'fix');
  assert.ok(r.files.FAILED.at > 0); assert.ok(!r.files.FAILED.text.includes('abcdefghijklmnop')); assert.ok(!r.log.includes('hunter22'));
  assert.equal((await cp.trackRuntime()({ root, task: 'T1', id: 'W9' })).error, 'missing');
});
