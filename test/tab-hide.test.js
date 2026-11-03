'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { create, KEY } = require('../public/tab-hide');
const store = (init) => { const m = new Map(init ? [[KEY, init]] : []); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }; };

test('hide, show and restore-all keep a per-user list in storage', () => {
  const s = store(); const t = create(s);
  t.hide('h1/a'); t.hide('h1/b'); t.hide('h1/a');
  assert.deepEqual(t.list(), ['h1/b', 'h1/a']); assert.ok(t.isHidden('h1/a'));
  t.show('h1/a'); assert.ok(!t.isHidden('h1/a'));
  assert.deepEqual(JSON.parse(s.m.get(KEY)), ['h1/b']);
  t.showAll(); assert.deepEqual(t.list(), []);
});

test('a new instance reads what was saved, and ignores corrupt data', () => {
  assert.deepEqual(create(store(JSON.stringify(['h/x', 7, null]))).list(), ['h/x']);
  assert.deepEqual(create(store('{oops')).list(), []);
  assert.deepEqual(create(store('{"a":1}')).list(), []);
});

test('pruning keeps whatever the caller says still matters', () => {
  const t = create(store(JSON.stringify(['h/a', 'h/b', 'h/c'])));
  t.prune((k) => k === 'h/b'); assert.deepEqual(t.list(), ['h/b']);
  t.prune(() => true); assert.deepEqual(t.list(), ['h/b']);
});

test('storage failures never break closing a tab', () => {
  const t = create({ getItem() { throw new Error('denied'); }, setItem() { throw new Error('full'); } });
  t.hide('h/a'); assert.ok(t.isHidden('h/a'));
});

test('the list is bounded', () => {
  const t = create(store());
  for (let i = 0; i < 300; i++) t.hide('h/' + i);
  assert.equal(t.list().length, 200);
});
