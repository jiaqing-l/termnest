'use strict';
// Page files are gzipped and revalidated (a reload gets 304, not ~830 KB again); big JSON answers are gzipped;
// API answers stay no-store. Real server.js with the documentation fixture (no SSH, no tmux, isolated HOME).
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), net = require('net'), zlib = require('zlib');
const { spawn } = require('child_process');
const { Vault } = require('../lib/vault');
const root = path.resolve(__dirname, '..');

function get(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: headers.method || 'GET', headers: { Host: '127.0.0.1:' + port, ...headers } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); if (headers.body) req.write(headers.body); req.end();
  });
}

test('static files: gzip + ETag/304; JSON: gzip when large; API stays no-store', { timeout: 30000 }, async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-http-')), data = path.join(scratch, 'data');
  new Vault(path.join(data, 'vault.json')).create('demo-password', { servers: [{ id: '11111111-1111-4111-8111-111111111111', name: 'demo-server', host: '192.0.2.10', port: 22, user: 'demo', auth: 'password' }] });
  const port = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const app = spawn(process.execPath, ['--require', path.join(__dirname, 'readme-fixture.cjs'), 'server.js'], { cwd: root,
    env: { PATH: process.env.PATH, HOME: scratch, USERPROFILE: scratch, TMPDIR: scratch, TW_DATA: data, TW_PORT: String(port), TW_POLL_MS: '1000', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; app.stdout.on('data', (b) => { log += b; }); app.stderr.on('data', (b) => { log += b; });
  t.after(async () => { const gone = new Promise((r) => app.once('exit', r)); app.kill(); await Promise.race([gone, new Promise((r) => setTimeout(r, 3000))]); fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  for (let i = 0; i < 100 && !log.includes('Termnest:'); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(log.includes('Termnest:'), log);

  const plain = await get(port, '/app.js');
  assert.equal(plain.status, 200); assert.equal(plain.headers['content-encoding'], undefined); assert.equal(plain.headers['cache-control'], 'no-cache');
  const gz = await get(port, '/app.js', { 'Accept-Encoding': 'gzip, br' });
  assert.equal(gz.headers['content-encoding'], 'gzip'); assert.ok(gz.body.length < plain.body.length / 2);
  assert.deepEqual(zlib.gunzipSync(gz.body), plain.body);
  const again = await get(port, '/app.js', { 'If-None-Match': gz.headers.etag });
  assert.equal(again.status, 304); assert.equal(again.body.length, 0);
  const loc = await get(port, '/locales.js', { 'Accept-Encoding': 'gzip' });
  assert.equal(loc.headers['content-encoding'], 'gzip'); assert.equal((await get(port, '/locales.js', { 'If-None-Match': loc.headers.etag })).status, 304);

  const login = await get(port, '/api/login', { method: 'POST', 'Content-Type': 'application/json', body: JSON.stringify({ password: 'demo-password' }) });
  assert.equal(login.status, 200);
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const st = await get(port, '/api/state', { Cookie: cookie, 'Accept-Encoding': 'gzip' });
  assert.equal(st.status, 200); assert.equal(st.headers['cache-control'], 'no-store');
  const json = st.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(st.body).toString() : st.body.toString();
  assert.ok(Array.isArray(JSON.parse(json).servers));
  if (json.length > 2048) assert.equal(st.headers['content-encoding'], 'gzip');
  const raw = await get(port, '/api/state', { Cookie: cookie });
  assert.equal(raw.headers['content-encoding'], undefined); JSON.parse(raw.body.toString());
});
