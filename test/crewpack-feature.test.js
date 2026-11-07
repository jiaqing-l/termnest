'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const cp = require('../lib/features/crewpack');
const wd = require('../lib/features/watchdog');
const detect = require('../lib/crew-detect');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-crewpack-'));
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
