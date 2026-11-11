'use strict';
// A crew task nobody enrolled (no _crew/nudge.conf line) is given its leader from evidence, kept in Termnest's memory —
// only when exactly one live Claude session in that workspace is proven to drive it.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { CrewSupervisor } = require('../lib/crew-supervisor');
const { leaderEvidenceRuntime } = require('../lib/features/crewpack');

const ROOT = '/home/dev/ws';
const session = (name, n, extra = {}) => ({ name, id: '$' + n, created: 1700000000 + n, paneIds: ['%' + n], aiTool: 'claude', aiPid: 1000 + n,
  aiCwd: ROOT + '/sub', aiSessionId: 'aaaaaaaa-0000-0000-0000-00000000000' + n, aiStatus: { startedAt: 1700000000000 + n, cfg: '.claude' }, ...extra });
function harness({ sessions, workers = [], evidence = {}, nudge = [], autoEnroll = true }) {
  const sup = Object.create(CrewSupervisor.prototype), hostState = { roots: { [ROOT]: { root: ROOT, available: true, nudge, tasks: [{ id: 'T1', status: 'running' }, { id: 'T2', status: 'done' }] } } };
  Object.assign(sup, { now: () => 1e13, state: { autoEnroll, excluded: [] }, evidenceAt: new Map(), evidence: new Map(), inferred: new Map(), hints: new Map(), enabled: () => true,
    host: () => hostState, io: { leaderEvidence: async () => evidence } });
  const r = { cfg: { id: 'vm' }, snapshot: { bootId: 'b', sessions, workers } };
  const h = { sup, run: () => sup.inferLeaders(r), get enrolled() { return (sup.inferred.get('vm') || []).map((x) => ({ root: x.root, taskId: x.task, session: sessions.find((q) => q.paneIds[0] === x.pane).name, why: x.why })); } };
  return h;
}

test('the session running crew-dispatch for the task becomes its leader', async () => {
  const h = harness({ sessions: [session('Lead', 1), session('Other', 2)], workers: [{ task: 'T1', owner: { name: 'Lead' } }] });
  await h.run();
  assert.deepEqual(h.enrolled, [{ root: ROOT, taskId: 'T1', session: 'Lead', why: 'dispatch' }]);
});

test('else the one chat that created it (crew-task.sh init) wins over chats that only mention it', async () => {
  const h = harness({ sessions: [session('A', 1), session('B', 2)], evidence: { T1: { A: { init: false, used: 3 }, B: { init: true, used: 1 } } } });
  await h.run();
  assert.deepEqual(h.enrolled.map((x) => [x.session, x.why]), [['B', 'chat_init']]);
});

test('ambiguous, already enrolled, closed, auto-enrol off: nothing is written', async () => {
  for (const opts of [
    { sessions: [session('A', 1), session('B', 2)], evidence: { T1: { A: { init: false, used: 1 }, B: { init: false, used: 2 } } } },
    { sessions: [session('A', 1)], workers: [{ task: 'T1', owner: { name: 'A' } }], nudge: [['%9', 'T1']] },
    { sessions: [session('A', 1)], workers: [{ task: 'T1', owner: { name: 'A' } }], autoEnroll: false },
    { sessions: [session('A', 1, { paneIds: ['%1', '%2'] })], workers: [{ task: 'T1', owner: { name: 'A' } }] },
    { sessions: [session('A', 1, { aiCwd: '/elsewhere' })], workers: [{ task: 'T1', owner: { name: 'A' } }] },
  ]) { const h = harness(opts); await h.run(); assert.deepEqual(h.enrolled, [], JSON.stringify(opts)); }
});

test('chat evidence: reads only the given transcripts and returns counts, never text', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-ev-')), old = process.env.HOME;
  try {
    const dir = path.join(home, '.claude', 'projects', '-home-dev-ws'); fs.mkdirSync(dir, { recursive: true });
    const sid = 'aaaaaaaa-0000-0000-0000-000000000001';
    fs.writeFileSync(path.join(dir, sid + '.jsonl'), [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', input: { command: 'bash scripts/crew/crew-task.sh init 20261110-cttb-cham-1-man "CTTB"' } }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', input: { command: 'bash scripts/crew/crew-dispatch.sh --task 20261110-cttb-cham-1-man --track R1' } }] } }),
      JSON.stringify({ type: 'user', message: { content: 'see 20261110-cttb-cham-1-man-old too' } }),
    ].join('\n'));
    process.env.HOME = home;
    const out = await leaderEvidenceRuntime()({ taskIds: ['20261110-cttb-cham-1-man', 'other-task'], sessions: [{ name: 'Display-Program', sessionId: sid, config: '.claude' }, { name: 'x', sessionId: '../../etc', config: '.claude' }] });
    assert.deepEqual(out, { evidence: { '20261110-cttb-cham-1-man': { 'Display-Program': { init: true, used: 2 } } } });
  } finally { process.env.HOME = old; fs.rmSync(home, { recursive: true, force: true }); }
});

test('the found leader is merged into the root the UI and the hub read, marked inferred', async () => {
  const h = harness({ sessions: [session('Lead', 1)], workers: [{ task: 'T1', owner: { name: 'Lead' } }] });
  await h.run();
  const [root] = h.sup.rootsWithLeaders('vm');
  assert.deepEqual(root.nudge, [['%1', 'T1']]); assert.deepEqual(root.inferred, ['T1']);
});

test('the crew kit registration (orchestrator-register → orchestrator.json) names the leader pane like nudge.conf', async () => {
  const { crewRuntime } = require('../lib/features/crewpack');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-orch-'));
  try {
    const dir = path.join(root, '_crew', 'tasks', '20261110-cttb-cham-1-man'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'MANIFEST.md'), '---\ntask_id: 20261110-cttb-cham-1-man\ntitle: "CTTB"\nstatus: planning\ntracks: [{ id: W0, state: done, executor: codex }]\n---\n');
    fs.writeFileSync(path.join(dir, 'orchestrator.json'), JSON.stringify({ schema: 1, provider: 'claude', tmux: { session: 'Display-Program', pane: '%12' } }));
    const out = await crewRuntime()({ roots: [root], cwds: [], days: 3 });
    assert.deepEqual(out.roots[0].nudge, [['%12', '20261110-cttb-cham-1-man']]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a track the leader did by hand (still pending in the manifest) shows as coded once its STATUS.md says DONE', async () => {
  const { crewRuntime } = require('../lib/features/crewpack');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-hand-'));
  try {
    const dir = path.join(root, '_crew', 'tasks', 'T8'); fs.mkdirSync(path.join(dir, 'tracks', 'R4'), { recursive: true }); fs.mkdirSync(path.join(dir, 'tracks', 'R5'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'MANIFEST.md'), '---\ntask_id: T8\ntitle: "R8"\nstatus: planning\ntracks: [{ id: R4, state: pending, executor: codex }, { id: R5, state: pending, executor: codex }]\n---\n');
    fs.writeFileSync(path.join(dir, 'tracks', 'R4', 'STATUS.md'), '# R4 — DONE\nleader ran the offline measurement by hand\n');
    const out = await crewRuntime()({ roots: [root], cwds: [], days: 3 });
    const tr = Object.fromEntries(out.roots[0].tasks[0].tracks.map((k) => [k.id, k.verdict]));
    assert.deepEqual(tr, { R4: 'coded', R5: '' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('when no leader is found the hub gets the reason: ambiguous (with names), no evidence, no session', async () => {
  const amb = harness({ sessions: [session('A', 1), session('B', 2)], evidence: { T1: { A: { init: false, used: 1 }, B: { init: false, used: 2 } } } });
  await amb.run(); assert.deepEqual(amb.sup.rootsWithLeaders('vm')[0].leaderHints, { T1: { code: 'ambiguous', sessions: ['A', 'B'] } });
  const none = harness({ sessions: [session('A', 1)] });
  await none.run(); assert.deepEqual(none.sup.rootsWithLeaders('vm')[0].leaderHints, { T1: { code: 'no_evidence' } });
  const away = harness({ sessions: [session('A', 1, { aiCwd: '/elsewhere' })] });
  await away.run(); assert.deepEqual(away.sup.rootsWithLeaders('vm')[0].leaderHints, { T1: { code: 'no_session' } });
});

test('hub: an enrolled task with NO tracks recorded (leader doing the parts by hand) still shows its leader', () => {
  const hub = require('../lib/features/opshub');
  const now = Date.now();
  const r = { cfg: { id: 'u3', name: 'dev-ubuntu-03' }, ready: true, lastPoll: now, snapshot: { hostname: 'dev-ubuntu-03', sessions: [{ name: 'Display-Program', paneIds: ['%1'], aiTool: 'claude', aiStatus: { tool: 'claude', status: 'busy', at: now } }] } };
  const crew = [{ root: '/w', nudge: [['%1', 'C1']], tasks: [{ id: 'C1', title: 'CTTB', status: 'dispatched', activeAt: now - 60000, tracks: [] }] }];
  const fleet = hub.buildFleet([r], () => crew, now);
  assert.equal(fleet.tasks.find((t) => t.id === 'C1').leader, 'Display-Program');
});

test('watching only (autopilot off), crew evidence read every 2 min stays current for 3 min; autopilot on keeps 1 min', () => {
  const sup = Object.create(CrewSupervisor.prototype);
  sup.enabled = () => false; sup.coordinatorRecorded = false; assert.equal(sup.evidenceBudget(), 180000);
  sup.enabled = () => true; sup.coordinatorRecorded = true; assert.equal(sup.evidenceBudget(), 60000);
});

test('with the Ops hub present the older per-team AI audits (tn-ops-audit-… sessions) are not started', () => {
  const src = fs.readFileSync(path.join(__dirname, '../lib/features/crewpack.js'), 'utf8');
  assert.match(src, /hubAudits: \(\) => \{ try \{ return !!host\.service\?\.\('opshub'\); \}/);
});
