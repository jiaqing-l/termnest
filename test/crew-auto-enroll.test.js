'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CrewSupervisor } = require('../lib/crew-supervisor');
const clone = v => JSON.parse(JSON.stringify(v));

// One VM, two leaders in one workspace. Crew's own nudge.conf says which pane runs which task.
function fixture(initial = {}, ioOverrides = {}) {
  const start = 1800000000000; let now = start, serial = 0;
  let disk = { enabled: true, autoRecovery: true, intervalMinutes: 30, autoEnroll: true, ...initial };
  const leader = (name, pane, pid) => ({ name, id: '$' + pane, created: 100 + pane, paneIds: ['%' + pane], path: '/ws', aiPid: pid,
    aiStatus: { tool: 'claude', status: 'busy', cfg: '.claude-team', startedAt: start - 3600000, at: start } });
  const r = { cfg: { id: 'vm0' }, ready: true, lastPoll: now, snapshot: { bootId: 'boot', workers: [], sessions: [leader('crew-a', 1, 701), leader('crew-b', 2, 702)] } };
  const task = (id, status = 'executing') => ({ id, title: id, status, blocked: '', heartbeat: {},
    tracks: [{ id: 'W1', state: 'running', rounds: 1, fixRounds: 0, lastRound: { round: '1', result: '', kind: 'new' } }] });
  const data = { roots: [{ root: '/ws', nudge: [['%1', 'task-a'], ['%2', 'task-b'], ['%9', 'task-gone']], tasks: [task('task-a'), task('task-b'), task('task-old', 'done')] }] };
  const sent = [], accounts = [];
  const io = {
    scan: async () => clone(data),
    validateLeader: async (_, l) => ({ processStart: 'ps-' + l.identity.agentPid }),
    coordinate: async () => ({ code: 'coordination_owner', token: { epoch: 1 } }),
    auditReady: async (_, a) => { if (a.confirmation) accounts.push(clone(a)); return { code: a.confirmation ? 'audit_account_registration_required' : 'audit_ready', accountRef: 'a'.repeat(64) }; },
    open: async () => {}, send: async () => {}, report: async () => ({ code: 'report_missing' }), revoke: async () => {},
    recover: async (_, s, l) => { sent.push({ session: s.name, taskIds: [...l.taskIds], pid: s.aiPid }); s.aiStatus.status = 'busy'; s.aiStatus.at = now; return { code: 'action_delivered', receipt: { delivery: 'delivered' } }; },
    ...ioOverrides,
  };
  const core = new CrewSupervisor({ load: () => clone(disk), save: s => { disk = clone(s); }, io, now: () => now, newId: () => 'tn-' + (++serial).toString(16).padStart(32, '0') });
  return {
    core, r, data, sent, accounts, get disk() { return disk; },
    session: name => r.snapshot.sessions.find(s => s.name === name),
    async tick(ms = 15000) { now += ms; r.lastPoll = now; await core.tick([r]); },
    idle(name) { const s = r.snapshot.sessions.find(s => s.name === name); s.aiStatus.status = 'idle'; s.aiStatus.at = now; },
  };
}

test('auto mode enrolls leaders from crew nudge.conf with their open tasks only', async () => {
  const f = fixture();
  await f.tick(); await f.tick();
  const found = f.core.status([f.r]).servers[0].discovered;
  assert.deepEqual(found.map(d => [d.session, d.taskIds, d.excluded]), [['crew-a', ['task-a'], false], ['crew-b', ['task-b'], false]]);
  const teams = f.core.status([f.r]).servers[0].teams;
  assert.deepEqual(teams.filter(t => t.session).map(t => t.session).sort(), ['crew-a', 'crew-b']);
  assert.equal(teams.some(t => t.reason.code === 'registration_required'), false);
});

test('an idle auto-enrolled leader with open work is reminded once, also at night', async () => {
  const f = fixture();
  await f.tick(); await f.tick();
  f.idle('crew-a');
  for (let i = 0; i < 30; i++) await f.tick(30000); // 15 minutes, crossing no quiet-hour rule
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0], { session: 'crew-a', taskIds: ['task-a'], pid: 701 });
});

test('a restarted Claude (new pid) stays enrolled without any owner action', async () => {
  const f = fixture();
  await f.tick(); await f.tick();
  const s = f.session('crew-a'); s.aiPid = 801; s.aiStatus.startedAt += 5000;
  await f.tick(); await f.tick();
  f.idle('crew-a');
  for (let i = 0; i < 30; i++) await f.tick(30000);
  assert.deepEqual(f.sent.map(x => [x.session, x.pid]), [['crew-a', 801]]);
});

test('an excluded leader is listed but never reminded', async () => {
  const f = fixture({ excluded: [{ serverId: 'vm0', session: 'crew-b' }] });
  await f.tick(); await f.tick();
  assert.equal(f.core.status([f.r]).servers[0].discovered.find(d => d.session === 'crew-b').excluded, true);
  f.idle('crew-b');
  for (let i = 0; i < 30; i++) await f.tick(30000);
  assert.equal(f.sent.length, 0);
});

test('without auto mode nothing is enrolled implicitly (previous behaviour)', async () => {
  const f = fixture({ autoEnroll: false });
  await f.tick(); await f.tick();
  f.idle('crew-a');
  for (let i = 0; i < 30; i++) await f.tick(30000);
  assert.equal(f.sent.length, 0);
});

test('a leader whose agent status is unknown is never treated as idle', async () => {
  const f = fixture();
  await f.tick(); await f.tick();
  delete f.session('crew-a').aiStatus;
  for (let i = 0; i < 30; i++) await f.tick(30000);
  assert.equal(f.sent.length, 0);
});

test('auto mode binds the audit account to the profile the leaders use, once', async () => {
  const f = fixture();
  await f.tick(); await f.tick(); await f.tick();
  assert.equal(f.accounts.length, 1);
  assert.equal(f.accounts[0].config, '.claude-team');
  assert.deepEqual(f.disk.workspaces, [{ serverId: 'vm0', root: '/ws', auditConfig: '.claude-team', auditAccount: 'a'.repeat(64) }]);
});

test('control accepts autoEnroll and excluded and rejects malformed exclusions', async () => {
  const f = fixture({ autoEnroll: false });
  const out = await f.core.control({ enabled: true, autoRecovery: true, autoEnroll: true, excluded: [{ serverId: 'vm0', session: 'crew-a' }] }, [f.r]);
  assert.equal(out.autoEnroll, true); assert.deepEqual(out.excluded, [{ serverId: 'vm0', session: 'crew-a' }]);
  await assert.rejects(f.core.control({ enabled: true, excluded: [{ serverId: 'vm0', session: 'bad name;' }] }, [f.r]), /invalid_control/);
});

test('open tasks without a leader are split into recent and dormant (untouched for over 2 days)', async () => {
  const f = fixture();
  const start = 1800000000000;
  f.data.roots[0].tasks.push({ id: 'task-fresh', title: '', status: 'executing', blocked: '', heartbeat: {}, tracks: [], activeAt: start },
    { id: 'task-stale', title: '', status: 'planning', blocked: '', heartbeat: {}, tracks: [], activeAt: start - 3 * 86400000 });
  await f.tick(); await f.tick();
  const teams = f.core.status([f.r]).servers[0].teams.filter(t => !t.session);
  const by = Object.fromEntries(teams.map(t => [t.taskIds[0], t.dormant]));
  assert.equal(by['task-fresh'], false); assert.equal(by['task-stale'], true);
  assert.equal(f.core.status([f.r]).servers[0].teams.find(t => t.session === 'crew-a').dormant, false);
});
