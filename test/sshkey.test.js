'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), cp = require('node:child_process');
const K = require('../lib/sshkey');
const { utils } = require('ssh2');

test('a made key is ed25519, installs once into authorized_keys with sshd permissions, and refuses non-keys', { skip: process.platform === 'win32' }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-ssh-'));
  try {
    const k = K.makeKey('my mac');
    assert.equal(utils.parseKey(k.private).type, 'ssh-ed25519'); assert.match(k.public, /^ssh-ed25519 \S+ termnest-mymac-/);
    const run = (input) => cp.spawnSync('sh', ['-c', K.INSTALL_SCRIPT], { env: { ...process.env, HOME: home }, input });
    assert.match(String(run(k.public + '\n').stdout), /INSTALLED/);
    assert.match(String(run(k.public + '\n').stdout), /INSTALLED/);
    const f = path.join(home, '.ssh', 'authorized_keys');
    assert.equal(fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length, 1);   // never twice
    assert.equal(fs.statSync(f).mode & 0o777, 0o600); assert.equal(fs.statSync(path.join(home, '.ssh')).mode & 0o777, 0o700);
    assert.notEqual(run('rm -rf /\n').status, 0);
    assert.match(K.manualCommand(k.public), /authorized_keys/);
    const ref = K.hold(k); assert.equal(K.take(ref).private, k.private); assert.equal(K.take(ref), null);   // one use
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
