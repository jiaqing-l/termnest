'use strict';
// The directory contains only authenticated ciphertext. The wrapping key belongs to the vault,
// never this store. Immutable objects precede a durable, atomic catalog publication.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { assertPrivatePath } = require('./service-runtime');
const LIMITS = Object.freeze({ chunkBytes: 256 * 1024, fileBytes: 256 * 1024 * 1024, jobBytes: 1024 ** 3,
  diskBytes: 10 * 1024 ** 3, files: 20000, entries: 100000, depth: 64, manifestBytes: 16 * 1024 ** 2,
  catalogBytes: 4 * 1024 ** 2, objects: 100000, previewBytes: 1024 ** 2, jobMs: 10 * 60000 });
const ID = /^[a-f0-9]{64}$/;
// Everything this store writes. Anything else in the folder (.DS_Store, Thumbs.db, a file the user dropped) is not ours: it is left alone
// and must never stop the backups.
const OBJECT = /^(?:catalog\.enc|[a-f0-9]{64}\.(?:chunk|manifest)|tmp-[a-f0-9]+)$/;
const HOURS = 24, DAYS = 14, MAX_SNAPSHOTS = 100;
// Newest `retention` snapshots, plus the newest of each of the last 24 hours and 14 days: a deleted/damaged file is still found in an
// older state long after the 5-minute ones have rotated out (the chunks are shared, so this costs little disk). Capped at 100.
function tieredKeep(snapshots, retention, now = Date.now()) {
  const keep = new Set(snapshots.slice(0, retention).map(s => s.id)), hours = new Set(), days = new Set();
  for (const s of snapshots) {
    const h = Math.floor(s.at / 3600000), d = Math.floor(s.at / 86400000);
    if (now - s.at < HOURS * 3600000 && !hours.has(h)) { hours.add(h); keep.add(s.id); }
    if (now - s.at < DAYS * 86400000 && !days.has(d)) { days.add(d); keep.add(s.id); }
  }
  const out = snapshots.filter(s => keep.has(s.id));
  return out.length > MAX_SNAPSHOTS ? out.slice(0, MAX_SNAPSHOTS) : out;
}
function error(code) { return Object.assign(new Error(code), { code }); }
function checkAbort(signal) { if (signal?.aborted) throw error('cancelled'); }
function safePath(p) {
  return typeof p === 'string' && p.length > 0 && Buffer.byteLength(p) <= 4096 && !/[\x00-\x1f\x7f\\]/.test(p) &&
    !p.startsWith('/') && !/^[A-Za-z]:/.test(p) && p.split('/').every(x => x && x !== '.' && x !== '..' && !x.includes(':') && !/[. ]$/.test(x) && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(x));
}
function identity(st) { return `${st.dev}:${st.ino}`; }
// Keep physical identities and nanosecond versions exact on NTFS and large filesystems.
function stat(target, descriptor = false) {
  const s = descriptor ? fs.fstatSync(target, { bigint: true }) : fs.lstatSync(target, { bigint: true });
  return { dev: s.dev, ino: s.ino, mtimeNs: s.mtimeNs, ctimeNs: s.ctimeNs,
    size: Number(s.size), nlink: Number(s.nlink), mode: Number(s.mode), uid: Number(s.uid),
    isDirectory: () => s.isDirectory(), isFile: () => s.isFile(), isSymbolicLink: () => s.isSymbolicLink() };
}
class SnapshotStore {
  constructor(dataDir, key, limits = {}, { create = true } = {}) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw error('key_missing');
    this.key = key; this.limits = { ...LIMITS, ...limits }; this.readers = 0;
    this.dataDir = path.resolve(dataDir); this.root = path.join(this.dataDir, 'server-backups');
    // DATA may have a platform alias above it, but the private directory itself must be real.
    if (create) fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const ds = stat(this.dataDir); if (!ds.isDirectory() || ds.isSymbolicLink()) throw error('unsafe_store');
    this.dataIdentity = identity(ds); this.dataReal = fs.realpathSync(this.dataDir);
    if (create) { try { fs.mkdirSync(this.root, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; } }
    const st = stat(this.root);
    if (!st.isDirectory() || st.isSymbolicLink() || (process.platform !== 'win32' && ((st.mode & 0o077) || st.uid !== process.getuid()))) throw error('unsafe_store');
    if (process.platform === 'win32') { try { assertPrivatePath(this.root, { directory: true }); } catch { throw error('unsafe_store'); } }
    this.rootIdentity = identity(st); this.guard();
    const names = this.names(); this.objectCount = names.length;
    if (names.includes('catalog.enc')) this.catalog = this.json('catalog.enc', this.limits.catalogBytes);
    else if (!create || names.some(n => !/^tmp-[a-f0-9]+$/.test(n))) throw error('catalog_missing');
    else { this.catalog = { v: 1, servers: {} }; this.atomic('catalog.enc', this.encode('catalog.enc', this.catalog)); }
    if (this.catalog.v !== 1 || !this.catalog.servers || typeof this.catalog.servers !== 'object') throw error('corrupt_store');
    if (Object.keys(this.catalog.servers).length > 128) throw error('quota');
    for (const [k, h] of Object.entries(this.catalog.servers)) {
      if (!h || typeof h.id !== 'string' || !h.id || h.id.length > 200 || typeof h.name !== 'string' || !Array.isArray(h.snapshots) || h.snapshots.length > 100 ||
        k !== crypto.createHmac('sha256', this.key).update('server:' + h.id).digest('hex')) throw error('corrupt_store');
      const ids = new Set();
      for (const s of h.snapshots) {
        if (!s || !ID.test(s.id) || ids.has(s.id) || s.serverId !== h.id || !Number.isFinite(s.at) || typeof s.complete !== 'boolean' || !Number.isSafeInteger(s.files) || s.files < 1 || s.files > this.limits.files ||
          !Number.isSafeInteger(s.bytes) || s.bytes < 1 || s.bytes > this.limits.jobBytes || !Number.isSafeInteger(s.skipped) || s.skipped < 0) throw error('corrupt_store');
        ids.add(s.id);
      }
    }
    this.usage();
  }
  static exists(dataDir) {
    let dir;
    try {
      const root = path.join(dataDir, 'server-backups'), s = stat(root);
      if (!s.isDirectory() || s.isSymbolicLink() || stat(dataDir).isSymbolicLink()) throw error('unsafe_store');
      dir = fs.opendirSync(root); return !!dir.readSync();
    } catch (e) { if (e.code === 'ENOENT') return false; throw error('unsafe_store'); }
    finally { if (dir) dir.closeSync(); }
  }
  verifyCatalog() {
    if (JSON.stringify(this.json('catalog.enc', this.limits.catalogBytes)) !== JSON.stringify(this.catalog)) throw error('corrupt_store');
  }
  guard() {
    const d = stat(this.dataDir), r = stat(this.root);
    if (d.isSymbolicLink() || r.isSymbolicLink() || !d.isDirectory() || !r.isDirectory() || identity(d) !== this.dataIdentity ||
      identity(r) !== this.rootIdentity || (process.platform !== 'win32' && ((r.mode & 0o077) || r.uid !== process.getuid())) || fs.realpathSync(this.dataDir) !== this.dataReal || fs.realpathSync(this.root) !== path.join(this.dataReal, 'server-backups')) throw error('unsafe_store');
  }
  names() {
    this.guard(); const out = [], dir = fs.opendirSync(this.root);
    try { let entry; while ((entry = dir.readSync())) { if (out.length >= this.limits.objects) throw error('quota'); out.push(entry.name); } }
    finally { dir.closeSync(); } return out;
  }
  stat(name) {
    this.guard(); const s = stat(path.join(this.root, name));
    if (!s.isFile() || s.nlink !== 1 || s.isSymbolicLink() || (process.platform !== 'win32' && ((s.mode & 0o077) || s.uid !== process.getuid()))) throw error('unsafe_store'); return s;
  }
  usage() { let bytes = 0; const names = this.names(); this.objectCount = names.length; for (const n of names) if (OBJECT.test(n)) bytes += this.stat(n).size;  /* stray files are not ours: not counted */ this.diskBytes = bytes; if (bytes > this.limits.diskBytes) throw error('quota'); return bytes; }
  encode(name, value) { return this.seal(name, Buffer.from(JSON.stringify(value))); }
  seal(name, data) {
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', this.key, iv); c.setAAD(Buffer.from('termnest-backup-v1:' + name));
    return Buffer.concat([Buffer.from('TNB1'), iv, c.update(data), c.final(), c.getAuthTag()]);
  }
  read(name, max) {
    if (name !== 'catalog.enc' && !/^(?:[a-f0-9]{64})\.(?:chunk|manifest)$/.test(name)) throw error('invalid_id');
    const st = this.stat(name); if (st.size > max + 32 || st.size < 32) throw error('corrupt_store');
    const fd = fs.openSync(path.join(this.root, name), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    let data;
    try {
      const opened = stat(fd, true); if (identity(opened) !== identity(st) || opened.nlink !== 1 || !opened.isFile()) throw error('unsafe_store');
      data = Buffer.alloc(st.size); let off = 0;
      while (off < data.length) { const n = fs.readSync(fd, data, off, data.length - off, off); if (!n) throw error('corrupt_store'); off += n; }
      const after = stat(fd, true); if (after.size !== st.size || after.mtimeNs !== st.mtimeNs || after.ctimeNs !== st.ctimeNs) throw error('unsafe_store');
      this.guard(); if (identity(this.stat(name)) !== identity(opened)) throw error('unsafe_store');
    } finally { fs.closeSync(fd); }
    return this.unseal(name, data);
  }
  unseal(name, data) {
    try {
      if (data.subarray(0, 4).toString() !== 'TNB1') throw error('corrupt_store');
      const d = crypto.createDecipheriv('aes-256-gcm', this.key, data.subarray(4, 16)); d.setAAD(Buffer.from('termnest-backup-v1:' + name)); d.setAuthTag(data.subarray(-16));
      return Buffer.concat([d.update(data.subarray(16, -16)), d.final()]);
    } catch { throw error('corrupt_store'); }
  }
  async readChunk(id) {
    if (!ID.test(id || '')) throw error('invalid_id');
    const name = id + '.chunk', st = this.stat(name);
    if (st.size > this.limits.chunkBytes + 32 || st.size < 32) throw error('corrupt_store');
    const fd = await fs.promises.open(path.join(this.root, name), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    let data;
    try {
      const opened = await fd.stat({ bigint: true });
      if (identity(opened) !== identity(st) || opened.nlink !== 1n || !opened.isFile()) throw error('unsafe_store');
      data = Buffer.alloc(st.size); let off = 0;
      while (off < data.length) { const { bytesRead } = await fd.read(data, off, data.length - off, off); if (!bytesRead) throw error('corrupt_store'); off += bytesRead; }
      const after = await fd.stat({ bigint: true });
      if (Number(after.size) !== st.size || after.mtimeNs !== st.mtimeNs || after.ctimeNs !== st.ctimeNs) throw error('unsafe_store');
      this.guard(); if (identity(this.stat(name)) !== identity(opened)) throw error('unsafe_store');
    } finally { await fd.close(); }
    return this.unseal(name, data);
  }
  json(name, max) { try { return JSON.parse(this.read(name, max)); } catch (e) { throw e.code === 'unsafe_store' ? e : error('corrupt_store'); } }
  syncDir() {
    let fd; try { fd = fs.openSync(this.root, 'r'); fs.fsyncSync(fd); }
    catch (e) { if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EBADF'].includes(e.code) || process.platform === 'linux') throw e; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  atomic(name, data) {
    this.guard();
    let previous; try { previous = this.stat(name); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if ((this.diskBytes || 0) + data.length > this.limits.diskBytes || (this.objectCount || 0) + 1 > this.limits.objects) throw error('quota');
    const tmp = 'tmp-' + crypto.randomBytes(16).toString('hex'), p = path.join(this.root, tmp);
    const fd = fs.openSync(p, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    try {
      let off = 0; while (off < data.length) { const n = fs.writeSync(fd, data, off, data.length - off); if (!n) throw error('storage_denied'); off += n; }
      fs.fsyncSync(fd); const s = stat(fd, true); if (!s.isFile() || s.nlink !== 1) throw error('unsafe_store');
      this.guard(); if (identity(this.stat(tmp)) !== identity(s)) throw error('unsafe_store');
      try { this.stat(name); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      fs.renameSync(p, path.join(this.root, name)); this.guard();
      if (identity(this.stat(name)) !== identity(s)) throw error('unsafe_store');
      this.syncDir();
      this.diskBytes = (this.diskBytes || 0) + data.length - (previous?.size || 0);
      this.objectCount = (this.objectCount || 0) + (previous ? 0 : 1);
    } finally { fs.closeSync(fd); try { this.guard(); fs.unlinkSync(p); } catch { /* absent after rename; never follow a changed directory */ } }
  }
  chunk(data) {
    if (!Buffer.isBuffer(data) || data.length > this.limits.chunkBytes) throw error('quota');
    const id = crypto.createHmac('sha256', this.key).update('chunk:').update(data).digest('hex'), name = id + '.chunk';
    try { const previous = this.read(name, this.limits.chunkBytes); if (!previous.equals(data)) throw error('corrupt_store'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; this.atomic(name, this.seal(name, data)); }
    return id;
  }
  begin(serverId, name) {
    if (typeof serverId !== 'string' || !serverId || serverId.length > 200 || typeof name !== 'string') throw error('invalid_server');
    this.verifyCatalog(); this.gc(); this.usage(); return { serverId, name: name.slice(0, 200), files: [], bytes: 0, paths: new Set() };
  }
  add(tx, file) {
    if (!safePath(file.path) || !['chat', 'file'].includes(file.kind) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > this.limits.fileBytes ||
      !Number.isFinite(file.mtimeMs) || !Array.isArray(file.chunks) || file.chunks.length > Math.ceil(this.limits.fileBytes / this.limits.chunkBytes) + 1 || file.chunks.some(id => !ID.test(id)) ||
      tx.files.length >= this.limits.files || tx.bytes + file.size > this.limits.jobBytes || tx.paths.has(file.path)) throw error('invalid_file');
    let size = 0; for (const id of file.chunks) size += this.read(id + '.chunk', this.limits.chunkBytes).length;
    if (size !== file.size) throw error('incomplete_file');
    tx.paths.add(file.path); tx.bytes += size;
    tx.files.push({ id: crypto.randomBytes(32).toString('hex'), path: file.path, kind: file.kind, ...(file.tool ? { tool: file.tool } : {}), size, mtimeMs: file.mtimeMs, chunks: file.chunks });
  }
  commit(tx, { skipped = 0, reason = '', retention = 32, signal } = {}) {
    checkAbort(signal); if (!tx.files.length || !tx.bytes) throw error('empty');
    if (!Number.isInteger(skipped) || skipped < 0 || !Number.isInteger(retention) || retention < 2 || retention > 100) throw error('invalid');
    const id = crypto.randomBytes(32).toString('hex'), at = Date.now();
    // Nothing changed since the newest snapshot (same paths, sizes and content): another copy would only push older versions out.
    const sig = this.contentSignature(tx.files), hostNow = this.catalog.servers[crypto.createHmac('sha256', this.key).update('server:' + tx.serverId).digest('hex')], prev = hostNow?.snapshots[0];
    if (prev && prev.complete === (skipped === 0) && prev.skipped === skipped) {
      let prevSig = prev.sig; if (!prevSig) { try { prevSig = this.contentSignature(this.manifest(tx.serverId, prev.id).entries); } catch { prevSig = null; } }
      if (prevSig && prevSig === sig) { this.gc(); return { ...prev, unchanged: true, checkedAt: at }; }
    }
    const summary = { id, serverId: tx.serverId, at, complete: skipped === 0, files: tx.files.length, bytes: tx.bytes, skipped, reason: String(reason).slice(0, 80), sig };
    const manifest = { v: 1, ...summary, entries: tx.files }, encoded = this.encode(id + '.manifest', manifest);
    if (encoded.length > this.limits.manifestBytes) throw error('quota');
    this.atomic(id + '.manifest', encoded); checkAbort(signal);
    const next = structuredClone(this.catalog), k = crypto.createHmac('sha256', this.key).update('server:' + tx.serverId).digest('hex');
    if (!next.servers[k] && Object.keys(next.servers).length >= 128) throw error('quota');
    const host = next.servers[k] ||= { id: tx.serverId, name: tx.name, snapshots: [] }; host.name = tx.name;
    host.snapshots.unshift(summary);
    const keep = tieredKeep(host.snapshots, retention, at), good = host.snapshots.find(s => s.complete);
    if (good && !keep.some(s => s.id === good.id)) keep[keep.length - 1] = good;
    host.snapshots = keep;
    const catalog = this.encode('catalog.enc', next); if (catalog.length > this.limits.catalogBytes) throw error('quota');
    checkAbort(signal); this.atomic('catalog.enc', catalog); this.catalog = next;
    this.gc(); return summary;
  }
  contentSignature(entries) {
    const h = crypto.createHmac('sha256', this.key).update('content:');
    for (const f of [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) h.update(JSON.stringify([f.path, f.kind, f.size, f.chunks])).update('\n');
    return h.digest('hex');
  }
  servers() { return Object.values(this.catalog.servers).map(h => ({ id: h.id, name: h.name })); }
  snapshots(serverId) { return Object.values(this.catalog.servers).find(h => h.id === serverId)?.snapshots.slice() || []; }
  manifest(serverId, id) {
    if (!ID.test(id || '') || !this.snapshots(serverId).some(s => s.id === id)) throw error('not_found');
    const m = this.json(id + '.manifest', this.limits.manifestBytes);
    if (m.v !== 1 || m.id !== id || m.serverId !== serverId || !Array.isArray(m.entries) || m.entries.length > this.limits.files) throw error('corrupt_store');
    const seen = new Set(), paths = new Set(); let totalBytes = 0;
    for (const f of m.entries) {
      if (!ID.test(f.id) || seen.has(f.id) || paths.has(f.path) || !safePath(f.path) || !['file', 'chat'].includes(f.kind) || !Number.isSafeInteger(f.size) || f.size < 0 || f.size > this.limits.fileBytes ||
        !Array.isArray(f.chunks) || f.chunks.length > Math.ceil(this.limits.fileBytes / this.limits.chunkBytes) + 1 || f.chunks.some(c => !ID.test(c))) throw error('corrupt_store');
      seen.add(f.id); paths.add(f.path); totalBytes += f.size;
    }
    if (totalBytes !== m.bytes || m.entries.length !== m.files || totalBytes > this.limits.jobBytes) throw error('corrupt_store');
    return m;
  }
  acquire(serverId, id) {
    const m = this.manifest(serverId, id); this.readers++;
    let released = false; return { manifest: m, release: () => { if (!released) { released = true; this.readers--; } } };
  }
  *fileBytes(file) {
    let size = 0;
    for (const id of file.chunks) { const b = this.read(id + '.chunk', this.limits.chunkBytes); size += b.length; if (size > file.size) throw error('corrupt_store'); yield b; }
    if (size !== file.size) throw error('corrupt_store');
  }
  async *downloadBytes(file) {
    let size = 0;
    for (const id of file.chunks) {
      const bytes = await this.readChunk(id); size += bytes.length;
      if (size > file.size) throw error('corrupt_store'); yield bytes;
    }
    if (size !== file.size) throw error('corrupt_store');
  }
  async stream(res, serverId, snapshotId, fileId) {
    const lease = this.acquire(serverId, snapshotId);
    try { await this.transfer(res, lease.manifest, fileId); } finally { lease.release(); }
  }
  async export(res, serverId, snapshotId) {
    const lease = this.acquire(serverId, snapshotId);
    try { await this.transfer(res, lease.manifest); } finally { lease.release(); }
  }
  async transfer(res, manifest, fileId) {
    if (fileId !== undefined) {
      const f = manifest.entries.find(f => f.id === fileId); if (!f) throw error('not_found');
      res.setHeader('Content-Type', 'application/octet-stream'); res.setHeader('Content-Length', f.size);
      res.setHeader('Content-Disposition', `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(f.path.split('/').at(-1)).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))}`);
      await pipeline(Readable.from(this.downloadBytes(f), { objectMode: false, highWaterMark: this.limits.chunkBytes }), res); return;
    }
    const store = this;
    async function* archive() {
      let n = 0;
      for (const f of manifest.entries) {
        const pax = paxRecord('path', f.path), xname = 'PaxHeaders/' + (++n);
        yield tarHeader(xname, pax.length, f.mtimeMs, 'x'); yield pax; if (pax.length % 512) yield Buffer.alloc(512 - pax.length % 512);
        yield tarHeader('files/' + n, f.size, f.mtimeMs, '0'); yield* store.downloadBytes(f);
        if (f.size % 512) yield Buffer.alloc(512 - f.size % 512);
      }
      yield Buffer.alloc(1024);
    }
    res.setHeader('Content-Type', 'application/x-tar'); res.setHeader('Content-Disposition', 'attachment; filename="termnest-backup.tar"');
    await pipeline(Readable.from(archive(), { objectMode: false, highWaterMark: this.limits.chunkBytes }), res);
  }
  preview(serverId, snapshotId, fileId) {
    const lease = this.acquire(serverId, snapshotId);
    try {
      const f = lease.manifest.entries.find(f => f.id === fileId); if (!f) throw error('not_found');
      const max = this.limits.previewBytes, start = f.kind === 'chat' ? Math.max(0, f.size - max) : 0;
      const parts = []; let offset = 0, got = 0;
      for (const id of f.chunks) {
        const b = this.read(id + '.chunk', this.limits.chunkBytes);
        if (offset + b.length > start && got < max) { const p = b.subarray(Math.max(0, start - offset), Math.max(0, start - offset) + max - got); parts.push(p); got += p.length; }
        offset += b.length; if (got === max) break;
      }
      let data = Buffer.concat(parts), text = null, binary = data.some(byte => byte < 9 || (byte > 10 && byte < 13) || (byte > 13 && byte < 32) || byte === 127);
      // Cut UTF-8 only at code point boundaries for a bounded prefix/tail.
      if (start) { let i = 0; while (i < 3 && (data[i] & 0xc0) === 0x80) i++; data = data.subarray(i); }
      if (f.size > max && !start) { let cut = data.length; while (cut > data.length - 4 && cut > 0) { try { new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, cut)); break; } catch { cut--; } } data = data.subarray(0, cut); }
      try { if (!binary) text = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { binary = true; }
      return { path: f.path, kind: f.kind, ...(f.tool ? { tool: f.tool } : {}), text, size: f.size, binary, truncated: f.size > max };
    } finally { lease.release(); }
  }
  gc() {
    // A lease pins ALL objects until its stream finishes, including snapshots removed from catalog.
    if (this.readers) return;
    const keep = new Set(['catalog.enc']);
    for (const h of Object.values(this.catalog.servers)) for (const s of h.snapshots) {
      keep.add(s.id + '.manifest'); const m = this.manifest(h.id, s.id); for (const f of m.entries) for (const c of f.chunks) keep.add(c + '.chunk');
    }
    for (const n of this.names()) {
      if (keep.has(n)) continue;
      if (!OBJECT.test(n)) continue;   // not ours (.DS_Store, Thumbs.db…): never fatal, never deleted
      this.stat(n); this.guard(); fs.unlinkSync(path.join(this.root, n));
    }
    this.syncDir(); this.usage();
  }
}
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`; let n = Buffer.byteLength(body) + 1;
  while (String(n).length + Buffer.byteLength(body) !== n) n = String(n).length + Buffer.byteLength(body);
  return Buffer.from(String(n) + body);
}
function tarHeader(name, size, mtimeMs, type) {
  const b = Buffer.alloc(512); b.write(name, 0, 100, 'utf8');
  const oct = (value, pos, len) => b.write(Math.floor(value).toString(8).padStart(len - 1, '0') + '\0', pos, len, 'ascii');
  oct(0o600, 100, 8); oct(0, 108, 8); oct(0, 116, 8); oct(size, 124, 12); oct(Math.max(0, mtimeMs / 1000 || 0), 136, 12);
  b.fill(32, 148, 156); b.write(type, 156); b.write('ustar\0', 257, 6); b.write('00', 263, 2);
  const sum = b.reduce((a, v) => a + v, 0); b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8); return b;
}
module.exports = { SnapshotStore, LIMITS, tieredKeep, safePath, error, checkAbort, paxRecord, tarHeader };
