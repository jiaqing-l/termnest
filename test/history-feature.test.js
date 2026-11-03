'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const history = require('../lib/features/history');

function setup(backend) {
  let handler; const sent = [];
  history.register({
    route: (m, p, h) => { assert.equal(m, 'POST'); assert.equal(p, '/clear'); handler = h; },
    readJson: async (req) => req.body, backendOf: (id) => (id === 'h1' ? backend : null), shq: (s) => `'${s}'`, log() {},
    send: (res, code, body) => sent.push([code, body]), fail: (res, code, msg) => sent.push([code, { error: msg }]),
  });
  return { call: (body) => handler({ req: { body }, res: {} }), sent };
}

test('clears the named session only after it is found in the snapshot', async () => {
  const cmds = [], t = setup({ mode: 'native', snapshot: { sessions: [{ name: 'Smart-Visibility' }] }, exec: async (c) => { cmds.push(c); return { code: 0 }; } });
  await t.call({ server: 'h1', session: 'Smart-Visibility' });
  assert.deepEqual(cmds, ["tmux clear-history -t '=Smart-Visibility:'"]); assert.deepEqual(t.sent[0], [200, { ok: true }]);
});

test('unknown session, unknown server and shell-looking names never reach exec', async () => {
  const cmds = [], t = setup({ mode: 'native', snapshot: { sessions: [{ name: 'a' }] }, exec: async (c) => { cmds.push(c); return { code: 0 }; } });
  await t.call({ server: 'h1', session: 'b' }); await t.call({ server: 'nope', session: 'a' }); await t.call({ server: 'h1', session: "a'; rm -rf /" });
  assert.deepEqual(cmds, []); assert.deepEqual(t.sent.map((s) => s[0]), [400, 400, 400]);
});
