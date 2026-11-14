'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), cp = require('node:child_process');
const { acquireDataLock } = require('../lib/service-runtime');
const { Vault } = require('../lib/vault');

test('set-password refuses while the data lock is held and, once free, drops copies made with the old password', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-setpw-'));
  try {
    const v = new Vault(path.join(dir, 'vault.json')); v.create('old-password-1', { servers: [] });
    const env = { ...process.env, TW_DATA: dir, TW_OLD_PASSWORD: 'old-password-1', TW_NEW_PASSWORD: 'new-password-2' };
    const lock = await acquireDataLock(dir, { strict: false });
    const busy = cp.spawnSync(process.execPath, [path.join(__dirname, '../scripts/set-password.js')], { env, encoding: 'utf8' });
    assert.equal(busy.status, 1); assert.match(busy.stderr, /đang chạy/);
    assert.equal(new Vault(path.join(dir, 'vault.json')).unlock('old-password-1'), true);   // untouched
    lock.release();
    const ok = cp.spawnSync(process.execPath, [path.join(__dirname, '../scripts/set-password.js')], { env, encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(new Vault(path.join(dir, 'vault.json')).unlock('new-password-2'), true);
    assert.equal(new Vault(path.join(dir, 'vault.json')).unlock('old-password-1'), false);   // old copies no longer open with it
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
