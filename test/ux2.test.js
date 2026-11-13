'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const U = require('../public/features/ux2');

const S = (key, state, o = {}) => Object.assign({ key, name: key.split('/')[1], state, crew: false, host: 'srv', path: '/data/p/' + key, cmd: 'bash' }, o);

test('monogram: two letters, hue from the fixed palette and stable for a name', () => {
  assert.equal(U.initials('fes-api'), 'FA');
  assert.equal(U.initials('termnest'), 'TE');
  assert.equal(U.initials(''), '?');
  for (const n of ['a', 'fes', 'xspire-workspaces', 'Codex_1']) { assert.ok(U.HUES.includes(U.hue(n)), n); assert.equal(U.hue(n), U.hue(n)); }
  assert.deepEqual([...U.HUES], [212, 262, 330, 24, 160, 190, 285, 45]);
  assert.match(U.monoHtml('fes-api'), /^<span class="mono av-mono" style="--h:\d+">FA<\/span>$/);
  assert.ok(!U.monoHtml('<b>').includes('<b>'), 'names are escaped');
});

test('priority grouping: pinned, needs you, running crews, running, resting', () => {
  const l = [S('s/a', 'idle'), S('s/b', 'run'), S('s/c', 'run', { crew: true }), S('s/d', 'wait'), S('s/e', 'run'), S('s/f', 'idle')];
  const g = U.groupSessions(l, 'prio', ['s/e']);
  assert.deepEqual(g.map((x) => x.id), ['pin', 'need', 'crewrun', 'run', 'idle']);
  assert.deepEqual(g.map((x) => x.items.map((i) => i.key)), [['s/e'], ['s/d'], ['s/c'], ['s/b'], ['s/a', 's/f']]);
  assert.deepEqual(U.groupSessions(l, 'nonsense', []).map((x) => x.id), ['need', 'crewrun', 'run', 'idle'], 'an unknown mode is the default');
});

test('empty groups are dropped and every session lands in exactly one group, in every mode', () => {
  const l = [S('s/a', 'idle'), S('s/b', 'run', { cmd: 'claude', crew: true }), S('s/c', 'wait', { cmd: 'codex', host: 'other', path: '' })];
  for (const m of U.MODES) {
    const g = U.groupSessions(l, m, []);
    assert.ok(g.every((x) => x.items.length), m);
    assert.deepEqual(g.flatMap((x) => x.items.map((i) => i.key)).sort(), ['s/a', 's/b', 's/c'], m);
  }
});

test('project, host, crew, tool and status modes', () => {
  assert.equal(U.projectOf('/data/thanhlg/xspire-workspaces/'), 'xspire-workspaces');
  assert.equal(U.projectOf('C:\\work\\termnest'), 'termnest');
  assert.equal(U.projectOf('/'), ''); assert.equal(U.projectOf(''), ''); assert.equal(U.projectOf(undefined), '');
  const l = [S('s/a', 'idle', { path: '/x/zeta' }), S('s/b', 'run', { path: '/x/alpha' }), S('s/c', 'wait', { path: '/' })];
  const p = U.groupSessions(l, 'proj', []);
  assert.deepEqual(p.map((g) => g.text || g.key), ['alpha', 'zeta', 'ux2.h_other']);
  assert.deepEqual(U.groupSessions(l, 'stat', []).map((g) => g.id), ['wait', 'run', 'idle']);
  const t = U.groupSessions([S('s/a', 'run', { cmd: 'claude --resume' }), S('s/b', 'run', { tool: 'codex' }), S('s/c', 'run')], 'tool', []);
  assert.deepEqual(t.map((g) => g.id), ['t:Claude', 't:Codex', 't:other']);
  assert.deepEqual(U.groupSessions([S('s/a', 'run', { host: 'M1' }), S('s/b', 'run', { host: 'M2' })], 'host', []).map((g) => g.text), ['M1', 'M2']);
});

test('pins and mode persist in localStorage', () => {
  const mem = {}; globalThis.localStorage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); } };
  assert.equal(U.getMode(), 'prio');
  U.setMode('proj'); assert.equal(U.getMode(), 'proj'); U.setMode('bogus'); assert.equal(U.getMode(), 'proj');
  assert.deepEqual(U.togglePin('s/a'), ['s/a']); assert.deepEqual(U.togglePin('s/b'), ['s/b', 's/a']);
  assert.deepEqual(U.togglePin('s/a'), ['s/b']); assert.deepEqual(U.getPins(), ['s/b']);
  mem['tw-pins'] = '{bad'; assert.deepEqual(U.getPins(), []);
});
