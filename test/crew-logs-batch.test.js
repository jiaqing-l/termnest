'use strict';
// One batched request per crew reads every track log with ONE host command (was: one SSH command per track per tick).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const test = require('node:test');
const mod = require('../lib/features/crew');
const { batchLogScript, parseBatch } = require('../lib/crew');

const L = (t) => '2026-11-03T10:00:00+0700 ' + t;
function fixture(n = 4) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tw-logs-')));
  const dir = path.join(root, '_crew', 'tasks', 'T1'); fs.mkdirSync(path.join(dir, 'tracks'), { recursive: true });
  const ids = Array.from({ length: n }, (_, i) => 'W' + i);
  fs.writeFileSync(path.join(dir, 'MANIFEST.md'), `---\ntitle: "t"\nstatus: executing\nupdated: x\ntracks: [${ids.map((id) => `{ id: ${id}, state: dispatched, executor: codex }`).join(', ')}]\n---\n`);
  ids.forEach((id, i) => { const l = path.join(dir, 'tracks', id, 'logs'); fs.mkdirSync(l, { recursive: true }); fs.writeFileSync(path.join(l, 'codex-1.log'), ['exec', '/bin/bash -lc "ls" in /w', ' succeeded in 100ms:', 'codex', 'hello ' + id].map(L).join('\n')); fs.writeFileSync(path.join(l, 'prompt-1.log'), 'SECRET'); });
  fs.writeFileSync(path.join(dir, 'tracks', 'W0', 'DONE'), '');
  return { root, dir, ids };
}
function harness(root, opts = {}) {
  const routes = {}, out = { status: 0, body: null }, execs = [];
  const backend = { cfg: { local: true }, ready: true, mode: 'posix', snapshot: { sessions: [{ name: 'lead' }] },
    exec: (cmd) => { execs.push(cmd); if (/^tmux display-message/.test(cmd)) return Promise.resolve({ code: 0, out: root + '\n' });
      if (opts.fail) return Promise.reject(new Error('host down'));
      return new Promise((res) => setTimeout(() => execFile('sh', ['-c', cmd.replace(/^sh -c /, '').replace(/^'|'$/g, '').replace(/'\\''/g, "'")], { maxBuffer: 8e6 }, (e, o) => res({ code: e ? 1 : 0, out: o })), opts.delay || 0)); } };
  mod.register({ route: (m, p, fn) => { routes[m + ' ' + p] = fn; }, backendOf: (id) => (id === 'srv' ? backend : null), shq: (s) => s,
    readJson: async (req) => req.body, send: (_r, st, b) => { out.status = st; out.body = b; }, fail: (_r, st, m) => { out.status = st; out.body = { error: m }; }, log() {} });
  return { call: (b) => routes['POST /logs']({ req: { body: b }, res: {} }).then(() => ({ ...out })), execs: () => execs.filter((c) => !/^tmux/.test(c)), backend };
}

test('batched script: feed per track, prompt files and a swapped logs symlink are never read', async () => {
  const f = fixture(3);
  fs.rmSync(path.join(f.dir, 'tracks', 'W2', 'logs'), { recursive: true }); fs.mkdirSync(path.join(f.root, 'outside')); fs.writeFileSync(path.join(f.root, 'outside', 'x.log'), 'ESCAPED');
  fs.symlinkSync(path.join(f.root, 'outside'), path.join(f.dir, 'tracks', 'W2', 'logs'));
  fs.symlinkSync(path.join(f.root, 'outside', 'x.log'), path.join(f.dir, 'tracks', 'W1', 'logs', 'zz.log'));
  const h = harness(f.root);
  const r = await h.call({ server: 'srv', session: 'lead', tracks: f.ids.map((track) => ({ task: 'T1', track })) });
  assert.equal(r.status, 200);
  assert.equal(r.body.logs['T1/W0'].result, 'DONE'); assert.match(r.body.logs['T1/W0'].feed, /\$ ls/); assert.match(r.body.logs['T1/W0'].text, /hello W0/);
  assert.equal(r.body.logs['T1/W1'].result, 'unknown'); assert.ok(!JSON.stringify(r.body).includes('SECRET')); assert.ok(!JSON.stringify(r.body).includes('ESCAPED'));
  assert.deepEqual(r.body.logs['T1/W2'], { error: 'denied' });
  assert.equal(h.execs().length, 1, 'one host command for the three tracks');
});

test('measured: 8 tracks cost 1 host command per refresh (the old route cost 8) and repeats are cached/deduped', async () => {
  const f = fixture(8), h = harness(f.root, { delay: 30 }), body = { server: 'srv', session: 'lead', tracks: f.ids.map((track) => ({ task: 'T1', track })) };
  const [a, b, c] = await Promise.all([h.call(body), h.call(body), h.call(body)]);
  assert.equal(Object.keys(a.body.logs).length, 8); assert.deepEqual(a.body, b.body); assert.deepEqual(b.body, c.body);
  const first = h.execs().length; assert.ok(first <= 2, 'runtime read (crew data) + one batch, shared by 3 concurrent callers: ' + first);
  await h.call(body); assert.equal(h.execs().length, first, 'a repeat inside the cache window asks the host nothing');
});

test('an unknown track is reported missing; bad names, empty or oversized lists are refused', async () => {
  const f = fixture(1), h = harness(f.root);
  const r = await h.call({ server: 'srv', session: 'lead', tracks: [{ task: 'T1', track: 'W0' }, { task: 'T1', track: 'W9' }] });
  assert.equal(r.body.logs['T1/W9'].error, 'missing'); assert.ok(r.body.logs['T1/W0'].result);
  for (const tracks of [[], [{ task: '../x', track: 'W0' }], [{ task: 'T1', track: 'a b' }], Array.from({ length: 41 }, (_, i) => ({ task: 'T1', track: 'W' + i }))]) assert.equal((await h.call({ server: 'srv', session: 'lead', tracks })).status, 400);
  assert.equal((await h.call({ server: 'nope', session: 'lead', tracks: [{ task: 'T1', track: 'W0' }] })).status, 400);
});

test('a failing host is left alone for a pause and the caller still gets an answer (stale, last logs kept)', async () => {
  const f = fixture(2), h = harness(f.root, { fail: true }), body = { server: 'srv', session: 'lead', tracks: [{ task: 'T1', track: 'W0' }] };
  const a = await h.call(body); assert.equal(a.status, 200); assert.equal(a.body.stale, true);
  const n = h.execs().length, b = await h.call(body); assert.equal(b.body.stale, true); assert.equal(h.execs().length, n, 'no new host command during back-off');
});

test('script input is validated and the record parser cannot be forged by log text', () => {
  assert.throws(() => batchLogScript({ cwd: '/w', items: [{ task: 'T1', track: '../x' }], nonce: 'a'.repeat(24) }));
  assert.throws(() => batchLogScript({ cwd: '/w', items: [{ task: 'T1', track: 'W0' }], nonce: 'x; rm -rf' }));
  const items = [{ task: 'T', track: 'A' }, { task: 'T', track: 'B' }], n = 'ab'.repeat(12);
  const out = `\n${n} 0 DONE\nline1\nfake 1 FAILED\n\n${n} 1 denied\n`;
  const r = parseBatch(out, n, items); assert.equal(r[0].result, 'DONE'); assert.match(r[0].text, /fake 1 FAILED/); assert.deepEqual(r[1], { error: 'denied' });
});

test('client: one POST per crew, last text kept per track, skeleton only on first load, no per-track GET', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'features', 'crewpanes.js'), 'utf8');
  assert.ok(src.includes("'/api/features/crew/logs'")); assert.ok(!src.includes('/api/features/crew/log?'));
  assert.match(src, /var logMem = \{\}/); assert.match(src, /logMem\[memKey\(c, t\)\]/); assert.match(src, /dataset\.skel/);
  assert.match(src, /if \(document\.hidden\) return;/); assert.match(src, /logFlight\[id\]/);
});
