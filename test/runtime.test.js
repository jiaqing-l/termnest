 'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('runtime ZIP extracts with spaces and Unicode paths despite a conflicting tar on PATH', {
  skip: !['darwin', 'win32'].includes(process.platform),
}, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-runtime-'));
  try {
    const folder = path.join(temp, 'Termnest tiếng Việt');
    fs.mkdirSync(folder);
    const archive = path.join(folder, 'node.zip');
    fs.writeFileSync(archive, Buffer.from('UEsDBBQAAAAAAFWHYl0fiHmsHAAAABwAAAARAAAAcnVudGltZS9oZWxsby50eHRUZXJtbmVzdCDigJQgVGnhur9uZyBWaeG7h3QKUEsBAhQDFAAAAAAAVYdiXR+IeawcAAAAHAAAABEAAAAAAAAAAAAAAIABAAAAAHJ1bnRpbWUvaGVsbG8udHh0UEsFBgAAAAABAAEAPwAAAEsAAAAAAA==', 'base64'));
    const poison = path.join(temp, 'bin');
    fs.mkdirSync(poison);
    // An unrelated executable named tar must never be selected from PATH.
    fs.copyFileSync(process.execPath, path.join(poison, process.platform === 'win32' ? 'tar.exe' : 'tar'));
    execFileSync(process.execPath, ['-e',
      "require('./packaging/runtime').extractArchive(process.argv[1], process.argv[2])",
      archive, folder], { cwd: path.resolve(__dirname, '..'),
      env: {...process.env, PATH: poison}, encoding: 'utf8' });
    assert.equal(fs.readFileSync(path.join(folder, 'runtime/hello.txt'), 'utf8'), 'Termnest — Tiếng Việt\n');
    // A distinct Unicode destination must take the ASCII staging fallback.
    const destination = path.join(temp, 'Đích giải nén');
    execFileSync(process.execPath, ['-e',
      "require('./packaging/runtime').extractArchive(process.argv[1], process.argv[2])",
      archive, destination], { cwd: path.resolve(__dirname, '..'),
      env: {...process.env, PATH: poison}, encoding: 'utf8' });
    assert.equal(fs.readFileSync(path.join(destination, 'runtime/hello.txt'), 'utf8'), 'Termnest — Tiếng Việt\n');
    assert.equal(fs.readdirSync(folder).some(name => name.startsWith('tmux-extract-')), false);

  } finally { fs.rmSync(temp, {recursive: true, force: true}); }
});

test('release preparation uses npm script context without downloading another Node', () => {
  const root = path.resolve(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['prepare:desktop'], 'node packaging/prepare-desktop.js');
  for (const name of ['.github/workflows/release.yml', 'packaging/mac/build-app.sh', 'docs/development.md']) {
    const text = fs.readFileSync(path.join(root, name), 'utf8');
    assert.match(text, /npm run prepare:desktop/);
    assert.doesNotMatch(text, /npm exec -- node/);
  }
});
