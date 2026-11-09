'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const feature = require('../lib/features/ops');
const { Vault } = require('../lib/vault');
const NOW = 1800000000000;
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const clone = v => JSON.parse(JSON.stringify(v));
function fixture(t, options = {}) {
  let now = NOW, data = clone(options.data || { pack: { rules: { dormant: { level: 'auto', after: 0 } }, auto: { perHour: 10, quietFrom: '00:00', quietTo: '00:00' } } });
  let locked = false, timer, snapshot, send = options.send || (() => Promise.resolve({ code: 0 })), failSave = null, onSave = null;
  const routes = new Map(), logs = [], calls = [], saves = [];
  const s = { name: 'team', created: 42, cmd: 'codex', aiStatus: { status: 'idle', at: NOW - 40 * 60000 } };
  const r = { cfg: { id: 'host', name: 'Fixture' }, mode: options.mode || 'native', ready: true, lastPoll: now,
    snapshot: { bootId: 'boot-one', sessions: [s] }, lost: [],
    exec(script) { calls.push(script); return send(script); },
    keysPlain(name, text, enter) { calls.push({ name, text, enter }); return send(); } };
  const host = { settings: {
    get: () => { if (locked) throw Error('vault locked'); return clone(data); },
    set: value => { data = clone(value); saves.push(clone(value)); if (onSave) onSave(value); if (failSave) throw Error('private exception must not leak'); options.persist?.(value); },
  }, onSnapshot: fn => { snapshot = fn; }, route: (m, p, fn) => routes.set(m + ' ' + p, fn),
  remotes: () => [r], backendOf: id => id === r.cfg.id && r.ready ? r : null,
  readJson: async req => req, send: (res, status, body) => Object.assign(res, { status, body }),
  fail: (res, status, error, extra) => Object.assign(res, { status, body: { error, ...extra } }), log: line => logs.push(line) };
  const clock = { now: () => now, setInterval: (fn, ms) => { assert.equal(ms, 15000); timer = fn; return { unref() { f.unref = true; } }; }, clearInterval() {} };
  const f = { r, s, host, calls, saves, logs, unref: false, status: () => controller.status(), stop: () => controller.stop(),
    snapshot: () => snapshot(r), tick: () => timer(), advance(ms) { now += ms; }, refresh() { r.lastPoll = now; },
    locked(value) { locked = value; }, setSend(fn) { send = fn; }, failSave(value) { failSave = value; }, onSave(fn) { onSave = fn; },
    data: () => clone(data), async route(method, path, req = {}) { const res = {}; await routes.get(method + ' ' + path)({ req, res }); return res; },
    reRegister() { controller.stop(); controller = feature.register(host, clock); return controller; } };
  let controller = feature.register(host, clock);
  t.after(() => controller.stop());
  return f;
}

test('backend unref timer delivers without HTTP and safe locked startup resumes only after unlock', async t => {
  const f = fixture(t); assert.equal(f.unref, true);
  f.locked(true); f.tick(); await settle(); assert.equal(f.calls.length, 0); assert.equal(f.status().monitoring, false);
  f.locked(false); f.tick(); await settle(); assert.equal(f.calls.length, 1);
  assert.match(f.calls[0], /session_created/);
  const n = f.data().log[0]; assert.equal(n.delivery, 'delivered'); assert.equal(n.responded, null); assert.equal(n.progress, 'unknown');
  assert.equal(f.status().quota, 'unknown');
});

test('durable intent precedes an asynchronous send; concurrent snapshots and manual request cannot duplicate it', async t => {
  const pending = deferred(), f = fixture(t, { send: () => pending.promise });
  f.snapshot();
  assert.equal(f.calls.length, 1); assert.equal(f.data().log[0].delivery, 'pending'); assert.equal(f.status().pending, 1);
  assert.equal(Object.values(f.saves[0].intents)[0].delivery, 'pending');
  for (let i = 0; i < 10; i++) { f.snapshot(); f.tick(); }
  const res = await f.route('POST', '/nudge', { server: 'host', key: 'host/team/dormant' });
  assert.equal(res.status, 409); assert.equal(res.body.code, 'OPS_INFLIGHT'); assert.equal(f.calls.length, 1);
  pending.resolve({ code: 0 }); await settle();
  assert.equal(f.status().pending, 0); assert.equal(f.data().log[0].delivery, 'delivered');
  f.snapshot(); await settle(); assert.equal(f.calls.length, 1);
});

test('once-per-idle survives feature re-register, log clear and log truncation', async t => {
  const f = fixture(t); f.snapshot(); await settle(); assert.equal(f.calls.length, 1);
  await f.route('POST', '/log/clear'); assert.deepEqual(f.data().log, []);
  f.reRegister(); f.snapshot(); await settle(); assert.equal(f.calls.length, 1);
  // A distinct idle period after actual work may receive another approved message.
  f.s.aiStatus = { status: 'busy', at: NOW + 1 }; f.advance(2); f.snapshot();
  f.s.aiStatus = { status: 'idle', at: NOW + 2 }; f.snapshot(); await settle(); assert.equal(f.calls.length, 2);
  // An out-of-order status cannot replay the old idle period.
  f.s.aiStatus.at = NOW - 40 * 60000; f.snapshot(); await settle(); assert.equal(f.calls.length, 2);
});

test('agent start/conversation identity and host reboot are part of the reservation', async t => {
  const f = fixture(t);
  f.s.aiPid = 123; f.s.aiSessionId = 'conversation-one'; f.s.aiStatus.startedAt = NOW - 10000000;
  f.snapshot(); await settle(); assert.equal(f.calls.length, 1);
  f.reRegister(); f.snapshot(); await settle(); assert.equal(f.calls.length, 1);
  f.s.aiPid = 124; f.s.aiSessionId = 'conversation-two'; f.s.aiStatus.startedAt++;
  f.snapshot(); await settle(); assert.equal(f.calls.length, 2);
  f.r.snapshot.bootId = 'boot-two'; f.snapshot(); await settle(); assert.equal(f.calls.length, 3);
});

test('encrypted disk restart deduplicates delivered intents and turns interrupted sends into uncertain owner review', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termnest-ops-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'vault.json'), password = 'fixture-ops-password';
  let v = new Vault(file); v.create(password, { servers: [], features: {} });
  const persist = value => { v.data.features.ops = value; v.save(); };
  const first = fixture(t, { persist }); first.snapshot(); await settle(); assert.equal(first.calls.length, 1);
  v = new Vault(file); assert.equal(v.unlock(password), true);
  const resumed = fixture(t, { data: v.data.features.ops, persist }); resumed.tick(); await settle(); assert.equal(resumed.calls.length, 0);
  // Simulate process death after a durable intent, with an unresolved remote acknowledgement.
  const pending = deferred(), during = fixture(t, { data: v.data.features.ops, persist, send: () => pending.promise });
  during.s.created = 43; during.snapshot(); assert.equal(during.calls.length, 1);
  assert.equal(v.data.features.ops.log.at(-1).delivery, 'pending');
  v = new Vault(file); assert.equal(v.unlock(password), true);
  const recovered = fixture(t, { data: v.data.features.ops, persist }); recovered.s.created = 43;
  recovered.tick(); await settle(); assert.equal(recovered.calls.length, 0);
  assert.equal(recovered.data().log.at(-1).delivery, 'uncertain');
  const board = await recovered.route('GET', '/board'); assert.ok(board.body.servers[0].findings.some(n => n.code === 'OPS_DELIVERY_UNCERTAIN'));
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /fixture-ops-password|OPS_DELIVERY_PENDING|Please continue/);
  pending.resolve({ code: 0 }); await settle();
});

test('offline, stale, future snapshots and busy/waiting/unknown/parked/gone identities gate automatic sends', async t => {
  for (const kind of ['offline', 'stale', 'future', 'busy', 'waiting', 'unknown', 'parked', 'dead', 'no-created', 'no-idle-time']) {
    const f = fixture(t);
    if (kind === 'offline') f.r.ready = false;
    if (kind === 'stale') f.advance(90000);
    if (kind === 'future') f.r.lastPoll += 1;
    if (kind === 'busy' || kind === 'waiting') f.s.aiStatus.status = kind;
    if (kind === 'unknown') delete f.s.aiStatus;
    if (kind === 'parked') f.s.aiStatus.parked = true;
    if (kind === 'dead') f.s.dead = true;
    if (kind === 'no-created') delete f.s.created;
    if (kind === 'no-idle-time') delete f.s.aiStatus.at;
    f.snapshot(); f.tick(); await settle(); assert.equal(f.calls.length, 0, kind);
  }
});

test('manual route rechecks online freshness, status, creation identity and idle timestamp before typing', async t => {
  for (const change of ['offline', 'stale', 'waiting-before', 'replaced-before', 'new-idle-before', 'waiting-after-save', 'replaced-after-save', 'new-idle-after-save']) {
    const f = fixture(t, { data: { pack: { rules: { dormant: { level: 'suggest', after: 0 } } } } });
    f.snapshot(); assert.equal(f.calls.length, 0);
    if (change === 'offline') f.r.ready = false;
    if (change === 'stale') f.advance(90000);
    if (change === 'waiting-before') f.s.aiStatus.status = 'waiting';
    if (change === 'replaced-before') f.s.created++;
    if (change === 'new-idle-before') f.s.aiStatus.at++;
    if (change.endsWith('after-save')) f.onSave(value => {
      if (!Object.values(value.intents || {}).some(n => n.delivery === 'pending')) return;
      if (change === 'waiting-after-save') f.s.aiStatus.status = 'waiting';
      if (change === 'replaced-after-save') f.s.created++;
      if (change === 'new-idle-after-save') f.s.aiStatus.at++;
    });
    const res = await f.route('POST', '/nudge', { server: 'host', key: 'host/team/dormant' });
    assert.equal(res.status, 409, change); assert.equal(f.calls.length, 0, change);
  }
});

test('powershell transport is awaited and reports delivery separately from agent response', async t => {
  const pending = deferred(), f = fixture(t, { mode: 'powershell', send: () => pending.promise });
  f.snapshot(); assert.equal(f.data().log[0].delivery, 'pending'); assert.equal(f.status().pending, 1);
  f.snapshot(); assert.equal(f.calls.length, 1);
  pending.resolve(); await settle(); assert.equal(f.data().log[0].delivery, 'delivered');
  f.s.aiStatus = { status: 'busy', at: NOW - 1 }; f.snapshot(); assert.equal(f.data().log[0].responded, null);
  f.advance(1); f.s.aiStatus = { status: 'busy', at: NOW + 1 }; f.snapshot();
  assert.equal(f.data().log[0].responded, true); assert.equal(f.data().log[0].code, 'OPS_AGENT_RESPONDED'); assert.equal(f.data().log[0].progress, 'unknown');
});

test('only proven not-sent failure retries, with persistent backoff and a three-attempt bound', async t => {
  const f = fixture(t, { send: () => Promise.resolve({ code: 75, out: 'TW_OPS_NOT_SENT' }) });
  f.snapshot(); await settle(); assert.equal(f.calls.length, 1); assert.equal(f.data().log[0].delivery, 'failed');
  f.reRegister(); f.tick(); await settle(); assert.equal(f.calls.length, 1);
  f.advance(14999); f.tick(); await settle(); assert.equal(f.calls.length, 1);
  f.advance(1); f.tick(); await settle(); assert.equal(f.calls.length, 2);
  f.advance(29999); f.tick(); await settle(); assert.equal(f.calls.length, 2);
  f.advance(1); f.tick(); await settle(); assert.equal(f.calls.length, 3); assert.equal(f.data().log[0].delivery, 'exhausted');
  f.advance(3600000); f.refresh(); f.tick(); await settle(); assert.equal(f.calls.length, 3);
});

test('timeout/throw, partial nonzero send and malformed acknowledgements escalate and never auto-retry', async t => {
  for (const send of [() => Promise.reject(Error('SECRET-private-transport-error')), () => Promise.resolve({ code: 1 }), () => Promise.resolve({ code: 75, out: 'not-the-marker' }), () => Promise.resolve(null)]) {
    const f = fixture(t, { send }); f.snapshot(); await settle();
    assert.equal(f.data().log[0].delivery, 'uncertain'); assert.equal(f.calls.length, 1);
    f.advance(3600000); f.refresh(); f.s.aiStatus.at = NOW + 3600000;
    f.reRegister(); f.tick(); await settle(); assert.equal(f.calls.length, 1);
    assert.doesNotMatch(f.logs.join(' '), /SECRET|private-transport-error/);
  }
});

test('intent persistence failure prevents sends; acknowledgement persistence failure leaves durable intent reserved', async t => {
  const f = fixture(t); f.failSave(true); f.snapshot(); await settle();
  assert.equal(f.calls.length, 0); assert.equal(f.status().code, 'OPS_PERSISTENCE_FAILED'); assert.equal(f.status().monitoring, false);
  f.failSave(false); f.tick(); await settle(); assert.equal(f.calls.length, 0);
  const pending = deferred(), ack = fixture(t, { send: () => pending.promise }); ack.snapshot(); assert.equal(ack.calls.length, 1);
  ack.failSave(true); pending.resolve({ code: 0 }); await settle();
  assert.equal(ack.data().log[0].delivery, 'pending');
  ack.failSave(false); ack.reRegister(); ack.tick(); await settle();
  assert.equal(ack.data().log[0].delivery, 'uncertain'); assert.equal(ack.calls.length, 1);
});

test('log clear cannot reset rate limits; shipped defaults keep dormant suggest and the quiet window', async t => {
  const f = fixture(t, { data: { pack: { rules: { dormant: { level: 'auto', after: 0 } }, auto: { perHour: 1, quietFrom: '00:00', quietTo: '00:00' } } } });
  f.snapshot(); await settle(); assert.equal(f.calls.length, 1);
  await f.route('POST', '/log/clear'); f.advance(1); f.s.aiStatus.at = NOW + 1;
  f.reRegister(); f.tick(); await settle(); assert.equal(f.calls.length, 1);
  f.advance(3600000); f.refresh(); f.tick(); await settle(); assert.equal(f.calls.length, 2);
  const defaults = fixture(t, { data: {} }); defaults.tick(); await settle(); assert.equal(defaults.calls.length, 0);
  const res = await defaults.route('GET', '/pack'); assert.equal(res.body.rules.dormant.level, 'suggest'); assert.equal(res.body.auto.quietFrom, '23:00'); assert.equal(res.body.auto.quietTo, '07:00');
});

test('drain stops new backend sends while an accepted asynchronous send remains pending', async t => {
  const pending = deferred(), f = fixture(t, { send: () => pending.promise });
  f.snapshot(); assert.equal(f.status().pending, 1);
  f.stop(); assert.equal(f.status().monitoring, false); assert.equal(f.status().pending, 1);
  f.s.created++; f.snapshot(); f.tick(); assert.equal(f.calls.length, 1);
  pending.resolve({ code: 0 }); await settle(); assert.equal(f.status().pending, 0);
});

test('stopping one feature host does not stop another backend instance', async t => {
  const first = fixture(t), second = fixture(t); first.stop();
  assert.equal(first.status().monitoring, false); assert.equal(second.status().monitoring, true);
  first.tick(); second.tick(); await settle(); assert.equal(first.calls.length, 0); assert.equal(second.calls.length, 1);
});
