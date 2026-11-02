'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const {start} = require('../packaging/smoke');
const {status} = require('../packaging/launcher');

test('identity is explicit, exposes no setup token, and rejects an unrelated status API', async () => {
  const foreign = http.createServer((req, res) => res.end(JSON.stringify({setup: true})));
  await new Promise(resolve => foreign.listen(0, '127.0.0.1', resolve));
  try { assert.equal(await status(foreign.address().port), false); }
  finally { await new Promise(resolve => foreign.close(resolve)); }
  const app = await start({extraArgs: ['--desktop-pipe']});
  try {
    assert.equal(await status(app.port), true);
    assert.deepEqual(await (await app.request('/__app')).json(), {app: 'tmux-dev', active_work: 0});
    app.child.stdin.end();
    assert.equal((await app.exited).code, 0);
  } finally { await app.close(); }
});

test('private pipe close drains an accepted write and rejects new writes', async () => {
  const app = await start({extraArgs: ['--desktop-pipe'], env: {TW_SETUP_TOKEN: 'test-secret'}});
  let req;
  try {
    const body = JSON.stringify({password: 'long-enough-password', setupToken: 'test-secret'});
    const result = new Promise((resolve, reject) => {
      req = http.request(app.url + '/api/setup', {method: 'POST', headers: {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)}}, res => {res.resume(); res.on('end', () => resolve(res.statusCode));});
      req.on('error', reject); req.write(body.slice(0, 10));
    });
    for (let i = 0; i < 50; i++) {
      if ((await (await app.request('/__app')).json()).active_work === 1) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal((await (await app.request('/__app')).json()).active_work, 1);
    app.child.stdin.end();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(app.child.exitCode, null);
    assert.equal((await app.request('/api/login', {password: 'new-work'})).status, 503);
    req.end(body.slice(10));
    assert.equal(await result, 200);
    assert.equal((await app.exited).code, 0);
    assert.equal(fs.existsSync(app.data + '/vault.json'), true);
  } finally { if (req) req.destroy(); await app.close(); }
});

test('source and packaged UI serve original fonts locally with restrictive CSP', async () => {
  for (const launcher of [false, true]) {
    const app = await start({launcher});
    try {
      const response = await app.request('/');
      const html = await response.text();
      assert.doesNotMatch(html, /https:\/\/(fonts|cdn)/);
      assert.match(html, /\/fonts\/fonts.css/);
      const csp = response.headers.get('content-security-policy');
      assert.doesNotMatch(csp, /fonts.googleapis|fonts.gstatic|connect-src[^;]* wss?:[ ;]/);
      assert.match(csp, /font-src 'self'/);
      const css = await (await app.request('/fonts/fonts.css')).text();
      for (const family of ['Be Vietnam Pro', 'Nunito', 'JetBrains Mono']) assert.ok(css.includes(family));
      const fonts = [...css.matchAll(/url\('([^']+)'\)/g)].map(m => m[1]);
      assert.ok(fonts.length >= 18);
      for (const font of fonts) {
        const resource = await app.request(font);
        assert.equal(resource.status, 200, font);
        assert.equal(resource.headers.get('content-type'), 'font/woff2');
        const bytes = Buffer.from(await resource.arrayBuffer());
        assert.equal(bytes.subarray(0, 4).toString(), 'wOF2');
      }
      assert.equal((await app.request('/fonts/missing.woff2')).status, 404);
      assert.equal((await app.request('/fonts/%2e%2e/server.js')).status, 404);
    } finally { await app.close(); }
  }
});
