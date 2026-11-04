'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { start } = require('../packaging/smoke');
const { dataDir } = require('../packaging/launcher');
const { copyTree, keep } = require('../packaging/assemble');
const { checkPayload } = require('../packaging/check-payload');
const { Vault } = require('../lib/vault');
const password = 'test-password-at-least-ten';

const chrome = process.env.CHROME_BIN || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find(file => fs.existsSync(file));
test('Chrome: setup requires the launch token, clears the hash and switches to login', { skip: !chrome || process.env.TW_REAL_BROWSER_TEST !== '1' }, async () => {
  await require('../packaging/browser-smoke').browserSmoke(chrome);
});

test('ordinary server never exposes setup or quit', async () => {
  const app = await start({ launcher: false });
  try {
    assert.deepEqual(await (await app.request('/api/status')).json(), { setup: false, authed: false });
    assert.equal((await app.request('/api/setup', { password, setupToken: 'guess' })).status, 404);
    assert.equal((await app.request('/api/quit', {})).status, 404);
  } finally { await app.close(); }
});
test('setup validates token and password, succeeds once, requires login to quit', async () => {
  const app = await start({ env: { TW_SETUP_TOKEN: 'test-secret' } });
  try {
    assert.equal((await (await app.request('/api/status')).json()).webSetup, true);
    assert.equal((await app.request('/api/quit', {})).status, 401);
    assert.equal((await app.request('/api/setup', { password, setupToken: 'wrong-length' })).status, 403);
    assert.equal((await app.request('/api/setup', { password, setupToken: 123 })).status, 403);
    assert.equal((await app.request('/api/setup', { password: 'short', setupToken: 'test-secret' })).status, 400);
    assert.equal(fs.existsSync(path.join(app.data, 'vault.json')), false);
    const results = await Promise.all([1, 2].map(() => app.request('/api/setup', { password, setupToken: 'test-secret' })));
    assert.deepEqual(results.map(r => r.status).sort(), [200, 404]);
    assert.equal((await app.request('/api/setup', { password, setupToken: 'test-secret' })).status, 404);
    assert.equal((await (await app.request('/api/status')).json()).webSetup, undefined);
    assert.equal((await app.request('/api/quit', {})).status, 401);
    const login = await app.request('/api/login', { password });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await app.request('/api/quit', {}, cookie)).status, 200);
    assert.equal((await app.exited).code, 0);
  } finally { await app.close(); }
});
test('an existing vault disables setup even with the environment token', async () => {
  const app = await start({ launcher: false, env: { TW_SETUP_TOKEN: 'test-secret' }, beforeStart: dir => new Vault(path.join(dir, 'vault.json')).create(password) });
  try {
    assert.equal((await (await app.request('/api/status')).json()).webSetup, undefined);
    assert.equal((await app.request('/api/setup', { password: 'replacement-password', setupToken: 'test-secret' })).status, 404);
    assert.equal((await app.request('/api/login', { password })).status, 200);
    assert.equal((await app.request('/api/quit', {})).status, 404);
  } finally { await app.close(); }
});
test('a second launcher exits without starting another server or overwriting data', async () => {
  const app = await start();
  try {
    await promisify(execFile)(process.execPath, [path.resolve('packaging/launcher.js'), '--no-open'], {
      env: { ...process.env, TW_DATA: app.data, TW_PORT: String(app.port) }, timeout: 10000,
    });
    assert.equal((await app.request('/api/status')).status, 200);
    assert.equal(fs.existsSync(path.join(app.data, 'vault.json')), false);
  } finally { await app.close(); }
});
test('launcher uses per-user platform paths and honors an explicit data override', () => {
  assert.equal(dataDir('win32', { APPDATA: '/roaming' }, '/fixture/user'), path.join('/roaming', 'Termnest'));
  assert.equal(dataDir('win32', {}, '/fixture/user'), path.join('/fixture/user', 'AppData', 'Roaming', 'Termnest'));
  assert.equal(dataDir('darwin', {}, '/fixture/user'), path.join('/fixture/user', 'Library', 'Application Support', 'Termnest'));
  assert.equal(dataDir('darwin', { TW_DATA: '/custom' }, '/fixture/user'), path.resolve('/custom'));
  assert.equal(dataDir('linux', {}, '/fixture/user'), path.join('/fixture/user', '.local', 'share', 'Termnest'));
  assert.equal(dataDir('linux', { XDG_DATA_HOME: '/xdg' }, '/fixture/user'), path.join('/xdg', 'Termnest'));
});
test('assembly prunes development/native build files but preserves runtime assets and helpers', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-payload-test-'));
  const source = path.join(temp, 'source');
  const files = [
    'node-pty/prebuilds/win32-x64/pty.node', 'node-pty/prebuilds/win32-x64/winpty.dll',
    'node-pty/prebuilds/win32-x64/winpty-agent.exe', 'node-pty/prebuilds/win32-x64/conpty/conpty.dll',
    'node-pty/prebuilds/win32-arm64/pty.node', 'node-pty/prebuilds/darwin-arm64/pty.node',
    'node-pty/prebuilds/darwin-arm64/spawn-helper', 'node-pty/prebuilds/darwin-x64/spawn-helper',
    'node-pty/src/unix.cc', 'node-pty/deps/file', 'node-pty/third_party/file', 'node-pty/binding.gyp', 'node-pty/scripts/file',
    'node-pty/prebuilds/win32-x64/debug.pdb', '@xterm/xterm/src/file', '@xterm/xterm/lib/xterm.js',
    '@xterm/addon-fit/lib/addon-fit.js', 'nan/index.js', 'node-addon-api/index.js', 'cpu-features/lib/index.js',
    'ssh2/lib/protocol/crypto.js', 'ssh2/lib/protocol/crypto/build/Release/sshcrypto.node',
    'ws/index.js', 'ws/LICENSE', 'ws/README.md', 'ws/index.js.map',
    'node-pty/build/Release/pty.node', 'node-pty/build/Release/obj.target/pty/src/unix/pty.o', 'node-pty/build/config.gypi', 'node-pty/build/Makefile',
  ];
  try {
    for (const file of files) { const full = path.join(source, file); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, 'fixture'); }
    for (const platform of ['win32', 'darwin', 'linux']) {
      const out = path.join(temp, platform); copyTree(source, out, platform);
      assert.equal(fs.existsSync(path.join(out, '@xterm/xterm/lib/xterm.js')), true);
      assert.equal(fs.existsSync(path.join(out, '@xterm/addon-fit/lib/addon-fit.js')), true);
      assert.equal(fs.existsSync(path.join(out, 'ssh2/lib/protocol/crypto.js')), true);
      assert.equal(fs.readFileSync(path.join(out, 'ws/LICENSE'), 'utf8'), 'fixture');
      for (const file of files.filter(file => /src\/|deps\/|third_party\/|binding.gyp|scripts\/|\.pdb|\.map|README|^nan\/|^node-addon-api\/|^cpu-features\/|sshcrypto/.test(file))) assert.equal(fs.existsSync(path.join(out, file)), false, file);
      assert.equal(fs.existsSync(path.join(out, 'node-pty/prebuilds/win32-arm64')), false);
      assert.equal(fs.existsSync(path.join(out, 'node-pty/prebuilds/win32-x64')), platform === 'win32');
      assert.equal(fs.existsSync(path.join(out, 'node-pty/prebuilds/darwin-arm64')), platform === 'darwin');
      if (platform === 'darwin' && process.platform !== 'win32') assert.equal(fs.statSync(path.join(out, 'node-pty/prebuilds/darwin-x64/spawn-helper')).mode & 0o777, 0o755);
      if (platform === 'win32') for (const file of files.slice(1, 4)) assert.equal(fs.existsSync(path.join(out, file)), true);
      // Only Linux compiles node-pty during assembly, and ships just the addon itself.
      assert.equal(fs.existsSync(path.join(out, 'node-pty/build/Release/pty.node')), platform === 'linux');
      for (const file of ['node-pty/build/Release/obj.target/pty/src/unix/pty.o', 'node-pty/build/config.gypi', 'node-pty/build/Makefile']) assert.equal(fs.existsSync(path.join(out, file)), false);
      checkPayload(out);
    }
    assert.equal(keep('data/vault.json', 'darwin'), false);
    const forbidden = path.join(temp, 'forbidden'); fs.mkdirSync(forbidden); fs.writeFileSync(path.join(forbidden, 'vault.json'), '{}');
    assert.throws(() => checkPayload(forbidden), /Forbidden/);
    const artifact = path.join(temp, 'Termnest-Setup.exe'); fs.writeFileSync(artifact, ''); fs.truncateSync(artifact, 60 * 1024 * 1024 + 1);
    assert.throws(() => checkPayload(path.join(temp, 'darwin'), artifact), /size/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
