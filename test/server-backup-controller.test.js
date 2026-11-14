'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Writable } = require('node:stream');
const { Vault } = require('../lib/vault');
const { createFeatures } = require('../lib/features');
async function within(promise, label, ms = 5000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('fixture timeout: ' + label)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function waitForRead(controller, reading) {
  await within(Promise.race([reading, controller.job.promise.then(() => { throw Error('backup ended before suspended read: ' + controller.status().servers[0]?.reason); })]), 'source read entered');
}
function fixture(t, locked = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-backup-controller-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vault = new Vault(path.join(root, 'vault.json')), libDir = path.join(root, 'lib'), home = path.join(root, 'source'); fs.mkdirSync(libDir); fs.mkdirSync(home);
  fs.writeFileSync(path.join(libDir, 'server-backup.js'), `module.exports=require(${JSON.stringify(require.resolve('../lib/features/server-backup'))});`);
  if (!locked) vault.create('synthetic-password', { servers: [{ id: 'vm', name: 'Synthetic VM' }] });
  const remotes = new Map([['vm', { cfg: { id: 'vm' }, ready: true }]]), logs = [];
  const deps = { dataDir: root, vault: () => vault, save: () => vault.save(), remotes: () => remotes, backendOf: id => remotes.get(id),
    readJson: async req => req.body, send: (res, status, body) => { res.status = status; res.body = body; }, fail: (res, status, message) => { res.status = status; res.body = { error: message }; } };
  const features = createFeatures({ libDir, publicDir: root, deps, log: { log: m => logs.push(m), error: m => logs.push(m) } }); features.load();
  const controller = features.service('server-backup'); controller.stop(); controller.stopped = false;
  // Model the Linux VM's wire protocol, not its scanner on the local test OS.
  // The native Linux scanner and SSH serialization have their own source fixtures.
  const sourceFiles = new Map(), remoteHome = '/synthetic/source';
  controller.options.transport = async function* (b, config, signal) {
    for (const [relative, file] of sourceFiles) {
      if (signal?.aborted) throw Object.assign(Error('cancelled'), { code: 'cancelled' });
      const chat = relative.match(/^(\.(claude|codex)[^/]*)\/(projects|sessions|archived_sessions)\/(.+\.jsonl)$/);
      const root = config.roots.findIndex(r => (remoteHome + '/' + relative).startsWith(r + '/'));
      if (!(chat && config.includeChats) && root < 0) continue;
      const scope = chat && config.includeChats ? { kind: 'chat', tool: chat[2], path: `chats/${chat[2]}/${relative}` } :
        { kind: 'file', path: `files/${root + 1}-${path.posix.basename(config.roots[root])}/${(remoteHome + '/' + relative).slice(config.roots[root].length + 1)}` };
      const bytes = fs.readFileSync(file);
      yield { t: 'file', ...scope, size: bytes.length, mtimeMs: fs.statSync(file).mtimeMs };
      for (let offset = 0; offset < bytes.length; offset += config.limits.chunkBytes) yield { t: 'chunk', data: bytes.subarray(offset, offset + config.limits.chunkBytes).toString('base64') };
      yield { t: 'end' };
    }
    yield { t: 'done', skipped: 0, reason: '' };
  };
  t.after(() => controller.stop());
  const request = async (method, route, body) => { const res = {}; await features.handle({ method, body }, res, new URL('/api/features/server-backup' + route, 'http://localhost')); return res; };
  const write = (p, bytes) => { const file = path.join(home, p); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); sourceFiles.set(p, file); return file; };
  return { root, vault, home: remoteHome, remotes, features, controller, logs, request, write };
}
async function finish(controller) { const job = controller.job; if (job) await within(job.promise, 'backup completion'); }

test('locked registration/status are safe and read-only; saved SSH hosts default to automatic all-chat scope', { timeout: 15000 }, async t => {
  const f = fixture(t, true); assert.deepEqual(f.features.names(), ['server-backup']);
  const before = fs.readdirSync(f.root); const status = await f.request('GET', '/status'); assert.equal(status.status, 200); assert.equal(status.body.enabled, false); assert.deepEqual(fs.readdirSync(f.root), before);
  assert.equal((await f.request('GET', '/snapshots?server=vm')).status, 401);
  f.vault.create('synthetic-password', { servers: [{ id: 'vm', name: 'Synthetic VM' }] });
  const ready = await f.request('GET', '/status'); assert.equal(ready.body.enabled, true); assert.equal(ready.body.intervalMinutes, 5); assert.equal(ready.body.retention, 32);
  assert.deepEqual(ready.body.servers[0].roots, []); assert.equal(ready.body.servers[0].includeChats, true); assert.equal(ready.body.servers[0].hasSnapshot, false); assert.equal(ready.body.servers[0].lastSuccessAt, null);
  assert.equal(fs.existsSync(path.join(f.root, 'server-backups')), false); assert.equal(f.vault.data.features, undefined);
});

test('end-to-end auto chat -> forced encrypted key backup -> offline restart/password change -> saved routes', { timeout: 15000 }, async t => {
  const f = fixture(t), text = 'SECRET-CONTENT-no-plaintext user/assistant', binary = crypto.randomBytes(900000);
  f.write('.claude/projects/a/session.jsonl', JSON.stringify({ type: 'user', message: { content: text } }) + '\n');
  f.write('.codex/archived_sessions/s.jsonl', text); f.write('project/.env', 'PRIVATE_ENV=' + text); f.write('project/blob.bin', binary);
  await f.request('POST', '/control', { enabled: true, servers: [{ serverId: 'vm', roots: [path.posix.join(f.home, 'project')], includeChats: true }] });
  f.controller.tick(); assert.equal(f.controller.pending(), 1); assert.equal((await f.request('POST', '/run', { serverId: 'vm' })).status, 409); await finish(f.controller);
  const status = (await f.request('GET', '/status')).body; assert.equal(status.servers[0].phase, 'current'); assert.equal(status.servers[0].files, 4); assert.ok(status.servers[0].lastSuccessAt);
  const key = f.vault.data.features['server-backup'].contentKey; assert.equal(Buffer.from(key, 'base64').length, 32); assert.ok(f.vault.info().count);
  const copied = Vault.read(fs.readFileSync(path.join(f.vault.info().dir, `vault-${f.vault.info().lastAt}.json`), 'utf8'), 'synthetic-password'); assert.equal(copied.features['server-backup'].contentKey, key);
  f.remotes.clear(); f.vault.data.servers = []; f.vault.create('changed-synthetic-password', f.vault.data);
  const reopened = new Vault(f.vault.file); assert.ok(reopened.unlock('changed-synthetic-password')); assert.equal(reopened.data.features['server-backup'].contentKey, key);
  // Discard the in-memory cache to exercise the disk path after a backend restart.
  f.controller.store = null; f.controller.storeKey = null;
  const snapshots = (await f.request('GET', '/snapshots?server=vm')).body.snapshots; assert.equal(snapshots.length, 1);
  const sid = snapshots[0].id, files = (await f.request('GET', '/files?server=vm&snapshot=' + sid)).body.files;
  assert.equal(files.length, 4); assert.ok(files.every(f => /^[a-f0-9]{64}$/.test(f.id) && !f.chunks));
  const chat = files.find(f => f.kind === 'chat'), preview = (await f.request('GET', `/preview?server=vm&snapshot=${sid}&file=${chat.id}`)).body; assert.ok(preview.text.includes(text));
  const binaryEntry = files.find(f => f.path.endsWith('blob.bin')), binaryPreview = (await f.request('GET', `/preview?server=vm&snapshot=${sid}&file=${binaryEntry.id}`)).body; assert.equal(binaryPreview.binary, true);
  class Response extends Writable { constructor() { super(); this.parts = []; this.headers = {}; } setHeader(k, v) { this.headers[k] = v; } _write(c, e, cb) { this.parts.push(Buffer.from(c)); cb(); } }
  const download = new Response(); await f.features.handle({ method: 'GET' }, download, new URL(`/api/features/server-backup/download?server=vm&snapshot=${sid}&file=${binaryEntry.id}`, 'http://localhost')); assert.deepEqual(Buffer.concat(download.parts), binary);
  const archive = new Response(); await f.features.handle({ method: 'GET' }, archive, new URL(`/api/features/server-backup/export?server=vm&snapshot=${sid}`, 'http://localhost')); assert.equal(archive.headers['Content-Type'], 'application/x-tar'); assert.ok(Buffer.concat(archive.parts).includes(binary));
  const offline = (await f.request('GET', '/status')).body; assert.equal(offline.servers[0].hasSnapshot, true); assert.equal(offline.servers[0].phase, 'offline'); assert.equal(offline.storage.host, os.hostname());
  assert.doesNotMatch(JSON.stringify(status) + JSON.stringify(offline) + JSON.stringify(f.logs), new RegExp(key.replace(/[+/$]/g, '\\$&')));
  for (const dir of [path.join(f.root, 'server-backups'), f.vault.info().dir]) for (const name of fs.readdirSync(dir)) assert.equal(fs.readFileSync(path.join(dir, name)).includes(Buffer.from(text)), false);
});

test('OFF cancels before publication, manual runs while paused are explicit, settings replacement and global dedupe', { timeout: 15000 }, async t => {
  const f = fixture(t); f.write('.codex/sessions/s.jsonl', 'saved conversation');
  const first = await f.request('POST', '/run', { serverId: 'vm' }); assert.equal(first.status, 202); assert.deepEqual(first.body, { queued: true, serverId: 'vm' });
  await f.request('POST', '/control', { enabled: false }); await finish(f.controller);
  assert.equal((await f.request('GET', '/snapshots?server=vm')).body.snapshots.length, 0);
  f.controller.tick(); assert.equal(f.controller.pending(), 0);
  assert.equal((await f.request('POST', '/run', { serverId: 'vm' })).status, 202); await finish(f.controller);
  assert.equal((await f.request('GET', '/status')).body.servers[0].phase, 'paused');
  const good = (await f.request('GET', '/snapshots?server=vm')).body.snapshots[0];
  assert.equal((await f.request('POST', '/control', { enabled: true, servers: [] })).status, 200);
  assert.equal((await f.request('POST', '/run', { serverId: 'vm' })).status, 409);
  assert.equal((await f.request('GET', '/snapshots?server=vm')).body.snapshots[0].id, good.id);
  for (const bad of [{ enabled: true, intervalMinutes: 1 }, { enabled: true, retention: 1 }, { enabled: true, servers: [{ serverId: 'vm', roots: ['/'], includeChats: true }] }, { enabled: true, servers: [{ serverId: 'unknown', roots: [], includeChats: true }] }]) assert.equal((await f.request('POST', '/control', bad)).status, 400);
});

test('failed forced vault backup prevents the first snapshot; missing/corrupt keys never reset existing stores', { timeout: 15000 }, async t => {
  const f = fixture(t); f.write('.codex/sessions/a.jsonl', 'backup content'); const original = f.vault.copy.bind(f.vault); f.vault.copy = () => {};
  await f.request('POST', '/run', { serverId: 'vm' }); await finish(f.controller); assert.equal((await f.request('GET', '/status')).body.servers[0].reason, 'vault_backup_failed'); assert.equal(fs.existsSync(path.join(f.root, 'server-backups')), false);
  f.vault.copy = original; await f.request('POST', '/run', { serverId: 'vm' }); await finish(f.controller);
  const catalog = fs.readFileSync(path.join(f.root, 'server-backups', 'catalog.enc'));
  const s = f.vault.data.features['server-backup']; delete s.contentKey; f.vault.save(); f.controller.store = null;
  const status = (await f.request('GET', '/status')).body; assert.equal(status.servers[0].reason, 'key_lost');
  await f.request('POST', '/run', { serverId: 'vm' }); await finish(f.controller); assert.deepEqual(fs.readFileSync(path.join(f.root, 'server-backups', 'catalog.enc')), catalog);
});

test('reconnect catches up, shutdown cancels, changing backend identity cannot publish, and cross-host IDs fail', { timeout: 15000 }, async t => {
  const f = fixture(t); f.write('.codex/sessions/a.jsonl', 'backup content');
  f.remotes.get('vm').ready = false; f.controller.tick(); assert.equal(f.controller.pending(), 0); f.remotes.get('vm').ready = true; f.controller.tick(); await finish(f.controller);
  const good = f.controller.store.snapshots('vm')[0]; assert.ok(good);
  f.remotes.get('vm').ready = false; f.controller.tick(); f.remotes.get('vm').ready = true; f.controller.tick(); assert.equal(f.controller.pending(), 1); f.controller.stop(); await finish(f.controller); assert.equal(f.controller.store.snapshots('vm').length, 1);
  f.controller.stopped = false;
  const original = f.controller.options.transport;
  f.controller.options.transport = async function* (...args) { for await (const m of original(...args)) { if (m.t === 'done') f.remotes.set('vm', { ready: true }); yield m; } };
  await f.request('POST', '/run', { serverId: 'vm' }); await finish(f.controller); assert.equal(f.controller.store.snapshots('vm').length, 1);
  const file = f.controller.store.manifest('vm', good.id).entries[0];
  assert.equal((await f.request('GET', `/preview?server=other&snapshot=${good.id}&file=${file.id}`)).status, 404);
  assert.equal((await f.request('GET', `/preview?server=vm&snapshot=${good.id}&file=../../vault.json`)).status, 404);
});

test('live cached metadata corruption is explicit, and GET never initializes crash remnants', { timeout: 15000 }, async t => {
  const f = fixture(t); f.write('.codex/sessions/a.jsonl', 'synthetic backup content');
  await f.request('POST', '/run', { serverId: 'vm' }); await finish(f.controller);
  const catalogPath = path.join(f.root, 'server-backups', 'catalog.enc'); fs.writeFileSync(catalogPath, 'corrupted ciphertext');
  assert.equal((await f.request('GET', '/status')).body.servers[0].reason, 'corrupt_store');
  await f.request('POST', '/run', { serverId: 'vm' }); await finish(f.controller); assert.equal(fs.readFileSync(catalogPath, 'utf8'), 'corrupted ciphertext');
  for (const n of fs.readdirSync(path.dirname(catalogPath))) fs.unlinkSync(path.join(path.dirname(catalogPath), n));
  fs.writeFileSync(path.join(path.dirname(catalogPath), 'tmp-abc'), 'encrypted remnant', { mode: 0o600 });
  f.controller.store = null;
  const before = fs.readdirSync(path.dirname(catalogPath));
  assert.equal((await f.request('GET', '/status')).body.servers[0].reason, 'catalog_missing'); assert.deepEqual(fs.readdirSync(path.dirname(catalogPath)), before);
});

test('scope OFF during a suspended read aborts late publication and leaves the previous copy usable', { timeout: 15000 }, async t => {
  const f = fixture(t); f.write('.codex/sessions/a.jsonl', 'original'); await f.request('POST', '/run', { serverId: 'vm' }); await finish(f.controller);
  const good = f.controller.store.snapshots('vm')[0], original = f.controller.options.transport;
  f.write('.codex/sessions/a.jsonl', 'new changed conversation'); let release, entered;
  const gate = new Promise(r => { release = r; }), reading = new Promise(r => { entered = r; });
  f.controller.options.transport = async function* (...args) { for await (const m of original(...args)) { if (m.t === 'chunk') { entered(); await within(gate, 'suspended read released'); } yield m; } };
  try {
    assert.equal((await f.request('POST', '/run', { serverId: 'vm' })).status, 202); await waitForRead(f.controller, reading);
    await f.request('POST', '/control', { enabled: false });
  } finally { release(); await finish(f.controller); }
  assert.equal(f.controller.store.snapshots('vm')[0].id, good.id); const file = f.controller.store.manifest('vm', good.id).entries[0]; assert.equal(f.controller.store.preview('vm', good.id, file.id).text, 'original');
});

test('a reconnect waiting behind another host catches up immediately even after a recent successful attempt', { timeout: 15000 }, async t => {
  const f = fixture(t); f.write('.codex/sessions/a.jsonl', 'recent conversation');
  await f.request('POST', '/run', { serverId: 'vm' }); await finish(f.controller);
  const first = f.controller.store.snapshots('vm')[0];
  f.remotes.get('vm').ready = false; f.controller.tick();
  f.write('.codex/sessions/a.jsonl', 'recent conversation, then more');   // an unchanged tree is not stored again
  // The global gate is held while this host reconnects. Catch-up must survive that busy tick.
  f.controller.job = { serverId: 'other-host', abort: new AbortController() };
  f.remotes.get('vm').ready = true; f.controller.tick(); f.controller.job = null;
  f.controller.tick(); assert.equal(f.controller.pending(), 1); await finish(f.controller);
  assert.equal(f.controller.store.snapshots('vm').length, 2); assert.notEqual(f.controller.store.snapshots('vm')[0].id, first.id);
});

test('control accepts all status rows after host deletion without enrolling stored-only history', { timeout: 15000 }, async t => {
  const f = fixture(t); f.write('.codex/sessions/a.jsonl', 'original offline conversation'); f.write('project/.env', 'original working file');
  const roots = [path.posix.join(f.home, 'project')];
  await f.request('POST', '/control', { enabled: true, servers: [{ serverId: 'vm', roots, includeChats: true }] });
  await f.request('POST', '/run', { serverId: 'vm' }); await finish(f.controller);
  const good = f.controller.store.snapshots('vm')[0], file = f.controller.store.manifest('vm', good.id).entries.find(e => e.kind === 'chat');
  f.vault.data.servers = [{ id: 'current', name: 'Current VM' }]; f.vault.save(); f.remotes.clear(); f.remotes.set('current', { cfg: { id: 'current' }, ready: true });
  const status = () => f.request('GET', '/status').then(r => r.body);
  // Match the UI's complete-list request, including the deleted VM row.
  const uiRequest = s => ({ enabled: s.enabled, intervalMinutes: s.intervalMinutes, retention: s.retention,
    servers: s.servers.map(row => ({ serverId: row.id, roots: row.roots, includeChats: row.includeChats })) });
  const body = uiRequest(await status()); body.servers.find(c => c.serverId === 'current').roots = roots;
  const changed = await f.request('POST', '/control', body); assert.equal(changed.status, 200);
  assert.deepEqual(changed.body.servers.find(s => s.id === 'current').roots, roots);
  assert.deepEqual(changed.body.servers.find(s => s.id === 'vm').roots, roots);
  // An explicit complete list omits the deleted scope; its stored copy remains visible.
  const current = body.servers.filter(c => c.serverId === 'current');
  assert.equal((await f.request('POST', '/control', { enabled: true, servers: current })).status, 200);
  let stored = (await status()).servers.find(s => s.id === 'vm'); assert.equal(stored.configured, false); assert.equal(stored.hasSnapshot, true);
  assert.equal((await f.request('POST', '/control', uiRequest(await status()))).status, 200);
  stored = (await status()).servers.find(s => s.id === 'vm'); assert.equal(stored.configured, false); assert.equal(stored.includeChats, false); assert.deepEqual(stored.roots, []);
  assert.ok(!f.controller.config().servers.some(c => c.serverId === 'vm'));
  const before = JSON.stringify(f.vault.data.features['server-backup']);
  const unknown = uiRequest(await status()); unknown.servers.push({ serverId: 'unknown', roots: [], includeChats: false });
  assert.equal((await f.request('POST', '/control', unknown)).status, 400); assert.equal(JSON.stringify(f.vault.data.features['server-backup']), before);
  // Even a stale connection for the deleted ID must not schedule it.
  f.remotes.get('current').ready = false; f.remotes.set('vm', { cfg: { id: 'vm' }, ready: true }); f.controller.tick(); assert.equal(f.controller.pending(), 0);
  const preview = await f.request('GET', `/preview?server=vm&snapshot=${good.id}&file=${file.id}`);
  assert.equal(preview.status, 200); assert.equal(preview.body.text, 'original offline conversation');
  assert.equal((await f.request('GET', '/snapshots?server=vm')).body.snapshots[0].id, good.id);
});

test('manual failures and partial results remain visible with automatic backups OFF, and retries clear stale reasons', { timeout: 15000 }, async t => {
  const f = fixture(t); const original = f.controller.options.transport;
  f.write('.codex/sessions/a.jsonl', 'old good conversation');
  await f.request('POST', '/run', { serverId: 'vm' }); await finish(f.controller);
  const good = f.controller.store.snapshots('vm')[0], file = f.controller.store.manifest('vm', good.id).entries[0];
  await f.request('POST', '/control', { enabled: false });
  f.controller.options.transport = async function* () { throw Object.assign(Error('private transport detail'), { code: 'source_unavailable' }); };
  assert.equal((await f.request('POST', '/run', { serverId: 'vm' })).status, 202);
  let status = (await f.request('GET', '/status')).body; assert.equal(status.enabled, false); assert.equal(status.servers[0].phase, 'running'); assert.equal(status.servers[0].reason, '');
  await finish(f.controller);
  status = (await f.request('GET', '/status')).body;
  assert.equal(status.enabled, false); assert.equal(status.servers[0].phase, 'error'); assert.equal(status.servers[0].reason, 'source_unavailable');
  assert.equal(status.servers[0].lastSuccessAt, good.at); assert.equal(status.servers[0].hasSnapshot, true);
  assert.equal(f.controller.store.snapshots('vm')[0].id, good.id);
  assert.equal((await f.request('GET', `/preview?server=vm&snapshot=${good.id}&file=${file.id}`)).body.text, 'old good conversation');
  // A VM reports partial coverage over the protocol; symlink detection itself is
  // exercised by the Linux-only source tests, without requiring local link support.
  f.controller.options.transport = async function* (...args) {
    for await (const m of original(...args)) yield m.t === 'done' ? { ...m, skipped: 1, reason: 'symlink_skipped' } : m;
  };
  assert.equal((await f.request('POST', '/run', { serverId: 'vm' })).status, 202);
  assert.equal((await f.request('GET', '/status')).body.servers[0].reason, ''); await finish(f.controller);
  status = (await f.request('GET', '/status')).body; assert.equal(status.enabled, false); assert.equal(status.servers[0].phase, 'partial'); assert.equal(status.servers[0].reason, 'symlink_skipped');
  assert.equal(status.servers[0].lastSuccessAt, good.at);
  f.controller.options.transport = original;
  assert.equal((await f.request('POST', '/run', { serverId: 'vm' })).status, 202);
  status = (await f.request('GET', '/status')).body; assert.equal(status.servers[0].phase, 'running'); assert.equal(status.servers[0].reason, '');
  await finish(f.controller);
  status = (await f.request('GET', '/status')).body; assert.equal(status.enabled, false); assert.equal(status.servers[0].phase, 'paused'); assert.equal(status.servers[0].reason, '');
});

test('six-minute jobs fairly visit every due VM before repeating while preserving the global gate', { timeout: 15000 }, async t => {
  const f = fixture(t), ids = ['vm', 'second', 'third'], starts = [], original = f.controller.options.transport;
  f.write('.codex/sessions/a.jsonl', 'synthetic conversation');
  f.vault.data.servers = ids.map(id => ({ id, name: id })); f.vault.save();
  for (const id of ids) f.remotes.set(id, { cfg: { id }, ready: true });
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  f.controller.options.transport = async function* (backend, ...args) {
    starts.push(backend.cfg.id);
    for await (const m of original(backend, ...args)) { if (m.t === 'done') now += 6 * 60000; yield m; }
  };
  for (const id of [...ids, ...ids]) {
    f.controller.tick(); assert.equal(f.controller.job?.serverId, id);
    const job = f.controller.job; f.controller.tick(); assert.equal(f.controller.job, job); assert.equal(f.controller.pending(), 1);
    assert.equal((await f.request('POST', '/run', { serverId: ids.find(other => other !== id) })).status, 409);
    await finish(f.controller); assert.equal(f.controller.pending(), 0);
    assert.equal((await f.request('GET', '/status')).body.servers.find(s => s.id === id).phase, 'current');
  }
  assert.deepEqual(starts, [...ids, ...ids]);
});

test('suspended-read fixture fails promptly when transport ends before entering', { timeout: 15000 }, async t => {
  const f = fixture(t);
  f.controller.options.transport = async function* () { throw Object.assign(Error('fixture failure'), { code: 'source_unavailable' }); };
  assert.equal((await f.request('POST', '/run', { serverId: 'vm' })).status, 202);
  await assert.rejects(waitForRead(f.controller, new Promise(() => {})), /backup ended before suspended read: source_unavailable/);
  await assert.rejects(within(new Promise(() => {}), 'deliberately unreleased gate', 20), /fixture timeout: deliberately unreleased gate/);
  assert.equal(f.controller.pending(), 0);
});
