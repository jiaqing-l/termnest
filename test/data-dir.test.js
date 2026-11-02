'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { dataDir } = require('../packaging/launcher');
const { Vault } = require('../lib/vault');

function fixture(t, platform = 'darwin') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'termnest-migration-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const parent = platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : path.join(home, 'roaming');
  const env = platform === 'win32' ? { APPDATA: parent } : {};
  const legacy = path.join(parent, 'Tmux Dev'), target = path.join(parent, 'Termnest');
  fs.mkdirSync(path.join(legacy, 'settings'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'settings', 'theme.json'), '{"theme":"dark"}', { mode: 0o600 });
  const prefs = { commands: ['echo hello'], pets: { enabled: true } };
  const servers = [{ id: 'demo', host: '192.0.2.10', user: 'demo', key: 'fixture-ssh-key' }];
  new Vault(path.join(legacy, 'vault.json')).create('migration-password', { servers, prefs });
  const bytes = fs.readFileSync(path.join(legacy, 'vault.json'));
  return { home, parent, env, legacy, target, bytes, prefs, servers,
    run: (io = fs) => dataDir(platform, env, home, io) };
}
function intact(f) {
  assert.deepEqual(fs.readFileSync(path.join(f.target, 'vault.json')), f.bytes);
  const vault = new Vault(path.join(f.target, 'vault.json'));
  assert.equal(vault.unlock('migration-password'), true);
  assert.deepEqual(vault.data.servers, f.servers);
  assert.deepEqual(vault.data.prefs, f.prefs);
  assert.equal(fs.readFileSync(path.join(f.target, 'settings/theme.json'), 'utf8'), '{"theme":"dark"}');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(f.target, 'settings/theme.json')).mode & 0o777, 0o600);
}
for (const platform of ['darwin', 'win32']) {
  test(`${platform}: move preserves encrypted vault, password, servers and settings; repeated calls are safe`, t => {
    const f = fixture(t, platform);
    assert.equal(f.run(), f.target); intact(f);
    assert.equal(fs.existsSync(f.legacy), false);
    assert.equal(f.run(), f.target); intact(f);
  });
  test(`${platform}: copy fallback publishes a complete vault and retains the legacy backup`, t => {
    const f = fixture(t, platform);
    const io = { ...fs, renameSync(from, to) {
      if (from === f.legacy) throw Object.assign(new Error('cross-volume'), { code: 'EXDEV' });
      fs.renameSync(from, to);
    } };
    assert.equal(f.run(io), f.target); intact(f);
    assert.deepEqual(fs.readFileSync(path.join(f.legacy, 'vault.json')), f.bytes);
    assert.deepEqual(fs.readdirSync(f.parent).sort(), ['Termnest', 'Tmux Dev']);
  });
}
test('copy or publish failure never leaves a partial installation or removes legacy data; retry succeeds', t => {
  for (const fail of ['copy', 'publish']) {
    const f = fixture(t);
    const io = { ...fs, renameSync() { throw new Error('move blocked'); }, cpSync(from, to, opts) {
      fs.cpSync(from, to, opts);
      if (fail === 'copy') throw new Error('disk full');
    } };
    assert.throws(() => f.run(io), /Could not migrate/);
    assert.equal(fs.existsSync(f.target), false);
    assert.deepEqual(fs.readFileSync(path.join(f.legacy, 'vault.json')), f.bytes);
    assert.deepEqual(fs.readdirSync(f.parent), ['Tmux Dev']);
    assert.equal(f.run(), f.target); intact(f);
  }
});
test('an existing Termnest directory takes precedence without merging or altering old data', t => {
  const f = fixture(t);
  fs.mkdirSync(f.target); fs.writeFileSync(path.join(f.target, 'vault.json'), 'existing');
  assert.equal(f.run(), f.target);
  assert.equal(fs.readFileSync(path.join(f.target, 'vault.json'), 'utf8'), 'existing');
  assert.deepEqual(fs.readFileSync(path.join(f.legacy, 'vault.json')), f.bytes);
});
test('TW_DATA bypasses migration and Linux retains its legacy directory', t => {
  const f = fixture(t);
  assert.equal(dataDir('darwin', { TW_DATA: './custom-data' }, f.home), path.resolve('./custom-data'));
  assert.equal(dataDir('linux', {}, f.home), path.join(f.home, '.tmux-web'));
  assert.equal(fs.existsSync(f.target), false);
  assert.ok(fs.existsSync(f.legacy));
});
test('fresh installs resolve Termnest paths without creating directories', t => {
  const f = fixture(t, 'win32'); fs.rmSync(f.legacy, { recursive: true });
  assert.equal(f.run(), f.target); assert.equal(fs.existsSync(f.target), false);
  assert.equal(dataDir('win32', {}, f.home), path.join(f.home, 'AppData', 'Roaming', 'Termnest'));
});
