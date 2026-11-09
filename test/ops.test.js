'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const ops = require('../lib/ops');

const NOW = 1_800_000_000_000;
const pack = ops.cleanPack({});
function run(sessions, extra = {}) {
  const memo = extra.memo || {};
  return ops.evaluate({ server: 'm1', snapshot: { cpu: 10, ram: 20, sessions, ...(extra.snap || {}) }, online: extra.online !== false, lost: extra.lost || [], pack: extra.pack || pack, memo, now: extra.now || NOW, nudges: extra.nudges || [] });
}
// A Claude pane whose own session file says `status`, last changed `mins` ago.
const claude = (status, mins, o = {}) => ({ name: 'a', created: 1, cmd: 'claude', state: 'wait', activityAge: 5, lines: ['❯ '], aiStatus: { tool: 'claude', status, at: NOW - mins * 60000, waitingFor: '', ...(o.st || {}) }, ...o });
const rules = (list) => list.map((f) => f.rule).sort();

test('working / waiting / done come only from the status the agent writes, timed from that file', () => {
  assert.deepEqual(rules(run([claude('busy', 90, { activityAge: 9000 })])), []);
  assert.deepEqual(run([claude('waiting', 4, { st: { waitingFor: 'permission' } })]).map((f) => [f.rule, f.source, f.params[0]]), [['asking', 'status', 'permission']]);
  assert.deepEqual(run([claude('idle', 2)]).map((f) => [f.rule, f.source]), [['finished', 'status']]);
  // Opened and never given work: not "finished", and never nudged to continue however long it sits there.
  assert.deepEqual(rules(run([claude('idle', 2, { st: { fresh: true } })])), []);
  assert.deepEqual(rules(run([claude('idle', 500, { st: { fresh: true } })])), []);
  const d = run([claude('idle', 50)]);
  assert.deepEqual(d.map((f) => [f.rule, f.params[0], f.template]), [['dormant', 50, 'continue']]);
  assert.ok(d[0].since >= 50 * 60);
});

test('screen text alone never makes a verdict: no status file means "unknown", even with a question or an error on screen', () => {
  const noFile = { name: 'b', created: 1, cmd: 'claude', state: 'wait', asking: true, activityAge: 4000, lines: ['Error: boom', 'Do you want to proceed?', '❯ 1. Yes', 'usage limit reached'] };
  const m = {}; run([noFile], { memo: m });
  assert.deepEqual(rules(run([noFile], { memo: m, now: NOW + 61000 })), ['unknown']);
  assert.equal(ops.canSend(noFile), 'unknown');
});

test('nothing is typed unless the agent itself says idle at its own prompt', () => {
  assert.equal(ops.canSend(claude('waiting', 1)), 'asking');
  assert.equal(ops.canSend(claude('busy', 1)), 'busy');
  assert.equal(ops.canSend(claude('idle', 1, { st: { parked: true } })), 'hub');
  assert.equal(ops.canSend({ name: 's', cmd: 'bash', state: 'idle' }), 'no-agent');
  assert.equal(ops.canSend(null), 'gone');
  assert.equal(ops.canSend(claude('idle', 40)), '');
});

test("a pane whose conversation was moved to Claude's background list is not reported as done", () => {
  assert.deepEqual(rules(run([claude('idle', 1300, { st: { parked: true } })])), []);
});

test('background Claude sessions are listed only when they wait for you', () => {
  const out = run([], { snap: { bgAgents: [{ name: 'Fix PG', status: 'waiting', at: NOW - 600000 }, { name: 'Done', status: 'idle', at: NOW }] } });
  assert.deepEqual(out.map((f) => [f.rule, f.session]), [['asking', 'bg:Fix PG']]);
});

test('Codex: an aborted turn from its rollout is reported', () => {
  const codex = { name: 'c', created: 1, cmd: 'codex', aiStatus: { tool: 'codex', status: 'aborted', at: NOW - 120000 } };
  assert.deepEqual(rules(run([codex])), ['aborted']);
});

test('process and machine facts: agent gone from its pane, lost after reboot, offline, overload', () => {
  const memo = {};
  run([claude('busy', 1)], { memo });
  assert.deepEqual(run([{ name: 'a', created: 1, cmd: 'zsh', state: 'idle' }], { memo }).map((f) => [f.rule, f.source]), [['exited', 'process']]);
  assert.deepEqual(rules(run([], { lost: ['x'] })), ['lost']);
  const m2 = {}; run([], { online: false, memo: m2 });
  assert.deepEqual(rules(run([], { online: false, memo: m2, now: NOW + 3 * 60000 })), ['offline']);
  const m3 = {}; run([], { memo: m3, snap: { cpu: 97.4 } });
  assert.deepEqual(run([], { memo: m3, snap: { cpu: 97.4 }, now: NOW + 6 * 60000 }).map((f) => f.params), [[97, 20]]);
});

test('a nudge is confirmed only by the status file changing after it', () => {
  const n = { at: NOW - 60000, verified: null };
  assert.equal(ops.verify(n, claude('busy', 0), NOW, 3), true);
  assert.equal(ops.verify(n, claude('idle', 0), NOW, 3), true);
  assert.equal(ops.verify(n, claude('idle', 5), NOW, 3), null);
  assert.equal(ops.verify(n, claude('busy', 5), NOW, 3), null);
  assert.equal(ops.verify(n, claude('idle', 5), NOW + 3 * 60000, 3), false);
  assert.equal(ops.verify(n, { name: 'x', cmd: 'claude' }, NOW + 3 * 60000, 3), false);
  assert.ok(rules(run([claude('idle', 5)], { nudges: [{ ...n, server: 'm1', session: 'a', verified: false }] })).includes('unheard'));
});

test('only "dormant" can carry a message; a team pack adds labelled text matches only', () => {
  assert.equal(ops.cleanPack({ rules: { asking: { level: 'suggest' } } }).rules.asking.level, 'notify');
  const p = ops.cleanPack({ name: 'team-x', custom: [{ id: 'rel', title: 'Release script started', match: 'release\\.sh', level: 'suggest' }, { id: 'x', title: 't', match: '(' }] });
  assert.deepEqual(p.custom.map((c) => [c.id, c.level]), [['rel', 'notify']]);
  const out = run([claude('busy', 1, { lines: ['./release.sh --prod'] })], { pack: p });
  assert.deepEqual(out.map((f) => [f.rule, f.source, f.params[0]]), [['custom', 'text', 'Release script started']]);
});

test('the core pack has no project-specific rule', () => {
  const text = JSON.stringify(ops.DEFAULT_PACK).toLowerCase();
  for (const word of ['xspire', 'crew', 'dotnet', 'gitlab', 'devkit']) assert.ok(!text.includes(word), word);
});

test('Claude background jobs marked blocked are reported with what Claude says it needs; old or finished ones are not', () => {
  const day = 86400000, jobs = [
    { id: 'a1', name: 'Lỗi nghiệp vụ PG cũ', state: 'working', tempo: 'blocked', needs: 'send a prompt to start', at: NOW - 3600000 },
    { id: 'b2', name: 'Old', state: 'blocked', tempo: 'blocked', needs: 'x', at: NOW - 30 * day },
    { id: 'c3', name: 'Run', state: 'working', tempo: 'active', needs: '', at: NOW },
    { id: 'd4', name: 'Done', state: 'done', tempo: 'idle', needs: '', at: NOW },
  ];
  const out = run([], { snap: { jobs } });
  assert.deepEqual(out.map((f) => [f.rule, f.session, f.params[1], f.source]), [['bgjob', 'job:Lỗi nghiệp vụ PG cũ', 'send a prompt to start', 'status']]);
  assert.equal(run([], { snap: { jobs }, pack: ops.cleanPack({ rules: { bgjob: { days: 60 } } }) }).length, 2);
});

test('built-in nudge texts follow the reader language; a team template stays as written', () => {
  const p = ops.cleanPack({ templates: { ship: 'Chạy checklist phát hành.' } });
  assert.deepEqual(Object.keys(p.templates), ['ship']);
  const vi = ops.withTemplates(p, { continue: 'Hãy tiếp tục…' });
  assert.equal(vi.templates.continue, 'Hãy tiếp tục…');
  assert.equal(vi.templates.ship, 'Chạy checklist phát hành.');
  assert.equal(ops.withTemplates(p, {}).templates.continue, ops.CORE_TEMPLATES.continue);
  assert.equal(run([claude('idle', 50)])[0].template, 'continue');
});

test('a parked pane reports the background conversation it shows, but never offers a nudge', () => {
  const parked = claude('idle', 1300, { st: { parked: true, job: { status: 'idle', at: NOW - 50 * 60000 } } });
  const out = run([parked]);
  assert.deepEqual(out.map((f) => [f.rule, f.level, f.template]), [['dormant', 'notify', undefined]]);
  assert.equal(ops.canSend(parked), 'hub');
  assert.deepEqual(rules(run([claude('idle', 1, { st: { parked: true, job: { status: 'waiting', at: NOW } } })])), ['asking']);
});

test('automatic messages: only for a rule with a message, inside the limits, once per idle period, never in quiet hours', () => {
  const p = ops.cleanPack({ rules: { dormant: { level: 'auto' }, asking: { level: 'auto' } }, auto: { perHour: 2, quietFrom: '23:00', quietTo: '07:00' } });
  assert.equal(p.rules.asking.level, 'notify');
  const s = claude('idle', 50);
  const f = run([s], { pack: p })[0];
  assert.deepEqual([f.rule, f.level, f.template], ['dormant', 'auto', 'continue']);
  const at = (h) => new Date(2026, 10, 7, h, 0).getTime();
  const sess = { ...s, aiStatus: { ...s.aiStatus, at: at(14) - 50 * 60000 } };
  assert.equal(ops.autoGate(f, sess, p, [], at(14)), '');
  assert.equal(ops.autoGate(f, sess, p, [], at(23)), 'quiet');
  assert.equal(ops.autoGate(f, sess, p, [], at(3)), 'quiet');
  // one message per idle period: a send after the period began holds back the next one
  assert.equal(ops.autoGate(f, sess, p, [{ server: 'm1', session: 'a', at: at(14) - 60000, why: 'auto' }], at(14)), 'once');
  assert.equal(ops.autoGate(f, { ...sess, aiStatus: { ...sess.aiStatus, status: 'busy' } }, p, [], at(14)), 'busy');
  assert.equal(ops.autoGate(f, { ...sess, aiStatus: { ...sess.aiStatus, status: 'waiting' } }, p, [], at(14)), 'asking');
  assert.equal(ops.autoGate({ ...f, level: 'suggest' }, sess, p, [], at(14)), 'not-auto');
  assert.equal(ops.cleanPack({ auto: { perHour: 99, quietFrom: '25:00' } }).auto.perHour, 10);
  assert.equal(ops.cleanPack({ auto: { quietFrom: '25:00' } }).auto.quietFrom, '23:00');
});
