'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFeatures } = require('../lib/features');
const { Vault } = require('../lib/vault');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-private-host-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lib = path.join(root, 'features'); fs.mkdirSync(lib); const vault = new Vault(path.join(root, 'vault.json'));
  const deps = { dataDir: root, vault: () => vault, save: () => vault.save(), remotes: () => new Map(), backendOf: () => null, send() {}, fail() {}, readJson: async () => ({}) };
  const features = createFeatures({ libDir: lib, publicDir: root, deps, log: { log() {}, error() {} } });
  fs.writeFileSync(path.join(lib, 'probe.js'), `module.exports={name:'probe',register(h){h.provide('probe',h);}};`); features.load();
  return { root, vault, host: features.service('probe') };
}
test('private host registers while locked and exposes no key through public feature contracts', t => {
  const f = fixture(t); assert.equal(f.host.privateData.unlocked(), false); assert.deepEqual(f.host.settings.get(), {});
  assert.deepEqual(f.host.privateData.servers(), []); assert.equal(f.host.privateData.directory(), f.root);
  assert.throws(() => f.host.privateData.forceVaultBackup(), /vault_locked/);
  f.vault.create('synthetic-password', { servers: [{ id: 'vm1', host: 'vm.invalid', key: 'private secret' }] });
  assert.deepEqual(f.host.privateData.servers(), [{ id: 'vm1', name: 'vm.invalid', local: false }]);
});
test('forced vault copy must actually contain the current private feature key', t => {
  const f = fixture(t); f.vault.create('synthetic-password');
  f.host.settings.set({ contentKey: 'first-key' }); f.host.privateData.forceVaultBackup();
  const backup = path.join(f.vault.info().dir, `vault-${f.vault.info().lastAt}.json`);
  assert.equal(Vault.read(fs.readFileSync(backup, 'utf8'), 'synthetic-password').features.probe.contentKey, 'first-key');
  f.host.settings.set({ contentKey: 'new-key' }); f.vault.copy = () => {};
  assert.throws(() => f.host.privateData.forceVaultBackup(), /vault_backup_failed/);
});
