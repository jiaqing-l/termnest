'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFileSync } = require('node:child_process');
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
  const extracted = path.join(dir, 'out'); fs.mkdirSync(extracted); execFileSync('tar', ['-xzpf', output, '-C', extracted]);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  for (const name of ['server.js', 'package.json', 'package-lock.json', 'docs/supervisor.md', 'scripts/install-supervisor.sh', 'scripts/prepare-pty.js']) assert.ok(result.entries.includes(name), name);
  for (const name of ['scripts/install-supervisor.ps1', 'scripts/install-supervisor-macos.sh']) if (fs.existsSync(path.join(root, name))) assert.ok(result.entries.includes(name), 'platform installer included');
  const sums = fs.readFileSync(path.join(extracted, 'SHA256SUMS'), 'utf8');
  for (const name of result.entries.filter(n => n !== 'SHA256SUMS')) {
    assert.ok(safeEntry(name), name); assert.match(sums, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.deepEqual(fs.readFileSync(path.join(extracted, name)), fs.readFileSync(path.join(root, name)), name);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(extracted, name)).mode & 0o777, fs.statSync(path.join(root, name)).mode & 0o777, name);
  }
});
test('sentinel secrets, recursive archives, hidden metadata and native extensions are excluded', t => {
  const dir = fixture(t), source = path.join(dir, 'source');
  for (const name of ['server.js', 'package.json', 'package-lock.json', 'docs/supervisor.md', 'lib/ok.js', 'public/ok.css', 'scripts/install-supervisor.ps1', 'scripts/install-supervisor-macos.sh']) put(source, name, 'safe source\n');
  const excluded = ['.env', 'data/vault.json', 'node_modules/secret.js', 'implementation/old.tar.gz', 'public/.DS_Store', 'lib/.env', 'scripts/private.key', 'lib/credentials.json', 'public/data/secret.json', 'public/nested/old.tar.gz', 'lib/mac.node'];
  for (const name of excluded) put(source, name, 'SENTINEL-SECRET');
  const output = path.join(source, 'implementation', 'termnest-update-test.tar.gz');
  const { entries } = build({ source, output });
  for (const name of excluded) assert.ok(!entries.includes(name), name);
  for (const name of ['scripts/install-supervisor.ps1', 'scripts/install-supervisor-macos.sh']) assert.ok(entries.includes(name), 'platform installer is included: ' + name);
  const out = path.join(dir, 'out'); fs.mkdirSync(out); execFileSync('tar', ['-xzf', output, '-C', out]);
  for (const name of entries) assert.ok(!fs.readFileSync(path.join(out, name)).includes('SENTINEL-SECRET'));
  assert.deepEqual(build({ source, output }).entries, entries, 'repeat build does not recursively include output');
});
test('unsafe paths, symlinks and disguised native binaries fail closed without replacing prior output', t => {
  for (const name of ['../secret', '/secret', 'lib/../secret', 'lib/a\nb', 'lib/secret.key', 'lib/node_modules/a.js', 'lib/.env']) assert.equal(safeEntry(name), false, name);
  const dir = fixture(t), source = path.join(dir, 'source'), output = path.join(dir, 'old.tar.gz');
  for (const name of ['server.js', 'package.json', 'package-lock.json', 'docs/supervisor.md', 'lib/ok.js', 'public/ok.css', 'scripts/ok.js']) put(source, name, 'source');
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
