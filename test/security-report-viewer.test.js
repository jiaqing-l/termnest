'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { inlineAssets } = require('../lib/html-assets');
const { injectReportLinks } = require('../lib/report-links');

test('data files are never inlined through <script src> or <link>', async () => {
  const read = async (abs) => ({ text: 'SECRET:' + abs, kind: 'text' });
  const html = '<script type="application/json" src="../appsettings.json"></script><script src="d.json"></script><script src="ok.js"></script><link rel="stylesheet" href=".env"><link rel="stylesheet" href="a.css">';
  const out = await inlineAssets(html, '/w/s/report.html', read);
  assert.ok(!out.includes('SECRET:/w/appsettings.json') && !out.includes('SECRET:/w/s/d.json') && !out.includes('.env\nSECRET'));
  assert.ok(!out.includes('SECRET:/w/s/.env'));
  assert.ok(out.includes('SECRET:/w/s/ok.js') && out.includes('SECRET:/w/s/a.css'));
});

test('report guard blocks navigation, drops meta refresh and keeps the doctype first', () => {
  const out = injectReportLinks('<!doctype html><html><head><meta http-equiv="refresh" content="0;url=https://x"></head><body>a</body></html>');
  assert.ok(out.startsWith('<!doctype html>'));
  assert.ok(!/http-equiv/i.test(out));
  assert.match(out, /addEventListener\('navigate'/);
});

test('drop folder: refuses a planted symlink, accepts a fresh 0700 folder', { skip: process.platform === 'win32' }, () => {   // POSIX mode bits and mkdir -m do not exist on Windows
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), cp = require('node:child_process');
  const { storeScript } = require('../lib/features/drop');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-drop-')), uid = process.getuid();
  try {
    const evil = path.join(tmp, 'evil'); fs.mkdirSync(evil);
    fs.symlinkSync(evil, path.join(tmp, `termnest-drop-${uid}`));
    const bad = cp.spawnSync('sh', ['-c', storeScript('a.txt')], { input: 'x', env: { ...process.env, TMPDIR: tmp } });
    assert.notEqual(bad.status, 0); assert.deepEqual(fs.readdirSync(evil), []);
    fs.unlinkSync(path.join(tmp, `termnest-drop-${uid}`));
    const ok = cp.spawnSync('sh', ['-c', storeScript('a.txt')], { input: 'x', env: { ...process.env, TMPDIR: tmp } });
    assert.equal(ok.status, 0);
    assert.equal(fs.statSync(path.join(tmp, `termnest-drop-${uid}`)).mode & 0o777, 0o700);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('login throttle is per client: a guesser is locked, the owner (another client) still signs in; logout closes terminals', { timeout: 30000 }, async (t) => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http'), net = require('node:net');
  const { spawn } = require('node:child_process'), { Vault } = require('../lib/vault');
  const root = path.resolve(__dirname, '..');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-thr-')), data = path.join(scratch, 'data');
  new Vault(path.join(data, 'vault.json')).create('demo-password', { servers: [] });
  const port = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const app = spawn(process.execPath, ['--require', path.join(__dirname, 'readme-fixture.cjs'), 'server.js'], { cwd: root,
    env: { ...process.env, HOME: scratch, USERPROFILE: scratch, TMPDIR: scratch, TW_DATA: data, TW_PORT: String(port), TW_TMUX_SOCKET: 'twqa', TW_PASSWORD_FILE: undefined, TW_PACKAGED: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; app.stdout.on('data', (b) => { log += b; }); app.stderr.on('data', (b) => { log += b; });
  t.after(async () => { const gone = new Promise((r) => app.once('exit', r)); app.kill(); await Promise.race([gone, new Promise((r) => setTimeout(r, 3000))]); fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  for (let i = 0; i < 100 && !log.includes('Termnest:'); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(log.includes('Termnest:'), log);
  const login = (password, ua) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ password });
    const req = http.request({ host: '127.0.0.1', port, path: '/api/login', method: 'POST', headers: { Host: '127.0.0.1:' + port, 'Content-Type': 'application/json', 'User-Agent': ua, 'Content-Length': Buffer.byteLength(body) } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end(body);
  });
  const codes = []; for (let i = 0; i < 6; i++) codes.push(await login('wrong' + i, 'curl/8'));
  assert.deepEqual(codes, [401, 401, 401, 401, 401, 429]);
  assert.equal(await login('demo-password', 'curl/8'), 429, 'the guesser stays locked even with the right password');
  assert.equal(await login('demo-password', 'Mozilla/5.0 owner'), 200, 'the owner is not locked out');
  assert.match(fs.readFileSync(path.join(root, 'server.js'), 'utf8'), /closeTermsOf\(out\)/);
});
