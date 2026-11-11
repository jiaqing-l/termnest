'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
process.env.TW_CREW_DEMO = '1'; // registered crews and /spawn exist only for the prototype's fake agents
const mod = require('../lib/features/crewpanes');

function host(sessions = []) {
  const routes = {}, store = {}, started = [], stopped = [], sent = [], out = { status: 0, body: null };
  const backend = { cfg: { id: 'srv' }, ready: true, snapshot: { sessions }, exec: async (cmd) => { sent.push(cmd); return { code: 0, out: '' }; } };
  return { routes, started, stopped, sent, out, h: {
    route: (m, p, fn) => { routes[`${m} ${p}`] = fn; },
    settings: { get: () => ({ ...store }), set: (v) => Object.assign(store, v) },
    backendOf: (id) => (id === 'srv' ? backend : null), shq: (s) => `'${String(s).replace(/'/g, `'\\''`)}'`,
    sessions: { start: async (_b, o) => { started.push(o.name); }, stop: async (_b, name) => { stopped.push(name); return true; } },
    readJson: async (req) => req.body, send: (_r, st, body) => { out.status = st; out.body = body; }, fail: (_r, st, msg) => { out.status = st; out.body = { error: msg }; }, log() {},
  } };
}
const call = (fx, key, body) => fx.routes[key]({ req: { body }, res: {}, url: new URL('http://x/?id=' + encodeURIComponent((body || {}).id || '')) });

test('creating a crew starts only the orchestrator: workers come from the orchestrator later', async () => {
  const fx = host(); mod.register(fx.h);
  await call(fx, 'POST /create', { server: 'srv', name: 'UIUX', dir: '/tmp', workers: 3 });
  assert.equal(fx.out.status, 200);
  assert.deepEqual(fx.started, ['UIUX']);
  await call(fx, 'GET /list', {});
  assert.deepEqual(fx.out.body.crews[0].workers, []);
});

test('the orchestrator spawns workers of its chosen kind; nobody else adds them', async () => {
  const fx = host(); mod.register(fx.h);
  await call(fx, 'POST /create', { server: 'srv', name: 'UIUX', dir: '/tmp' });
  await call(fx, 'POST /spawn', { id: 'srv/UIUX', kind: 'codex' }); assert.equal(fx.out.status, 200);
  await call(fx, 'POST /spawn', { id: 'srv/UIUX', kind: 'claude' }); assert.equal(fx.out.status, 200);
  assert.deepEqual(fx.started, ['UIUX', 'UIUX-W1', 'UIUX-W2']);
  await call(fx, 'GET /list', {});
  assert.deepEqual(fx.out.body.crews[0].workers, ['UIUX-W1', 'UIUX-W2']);
  assert.deepEqual(fx.out.body.crews[0].kinds, { 'UIUX-W1': 'codex', 'UIUX-W2': 'claude' });
});

test('spawn refuses unknown kinds, a ninth worker and unknown crews', async () => {
  const fx = host(); mod.register(fx.h);
  await call(fx, 'POST /create', { server: 'srv', name: 'many', dir: '/tmp' });
  await call(fx, 'POST /spawn', { id: 'srv/many', kind: 'gpt' }); assert.equal(fx.out.status, 400);
  for (let i = 0; i < 8; i++) { await call(fx, 'POST /spawn', { id: 'srv/many', kind: 'codex' }); assert.equal(fx.out.status, 200); }
  await call(fx, 'POST /spawn', { id: 'srv/many', kind: 'codex' }); assert.equal(fx.out.status, 400);
  await call(fx, 'POST /spawn', { id: 'srv/nope', kind: 'codex' }); assert.equal(fx.out.status, 404);
});

test('bad names, unknown servers, duplicate crews and taken session names are refused', async () => {
  const fx = host([{ name: 'busy-W1' }]); mod.register(fx.h);
  await call(fx, 'POST /create', { server: 'srv', name: 'bad name!' }); assert.equal(fx.out.status, 400);
  await call(fx, 'POST /create', { server: 'nope', name: 'ok' }); assert.equal(fx.out.status, 400);
  await call(fx, 'POST /create', { server: 'srv', name: 'busy' }); assert.equal(fx.out.status, 409);
  await call(fx, 'POST /create', { server: 'srv', name: 'fine', dir: '/tmp' }); assert.equal(fx.out.status, 200);
  await call(fx, 'POST /create', { server: 'srv', name: 'fine', dir: '/tmp' }); assert.equal(fx.out.status, 409);
});

test('send only types into members of a registered crew and rejects newlines', async () => {
  const fx = host(); mod.register(fx.h);
  await call(fx, 'POST /create', { server: 'srv', name: 'c', dir: '/tmp' });
  await call(fx, 'POST /send', { id: 'srv/c', session: 'other', text: 'hi' }); assert.equal(fx.out.status, 400);
  await call(fx, 'POST /send', { id: 'srv/c', session: 'c', text: 'a\nb' }); assert.equal(fx.out.status, 400);
  const before = fx.sent.length;
  await call(fx, 'POST /send', { id: 'srv/c', session: 'c', text: 'continue' }); assert.equal(fx.out.status, 200);
  assert.ok(fx.sent.length > before && /send-keys/.test(fx.sent[fx.sent.length - 1]));
});

test('stopping a crew removes it from the registry', async () => {
  const fx = host(); mod.register(fx.h);
  await call(fx, 'POST /create', { server: 'srv', name: 'gone', dir: '/tmp' });
  await call(fx, 'POST /stop', { id: 'srv/gone' }); assert.equal(fx.out.status, 200);
  await call(fx, 'GET /list', {}); assert.deepEqual(fx.out.body.crews, []);
});

test('an ordinary session becomes a crew when it spawns its first worker; unknown sessions are refused', async () => {
  const fx = host([{ name: 'myclaude', path: '/work/app' }]); mod.register(fx.h);
  await call(fx, 'POST /spawn', { server: 'srv', session: 'ghost', kind: 'codex' }); assert.equal(fx.out.status, 404);
  await call(fx, 'POST /spawn', { server: 'srv', session: 'myclaude', kind: 'codex' }); assert.equal(fx.out.status, 200);
  await call(fx, 'POST /spawn', { server: 'srv', session: 'myclaude', kind: 'claude' }); assert.equal(fx.out.status, 200);
  assert.deepEqual(fx.started, ['myclaude-W1', 'myclaude-W2']); // the session itself already exists; only workers start
  await call(fx, 'GET /list', {});
  assert.equal(fx.out.body.crews.length, 1);
  assert.equal(fx.out.body.crews[0].name, 'myclaude'); assert.equal(fx.out.body.crews[0].dir, '/work/app');
  assert.deepEqual(fx.out.body.crews[0].kinds, { 'myclaude-W1': 'codex', 'myclaude-W2': 'claude' });
});

test('without TW_CREW_DEMO nothing here creates sessions: a real Crew is derived from _crew, its workers are tracks', async () => {
  const keep = process.env.TW_CREW_DEMO; delete process.env.TW_CREW_DEMO;
  try {
    const fx = host([{ name: 'lead', path: '/w' }]); mod.register(fx.h);
    await call(fx, 'POST /create', { server: 'srv', name: 'x', dir: '/tmp' }); assert.equal(fx.out.status, 404);
    await call(fx, 'POST /spawn', { server: 'srv', session: 'lead', kind: 'codex' }); assert.equal(fx.out.status, 404);
    assert.deepEqual(fx.started, []);
  } finally { process.env.TW_CREW_DEMO = keep; }
});

// deriveCrews lives in the page script: load just that function and feed it the Vận hành fleet shape.
const fs = require('node:fs'), path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, '../public/features/crewpanes.js'), 'utf8');
const deriveCrews = new Function(src.slice(src.indexOf('function deriveCrews('), src.indexOf('function mergeCrews()')) + '; return deriveCrews;')();
const fleet = {
  sessions: [{ machine: 'm1', name: 'lead', workers: [{ kind: 'codex', task: 'T1', track: 'W1' }, { kind: 'claude', task: 'T1', track: 'W3' }] }],
  tasks: [
    { machine: 'm1', root: '/w', id: 'T1', title: 'Export Excel', leader: 'lead', tracks: [{ id: 'W1', state: 'dispatched' }, { id: 'W2', state: 'queued' }, { id: 'W3', state: 'done' }] },
    { machine: 'm1', root: '/w', id: 'T2', title: 'Other', leader: '', tracks: [{ id: 'W1', state: 'dispatched' }] },
    { machine: 'm1', root: '/w', id: 'T3', title: 'No tracks', leader: 'lead', tracks: [] },
  ],
};

test('deriveCrews: one Crew per leader session, workers are the task tracks, kinds come from the running processes', () => {
  const crews = deriveCrews(fleet);
  assert.equal(crews.length, 1);
  const c = crews[0];
  assert.equal(c.id, 'm1/lead'); assert.equal(c.derived, true); assert.equal(c.dir, '/w');
  assert.deepEqual(c.workers, ['W1', 'W2', 'W3']);
  assert.deepEqual(c.kinds, { W1: 'codex', W2: '', W3: 'claude' });
  assert.equal(c.trackMap.W2.state, 'queued'); assert.equal(c.trackMap.W3.task, 'T1');
});

test('deriveCrews: a task without leader or without tracks creates no Crew; two tasks of one leader keep their tracks apart', () => {
  assert.deepEqual(deriveCrews({ tasks: [{ machine: 'm', id: 'A', leader: '', tracks: [{ id: 'W1', state: 'done' }] }] }), []);
  const two = deriveCrews({ tasks: [
    { machine: 'm', root: '/r', id: 'A', title: 'a', leader: 'L', tracks: [{ id: 'W1', state: 'dispatched' }] },
    { machine: 'm', root: '/r', id: 'B', title: 'b', leader: 'L', tracks: [{ id: 'W1', state: 'queued' }] }] });
  assert.equal(two.length, 1); assert.deepEqual(two[0].workers, ['W1', 'B/W1']);
  assert.equal(two[0].trackMap['B/W1'].task, 'B');
});

test('demo: the worker sessions of a finished plan are closed after the cleanup delay, the crew itself stays', async () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'crewtidy-'));
  const keep = [process.env.TW_CREW_CLEANUP_MS, process.env.TW_CREW_SYNC_MS];
  process.env.TW_CREW_CLEANUP_MS = '0'; process.env.TW_CREW_SYNC_MS = '30';
  try {
    const fx = host(); mod.register(fx.h);
    await call(fx, 'POST /create', { server: 'srv', name: 'tidy', dir });
    await call(fx, 'POST /spawn', { id: 'srv/tidy', kind: 'codex' }); await call(fx, 'POST /spawn', { id: 'srv/tidy', kind: 'claude' });
    fs.mkdirSync(path.join(dir, '.crew-demo', 'tidy'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.crew-demo', 'tidy', 'tracks.json'), JSON.stringify({ phase: 'done', at: Date.now() - 1000, tracks: [] }));
    await new Promise((r) => setTimeout(r, 300));
    await call(fx, 'GET /list', {});
    assert.deepEqual(fx.out.body.crews[0].workers, []);
    assert.deepEqual(fx.stopped.sort(), ['tidy-W1', 'tidy-W2']);
    assert.equal(fx.out.body.crews.length, 1);
  } finally { process.env.TW_CREW_CLEANUP_MS = keep[0]; process.env.TW_CREW_SYNC_MS = keep[1]; if (keep[0] === undefined) delete process.env.TW_CREW_CLEANUP_MS; if (keep[1] === undefined) delete process.env.TW_CREW_SYNC_MS; fs.rmSync(dir, { recursive: true, force: true }); }
});
