'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Vault } = require('../lib/vault');

test('the store keeps encrypted hourly copies and opens the newest good one when the file is damaged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-vault-')), file = path.join(dir, 'vault.json');
  try {
    const v = new Vault(file); v.create('pw', { servers: ['a'] });
    const copies = () => fs.readdirSync(path.join(dir, 'backups'));
    assert.equal(copies().length, 1);
    v.data.servers.push('b'); v.save();
    assert.equal(copies().length, 1);   // at most one copy an hour
    assert.ok(!fs.readFileSync(path.join(dir, 'backups', copies()[0]), 'utf8').includes('"a"'));   // copies are encrypted too
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o077, 0);
    // an older copy set: keep only the newest ten
    for (let i = 0; i < 12; i++) fs.copyFileSync(path.join(dir, 'backups', copies()[0]), path.join(dir, 'backups', `vault-${1700000000000 + i}.json`));
    fs.renameSync(path.join(dir, 'backups', copies().sort().at(-1)), path.join(dir, 'backups', `vault-${Date.now() - 2 * 3600000}.json`));
    v.save(); assert.equal(copies().length, 10);
    // damaged file: the newest copy opens with the same password, the damaged file is kept aside
    fs.writeFileSync(file, '{"v":1,"salt":"x"');
    const w = new Vault(file);
    assert.equal(w.unlock('wrong'), false);
    assert.equal(w.unlock('pw'), true);
    assert.ok(w.recovered && w.recovered.at > 0);
    assert.deepEqual(w.data.servers, ['a', 'b']);
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('vault.json.damaged-')));
    const again = new Vault(file); assert.equal(again.unlock('pw'), true); assert.equal(again.recovered, null);   // repaired
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the copy interval follows the setting', () => {
  const { cleanPrefs, mergePrefs } = require('../lib/parse');
  assert.equal(mergePrefs().backupMinutes, 60);
  assert.equal(cleanPrefs({ backupMinutes: 15 }).backupMinutes, 15);
  assert.throws(() => cleanPrefs({ backupMinutes: 5 }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-vault-')), file = path.join(dir, 'vault.json');
  try {
    const v = new Vault(file); v.create('pw', { servers: [], prefs: { backupMinutes: 15 } });
    const copies = () => fs.readdirSync(path.join(dir, 'backups'));
    const only = copies()[0]; fs.renameSync(path.join(dir, 'backups', only), path.join(dir, 'backups', `vault-${Date.now() - 20 * 60000}.json`));
    v.save(); assert.equal(copies().length, 2);   // 20 minutes > 15: a new copy
    v.data.prefs.backupMinutes = 1440; v.save(); assert.equal(copies().length, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
