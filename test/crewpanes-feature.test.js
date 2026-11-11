'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const mod = require('../lib/features/crewpanes');

function host(sessions = []) {
  const routes = {}, store = {}, started = [], sent = [], out = { status: 0, body: null };
  const backend = { cfg: { id: 'srv' }, ready: true, snapshot: { sessions }, exec: async (cmd) => { sent.push(cmd); return { code: 0, out: '' }; } };
  return { routes, started, sent, out, h: {
    route: (m, p, fn) => { routes[`${m} ${p}`] = fn; },
    settings: { get: () => ({ ...store }), set: (v) => Object.assign(store, v) },
    backendOf: (id) => (id === 'srv' ? backend : null), shq: (s) => `'${String(s).replace(/'/g, `'\\''`)}'`,
    sessions: { start: async (_b, o) => { started.push(o.name); }, stop: async () => true },
    readJson: async (req) => req.body, send: (_r, st, body) => { out.status = st; out.body = body; }, fail: (_r, st, msg) => { out.status = st; out.body = { error: msg }; }, log() {},
  } };
}
const call = (fx, key, body) => fx.routes[key]({ req: { body }, res: {}, url: new URL('http://x/?id=' + encodeURIComponent((body || {}).id || '')) });

test('creating a crew starts one orchestrator and N workers and registers them', async () => {
  const fx = host(); mod.register(fx.h);
  await call(fx, 'POST /create', { server: 'srv', name: 'UIUX', dir: '/tmp', workers: 3 });
  assert.equal(fx.out.status, 200);
  assert.deepEqual(fx.started, ['UIUX', 'UIUX-codex-1', 'UIUX-codex-2', 'UIUX-codex-3']);
  await call(fx, 'GET /list', {});
  assert.deepEqual(fx.out.body.crews[0].workers, ['UIUX-codex-1', 'UIUX-codex-2', 'UIUX-codex-3']);
});

test('bad names, unknown servers, duplicate crews and taken session names are refused', async () => {
  const fx = host([{ name: 'busy-codex-1' }]); mod.register(fx.h);
  await call(fx, 'POST /create', { server: 'srv', name: 'bad name!', workers: 2 }); assert.equal(fx.out.status, 400);
  await call(fx, 'POST /create', { server: 'nope', name: 'ok', workers: 2 }); assert.equal(fx.out.status, 400);
  await call(fx, 'POST /create', { server: 'srv', name: 'busy', workers: 2 }); assert.equal(fx.out.status, 409);
  await call(fx, 'POST /create', { server: 'srv', name: 'fine', dir: '/tmp', workers: 2 }); assert.equal(fx.out.status, 200);
  await call(fx, 'POST /create', { server: 'srv', name: 'fine', dir: '/tmp', workers: 2 }); assert.equal(fx.out.status, 409);
});

test('worker count is clamped to 1..4 and add-worker stops at 4', async () => {
  const fx = host(); mod.register(fx.h);
  await call(fx, 'POST /create', { server: 'srv', name: 'many', dir: '/tmp', workers: 99 });
  assert.equal(fx.out.body.crew.workers.length, 4);
  await call(fx, 'POST /add-worker', { id: 'srv/many' }); assert.equal(fx.out.status, 400);
});

test('send only types into members of a registered crew and rejects newlines', async () => {
  const fx = host(); mod.register(fx.h);
  await call(fx, 'POST /create', { server: 'srv', name: 'c', dir: '/tmp', workers: 1 });
  await call(fx, 'POST /send', { id: 'srv/c', session: 'other', text: 'hi' }); assert.equal(fx.out.status, 400);
  await call(fx, 'POST /send', { id: 'srv/c', session: 'c', text: 'a\nb' }); assert.equal(fx.out.status, 400);
  const before = fx.sent.length;
  await call(fx, 'POST /send', { id: 'srv/c', session: 'c', text: 'continue' }); assert.equal(fx.out.status, 200);
  assert.ok(fx.sent.length > before && /send-keys/.test(fx.sent[fx.sent.length - 1]));
});

test('stopping a crew removes it from the registry', async () => {
  const fx = host(); mod.register(fx.h);
  await call(fx, 'POST /create', { server: 'srv', name: 'gone', dir: '/tmp', workers: 1 });
  await call(fx, 'POST /stop', { id: 'srv/gone' }); assert.equal(fx.out.status, 200);
  await call(fx, 'GET /list', {}); assert.deepEqual(fx.out.body.crews, []);
});
