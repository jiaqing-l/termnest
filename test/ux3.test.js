'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const U = require('../public/features/ux3.js');

test('fuzzy: diacritics folded, substring beats subsequence, no match is -1', () => {
  assert.equal(U.fuzzy('phien', 'Phiên mới') > 0, true);
  assert.ok(U.fuzzy('pm', 'Phiên mới') > 0);
  assert.ok(U.fuzzy('tok', 'Token AI') > U.fuzzy('tai', 'Token AI'));
  assert.equal(U.fuzzy('zzz', 'Token AI'), -1);
  assert.equal(U.fuzzy('', 'anything'), 0);
});

test('rank: best first, hint-only match below label match, empty query keeps order', () => {
  const items = [{ label: 'Cài đặt' }, { label: 'dev-ubuntu', hint: 'cai' }, { label: 'Cài file' }];
  assert.deepEqual(U.rank(items, '').map((x) => x.label), ['Cài đặt', 'dev-ubuntu', 'Cài file']);
  const r = U.rank(items, 'cai').map((x) => x.label);
  assert.equal(r[r.length - 1], 'dev-ubuntu');
  assert.deepEqual(U.rank(items, 'qqq'), []);
});

function mem() { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = v; }, removeItem: (k) => { delete m[k]; }, _m: m }; }

test('cache: allowlist, query stripped, copies, secrets scrubbed, size cap', () => {
  const st = mem(), c = U.createCache(st, { allow: [/^\/api\/tokens/], maxBytes: 200 });
  assert.ok(c.allowed('/api/tokens?zone=x')); assert.ok(!c.allowed('/api/state'));
  assert.equal(c.key('/api/tokens?zone=x'), '/api/tokens');
  assert.ok(c.set('/api/tokens', { a: 1, password: 'p', n: { apiKey: 'k', ok: 2 } }));
  const g = c.get('/api/tokens'); assert.deepEqual(g.data, { a: 1, n: { ok: 2 } });
  g.data.a = 9; assert.equal(c.get('/api/tokens').data.a, 1);
  assert.ok(!/password|apiKey/.test(JSON.stringify(st._m)));
  assert.equal(c.set('/big', { x: 'y'.repeat(500) }), false);
  assert.equal(U.createCache(st, { allow: [] }).get('/api/tokens').data.a, 1, 'persists across instances');
});

test('cache: expired entries are ignored', () => {
  const c = U.createCache(mem(), { allow: [/./], maxAge: -1 }); c.set('/k', { a: 1 }); assert.equal(c.get('/k'), null);
});

test('swr: bypass for non-GET / non-allowlisted / disabled returns the raw promise untouched', async () => {
  let calls = 0; const raw = () => { calls++; return Promise.resolve({ v: calls }); };
  const c = U.createCache(mem(), { allow: [/^\/api\/tokens/] });
  let on = true; const f = U.createSwr(c, raw, { enabled: () => on, canRefetch: () => true });
  assert.deepEqual(await f('POST', '/api/tokens', { a: 1 }), { v: 1 });
  assert.deepEqual(await f('GET', '/api/other'), { v: 2 });
  on = false; assert.deepEqual(await f('GET', '/api/tokens'), { v: 3 });
  assert.equal(c.get('/api/tokens'), null, 'nothing cached while off');
});

test('swr: first call with cache serves stale then refetches; later calls are plain; no cache waits for real data', async () => {
  const st = mem(), c = U.createCache(st, { allow: [/^\/api\/tokens/] });
  let n = 0; const raw = () => Promise.resolve({ n: ++n });
  const log = [];
  const hooks = { canRefetch: () => true, stale: (k) => log.push('stale ' + k), refetch: (k) => log.push('refetch ' + k), fresh: () => log.push('fresh'), pending: () => log.push('pending'), settled: () => log.push('settled') };
  let f = U.createSwr(c, raw, hooks);
  assert.deepEqual(await f('GET', '/api/tokens?z=1'), { n: 1 }, 'cold: waits for real data');
  assert.deepEqual(log.slice(0, 1), ['pending']);
  f = U.createSwr(c, raw, hooks);   // new page load
  log.length = 0;
  assert.deepEqual(await f('GET', '/api/tokens?z=1'), { n: 1 }, 'warm: the cached copy');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(log, ['stale /api/tokens', 'refetch /api/tokens', 'fresh']);
  assert.deepEqual(await f('GET', '/api/tokens'), { n: 3 }, 'second call goes to the network');
});

test('swr: a failing request rejects exactly as before when nothing is cached, and is swallowed when stale was served', async () => {
  const c = U.createCache(mem(), { allow: [/./] });
  const bad = () => Promise.reject(new Error('boom'));
  await assert.rejects(U.createSwr(c, bad, { canRefetch: () => true })('GET', '/x'), /boom/);
  c.set('/y', { a: 1 });
  assert.deepEqual(await U.createSwr(c, bad, { canRefetch: () => true })('GET', '/y'), { a: 1 });
  await new Promise((r) => setImmediate(r));   // no unhandled rejection
});

test('swr: without a way to refresh the owner, never serves stale', async () => {
  const c = U.createCache(mem(), { allow: [/./] }); c.set('/z', { old: 1 });
  assert.deepEqual(await U.createSwr(c, () => Promise.resolve({ fresh: 1 }), { canRefetch: () => false })('GET', '/z'), { fresh: 1 });
});

test('timings: keeps the newest 20, newest first, summary', () => {
  const t = U.createTimings(20);
  for (let i = 1; i <= 25; i++) t.add({ first: i * 10 });
  assert.equal(t.list().length, 20); assert.equal(t.list()[0].first, 250);
  assert.deepEqual(t.summary(), { n: 20, median: 160, max: 250 });
  t.clear(); assert.equal(t.summary(), null);
});

test('isPaletteKey: Cmd/Ctrl-K only', () => {
  const k = (o) => Object.assign({ type: 'keydown', key: 'k' }, o);
  const globalLS = globalThis.localStorage;
  assert.ok(U.isPaletteKey(k({ metaKey: true }))); assert.ok(U.isPaletteKey(k({ ctrlKey: true })));
  assert.ok(!U.isPaletteKey(k({}))); assert.ok(!U.isPaletteKey(k({ ctrlKey: true, shiftKey: true }))); assert.ok(!U.isPaletteKey(k({ ctrlKey: true, key: 'j' })));
  globalThis.localStorage = globalLS;
});
