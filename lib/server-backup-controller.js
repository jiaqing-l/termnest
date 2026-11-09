'use strict';
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { SnapshotStore, LIMITS, error } = require('./server-backup-store');
const { validRoot, collect } = require('./server-backup-source');
const { BackupDownloads } = require('./server-backup-download');
const SAFE_CODES = new Set(['cancelled', 'empty', 'quota', 'unsafe_store', 'key_missing', 'key_lost', 'corrupt_store', 'catalog_missing',
  'vault_backup_failed', 'vault_locked', 'unsupported_source', 'unsafe_root', 'unsafe_source', 'source_changed', 'listing_failed',
  'scan_limit', 'job_limit', 'timeout', 'source_unavailable', 'source_protocol', 'protocol_limit', 'incomplete_file', 'source_failed', 'not_found']);
function codeOf(e) { return SAFE_CODES.has(e?.code) ? e.code : ['ENOSPC', 'EDQUOT'].includes(e?.code) ? 'quota' : ['EACCES', 'EPERM', 'EROFS'].includes(e?.code) ? 'storage_denied' : 'backup_failed'; }
class BackupController {
  constructor(host, options = {}) {
    this.host = host; this.dataDir = host.privateData.directory(); if (!this.dataDir) throw error('storage_unavailable');
    this.options = options; this.store = null; this.storeKey = null; this.states = new Map(); this.online = new Map(); this.catchup = new Set(); this.job = null; this.stopped = false;
    this.downloads = new BackupDownloads(this, options.downloads);
    if (options.timers !== false) { this.timer = setInterval(() => this.tick(), 5000); this.timer.unref?.(); this.first = setTimeout(() => this.tick(), 100); this.first.unref?.(); }
  }
  settings() { return this.host.privateData.unlocked() ? this.host.settings.get() : {}; }
  config() {
    const s = this.settings();
    if ((s.enabled !== undefined && typeof s.enabled !== 'boolean') || (s.servers !== undefined && (!Array.isArray(s.servers) || s.servers.length > 128 || s.servers.some(c => !c || typeof c.serverId !== 'string' || !Array.isArray(c.roots) || c.roots.length > 16 || c.roots.some(r => !validRoot(r)) || typeof c.includeChats !== 'boolean'))) ||
      (s.intervalMinutes !== undefined && (!Number.isInteger(s.intervalMinutes) || s.intervalMinutes < 5 || s.intervalMinutes > 1440)) ||
      (s.retention !== undefined && (!Number.isInteger(s.retention) || s.retention < 2 || s.retention > 100)) ||
      (s.knownServers !== undefined && (!Array.isArray(s.knownServers) || s.knownServers.some(id => typeof id !== 'string')))) throw error('corrupt_store');
    const servers = Array.isArray(s.servers) ? s.servers.map(c => ({ ...c, roots: [...c.roots] })) : [];
    for (const saved of this.host.privateData.servers()) if (!saved.local && !servers.some(c => c.serverId === saved.id)) servers.push({ serverId: saved.id, roots: [], includeChats: true });
    // An explicit complete list suppresses defaults for unselected EXISTING hosts. Newly saved hosts
    // still receive automatic chat protection after unlock.
    if (Array.isArray(s.knownServers)) for (let i = servers.length - 1; i >= 0; i--) {
      if (s.knownServers.includes(servers[i].serverId) && !(s.servers || []).some(c => c.serverId === servers[i].serverId)) servers.splice(i, 1);
    }
    return { enabled: s.enabled !== false, intervalMinutes: s.intervalMinutes || 5, retention: s.retention || 32, servers };
  }
  openStore(create = false) {
    if (!this.host.privateData.unlocked()) throw error('vault_locked');
    let s = this.settings();
    if (!s.contentKey) {
      if (SnapshotStore.exists(this.dataDir)) throw error('key_lost');
      if (!create) return null;
      s = { ...s, contentKey: crypto.randomBytes(32).toString('base64'), keyBackedUp: false }; this.host.settings.set(s);
    }
    if (!/^[A-Za-z0-9+/]{43}=$/.test(s.contentKey) || Buffer.from(s.contentKey, 'base64').length !== 32) throw error('key_missing');
    if (create && !s.keyBackedUp) {
      try { this.host.privateData.forceVaultBackup(); } catch { throw error('vault_backup_failed'); }
      s = { ...s, keyBackedUp: true }; this.host.settings.set(s);
    }
    if (this.storeKey !== s.contentKey) { this.store = null; this.storeKey = s.contentKey; }
    if (!this.store && (create || SnapshotStore.exists(this.dataDir))) this.store = new SnapshotStore(this.dataDir, Buffer.from(s.contentKey, 'base64'), this.options.limits, { create });
    this.store?.verifyCatalog();
    return this.store;
  }
  status() {
    const storage = { host: os.hostname(), path: path.resolve(this.dataDir, 'server-backups') };
    if (!this.host.privateData.unlocked()) return { enabled: false, intervalMinutes: 5, retention: 32, storage, servers: [], limits: LIMITS };
    const config = this.config(), saved = this.host.privateData.servers().filter(s => !s.local);
    let store, storeError = ''; try { store = this.openStore(); } catch (e) { storeError = codeOf(e); }
    const ids = new Set([...saved.map(s => s.id), ...config.servers.map(s => s.serverId), ...(store?.servers().map(s => s.id) || [])]);
    const servers = [...ids].map(id => {
      const c = config.servers.find(c => c.serverId === id), backend = this.host.backendOf(id), online = !!backend?.ready;
      const snapshots = store?.snapshots(id) || [], latest = snapshots[0], good = snapshots.find(s => s.complete), state = this.states.get(id) || {};
      const running = this.job?.serverId === id;
      const outcome = state.phase === 'partial' || (state.phase === 'error' && state.reason !== 'cancelled') ? state.phase :
        !state.phase && latest && !latest.complete ? 'partial' : '';
      const phase = running ? 'running' : storeError ? 'error' : !config.enabled ? outcome || 'paused' : !online ? 'offline' :
        state.phase || (latest ? (latest.complete ? 'current' : 'partial') : 'never');
      return { id, name: saved.find(s => s.id === id)?.name || store?.servers().find(s => s.id === id)?.name || id,
        online, configured: !!c, roots: c?.roots || [], includeChats: c?.includeChats || false, phase,
        lastSuccessAt: good?.at || null, lastAttemptAt: state.lastAttemptAt || latest?.at || null,
        files: latest?.files || 0, bytes: latest?.bytes || 0, skipped: state.skipped ?? latest?.skipped ?? 0,
        reason: running ? '' : storeError || (state.phase ? state.reason : latest?.reason) || '', ...(state.progress && running ? { progress: state.progress } : {}), hasSnapshot: !!latest };
    });
    return { enabled: config.enabled, intervalMinutes: config.intervalMinutes, retention: config.retention, storage, servers, limits: this.options.limits ? { ...LIMITS, ...this.options.limits } : LIMITS };
  }
  control(body) {
    if (!this.host.privateData.unlocked()) throw error('vault_locked');
    if (!body || typeof body.enabled !== 'boolean' || (body.intervalMinutes !== undefined && (!Number.isInteger(body.intervalMinutes) || body.intervalMinutes < 5 || body.intervalMinutes > 1440)) ||
      (body.retention !== undefined && (!Number.isInteger(body.retention) || body.retention < 2 || body.retention > 100))) throw error('invalid');
    const s = this.settings(), current = this.config(); let servers = current.servers;
    if (body.servers !== undefined) {
      if (!Array.isArray(body.servers) || body.servers.length > 128) throw error('invalid');
      const saved = new Set(this.host.privateData.servers().filter(s => !s.local).map(s => s.id)), seen = new Set();
      const configured = new Set(current.servers.map(c => c.serverId)), known = new Set([...saved, ...configured]);
      if (body.servers.some(c => c && typeof c.serverId === 'string' && !known.has(c.serverId))) {
        for (const stored of this.openStore()?.servers() || []) known.add(stored.id);
      }
      servers = body.servers.flatMap(c => {
        if (!c || typeof c.serverId !== 'string' || !known.has(c.serverId) || seen.has(c.serverId) || !Array.isArray(c.roots) || c.roots.length > 16 ||
          c.roots.some(r => !validRoot(r)) || new Set(c.roots).size !== c.roots.length || typeof c.includeChats !== 'boolean') throw error('invalid');
        seen.add(c.serverId);
        // The UI sends every status row, including offline-only history. Echoing such a
        // row must not enroll an unconfigured, deleted server in automatic backups.
        if (!saved.has(c.serverId) && !configured.has(c.serverId)) return [];
        return [{ serverId: c.serverId, roots: c.roots.map(r => r.replace(/\/$/, '')), includeChats: c.includeChats }];
      });
    }
    this.host.settings.set({ ...s, enabled: body.enabled, intervalMinutes: body.intervalMinutes ?? current.intervalMinutes,
      retention: body.retention ?? current.retention, servers,
      knownServers: this.host.privateData.servers().filter(s => !s.local).map(s => s.id) });
    // Changing scopes also cancels the previous scope. OFF never allows a late publication.
    this.job?.abort.abort();
    return this.status();
  }
  run(serverId) {
    if (this.stopped) throw error('stopping');
    if (!this.host.privateData.unlocked()) throw error('vault_locked');
    if (this.job) throw error('busy');
    const config = this.config(), c = config.servers.find(c => c.serverId === serverId);
    const backend = this.host.backendOf(serverId);
    if (!backend?.ready) throw error('offline');
    if (!c || (!c.includeChats && !c.roots.length)) throw error('unconfigured');
    const saved = this.host.privateData.servers().find(s => s.id === serverId && !s.local); if (!saved) throw error('offline');
    this.catchup.delete(serverId);
    const connection = backend.client, identity = JSON.stringify([backend.cfg?.host, backend.cfg?.port, backend.cfg?.user, backend.cfg?.fingerprint]);
    const job = { serverId, abort: new AbortController() }; this.job = job;
    this.states.set(serverId, { phase: 'running', reason: '', lastAttemptAt: Date.now(), skipped: 0, progress: { files: 0, bytes: 0 } });
    job.promise = new Promise(resolve => setImmediate(resolve)).then(async () => {
      try {
        if (job.abort.signal.aborted) throw error('cancelled');
        const store = this.openStore(true);
        const out = await collect(store, backend, { ...c, name: saved.name, retention: config.retention }, {
          signal: job.abort.signal, transport: this.options.transport,
          beforeCommit: () => { if (this.host.backendOf(serverId) !== backend || backend.client !== connection || JSON.stringify([backend.cfg?.host, backend.cfg?.port, backend.cfg?.user, backend.cfg?.fingerprint]) !== identity || !backend.ready || !this.host.privateData.unlocked()) throw error('source_unavailable'); },
          progress: p => { const st = this.states.get(serverId); if (st) st.progress = p; },
        });
        Object.assign(this.states.get(serverId), { phase: out.complete ? 'current' : 'partial', reason: out.reason, skipped: out.skipped });
      } catch (e) { Object.assign(this.states.get(serverId), { phase: 'error', reason: codeOf(e) }); }
      finally { if (this.job === job) this.job = null; }
    });
    return { queued: true, serverId };
  }
  tick() {
    if (!this.host.privateData.unlocked()) this.downloads.clear();
    if (this.stopped || !this.host.privateData.unlocked()) return;
    let config; try { config = this.config(); } catch { return; } if (!config.enabled) return;
    const due = [], now = Date.now(), saved = new Set(this.host.privateData.servers().filter(s => !s.local).map(s => s.id));
    for (const c of config.servers) {
      const online = !!this.host.backendOf(c.serverId)?.ready, wasOnline = this.online.get(c.serverId);
      this.online.set(c.serverId, online);
      if (online && wasOnline === false) this.catchup.add(c.serverId);
      if (!saved.has(c.serverId) || !online || (!c.includeChats && !c.roots.length)) continue;
      const state = this.states.get(c.serverId);
      if (this.catchup.has(c.serverId) || state?.lastAttemptAt == null || now - state.lastAttemptAt >= config.intervalMinutes * 60000) due.push(c);
    }
    if (this.job) return;
    // Long jobs can outlast the interval. Oldest attempts (including never attempted)
    // go first so the saved-list order cannot starve later hosts. Reconnects stay due.
    due.sort((a, b) => (this.states.get(a.serverId)?.lastAttemptAt ?? 0) - (this.states.get(b.serverId)?.lastAttemptAt ?? 0));
    for (const c of due) {
      try { this.run(c.serverId); break; } catch { /* no exception escapes a timer */ }
    }
  }
  createDownload(body) { return this.downloads.mint(body); }
  cancelDownload(url) { this.downloads.cancel(url); }
  download(req, res, url) { return this.downloads.serve(req, res, url); }
  pending() { return (this.job ? 1 : 0) + this.downloads.active.size; }
  stop() { this.stopped = true; clearInterval(this.timer); clearTimeout(this.first); this.job?.abort.abort(); this.downloads.clear(); }
}
module.exports = { BackupController, codeOf };
