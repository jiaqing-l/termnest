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
    v.save(); assert.equal(copies().length, 1);   // 20 minutes > 15 but nothing changed: no new copy
    v.data.servers.push('x'); v.save(); assert.equal(copies().length, 2);   // changed: a new copy
    v.data.prefs.backupMinutes = 1440; v.data.servers.push('y'); v.save(); assert.equal(copies().length, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('copies also go to a folder of the user\'s choice, and synced cloud folders are suggested', () => {
  const { cloudFolders, checkFolder } = require('../lib/backup');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-extra-')), file = path.join(dir, 'data', 'vault.json'), drive = path.join(dir, 'drive');
  try {
    fs.mkdirSync(drive);
    assert.equal(checkFolder(drive), '');
    assert.equal(checkFolder('relative/dir'), 'invalid'); assert.equal(checkFolder(path.join(dir, 'missing')), 'notfound');
    fs.writeFileSync(path.join(dir, 'f'), ''); assert.equal(checkFolder(path.join(dir, 'f')), 'notdir');
    const v = new Vault(file); v.create('pw', { servers: ['a'], prefs: { backupDir: drive } });
    const mine = fs.readdirSync(path.join(drive, 'TERMNEST-backup'));
    assert.equal(mine.length, 1); assert.ok(!fs.readFileSync(path.join(drive, 'TERMNEST-backup', mine[0]), 'utf8').includes('"a"'));
    assert.equal(v.info().extra, path.join(drive, 'TERMNEST-backup')); assert.equal(v.info().extraError, '');
    // a copy from the other folder opens like any other once put back as the store
    fs.copyFileSync(path.join(drive, 'TERMNEST-backup', mine[0]), path.join(dir, 'restored.json'));
    const back = new Vault(path.join(dir, 'restored.json')); assert.equal(back.unlock('pw'), true); assert.deepEqual(back.data.servers, ['a']);
    // suggestions: a fake home with a Google Drive and an iCloud folder
    const home = path.join(dir, 'home'), gd = path.join(home, 'Library', 'CloudStorage', 'GoogleDrive-me@x.com', 'My Drive');
    fs.mkdirSync(gd, { recursive: true }); fs.mkdirSync(path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'), { recursive: true });
    assert.deepEqual(cloudFolders(home, 'darwin').map((c) => c.kind), ['gdrive', 'icloud']);
    assert.equal(cloudFolders(home, 'darwin')[0].path, gd);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a backup file opens only with its own password', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-read-')), file = path.join(dir, 'vault.json');
  try {
    new Vault(file).create('old-machine', { servers: [{ id: 's1' }], features: { notes: { notes: [{ t: 'ghi chú' }] } } });
    const text = fs.readFileSync(file, 'utf8');
    assert.deepEqual(Vault.read(text, 'old-machine').servers, [{ id: 's1' }]);
    assert.equal(Vault.read(text, 'old-machine').features.notes.notes[0].t, 'ghi chú');
    for (const [t, pw] of [[text, 'wrong'], ['not json', 'old-machine'], ['{"v":2}', 'old-machine'], ['{}', 'x']]) assert.equal(Vault.read(t, pw), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const { expired } = require('../lib/vault');
test('tiered retention keeps older days when many copies are made in a burst', () => {
  const now = Date.UTC(2026, 10, 14, 12), H = 3600000, D = 24 * H;
  const names = [];
  for (let i = 0; i < 30; i++) names.push(`vault-${now - i * 60000}.json`);            // burst of 30 within half an hour
  for (let d = 1; d <= 10; d++) names.push(`vault-${now - d * D}.json`);               // one a day before
  names.sort().reverse();
  const gone = new Set(expired(names, now)), kept = names.filter((n) => !gone.has(n));
  assert.ok(kept.length <= 28);
  for (let d = 1; d <= 10; d++) assert.ok(kept.includes(`vault-${now - d * D}.json`), `day ${d} kept`);
  assert.ok(kept.includes(`vault-${now}.json`));
});

test('an unchanged unlock does not add a copy; snapshot is verified and kept apart; orphan copies are reported', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-vault-')), file = path.join(dir, 'vault.json');
  try {
    const v = new Vault(file); v.create('pw', { servers: ['a'] });
    const copies = () => fs.readdirSync(path.join(dir, 'backups')).filter((f) => /^vault-\d{13}\.json$/.test(f));
    assert.equal(copies().length, 1);
    const w = new Vault(file); assert.equal(w.unlock('pw'), true); w.save();
    assert.equal(copies().length, 1, 'restart with the same data: no new copy');
    w.data.servers.push('b'); w.copyNext = true; w.save(); assert.equal(copies().length, 2);
    const snap = w.snapshot('prerestore');
    assert.ok(path.basename(snap).startsWith('vault-prerestore-')); assert.equal(copies().length, 2);
    assert.equal(Vault.read(fs.readFileSync(snap, 'utf8'), 'pw').servers.length, 2);
    assert.equal(Vault.orphanCopies(file), 0);
    fs.rmSync(file); assert.equal(Vault.orphanCopies(file), 2);
    // a snapshot that cannot be written throws
    fs.rmSync(path.join(dir, 'backups'), { recursive: true }); fs.writeFileSync(path.join(dir, 'backups'), 'x');
    assert.throws(() => w.snapshot('prerestore'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
