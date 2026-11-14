'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { Remote, MAX_CHANNELS } = require('../lib/remote');

// A fake ssh2 client: each exec opens a channel that answers after `delay` ms, or never opens when `hang` is set.
function fake({ delay = 20, hang = false } = {}) {
  const r = Object.create(Remote.prototype);
  r.ready = true; r.open = 0; r.peak = 0;
  r.client = { exec(cmd, cb) {
    if (hang) return;
    r.open += 1; r.peak = Math.max(r.peak, r.open);
    const st = new EventEmitter(); st.stderr = new EventEmitter(); st.close = () => {}; st.end = () => {};
    setTimeout(() => cb(null, st), 1);
    setTimeout(() => { st.emit('data', Buffer.from('ok ' + cmd)); r.open -= 1; st.emit('close', 0); }, delay);
  } };
  return r;
}

test('never more than MAX_CHANNELS commands at once on one connection; the rest wait and still finish', async () => {
  const r = fake({ delay: 30 });
  const out = await Promise.all(Array.from({ length: 20 }, (_, i) => r.exec('c' + i)));
  assert.equal(out.length, 20);
  assert.ok(out.every((x, i) => x.out === 'ok c' + i && x.code === 0));
  assert.ok(r.peak <= MAX_CHANNELS, 'peak ' + r.peak);
});

test('a channel that is never granted fails within the time limit instead of hanging the poll', async () => {
  const r = fake({ hang: true });
  const t0 = Date.now();
  await assert.rejects(r.exec('x', 200), /kênh SSH/);
  assert.ok(Date.now() - t0 < 1000);
  // the slot was released: the next command can run
  r.client = fake().client;
  assert.equal((await r.exec('y', 500)).out, 'ok y');
});

test('commands waiting for a channel fail cleanly (no crash) when the connection drops meanwhile', async () => {
  const r = fake({ delay: 30 });
  const all = Promise.allSettled(Array.from({ length: 12 }, (_, i) => r.exec('c' + i)));
  setTimeout(() => { r.client = null; r.ready = false; }, 10);
  const res = await all;
  assert.equal(res.length, 12);
  assert.ok(res.some((x) => x.status === 'rejected'));
});
