'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const { build, safeEntry } = require('../scripts/package-update');
const root = path.resolve(__dirname, '..');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termnest-package-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
function put(dir, name, bytes, mode = 0o644) {
  const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes, { mode });
}
test('bundle contains exact runnable sources, manifests, platform scripts and file modes', t => {
  const dir = fixture(t), output = path.join(dir, 'termnest-update-test.tar.gz');
  const result = build({ output });
  const extracted = path.join(dir, 'out'); fs.mkdirSync(extracted); execFileSync('tar', ['-xzpf', path.relative(extracted, output).split(path.sep).join('/')], { cwd: extracted });
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  for (const name of ['server.js', 'lib/vault.js', 'package.json', 'package-lock.json', 'docs/supervisor.md', 'docs/server-backups.md', 'scripts/install-supervisor.sh', 'scripts/prepare-pty.js']) assert.ok(result.entries.includes(name), name);
  for (const name of ['scripts/install-supervisor.ps1', 'scripts/install-supervisor-macos.sh']) if (fs.existsSync(path.join(root, name))) assert.ok(result.entries.includes(name), 'platform installer included');
  const sums = fs.readFileSync(path.join(extracted, 'SHA256SUMS'), 'utf8');
  for (const name of result.entries.filter(n => n !== 'SHA256SUMS')) {
    assert.ok(safeEntry(name), name); assert.match(sums, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.deepEqual(fs.readFileSync(path.join(extracted, name)), fs.readFileSync(path.join(root, name)), name);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(extracted, name)).mode & 0o777, fs.statSync(path.join(root, name)).mode & 0o777, name);
  }
});
test('real extracted source archive boots on loopback with pinned dependencies and isolated DATA', { timeout: 20000 }, async t => {
  const dir = fixture(t), output = path.join(dir, 'update.tar.gz'), extracted = path.join(dir, 'app');
  const { entries } = build({ output });
  // Check the archive before adding the external dependency link to this fixture only.
  assert.ok(entries.includes('lib/vault.js'));
  for (const name of entries) assert.ok(name === 'SHA256SUMS' || safeEntry(name), name);
  assert.ok(!entries.some(name => name.split('/').includes('node_modules')));
  fs.mkdirSync(extracted); execFileSync('tar', ['-xzpf', path.relative(extracted, output).split(path.sep).join('/')], { cwd: extracted });
  fs.symlinkSync(fs.realpathSync(path.join(root, 'node_modules')), path.join(extracted, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const fromArchive = createRequire(path.join(extracted, 'package.json'));
  const pkg = fromArchive('./package.json'), lock = fromArchive('./package-lock.json');
  for (const [name, version] of Object.entries(pkg.dependencies)) {
    assert.equal(fromArchive(name + '/package.json').version, version, name + ' installed pin');
    assert.equal(lock.packages['node_modules/' + name].version, version, name + ' lock pin');
  }
  const data = path.join(dir, 'data'), home = path.join(dir, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  // Never inherit boot credentials, setup tokens, app DATA or Node preload hooks.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(TW_|NODE_OPTIONS$|NODE_PATH$)/.test(key)));
  Object.assign(env, { TW_DATA: data, TW_PORT: '0', TW_DEFAULT_DIR: home, HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share') });
  const child = spawn(process.execPath, ['-e', `const {server}=require('./server'); server.once('listening',()=>console.log('ARCHIVE_LISTEN='+JSON.stringify(server.address())));`],
    { cwd: extracted, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let outputText = '', spawnError;
  child.stdout.on('data', bytes => { outputText += bytes; });
  child.stderr.on('data', bytes => { outputText += bytes; });
  child.on('error', error => { spawnError = error; });
  const closed = once(child, 'close');
  let forced = false;
  async function stop() {
    if (child.exitCode !== null || child.signalCode !== null) return closed;
    child.kill('SIGTERM');
    const deadline = setTimeout(() => { forced = true; child.kill('SIGKILL'); }, 4000);
    try { return await closed; } finally { clearTimeout(deadline); }
  }
  try {
    const deadline = Date.now() + 10000;
    while (!outputText.includes('ARCHIVE_LISTEN=')) {
      if (spawnError) throw spawnError;
      assert.equal(child.exitCode, null, outputText);
      assert.equal(child.signalCode, null, outputText);
      assert.ok(Date.now() < deadline, 'archive startup timeout: ' + outputText);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const address = JSON.parse(outputText.match(/ARCHIVE_LISTEN=(.+)/)[1]);
    assert.equal(address.address, '127.0.0.1'); assert.ok(address.port > 0);
    const request = route => fetch(`http://127.0.0.1:${address.port}${route}`, { signal: AbortSignal.timeout(2000), headers: { Connection: 'close' } });
    const identity = await request('/__app'); assert.equal(identity.status, 200);
    assert.equal((await identity.json()).app, 'tmux-dev');
    const health = await request('/api/supervisor/status'); assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { processAlive: true, unlocked: false, monitoring: false, error: false, observationsFresh: false, validatedAuditCompletion: false });
    assert.equal(health.headers.get('set-cookie'), null);
    assert.deepEqual(await (await request('/api/status')).json(), { setup: false, authed: false });
    const protectedResponse = await request('/api/state'); assert.equal(protectedResponse.status, 401); await protectedResponse.text();
    const page = await request('/'); assert.equal(page.status, 200); assert.match(await page.text(), /<html/i);
    assert.ok(fs.existsSync(path.join(data, 'service.lock')), 'real DATA lock acquired');
    const stopped = await stop();
    if (process.platform !== 'win32') assert.deepEqual(stopped, [0, null], outputText); // Windows has no SIGTERM: kill() ends it at once
    assert.equal(forced, false, 'owned server stopped gracefully');
    // Windows ends the process at once (no exit handler); the next start recognises the stale lock instead.
    if (process.platform !== 'win32') assert.equal(fs.existsSync(path.join(data, 'service.lock')), false, 'DATA lock released');
    assert.equal(fs.existsSync(path.join(data, 'vault.json')), false, 'no real or synthetic accounts loaded');
  } finally { await stop(); }
});
test('sentinel secrets, recursive archives, hidden metadata and native extensions are excluded', t => {
  const dir = fixture(t), source = path.join(dir, 'source');
  for (const name of ['server.js', 'package.json', 'package-lock.json', 'docs/supervisor.md', 'docs/server-backups.md', 'lib/ok.js', 'public/ok.css', 'scripts/install-supervisor.ps1', 'scripts/install-supervisor-macos.sh']) put(source, name, 'safe source\n');
  const excluded = ['.env', 'data/vault.json', 'node_modules/secret.js', 'implementation/old.tar.gz', 'public/.DS_Store', 'lib/.env', 'scripts/private.key', 'lib/credentials.json', 'lib/vault.json', 'lib/vault.js.bak', 'lib/vault/record.js', 'public/vault.js', 'scripts/vault.js', 'lib/nested/vault.js', 'lib/secret.js', 'public/data/secret.json', 'public/nested/old.tar.gz', 'lib/mac.node'];
  for (const name of excluded) put(source, name, 'SENTINEL-SECRET');
  const output = path.join(source, 'implementation', 'termnest-update-test.tar.gz');
  const { entries } = build({ source, output });
  for (const name of excluded) assert.ok(!entries.includes(name), name);
  for (const name of ['scripts/install-supervisor.ps1', 'scripts/install-supervisor-macos.sh']) assert.ok(entries.includes(name), 'platform installer is included: ' + name);
  const out = path.join(dir, 'out'); fs.mkdirSync(out); execFileSync('tar', ['-xzf', path.relative(out, output).split(path.sep).join('/')], { cwd: out });
  for (const name of entries) assert.ok(!fs.readFileSync(path.join(out, name)).includes('SENTINEL-SECRET'));
  assert.deepEqual(build({ source, output }).entries, entries, 'repeat build does not recursively include output');
});
test('unsafe paths, symlinks and disguised native binaries fail closed without replacing prior output', t => {
  for (const name of ['../secret', '/secret', 'lib/../secret', 'lib/a\nb', 'lib/secret.key', 'lib/node_modules/a.js', 'lib/.env']) assert.equal(safeEntry(name), false, name);
  const dir = fixture(t), source = path.join(dir, 'source'), output = path.join(dir, 'old.tar.gz');
  for (const name of ['server.js', 'package.json', 'package-lock.json', 'docs/supervisor.md', 'docs/server-backups.md', 'lib/ok.js', 'public/ok.css', 'scripts/ok.js']) put(source, name, 'source');
  fs.writeFileSync(output, 'prior artifact');
  if (process.platform !== 'win32') {
    fs.symlinkSync(path.join(source, 'server.js'), path.join(source, 'lib/link.js'));
    assert.throws(() => build({ source, output }), /symlink/); fs.unlinkSync(path.join(source, 'lib/link.js'));
  }
  put(source, 'lib/native', Buffer.from('7f454c460000', 'hex'));
  assert.throws(() => build({ source, output }), /native binary/);
  fs.unlinkSync(path.join(source, 'lib/native'));
  assert.throws(() => build({ source, output, tar: path.join(dir, 'missing-tar') }), /ENOENT/);
  assert.equal(fs.readFileSync(output, 'utf8'), 'prior artifact');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['old.tar.gz', 'source']);
});
test('exact vault source exception retains regular-file, link and native-byte checks', t => {
  assert.equal(safeEntry('lib/vault.js'), true);
  const dir = fixture(t), source = path.join(dir, 'source'), output = path.join(dir, 'old.tar.gz');
  for (const name of ['server.js', 'package.json', 'package-lock.json', 'docs/supervisor.md', 'docs/server-backups.md', 'lib/ok.js', 'public/ok.css', 'scripts/ok.js']) put(source, name, 'source');
  fs.writeFileSync(output, 'prior artifact');
  const vault = path.join(source, 'lib/vault.js');
  if (process.platform !== 'win32') {
    fs.symlinkSync(path.join(source, 'lib/ok.js'), vault);
    assert.throws(() => build({ source, output }), /symlink: lib\/vault.js/); fs.unlinkSync(vault);
  }
  put(dir, 'external.js', 'source');
  fs.linkSync(path.join(dir, 'external.js'), vault);
  assert.throws(() => build({ source, output }), /single-link file: lib\/vault.js/); fs.unlinkSync(vault);
  for (const magic of ['7f454c46', 'feedfacf', '4d5a0000']) {
    put(source, 'lib/vault.js', Buffer.from(magic, 'hex'));
    assert.throws(() => build({ source, output }), /native binary: lib\/vault.js/);
  }
  assert.equal(fs.readFileSync(output, 'utf8'), 'prior artifact');
});
