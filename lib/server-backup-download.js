'use strict';
const crypto = require('crypto');
const { error } = require('./server-backup-store');
const PREFIX = '/api/features/server-backup/download-ticket/';
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const ID = /^[a-f0-9]{64}$/;
const digest = token => crypto.createHash('sha256').update(token).digest('hex');

// These bearer capabilities authorize exactly one saved download, never another API.
// Only hashes live here. Neither settings, status nor logs contain download URLs.
class BackupDownloads {
  constructor(controller, { ttl = 120000, duration = 600000, maxPending = 8, maxActive = 2 } = {}) {
    this.controller = controller; this.ttl = ttl; this.duration = duration;
    this.maxPending = maxPending; this.maxActive = maxActive;
    this.tickets = new Map(); this.active = new Set();
  }
  clear() {
    for (const ticket of this.tickets.values()) { clearTimeout(ticket.timer); ticket.lease.release(); }
    this.tickets.clear();
    for (const job of this.active) job.res.destroy();
  }
  check() {
    if (this.controller.stopped || !this.controller.host.privateData.unlocked()) {
      this.clear(); throw error(this.controller.stopped ? 'stopping' : 'vault_locked');
    }
  }
  remove(key) {
    const ticket = this.tickets.get(key);
    if (ticket) { this.tickets.delete(key); clearTimeout(ticket.timer); }
    return ticket;
  }
  mint(body) {
    this.check();
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['serverId', 'snapshotId', 'fileId'].includes(k)) ||
      typeof body.serverId !== 'string' || !body.serverId.length || body.serverId.length > 256 || !ID.test(body.snapshotId || '') ||
      (body.fileId !== undefined && (typeof body.fileId !== 'string' || !ID.test(body.fileId)))) throw error('invalid');
    if (this.tickets.size + this.active.size >= this.maxPending) throw error('busy');
    const store = this.controller.openStore(); if (!store) throw error('not_found');
    const lease = store.acquire(body.serverId, body.snapshotId);
    try {
      if (body.fileId !== undefined && !lease.manifest.entries.some(f => f.id === body.fileId)) throw error('not_found');
      const token = crypto.randomBytes(32).toString('base64url'), key = digest(token);
      const ticket = { store, lease, fileId: body.fileId, expires: Date.now() + this.ttl };
      ticket.timer = setTimeout(() => { this.remove(key)?.lease.release(); }, this.ttl); ticket.timer.unref?.();
      this.tickets.set(key, ticket);
      return { downloadURL: PREFIX + token };
    } catch (e) { lease.release(); throw e; }
  }
  cancel(downloadURL) {
    if (typeof downloadURL !== 'string' || !downloadURL.startsWith(PREFIX) || !TOKEN.test(downloadURL.slice(PREFIX.length))) throw error('invalid');
    this.remove(digest(downloadURL.slice(PREFIX.length)))?.lease.release();
  }
  async serve(req, res, url) {
    res.setHeader('Cache-Control', 'no-store, private'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    const reject = status => { res.statusCode = status; res.end(); };
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); reject(405); return; }
    // System-browser navigation has no Origin. If present it must be this HTTP server.
    if ((req.headers.origin && req.headers.origin !== 'http://' + req.headers.host) ||
      (req.headers['sec-fetch-site'] && !['none', 'same-origin'].includes(req.headers['sec-fetch-site']))) { reject(403); return; }
    const token = url.pathname.slice(PREFIX.length);
    if (!url.pathname.startsWith(PREFIX) || !TOKEN.test(token) || url.search) { reject(404); return; }
    try { this.check(); } catch { reject(401); return; }
    // Delete synchronously, before any stream/I/O: racing GETs cannot both consume it.
    const ticket = this.remove(digest(token));
    if (!ticket) { reject(404); return; }
    const job = { res }; let timer;
    try {
      if (ticket.expires <= Date.now()) { reject(404); return; }
      if (this.active.size >= this.maxActive) { reject(409); return; }
      this.active.add(job);
      timer = setTimeout(() => res.destroy(), this.duration); timer.unref?.();
      // Use the leased manifest even if retention has since removed it from the catalog.
      await ticket.store.transfer(res, ticket.lease.manifest, ticket.fileId);
    } catch {
      if (!res.headersSent && !res.destroyed) reject(500); else res.destroy();
    } finally { clearTimeout(timer); this.active.delete(job); ticket.lease.release(); }
  }
}
module.exports = { BackupDownloads, PREFIX };
