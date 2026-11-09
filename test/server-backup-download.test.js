'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { Writable } = require('node:stream');
const { BackupController } = require('../lib/server-backup-controller');
const { PREFIX } = require('../lib/server-backup-download');

const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let n = 0; n < 200; n++) { if (fn()) return; await delay(5); } assert.fail('fixture timed out'); }
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-download-')); let unlocked = true;
  let settings = { contentKey: crypto.randomBytes(32).toString('base64'), keyBackedUp: true, enabled: false };
  const host = { privateData: { directory: () => dir, unlocked: () => unlocked, servers: () => [], forceVaultBackup: () => {} },
    settings: { get: () => settings, set: s => { settings = s; } }, backendOf: () => null };
  const controller = new BackupController(host, { timers: false, downloads: options }), store = controller.openStore(true);
  t.after(async () => { controller.stop(); await until(() => !controller.downloads.active.size); fs.rmSync(dir, { recursive: true, force: true }); });
  function save(value = 'saved', server = 'removed-vm') {
    const bytes = Buffer.from(value), tx = store.begin(server, server), chunks = [];
    for (let off = 0; off < bytes.length; off += store.limits.chunkBytes) chunks.push(store.chunk(bytes.subarray(off, off + store.limits.chunkBytes)));
    store.add(tx, { path: 'files/project/original.bin', kind: 'file', size: bytes.length, chunks, mtimeMs: 1 });
    const snapshot = store.commit(tx, { retention: 2 }), file = store.manifest(server, snapshot.id).entries[0];
    return { serverId: server, snapshotId: snapshot.id, fileId: file.id };
  }
  return { controller, store, save, lock: () => { unlocked = false; }, unlock: () => { unlocked = true; } };
}
class Response extends Writable {
  constructor({ block = false, abort = false } = {}) {
    super({ highWaterMark: 1 }); this.headers = {}; this.statusCode = 200; this.bytes = 0; this.maxChunk = 0;
    this.hash = crypto.createHash('sha256'); this.block = block; this.abort = abort; this.on('error', () => {});
  }
  setHeader(k, v) { this.headers[k] = v; }
  _write(chunk, _, cb) {
    this.headersSent = true; this.bytes += chunk.length; this.maxChunk = Math.max(this.maxChunk, chunk.length); this.hash.update(chunk);
    if (this.abort) { this.destroy(); cb(); } else if (this.block) this.resumeWrite = cb; else setImmediate(cb);
  }
}
function get(c, ticket, res = new Response(), method = 'GET', headers = {}) {
  return c.download({ method, headers: { host: 'localhost:1234', ...headers } }, res, new URL(ticket.downloadURL, 'http://localhost:1234'));
}

test('capabilities require exact saved identities, stay private and bounded, and cannot create a key while locked', async t => {
  const f = fixture(t, { maxPending: 2 }), c = f.controller, chosen = f.save(), other = f.save('other', 'other-vm');
  for (const body of [null, {}, { ...chosen, url: 'http://attacker' }, { ...chosen, serverId: 'other-vm' },
    { ...chosen, snapshotId: other.snapshotId }, { ...chosen, fileId: other.fileId }, { ...chosen, fileId: '../../vault.json' }, { ...chosen, fileId: null }]) {
    assert.throws(() => c.createDownload(body)); assert.equal(f.store.readers, 0);
  }
  const a = c.createDownload(chosen), b = c.createDownload(chosen);
  assert.match(a.downloadURL, new RegExp('^' + PREFIX + '[A-Za-z0-9_-]{43}$'));
  assert.equal(f.store.readers, 2); assert.throws(() => c.createDownload(chosen), { code: 'busy' });
  assert.ok(!JSON.stringify(c.status()).includes(a.downloadURL));
  assert.ok(!JSON.stringify([...c.downloads.tickets.keys()]).includes(a.downloadURL.slice(PREFIX.length)));
  c.cancelDownload(a.downloadURL); c.cancelDownload(a.downloadURL); assert.equal(f.store.readers, 1);
  f.lock(); assert.throws(() => c.createDownload(chosen), { code: 'vault_locked' }); assert.equal(f.store.readers, 0);
  f.unlock(); const replay = new Response(); await get(c, b, replay); assert.equal(replay.statusCode, 404);
  const settingsBefore = c.host.settings.get(), storeBefore = fs.readdirSync(f.store.root);
  f.lock(); const invalid = new Response(); await get(c, { downloadURL: PREFIX + 'a'.repeat(43) }, invalid);
  assert.equal(invalid.statusCode, 401); assert.deepEqual(c.host.settings.get(), settingsBefore); assert.deepEqual(fs.readdirSync(f.store.root), storeBefore);
  const freshDir = path.join(f.store.dataDir, 'fresh'); fs.mkdirSync(freshDir); let freshSettings = { enabled: false };
  const fresh = new BackupController({ ...c.host, privateData: { ...c.host.privateData, directory: () => freshDir, unlocked: () => true },
    settings: { get: () => freshSettings, set: value => { freshSettings = value; } } }, { timers: false });
  t.after(() => fresh.stop()); assert.throws(() => fresh.createDownload(chosen), { code: 'not_found' });
  assert.deepEqual(freshSettings, { enabled: false }); assert.deepEqual(fs.readdirSync(freshDir), [], 'mint cannot initialize keys or storage');
});

test('expired and cancelled links release pins; retained-away snapshot still downloads the exact leased version once', async t => {
  const f = fixture(t, { ttl: 2000 }), c = f.controller, old = f.save('chosen-version'), ticket = c.createDownload(old);
  f.save('v2'); f.save('v3'); assert.equal(f.store.snapshots(old.serverId).some(s => s.id === old.snapshotId), false);
  const res = new Response(); await get(c, ticket, res);
  assert.equal(res.hash.digest('hex'), crypto.createHash('sha256').update('chosen-version').digest('hex'));
  assert.equal(f.store.readers, 0); f.store.gc(); assert.equal(fs.existsSync(path.join(f.store.root, old.snapshotId + '.manifest')), false);
  c.downloads.ttl = 30;
  const current = f.save('expires'), expiring = c.createDownload(current);
  await until(() => !c.downloads.tickets.size); assert.equal(f.store.readers, 0);
  const expired = new Response(); await get(c, expiring, expired); assert.equal(expired.statusCode, 404);
  const late = c.createDownload(current); [...c.downloads.tickets.values()][0].expires = Date.now() - 1;
  const lateRes = new Response(); await get(c, late, lateRes); assert.equal(lateRes.statusCode, 404); assert.equal(f.store.readers, 0);
});

test('simultaneous consumption, bad method/origin/query/forgery and active limits cannot broaden authorization', async t => {
  const f = fixture(t, { maxActive: 1 }), c = f.controller, chosen = f.save(crypto.randomBytes(700000)), ticket = c.createDownload(chosen);
  for (const [method, headers, status] of [['HEAD', {}, 405], ['POST', {}, 405], ['GET', { origin: 'http://attacker' }, 403],
    ['GET', { origin: 'https://localhost:1234' }, 403], ['GET', { 'sec-fetch-site': 'cross-site' }, 403]]) {
    const res = new Response(); await get(c, ticket, res, method, headers); assert.equal(res.statusCode, status);
  }
  for (const suffix of ['?file=other', '/other', '%2f..', 'x']) {
    const res = new Response(); await get(c, { downloadURL: ticket.downloadURL + suffix }, res); assert.equal(res.statusCode, 404);
  }
  const forged = new Response(); await get(c, { downloadURL: PREFIX + 'z'.repeat(43) }, forged); assert.equal(forged.statusCode, 404);
  const blocked = new Response({ block: true }), first = get(c, ticket, blocked);
  await until(() => blocked.resumeWrite); assert.equal(c.pending(), 1);
  const replay = new Response(); await get(c, ticket, replay); assert.equal(replay.statusCode, 404);
  const next = c.createDownload(chosen), over = new Response(); await get(c, next, over); assert.equal(over.statusCode, 409);
  assert.equal(f.store.readers, 1); blocked.destroy(); await first; assert.equal(c.pending(), 0); assert.equal(f.store.readers, 0);
});

test('socket cancellation, corrupt chunks, deadline, lock and stop release active and pending leases', { timeout: 5000 }, async t => {
  // Mock writable sockets do not keep Node alive as a real HTTP socket does.
  const keepalive = setInterval(() => {}, 100); t.after(() => clearInterval(keepalive));
  const f = fixture(t, { duration: 50 }), c = f.controller, chosen = f.save(crypto.randomBytes(700000));
  await get(c, c.createDownload(chosen), new Response({ abort: true })); assert.equal(f.store.readers, 0);
  const blocked = new Response({ block: true }), timed = get(c, c.createDownload(chosen), blocked);
  await timed; assert.equal(blocked.destroyed, true); assert.equal(f.store.readers, 0);
  c.downloads.duration = 10000;
  for (const stop of [() => { f.lock(); c.tick(); }, () => c.stop()]) {
    const active = new Response({ block: true }), running = get(c, c.createDownload(chosen), active);
    await until(() => active.resumeWrite); c.createDownload(chosen); assert.equal(f.store.readers, 2);
    stop(); await running; assert.equal(f.store.readers, 0); assert.equal(c.downloads.tickets.size, 0); assert.equal(c.pending(), 0); f.unlock();
  }
  c.stopped = false;
  const entry = f.store.manifest(chosen.serverId, chosen.snapshotId).entries[0], filename = path.join(f.store.root, entry.chunks[0] + '.chunk');
  const ticket = c.createDownload(chosen); fs.writeFileSync(filename, 'corrupt');
  const res = new Response(); await get(c, ticket, res); assert.equal(res.destroyed, true); assert.equal(res.bytes, 0); assert.equal(f.store.readers, 0);
  c.stop(); assert.throws(() => c.createDownload(chosen), { code: 'stopping' });
});

test('original and tar >20 MB stream chunkwise with backpressure and a live event loop, without plaintext staging', { timeout: 15000 }, async t => {
  const f = fixture(t), c = f.controller, expected = crypto.createHash('sha256'), tx = f.store.begin('removed-vm', 'Removed VM'), chunks = [];
  const count = 88;
  for (let i = 0; i < count; i++) { const chunk = Buffer.alloc(f.store.limits.chunkBytes, i); expected.update(chunk); chunks.push(f.store.chunk(chunk)); }
  f.store.add(tx, { path: 'files/large.bin', kind: 'file', size: count * f.store.limits.chunkBytes, chunks, mtimeMs: 1 });
  const snapshot = f.store.commit(tx), file = f.store.manifest('removed-vm', snapshot.id).entries[0];
  const body = { serverId: 'removed-vm', snapshotId: snapshot.id, fileId: file.id }, names = fs.readdirSync(f.store.root).sort();
  const read = f.store.readChunk.bind(f.store); let reads = 0, outstanding = 0, maxOutstanding = 0;
  f.store.readChunk = async id => { reads++; maxOutstanding = Math.max(maxOutstanding, ++outstanding); try { return await read(id); } finally { outstanding--; } };
  // Ensure the download does not fall back to synchronous file/chunk reads.
  f.store.fileBytes = () => { throw Error('synchronous download'); };
  let ticks = 0; const heartbeat = setInterval(() => ticks++, 1); t.after(() => clearInterval(heartbeat));
  const original = new Response({ block: true }), running = get(c, c.createDownload(body), original);
  await until(() => original.resumeWrite); await delay(30); assert.ok(reads < 8, 'backpressure prevents eager whole-file reads');
  original.block = false; original.resumeWrite(); await running;
  assert.equal(original.hash.digest('hex'), expected.digest('hex')); assert.equal(original.bytes, count * f.store.limits.chunkBytes);
  assert.ok(original.maxChunk <= f.store.limits.chunkBytes); assert.equal(maxOutstanding, 1); assert.ok(ticks > 10);
  const archive = new Response(); delete body.fileId; await get(c, c.createDownload(body), archive);
  assert.ok(archive.bytes > 20_000_000); assert.ok(archive.maxChunk <= f.store.limits.chunkBytes); assert.equal(archive.headers['Content-Type'], 'application/x-tar');
  assert.deepEqual(fs.readdirSync(f.store.root).sort(), names); assert.equal(f.store.readers, 0);
});
