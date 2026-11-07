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
const agent = (o) => ({ name: 'a', created: 1, cmd: 'claude', state: 'wait', asking: false, activityAge: 10, lines: ['❯ '], ...o });
const rules = (list) => list.map((f) => f.rule).sort();

test('a pending question is only reported, and a pack cannot turn it into a suggestion', () => {
  const memo = {};
  run([agent({ asking: true })], { memo });
  const later = run([agent({ asking: true })], { memo, now: NOW + 4 * 60000 });
  assert.deepEqual(rules(later), ['asking']);
  assert.equal(later[0].template, undefined);
  assert.equal(ops.cleanPack({ rules: { asking: { level: 'suggest' } } }).rules.asking.level, 'notify');
  assert.equal(ops.canSend(agent({ asking: true })), 'asking');
});

test('a waiting agent is finished at first and dormant with a one-click nudge after the threshold', () => {
  const memo = {};
  run([agent()], { memo });
  assert.deepEqual(rules(run([agent()], { memo, now: NOW + 2 * 60000 })), ['finished']);
  const d = run([agent({ activityAge: 31 * 60 })], { memo });
  assert.deepEqual(rules(d), ['dormant']);
  assert.equal(d[0].template, 'continue');
  assert.equal(ops.canSend(agent()), '');
});

test('screen signals: error, quota, low context, loop', () => {
  const memo = {};
  const err = agent({ name: 'e', lines: ['Error: build failed', '❯ '] });
  const quota = agent({ name: 'q', lines: ['You have hit your limit · resets 5pm'] });
  const ctx = agent({ name: 'c', state: 'run', lines: ['working', 'Context left until auto-compact: 8%'] });
  const loop = agent({ name: 'l', state: 'run', lines: Array(6).fill('Retrying request to the server now') });
  run([err, quota, ctx, loop], { memo });
  const out = run([err, quota, ctx, loop], { memo, now: NOW + 6 * 60000 });
  assert.deepEqual(rules(out), ['context', 'error', 'finished', 'loop', 'quota']);
  assert.equal(out.find((f) => f.rule === 'context').params[0], 8);
});

test('an agent that left its session, a lost session, an offline machine and overload', () => {
  const memo = {};
  run([agent()], { memo });
  assert.deepEqual(rules(run([agent({ cmd: 'zsh', state: 'idle' })], { memo })), ['exited']);
  assert.deepEqual(rules(run([], { lost: ['x'] })), ['lost']);
  const m2 = {}; run([], { online: false, memo: m2 });
  assert.deepEqual(rules(run([], { online: false, memo: m2, now: NOW + 3 * 60000 })), ['offline']);
  const m3 = {}; run([], { memo: m3, snap: { cpu: 97 } });
  assert.deepEqual(rules(run([], { memo: m3, snap: { cpu: 97 }, now: NOW + 6 * 60000 })), ['overload']);
});

test('a plain shell is never nudged and a working session is left alone', () => {
  assert.equal(ops.canSend({ name: 's', cmd: 'bash', state: 'idle' }), 'no-agent');
  assert.equal(ops.canSend(agent({ state: 'run' })), 'busy');
  assert.equal(ops.canSend(null), 'gone');
});

test('a nudge is verified by activity after it, and an unheard one is reported once', () => {
  const n = { at: NOW, server: 'm1', session: 'a', verified: null };
  assert.equal(ops.verify(n, agent({ activityAge: 0 }), NOW + 5000, 3), true);
  assert.equal(ops.verify(n, agent({ activityAge: 60 }), NOW + 60000, 3), null);
  assert.equal(ops.verify(n, agent({ activityAge: 300 }), NOW + 4 * 60000, 3), false);
  const out = run([agent({ activityAge: 300 })], { nudges: [{ ...n, verified: false }] });
  assert.ok(rules(out).includes('unheard'));
});

test('a shared pack keeps only valid custom rules and templates, and they match screen text', () => {
  const p = ops.cleanPack({ name: 'team-x', templates: { ship: 'Run the release checklist.', bad: 'a\u0007b' },
    custom: [{ id: 'migr', title: 'Migration on a shared DB', match: 'database update', severity: 'urgent' }, { id: 'x', title: 't', match: '(' }, { id: '../a', title: 't', match: 'a' }] });
  assert.equal(p.name, 'team-x');
  assert.deepEqual(p.custom.map((c) => c.id), ['migr']);
  assert.ok(p.templates.ship && !p.templates.bad && p.templates.continue);
  const out = run([agent({ state: 'run', lines: ['dotnet ef database update'] })], { pack: p });
  assert.equal(out.find((f) => f.rule === 'custom').params[0], 'Migration on a shared DB');
});

test('the core pack has no project-specific rule', () => {
  const text = JSON.stringify(ops.DEFAULT_PACK);
  for (const word of ['xspire', 'crew', 'dotnet', 'gitlab', 'devkit']) assert.ok(!text.toLowerCase().includes(word), word);
});
