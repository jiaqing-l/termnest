'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Writable } = require('node:stream');
const { execFileSync } = require('node:child_process');
const { SnapshotStore, LIMITS, safePath } = require('../lib/server-backup-store');
async function within(promise, label, ms = 5000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('fixture timeout: ' + label)), ms); })]); }
  finally { clearTimeout(timer); }
}
function fixture(t, limits) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-backup-store-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const key = crypto.randomBytes(32), store = new SnapshotStore(dir, key, limits); return { dir, key, store };
}
function save(store, value, opts = {}, name = 'files/project/a.txt') {
  const tx = store.begin('vm1', 'Synthetic VM'), bytes = Buffer.from(value), chunks = [];
  for (let i = 0; i < bytes.length; i += store.limits.chunkBytes) chunks.push(store.chunk(bytes.subarray(i, i + store.limits.chunkBytes)));
  store.add(tx, { path: name, kind: 'file', size: bytes.length, mtimeMs: 1700000000000, chunks }); return store.commit(tx, opts);
}
class Response extends Writable {
  constructor(options = {}) { super({ highWaterMark: 64, ...options }); this.headers = {}; this.parts = []; }
  setHeader(k, v) { this.headers[k] = v; }
  _write(chunk, enc, cb) { this.parts.push(Buffer.from(chunk)); setImmediate(cb); }
  get bytes() { return Buffer.concat(this.parts); }
}
function content(store, s, file) { return Buffer.concat([...store.fileBytes(store.manifest('vm1', s.id).entries.find(f => !file || f.path === file))]); }

test('encrypted durable incremental objects retain old files/deletions and exact binary bytes after restart', async t => {
  const { store, dir, key } = fixture(t), sentinel = 'SECRET-CONTENT-synthetic-\u0111\u1ea5t';
  const first = save(store, sentinel), chunks1 = fs.readdirSync(store.root).filter(n => n.endsWith('.chunk'));
  const second = save(store, sentinel);
  assert.deepEqual(fs.readdirSync(store.root).filter(n => n.endsWith('.chunk')), chunks1);
  const binary = Buffer.concat([Buffer.from([0, 1, 255]), crypto.randomBytes(700000)]), third = save(store, binary, {}, 'files/project/tiếng Việt/' + 'x'.repeat(150) + '.bin');
  for (const n of fs.readdirSync(store.root)) { assert.ok(!n.includes(sentinel)); assert.equal(fs.readFileSync(path.join(store.root, n)).includes(Buffer.from(sentinel)), false); }
  const reopened = new SnapshotStore(dir, key); assert.deepEqual(content(reopened, first), Buffer.from(sentinel)); assert.deepEqual(content(reopened, second), Buffer.from(sentinel));
  const file = reopened.manifest('vm1', third.id).entries[0], res = new Response(); await reopened.stream(res, 'vm1', third.id, file.id); assert.deepEqual(res.bytes, binary);
  assert.equal(reopened.preview('vm1', third.id, file.id).binary, true);
  const tar = new Response(); await reopened.export(tar, 'vm1', third.id);
  // Exercise a separate system tar implementation, including PAX Unicode/long paths.
  if (process.platform !== 'win32') {
    const extracted = path.join(dir, 'extracted'); fs.mkdirSync(extracted);
    execFileSync('tar', ['-xf', '-', '-C', extracted], { input: tar.bytes, timeout: 5000 });
    assert.deepEqual(fs.readFileSync(path.join(extracted, file.path)), binary);
  }
  assert.ok(tar.bytes.subarray(-1024).equals(Buffer.alloc(1024)));
});

test('quota, interrupted publication, wrong key, missing/corrupt metadata preserve the last good copy', t => {
  const { store, dir, key } = fixture(t); const first = save(store, 'last-good');
  const original = store.atomic.bind(store);
  store.atomic = (name, bytes) => { if (name === 'catalog.enc') throw Object.assign(Error('synthetic full disk'), { code: 'ENOSPC' }); return original(name, bytes); };
  assert.throws(() => save(store, 'changed'), { code: 'ENOSPC' }); store.atomic = original;
  assert.deepEqual(new SnapshotStore(dir, key).snapshots('vm1').map(s => s.id), [first.id]);
  assert.deepEqual(content(store, first), Buffer.from('last-good'));
  store.limits.diskBytes = store.usage() + 10; assert.throws(() => save(store, crypto.randomBytes(200)), { code: 'quota' }); store.limits.diskBytes = LIMITS.diskBytes;
  assert.throws(() => new SnapshotStore(dir, crypto.randomBytes(32)), { code: 'corrupt_store' });
  const catalog = fs.readFileSync(path.join(store.root, 'catalog.enc'));
  fs.writeFileSync(path.join(store.root, 'catalog.enc'), Buffer.from('broken')); assert.throws(() => new SnapshotStore(dir, key), { code: 'corrupt_store' });
  fs.writeFileSync(path.join(store.root, 'catalog.enc'), catalog);
  fs.renameSync(path.join(store.root, 'catalog.enc'), path.join(store.root, 'lost.enc')); assert.throws(() => new SnapshotStore(dir, key), { code: 'catalog_missing' });
});

test('retention pins active exports, keeps the last complete copy through partial attempts, and reclaims orphans', async t => {
  const { store } = fixture(t); const first = save(store, crypto.randomBytes(800000), { retention: 2 });
  const originalBytes = content(store, first), lease = store.acquire('vm1', first.id);
  save(store, 'partial-one', { retention: 2, skipped: 1, reason: 'read_failed' });
  save(store, 'partial-two', { retention: 2, skipped: 1 }); assert.ok(store.snapshots('vm1').some(s => s.id === first.id));
  save(store, 'new-good', { retention: 2 }); save(store, 'newer-good', { retention: 2 });
  assert.ok(!store.snapshots('vm1').some(s => s.id === first.id));
  assert.deepEqual(Buffer.concat([...store.fileBytes(lease.manifest.entries[0])]), originalBytes);
  lease.release(); store.gc(); assert.equal(fs.existsSync(path.join(store.root, first.id + '.manifest')), false);
  const bad = store.chunk(Buffer.from('abandoned-unpublished')); assert.ok(fs.existsSync(path.join(store.root, bad + '.chunk'))); store.begin('vm1', 'VM'); assert.equal(fs.existsSync(path.join(store.root, bad + '.chunk')), false);
});

test('a blocked download stays byte-exact while later commits expire its snapshot', async t => {
  const { store } = fixture(t), bytes = crypto.randomBytes(900000), first = save(store, bytes, { retention: 2 });
  const file = store.manifest('vm1', first.id).entries[0]; let resume, started;
  const ready = new Promise(r => { started = r; });
  const res = new Response(); res._write = (chunk, enc, cb) => { res.parts.push(Buffer.from(chunk)); if (!resume) { resume = cb; started(); } else setImmediate(cb); };
  const download = store.stream(res, 'vm1', first.id, file.id);
  try {
    await within(Promise.race([ready, download.then(() => { throw Error('download ended before first write'); })]), 'download started');
    save(store, 'v2', { retention: 2 }); save(store, 'v3', { retention: 2 }); assert.equal(store.readers, 1);
  } finally {
    if (resume) resume(); else res.destroy();
    await within(download, 'download completion');
  }
  assert.deepEqual(res.bytes, bytes); assert.equal(store.readers, 0); store.gc();
});

test('private store rejects links, hardlinks, directory substitution and arbitrary IDs/paths', t => {
  const { store, dir, key } = fixture(t); const snapshot = save(store, 'secret'), f = store.manifest('vm1', snapshot.id).entries[0];
  for (const p of ['../x', '/etc/passwd', 'a/../x', 'a\\x', 'C:/x', 'a\nx', 'a//x', 'a/CON.txt', 'a/drive:stream', 'a/trailing.']) assert.equal(safePath(p), false);
  assert.throws(() => store.preview('vm1', snapshot.id, '../../x'), { code: 'not_found' });
  assert.throws(() => store.manifest('other', snapshot.id), { code: 'not_found' });
  const chunk = path.join(store.root, f.chunks[0] + '.chunk'), external = path.join(dir, 'external'); fs.renameSync(chunk, external); fs.linkSync(external, chunk);
  assert.throws(() => store.preview('vm1', snapshot.id, f.id), { code: 'unsafe_store' }); fs.unlinkSync(chunk); fs.renameSync(external, chunk);
  fs.renameSync(store.root, store.root + '-old'); fs.symlinkSync(store.root + '-old', store.root, 'dir');
  assert.throws(() => store.preview('vm1', snapshot.id, f.id), { code: 'unsafe_store' }); assert.throws(() => new SnapshotStore(dir, key), { code: 'unsafe_store' });
});

test('bounded UTF8 previews use the chat tail and text prefix with exact full downloads', t => {
  const { store } = fixture(t, { previewBytes: 101 });
  const tx = store.begin('vm1', 'VM'); const data = Buffer.from('đ'.repeat(200) + '\nlast message');
  store.add(tx, { path: 'chats/codex/session.jsonl', kind: 'chat', tool: 'codex', size: data.length, mtimeMs: 1, chunks: [store.chunk(data)] });
  const s = store.commit(tx), f = store.manifest('vm1', s.id).entries[0], p = store.preview('vm1', s.id, f.id);
  assert.equal(p.binary, false); assert.equal(p.truncated, true); assert.ok(Buffer.byteLength(p.text) <= 101); assert.ok(p.text.endsWith('last message')); assert.deepEqual(content(store, s), data);
});
module.exports = { Response };

test('process termination after fsync but before catalog rename leaves old publication and recoverable orphan cleanup', t => {
  const { store, dir, key } = fixture(t), good = save(store, 'last complete copy');
  const program = `
    const fs=require('fs'), {SnapshotStore}=require(process.argv[1]);
    const s=new SnapshotStore(process.argv[2],Buffer.from(process.argv[3],'base64'));
    const tx=s.begin('vm1','VM'), b=Buffer.from('new interrupted data');
    s.add(tx,{path:'files/new',kind:'file',size:b.length,mtimeMs:1,chunks:[s.chunk(b)]});
    const rename=fs.renameSync; fs.renameSync=(from,to)=>{if(to.endsWith('catalog.enc'))process.exit(23);return rename(from,to);};
    s.commit(tx);
  `;
  assert.throws(() => execFileSync(process.execPath, ['-e', program, require.resolve('../lib/server-backup-store'), dir, key.toString('base64')], { stdio: 'pipe', timeout: 5000 }), { status: 23 });
  assert.ok(fs.readdirSync(store.root).some(n => n.startsWith('tmp-')));
  const restarted = new SnapshotStore(dir, key); assert.deepEqual(restarted.snapshots('vm1').map(s => s.id), [good.id]); assert.deepEqual(content(restarted, good), Buffer.from('last complete copy'));
  restarted.begin('vm1', 'VM'); assert.ok(!fs.readdirSync(store.root).some(n => n.startsWith('tmp-')));
});
