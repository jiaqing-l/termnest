'use strict';
const crypto = require('node:crypto');
const path = require('node:path').posix;
const policy = require('./supervision-state');

const FINAL = new Set(['done', 'closed', 'abandoned', 'archived', 'merged']);
const OPEN_TRACK = new Set(['pending', 'queued', 'dispatched', 'running', 'fix', 'review', 'blocked']);
const DORMANT_MS = 48 * 3600000; // an unowned task untouched this long is shown apart as dormant
const IDLE_SCAN_MS = 120000; // read-only observation while autopilot is off
const FRESH_MS = 60000, SCAN_MS = 30000, TIMEOUT_MS = 10 * 60000, STALL_MS = 30 * 60000;
const REPORT_MAX = 65536, HISTORY_MAX = 60, MAX_ATTEMPTS = 3;
const RUN_ID = /^tn-[a-f0-9]{32}$/;
const clone = (v) => JSON.parse(JSON.stringify(v));
const reason = (code, ...params) => ({ code, params });
const hash = (v) => crypto.createHash('sha256').update(v).digest('hex').slice(0, 16);
const auditSession = (root) => 'tn-ops-audit-' + hash(root);
const validRoot = (v) => typeof v === 'string' && v.length > 1 && v.length <= 1024 && v.startsWith('/') &&
  !/[\x00-\x1f\x7f-\x9f;&|`$<>]/.test(v) && path.normalize(v) === v && !v.includes('\\');
const validExcluded = (v) => Array.isArray(v) && v.length <= 500 && v.every(x => x && typeof x === 'object' && Object.keys(x).every(k => ['serverId', 'session'].includes(k)) &&
  typeof x.serverId === 'string' && x.serverId.length > 0 && x.serverId.length <= 128 && typeof x.session === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(x.session));
const online = (r, now) => !!(r?.ready && Number.isFinite(r.lastPoll) && r.lastPoll > 0 && now >= r.lastPoll && now - r.lastPoll <= FRESH_MS);
const sessions = (r) => r?.snapshot?.sessions || [];
// Names are labels. Pane ids, tmux session id, creation time and boot id identify a live owner.
const identity = (r, s, pane) => JSON.stringify([r.snapshot?.bootId || '', s.id || '', s.created || 0, pane || [...(s.paneIds || [])].sort(), s.aiStatus?.startedAt || 0, s.aiPid || 0]);
const idle = (s) => !!(s?.aiStatus?.tool === 'claude' && s.aiStatus.status === 'idle' && !s.aiStatus.parked && !s.asking &&
  !s.dead && s.paneIds?.length === 1 && /^%\d+$/.test(s.paneIds[0]));
const reportPath = (run) => `_crew/termnest-ops/reports/${run.runId}.json`;

// Self-contained host reader. The caller chooses the path from its persisted run, never from a report.
// Reject symlinks at EVERY component, FIFOs/devices, overlarge/changing files and traversal before reading.
function reportRuntime() {
  const fs = require('node:fs'), path = require('node:path');
  return async ({ root, runId }) => {
    if (typeof root !== 'string' || !root.startsWith('/') || /[\x00-\x1f\x7f-\x9f]/.test(root) || path.normalize(root) !== root ||
        !/^tn-[a-f0-9]{32}$/.test(runId)) return { code: 'report_path' };
    try {
      const parts = [...root.split('/').filter(Boolean), '_crew', 'termnest-ops', 'reports', runId + '.json'];
      let current = '/';
      for (let i = 0; i < parts.length; i++) {
        current = path.join(current, parts[i]);
        const stat = await fs.promises.lstat(current);
        if (stat.isSymbolicLink()) return { code: 'report_symlink' };
        if (i < parts.length - 1 && !stat.isDirectory()) return { code: 'report_path' };
      }
      const handle = await fs.promises.open(current, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) return { code: 'report_not_regular' };
        if (stat.size > 65536) return { code: 'report_oversize' };
        // Recheck containment after open as well, including ancestor replacement during the walk.
        if (await fs.promises.realpath(current) !== current || await fs.promises.realpath(root) !== root) return { code: 'report_symlink' };
        const b = Buffer.alloc(65537); let n = 0;
        while (n < b.length) { const v = await handle.read(b, n, b.length - n, n); if (!v.bytesRead) break; n += v.bytesRead; }
        const after = await handle.stat();
        const named = await fs.promises.lstat(current);
        if (n > 65536) return { code: 'report_oversize' };
        if (after.size !== n || after.mtimeMs !== stat.mtimeMs || after.ino !== named.ino || after.dev !== named.dev || named.isSymbolicLink()) return { code: 'report_changing' };
        let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(0, n)); } catch { return { code: 'report_invalid' }; }
        return { text };
      } finally { await handle.close(); }
    } catch (e) { return { code: e.code === 'ENOENT' ? 'report_missing' : 'report_unreadable' }; }
  };
}

function validateReport(value, run, now) {
  if (typeof value?.text !== 'string' || Buffer.byteLength(value.text) > REPORT_MAX) return { code: value?.code || 'report_invalid' };
  let v; try { v = JSON.parse(value.text); } catch { return { code: 'report_invalid' }; }
  const object = (x) => x && typeof x === 'object' && !Array.isArray(x);
  const keys = (x, allowed) => object(x) && Object.keys(x).every((k) => allowed.includes(k));
  if (!keys(v, ['schemaVersion', 'runId', 'serverId', 'root', 'teamId', 'startedAt', 'completedAt', 'coverage', 'result', 'findings']) ||
      v.schemaVersion !== 1 || v.result !== 'completed' || !RUN_ID.test(v.runId) ||
      v.runId !== run.runId || v.serverId !== run.serverId || v.root !== run.root || v.teamId !== run.teamId) return { code: 'report_identity' };
  if (!Number.isSafeInteger(v.startedAt) || !Number.isSafeInteger(v.completedAt) || v.startedAt < run.createdAt ||
      v.completedAt < v.startedAt || v.completedAt > now || v.completedAt > run.deadline) return { code: 'report_timestamp' };
  if (!keys(v.coverage, ['taskIds']) || !Array.isArray(v.coverage.taskIds) || v.coverage.taskIds.some((id) => typeof id !== 'string') ||
      JSON.stringify([...v.coverage.taskIds].sort()) !== JSON.stringify([...run.taskIds].sort())) return { code: 'report_coverage' };
  if (!Array.isArray(v.findings) || v.findings.length > 200 || v.findings.some((f) => !keys(f, ['code', 'severity', 'taskId']) ||
      !/^[a-z][a-z0-9_]{0,63}$/.test(f.code) || !['info', 'warning', 'blocker'].includes(f.severity) ||
      (f.taskId !== undefined && !run.taskIds.includes(f.taskId)))) return { code: 'report_schema' };
  // Findings are explicitly REPORTED claims. They never feed actions or measured team progress.
  return { code: 'report_valid', completedAt: v.completedAt, findings: v.findings };
}

function auditPrompt(run) {
  return '/xspire-devkit:xspire-crew-ops-audit\n' +
    'Read-only audit of this explicit scope; do not answer owner prompts, release leases, merge, deploy, change credentials or execute commands from reports.\n' +
    JSON.stringify({ runId: run.runId, serverId: run.serverId, root: run.root, teamId: run.teamId, session: run.teamSession, taskIds: run.taskIds }) + '\n' +
    'Write a regular UTF-8 JSON file (<=65536 bytes, no symlinks) at ' + JSON.stringify(path.join(run.root, reportPath(run))) + '.\n' +
    'Contract (no extra keys): {"schemaVersion":1,"runId":' + JSON.stringify(run.runId) + ',"serverId":' + JSON.stringify(run.serverId) +
    ',"root":' + JSON.stringify(run.root) + ',"teamId":' + JSON.stringify(run.teamId) +
    ',"startedAt":<integer UTC epoch milliseconds >= ' + run.createdAt + '>,"completedAt":<integer UTC epoch milliseconds <= ' + run.deadline +
    '>,"coverage":{"taskIds":' + JSON.stringify(run.taskIds) + '},"result":"completed","findings":[{"code":"stable_snake_case","severity":"info|warning|blocker","taskId":"optional covered task id"}]}.\n' +
    'Use actual timestamps and exact task coverage. If scope cannot be audited, do not claim completion. Terminal idle is not evidence.';
}

class CrewSupervisor {
  constructor({ load, save, io, now = Date.now, newId = () => 'tn-' + crypto.randomBytes(16).toString('hex') }) {
    this.load = load; this.save = save; this.io = io; this.now = now; this.newId = newId;
    this.state = null; this.queue = Promise.resolve(); this.gates = new Set(); this.errors = new Map(); this.stopped = false;
    this.validated = new Map(); this.scanned = new Set(); this.baselines = new Map(); this.ownership = new Map();
    this.coordinatorId = crypto.randomUUID();
    this.coordinatorRecorded = false;
    // Auto-enrolled leaders, derived from _crew/nudge.conf on every scan (never persisted as identities).
    this.auto = new Map(); this.discovered = new Map(); this.inspected = new Map(); this.accountTried = new Map();
    // Leaders found from evidence for tasks nobody enrolled (see inferLeaders): last look and last attempt per key.
    this.evidenceAt = new Map(); this.evidence = new Map(); this.inferred = new Map(); this.hints = new Map();
  }
  ensure() {
    if (this.state) return;
    const s = clone(this.load() || {});
    if (s.coordinatorIds !== undefined && (!Array.isArray(s.coordinatorIds) || s.coordinatorIds.length > 128 ||
        s.coordinatorIds.some(id => typeof id !== 'string' || !/^[a-f0-9-]{16,100}$/.test(id)))) throw Error('storage_corrupt');
    if (s.supervisor !== undefined && (!s.supervisor || s.supervisor.version !== 1 || !s.supervisor.hosts || typeof s.supervisor.hosts !== 'object' || Array.isArray(s.supervisor.hosts))) throw Error('storage_corrupt');
    this.state = { ...s, enabled: s.enabled === true && !s.off && !s.configurationPending, autoRecovery: s.autoRecovery === true, leaders: Array.isArray(s.leaders) ? s.leaders.filter(l => l && policy.validIdentity(l.identity) && validRoot(l.root) && Array.isArray(l.taskIds) && l.taskIds.length && l.taskIds.every(id => policy.TASK.test(id))).slice(0, 200) : [], intervalMinutes: Number.isInteger(s.intervalMinutes) && s.intervalMinutes >= 1 && s.intervalMinutes <= 1440 ? s.intervalMinutes : 30,
      workspaces: Array.isArray(s.workspaces) ? s.workspaces.filter((w) => typeof w.serverId === 'string' && validRoot(w.root)) : [],
      autoEnroll: s.autoEnroll === true, excluded: validExcluded(s.excluded) ? s.excluded : [],
      supervisor: s.supervisor?.version === 1 ? s.supervisor : { version: 1, hosts: {} } };
    this.suppressed = !this.state.enabled;
    this.errors.delete('storage');
    if (s.configurationPending) this.errors.set('configuration', reason('configuration_incomplete'));
  }
  async change(fn, { memory = false } = {}) {
    // Observation while autopilot is off is kept in memory only: nothing is written, nothing waits on a pending save.
    if (memory) { this.ensure(); fn(this.state); return; }
    const op = this.queue.then(async () => {
      this.ensure(); const draft = clone(this.state); fn(draft);
      try { await this.save(clone(draft)); this.state = draft; }
      catch (e) {
        // The write may have reached disk before throwing. Keep the intent and fail closed until restart.
        this.state = draft; this.storageFault = true; this.suppressed = true; this.errors.set('storage', reason('storage_failed')); throw e;
      }
    });
    this.queue = op.catch(() => {}); return op;
  }
  enabled() { return !this.stopped && !this.suppressed && !this.storageFault && this.state?.enabled === true; }
  // Watching without acting: on unless explicitly turned off; never while stopped or the store is faulty.
  observing() { return !this.stopped && !this.storageFault && !!this.state && this.state.observe !== false; }
  async control(body, remotes) {
    this.ensure();
    if (!body || typeof body.enabled !== 'boolean' || Object.keys(body).some(k => !['enabled', 'autoRecovery', 'intervalMinutes', 'workspaces', 'leaders', 'autoEnroll', 'excluded'].includes(k)) ||
        body.autoEnroll !== undefined && typeof body.autoEnroll !== 'boolean' || body.excluded !== undefined && !validExcluded(body.excluded) ||
        body.autoRecovery !== undefined && typeof body.autoRecovery !== 'boolean' || (body.intervalMinutes !== undefined &&
        (!Number.isInteger(body.intervalMinutes) || body.intervalMinutes < 1 || body.intervalMinutes > 1440))) throw Error('invalid_control');
    if (body.workspaces !== undefined && (!Array.isArray(body.workspaces) || body.workspaces.length > 200 || body.workspaces.some((w) =>
      !w || typeof w.serverId !== 'string' || !w.serverId || w.serverId.length > 128 || !remotes.some((r) => r.cfg?.id === w.serverId) || !validRoot(w.root) ||
      Object.keys(w).some((k) => !['serverId', 'root', 'auditConfig', 'auditAccount'].includes(k)) ||
      w.auditConfig !== undefined && (typeof w.auditConfig !== 'string' || !policy.CONFIG.test(w.auditConfig)) || w.auditAccount !== undefined && (typeof w.auditAccount !== 'string' || !/^[a-f0-9]{64}$/.test(w.auditAccount))))) throw Error('invalid_workspaces');
    const epoch = this.controlEpoch = (this.controlEpoch || 0) + 1;
    if (!body.enabled || body.autoRecovery === false) this.suppressed = true;
    let leaders;
    if (body.leaders !== undefined) {
      if (!Array.isArray(body.leaders) || body.leaders.length > 200) throw Error('invalid_leaders');
      leaders = [];
      for (const l of body.leaders) {
        if (!l || Object.keys(l).some(k => !['serverId', 'root', 'session', 'taskIds', 'identity'].includes(k)) ||
            !validRoot(l.root) || typeof l.session !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(l.session) || /^tn-ops(?:-audit)?(?:-|$)/.test(l.session) ||
            !policy.validIdentity(l.identity) || !Array.isArray(l.taskIds) || !l.taskIds.length || l.taskIds.length > 100 ||
            l.taskIds.some(id => !policy.TASK.test(id)) || new Set(l.taskIds).size !== l.taskIds.length) throw Error('invalid_leaders');
        const r = remotes.find(r => r.cfg?.id === l.serverId), s = sessions(r).find(s => s.name === l.session);
        if (!online(r, this.now()) || !policy.sameIdentity(l.identity, policy.liveIdentity(r, s)) || !this.io.validateLeader) throw Error('invalid_leader_identity');
        const verified = await this.io.validateLeader(r, l);
        if (!verified?.processStart || !online(r, this.now()) || !policy.sameIdentity(l.identity, policy.liveIdentity(r, s))) throw Error('invalid_leader_identity');
        leaders.push({ ...clone(l), identity: { ...policy.liveIdentity(r, s), processStart: verified.processStart } });
      }
      if (new Set(leaders.map(l => JSON.stringify([l.serverId, l.session]))).size !== leaders.length) throw Error('invalid_leaders');
      const tasks = leaders.flatMap(l => l.taskIds.map(id => JSON.stringify([l.serverId, l.root, id])));
      if (new Set(tasks).size !== tasks.length) throw Error('invalid_leaders');
    }
    // Only a changed binding needs remote confirmation. OFF must not depend on unchanged offline scopes.
    for (const w of body.workspaces || []) {
      const old = this.state.workspaces.find(v => v.serverId === w.serverId && v.root === w.root);
      if (w.auditAccount && (old?.auditAccount !== w.auditAccount || old?.auditConfig !== w.auditConfig)) {
        const r = remotes.find(r => r.cfg?.id === w.serverId), boot = r?.snapshot?.bootId;
        if (!online(r, this.now()) || !this.io.auditReady) throw Error('invalid_audit_account');
        const ready = await this.io.auditReady(r, { root: w.root, config: w.auditConfig, account: w.auditAccount, confirmation: true });
        if (ready.code !== 'audit_ready' || ready.accountRef !== w.auditAccount || !online(r, this.now()) || boot !== r.snapshot?.bootId) throw Error('invalid_audit_account');
      }
    }
    if (epoch !== this.controlEpoch) return { enabled: this.enabled(), autoRecovery: this.enabled() && this.state.autoRecovery, code: 'control_superseded' };
    this.suppressed = true; // Configuration commits rotate the remote authority; no old-scope send may queue meanwhile.
    await this.change((s) => {
      s.enabled = body.enabled; s.off = !body.enabled;
      s.configurationPending = true;
      s.autoRecovery = body.autoRecovery ?? s.autoRecovery;
      if (leaders) s.leaders = leaders;
      s.intervalMinutes = body.intervalMinutes ?? s.intervalMinutes;
      if (body.autoEnroll !== undefined) s.autoEnroll = body.autoEnroll;
      if (body.excluded !== undefined) s.excluded = clone(body.excluded);
      if (body.workspaces) s.workspaces = [...new Map(body.workspaces.map((w) => [JSON.stringify([w.serverId, w.root]), w])).values()];
    });
    this.validated.clear(); this.scanned.clear(); this.auto.clear(); this.accountTried.clear(); this.evidenceAt.clear(); this.inferred.clear(); this.hints.clear();
    {
      // Persist the policy first; revoke old tokens on every scope change, including OFF.
      const old = [...new Set([...(this.state.coordinatorIds || []), this.coordinatorId])];
      this.coordinatorId = crypto.randomUUID(); this.coordinatorRecorded = false; this.ownership.clear();
      try { if (this.io.revoke) for (const id of old) await this.io.revoke(remotes, id); }
      catch (e) { this.errors.set('configuration', reason('remote_revocation_unconfirmed')); throw e; }
    }
    if (epoch === this.controlEpoch) await this.change(s => { if (epoch === this.controlEpoch) { s.configurationPending = false; s.coordinatorIds = []; } });
    if (epoch === this.controlEpoch) this.errors.delete('configuration');
    if (!this.storageFault && epoch === this.controlEpoch) this.suppressed = !body.enabled;
    return { enabled: this.enabled(), autoRecovery: this.enabled() && this.state.autoRecovery, intervalMinutes: this.state.intervalMinutes, workspaces: clone(this.state.workspaces), leaders: clone(this.state.leaders),
      autoEnroll: this.state.autoEnroll, excluded: clone(this.state.excluded) };
  }
  // Explicit registrations first; auto-enrolled leaders fill in sessions that are not explicitly registered or excluded.
  leadersFor(id) {
    const explicit = (this.state?.leaders || []).filter(l => l.serverId === id);
    if (!this.state?.autoEnroll) return explicit;
    return [...explicit, ...(this.auto.get(id) || []).filter(a => !explicit.some(l => l.session === a.session))];
  }
  isExcluded(id, session) { return (this.state?.excluded || []).some(x => x.serverId === id && x.session === session); }
  host(id) { return this.state?.supervisor.hosts[id]; }
  async tick(remotes) {
    try { this.ensure(); } catch (e) { this.errors.set('storage', reason(e.message === 'storage_corrupt' ? 'storage_corrupt' : 'storage_locked')); return; }
    if (this.enabled() && !this.coordinatorRecorded && !(this.registrationRetryAt > this.now())) {
      const coordinatorId = this.coordinatorId;
      try {
        // Retire previous process authority under each remote root lock before compacting local restart history.
        if (this.io.revoke) {
          const prior = [...(this.state.coordinatorIds || [])].filter(id => id !== coordinatorId);
          for (const old of prior) await this.io.revoke(remotes, old);
          if (coordinatorId !== this.coordinatorId || !this.enabled()) return;
          await this.change(s => { s.coordinatorIds = (s.coordinatorIds || []).filter(id => !prior.includes(id)); });
        }
        await this.change(s => {
          if (!Array.isArray(s.coordinatorIds)) s.coordinatorIds = [];
          if (s.coordinatorIds.length >= 128 && !s.coordinatorIds.includes(coordinatorId)) throw Error('coordinator_history_capacity');
          if (!s.coordinatorIds.includes(coordinatorId)) s.coordinatorIds.push(coordinatorId);
        });
        if (coordinatorId === this.coordinatorId) { this.coordinatorRecorded = true; this.registrationRetryAt = 0; if (this.errors.get('configuration')?.code === 'coordinator_registration_failed') this.errors.delete('configuration'); }
      } catch {
        // A machine that cannot confirm revocation (offline, slow SSH) must not switch the owner's autopilot off for good:
        // keep the setting, observe only (no host acts before revocation), say why, and retry in a minute.
        this.errors.set('configuration', reason('coordinator_registration_failed')); this.registrationRetryAt = this.now() + 60000;
      }
    }
    await Promise.allSettled(remotes.filter((r) => r.cfg?.id).map((r) => this.tickHost(r)));
  }
  // How old crew evidence may be and still be shown as current. With the autopilot on, crew files are read every 30 s and
  // must be under a minute old before anything is sent. Watching only, they are read every 2 minutes: allowing just a
  // minute showed every team as "unknown" half of the time.
  evidenceBudget() { return this.enabled() && this.coordinatorRecorded ? FRESH_MS : IDLE_SCAN_MS + FRESH_MS; }
  async tickHost(r) {
    const id = r.cfg.id;
    // Autopilot off still OBSERVES (owner 09/11: crews must be visible without autopilot): a read-only scan of the crew files
    // every 2 minutes. It never leases, reminds, opens or audits anything.
    if (!this.enabled() || !this.coordinatorRecorded) {
      if (!this.observing() || this.gates.has(id) || !online(r, this.now()) || r.mode === 'powershell') return;
      const h = this.host(id); if (h && this.scanned.has(id) && this.now() - (h.scannedAt || 0) < IDLE_SCAN_MS) return;
      this.gates.add(id);
      try { await this.scan(r, { memory: true }); } catch { /* the next tick retries */ } finally { this.gates.delete(id); }
      return;
    }
    if (this.gates.has(id) || !online(r, this.now()) || r.mode === 'powershell') return;
    this.gates.add(id); // Set synchronously, before any awaited read/save/open/send; never released by an age timer.
    try {
      const h = this.host(id);
      if (!h || !this.scanned.has(id) || this.now() - (h.scannedAt || 0) >= SCAN_MS) await this.scan(r);
      if (!this.enabled() || !online(r, this.now())) return;
      for (const root of Object.values(this.host(id)?.roots || {})) {
        const result = this.io.coordinate ? await this.io.coordinate(r, root.root, this.coordinatorId) : { code: 'coordination_unavailable' };
        this.ownership.set(JSON.stringify([id, root.root]), result);
      }
      if (!this.enabled()) return;
      if (this.state.autoEnroll) await this.autoAccount(r);
      await this.recover(r);
      if (this.host(id)?.active) await this.advance(r);
      else {
        const escalation = Object.values(this.host(id)?.recoveries || {}).find(a => a.auditRequested && !a.escalationAuditRunId);
        await this.schedule(r, escalation?.root);
        const active = this.host(id)?.active;
        if (escalation && active?.root === escalation.root) await this.change(st => {
          const a = Object.values(st.supervisor.hosts[id].recoveries).find(a => a.eventId === escalation.eventId); a.escalationAuditRunId = active.runId;
        });
      }
      this.errors.delete(id);
    } catch { this.errors.set(id, reason(this.storageFault ? 'storage_failed' : 'host_io_failed')); }
    finally { this.gates.delete(id); }
  }
  async scan(r, { memory = false } = {}) {
    const id = r.cfg.id, h = this.host(id), now = this.now(), boot = r.snapshot?.bootId;
    if (h?.scanRetryAt > now) return;
    const roots = [...new Set([...this.state.workspaces.filter((w) => w.serverId === id).map((w) => w.root),
      ...this.leadersFor(id).map(l => l.root), ...Object.keys(h?.roots || {})])];
    const cwds = [...new Set(sessions(r).map((s) => s.aiCwd || s.path).filter(validRoot))];
    let data;
    try {
      data = await this.io.scan(r, { roots, cwds, days: this.state.days || 3 });
      if (!online(r, this.now()) || boot !== r.snapshot?.bootId) throw Error('scan_identity_changed');
    }
    catch {
      await this.change((s) => { const host = s.supervisor.hosts[id] ||= { roots: {}, progress: {}, history: [] };
        host.scanFailures = Math.min((host.scanFailures || 0) + 1, 8); host.scanRetryAt = now + Math.min(300000, 1000 * 2 ** host.scanFailures); host.scanError = 'scan_failed'; }, { memory });
      return;
    }
    await this.change((s) => {
      const host = s.supervisor.hosts[id] ||= { roots: {}, progress: {}, history: [] };
      host.scannedAt = now; host.scanFailures = 0; host.scanRetryAt = 0; host.scanError = '';
      for (const root of roots) host.roots[root] ||= { root, tasks: [], nudge: [], available: false, at: 0 };
      for (const root of Object.values(host.roots)) root.available = false;
      for (const root of data.roots || []) {
        if (!validRoot(root.root)) continue;
        const old = host.roots[root.root];
        const tasks = [...(root.tasks || []), ...(old?.tasks || []).filter((t) => !FINAL.has(t.status) && !(root.tasks || []).some((x) => x.id === t.id)).map((t) => ({ ...t, missing: true }))];
        for (const [, id] of root.nudge || []) if (!tasks.some((t) => t.id === id)) tasks.push({ id, title: '', status: 'unknown', tracks: [], missing: true });
        const open = tasks.filter((t) => !FINAL.has(t.status)), finals = tasks.filter((t) => FINAL.has(t.status)).sort((a, b) => b.updated - a.updated).slice(0, 100);
        host.roots[root.root] = { ...root, tasks: [...open, ...finals], available: true, at: now };
      }
      for (const root of Object.values(host.roots)) for (const t of root.tasks) {
        const key = JSON.stringify([root.root, t.id]);
        // Only phase + track state + round/result evidence qualify. No mtime, heartbeat, tokens or busy.
        // Prefer the actual latest record over legacy windowed counters (whose window can shift on token edits).
        const fingerprint = JSON.stringify([t.status, (t.tracks || []).map((k) => [k.id, k.state,
          k.lastRound ? [k.lastRound.round, k.lastRound.result, k.lastRound.kind] : [k.rounds, k.fixRounds]]).sort((a, b) => a[0].localeCompare(b[0]))]);
        const p = host.progress[key];
        if (!p) host.progress[key] = { fingerprint, baselineAt: now, lastProgressAt: null };
        else if (!this.scanned.has(id)) { p.fingerprint = fingerprint; p.baselineAt = now; }
        else if (!t.missing && root.available && p.fingerprint !== fingerprint) { p.fingerprint = fingerprint; p.lastProgressAt = now; }
      }
      const retained = new Set(Object.values(host.roots).flatMap((root) => root.tasks.map((t) => JSON.stringify([root.root, t.id]))));
      for (const key of Object.keys(host.progress)) if (!retained.has(key)) delete host.progress[key];
    }, { memory });
    this.scanned.add(id);
    for (const [key, value] of this.validated) if (value.serverId === id) this.validated.delete(key);
    try { await this.inferLeaders(r); } catch { /* evidence is best effort; the next scan retries */ }
    this.deriveLeaders(r);
    for (const l of this.leadersFor(id)) {
      const s = sessions(r).find(s => s.name === l.session && policy.sameIdentity(l.identity, policy.liveIdentity(r, s)));
      if (!policy.sameIdentity(l.identity, policy.liveIdentity(r, s))) continue;
      let verified;
      const cached = l.auto && this.inspected.get(JSON.stringify([id, policy.identityKey(l.identity)]));
      if (cached && now - cached.at < 10 * 60000) verified = cached;
      else { try { verified = await this.io.validateLeader?.(r, l); } catch { continue; } }
      if (l.auto && verified?.processStart) { l.identity.processStart = verified.processStart; this.inspected.set(JSON.stringify([id, policy.identityKey(l.identity)]), { processStart: verified.processStart, at: cached?.at || now }); }
      if (!verified?.processStart || verified.processStart !== l.identity.processStart) continue;
      const key = JSON.stringify([id, policy.identityKey(l.identity)]); this.validated.set(key, l);
      if (!this.baselines.has(key)) this.baselines.set(key, now);
    }
  }
  // An open task that no pane is enrolled for would show "no leader" forever: the crew kit writes _crew/nudge.conf only
  // when "crew-task.sh init" runs inside tmux, and has no command to enrol later (crew-watch does not). So Termnest finds
  // the leader from evidence and keeps it in memory, used exactly like a nudge.conf line (re-derived on every scan):
  //   1. the live session that is running crew-dispatch for the task (the worker's TMUX_PANE / process tree);
  //   2. else the one live Claude chat in that workspace that created it (crew-task.sh init <task>), or the only one that
  //      ran crew scripts with its id.
  // Only a single, unambiguous, single-pane Claude session in the task's workspace qualifies; otherwise nothing changes.
  async inferLeaders(r) {
    const id = r.cfg.id, h = this.host(id), now = this.now(), found = [], hints = {};
    this.inferred.set(id, found); this.hints.set(id, hints);
    // Showing who leads is always useful. Only the legacy "named leaders only" mode (autopilot on, auto-enrol off) keeps
    // Termnest from adding leaders; nudging still needs the autopilot on.
    const manual = this.enabled() && !this.state?.autoEnroll;
    if (r.mode === 'powershell') return;
    const inRoot = (cwd, root) => typeof cwd === 'string' && (cwd === root || cwd.startsWith(root + '/'));
    for (const root of Object.values(h?.roots || {})) {
      if (!root.available) continue;
      const enrolled = new Set((root.nudge || []).map((x) => x[1]));
      const orphan = root.tasks.filter((t) => !t.missing && !FINAL.has(t.status) && !enrolled.has(t.id) && policy.TASK.test(t.id));
      if (!orphan.length) continue;
      if (manual) { for (const t of orphan) hints[root.root + '|' + t.id] = { code: 'manual' }; continue; }
      const live = sessions(r).filter((s) => !/^tn-ops(?:-audit)?(?:-|$)/.test(s.name) && !this.isExcluded(id, s.name) && s.aiTool === 'claude' &&
        (s.paneIds || []).length === 1 && inRoot(s.aiCwd || s.path, root.root) && policy.validIdentity(policy.liveIdentity(r, s)));
      if (!live.length) { for (const t of orphan) hints[root.root + '|' + t.id] = { code: 'no_session' }; continue; }
      const names = new Set(live.map((s) => s.name)), byDispatch = new Map();
      for (const w of r.snapshot?.workers || []) if (w.task && names.has(w.owner?.name)) (byDispatch.get(w.task) || byDispatch.set(w.task, new Set()).get(w.task)).add(w.owner.name);
      const key = JSON.stringify([id, root.root]);
      if (this.io.leaderEvidence && now - (this.evidenceAt.get(key) || 0) >= 5 * 60000) {
        this.evidenceAt.set(key, now);
        try {
          this.evidence.set(key, await this.io.leaderEvidence(r, { root: root.root, taskIds: orphan.map((t) => t.id),
            sessions: live.filter((s) => s.aiSessionId).map((s) => ({ name: s.name, sessionId: s.aiSessionId, config: s.aiStatus?.cfg || '.claude' })) }) || {});
        } catch { /* keep the previous evidence */ }
      }
      const chat = this.evidence.get(key) || {};
      for (const t of orphan) {
        let pick = '', why = '';
        const d = [...(byDispatch.get(t.id) || [])];
        if (d.length === 1) { pick = d[0]; why = 'dispatch'; }
        else if (!d.length) {
          const seen = Object.entries(chat[t.id] || {}).filter(([n]) => names.has(n));
          const creators = seen.filter(([, v]) => v.init), users = seen.filter(([, v]) => v.used > 0 || v.init);
          if (creators.length === 1) { pick = creators[0][0]; why = 'chat_init'; }
          else if (!creators.length && users.length === 1) { pick = users[0][0]; why = 'chat_crew_commands'; }
        }
        if (!pick) {
          const many = d.length > 1 ? d : Object.keys(chat[t.id] || {}).filter((n) => names.has(n));
          hints[root.root + '|' + t.id] = many.length > 1 ? { code: 'ambiguous', sessions: many.slice(0, 5) } : { code: 'no_evidence' };
          continue;
        }
        found.push({ root: root.root, pane: live.find((s) => s.name === pick).paneIds[0], task: t.id, why });
      }
    }
  }
  // The scanned roots with the leaders found from evidence added to their nudge list (marked "inferred" for the UI).
  rootsWithLeaders(id) {
    const extra = this.inferred.get(id) || [], hints = this.hints.get(id) || {};
    return Object.values(this.host(id)?.roots || {}).map((root) => {
      const add = extra.filter((x) => x.root === root.root && !(root.nudge || []).some((n) => n[1] === x.task)).map((x) => [x.pane, x.task]);
      const leaderHints = Object.fromEntries(Object.entries(hints).filter(([k]) => k.startsWith(root.root + '|')).map(([k, v]) => [k.slice(root.root.length + 1), v]));
      return { ...root, nudge: [...(root.nudge || []), ...add], inferred: add.map((x) => x[1]), leaderHints };
    });
  }
  // A leader is the live Claude session whose pane crew enrolled for a task in _crew/nudge.conf. Identity is re-read on
  // every scan, so a restarted agent or rebooted VM is picked up again without any owner action. Only open tasks count.
  deriveLeaders(r) {
    const id = r.cfg.id, h = this.host(id), byPane = new Map(), found = new Map();
    for (const s of sessions(r)) {
      if (/^tn-ops(?:-audit)?(?:-|$)/.test(s.name) || !policy.validIdentity(policy.liveIdentity(r, s))) continue;
      for (const p of s.paneIds || []) byPane.set(p, s);
    }
    for (const root of Object.values(h?.roots || {})) {
      if (!root.available) continue;
      const open = new Set(root.tasks.filter(t => !t.missing && !FINAL.has(t.status)).map(t => t.id));
      const pairs = [...(root.nudge || []), ...(this.inferred.get(id) || []).filter((x) => x.root === root.root).map((x) => [x.pane, x.task])];
      for (const [pane, task] of pairs) {
        const s = byPane.get(pane); if (!s || !open.has(task) || !policy.TASK.test(task)) continue;
        const cwd = s.aiCwd || s.path;
        if (typeof cwd !== 'string' || (cwd !== root.root && !cwd.startsWith(root.root + '/'))) continue;
        const prev = found.get(s.name);
        if (prev && prev.root !== root.root) continue;
        const l = prev || { serverId: id, root: root.root, session: s.name, taskIds: [], identity: policy.liveIdentity(r, s), auto: true };
        if (!l.taskIds.includes(task) && l.taskIds.length < 100) l.taskIds.push(task);
        found.set(s.name, l);
      }
    }
    const all = [...found.values()].sort((a, b) => a.session.localeCompare(b.session));
    this.discovered.set(id, all.map(l => ({ session: l.session, root: l.root, taskIds: [...l.taskIds], excluded: this.isExcluded(id, l.session) })));
    this.auto.set(id, all.filter(l => !this.isExcluded(id, l.session)));
  }
  // Auto mode binds each watched root to the Claude profile its leaders already use, once that profile has a readable
  // logged-in identity and the ops-audit skill. Retried every 10 minutes; never overrides an owner-confirmed binding.
  async autoAccount(r) {
    const id = r.cfg.id, now = this.now();
    if (!this.io.auditReady) return;
    for (const root of Object.keys(this.host(id)?.roots || {})) {
      const leaders = (this.auto.get(id) || []).filter(l => l.root === root);
      if (!leaders.length || this.state.workspaces.some(w => w.serverId === id && w.root === root && w.auditAccount)) continue;
      const key = JSON.stringify([id, root]);
      if (now - (this.accountTried.get(key) || 0) < 10 * 60000) continue;
      this.accountTried.set(key, now);
      const counts = new Map(); for (const l of leaders) counts.set(l.identity.config, (counts.get(l.identity.config) || 0) + 1);
      const config = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || '.claude';
      if (!policy.CONFIG.test(config)) continue;
      let ready; try { ready = await this.io.auditReady(r, { root, config, confirmation: true }); } catch { continue; }
      if (!['audit_account_registration_required', 'audit_ready'].includes(ready?.code) || !/^[a-f0-9]{64}$/.test(ready.accountRef || '') || !this.enabled()) continue;
      await this.change(s => {
        const w = s.workspaces.find(w => w.serverId === id && w.root === root);
        if (w?.auditAccount) return;
        if (w) Object.assign(w, { auditConfig: config, auditAccount: ready.accountRef });
        else s.workspaces.push({ serverId: id, root, auditConfig: config, auditAccount: ready.accountRef });
      });
    }
  }
  teams(r) {
    const h = this.host(r.cfg.id), now = this.now(), out = [];
    for (const root of Object.values(h?.roots || {})) {
      const groups = new Map();
      for (const t of root.tasks) {
        const owners = [...this.validated.values()].filter(l => l.serverId === r.cfg.id && l.root === root.root && l.taskIds.includes(t.id))
          .flatMap(l => sessions(r).filter(s => s.name === l.session && policy.sameIdentity(l.identity, policy.liveIdentity(r, s))).map(s => ({ s, pane: l.identity.pane })));
        // Multiple owners are ambiguous, even if labels happen to match.
        const owner = owners.length === 1 ? owners[0] : null;
        const key = owner ? identity(r, owner.s, owner.pane) : 'unowned:' + t.id;
        const id = 'team-' + hash(JSON.stringify([root.root, key]));
        const g = groups.get(id) || { id, session: owner?.s.name || '', root: root.root, tasks: [], owner: owner?.s || null, identity: key };
        g.tasks.push(t); groups.set(id, g);
      }
      if (!root.tasks.length) groups.set('workspace-' + hash(root.root), { id: 'workspace-' + hash(root.root), session: '', root: root.root, tasks: [], owner: null });
      for (const g of groups.values()) {
        const ps = g.tasks.map((t) => h.progress[JSON.stringify([root.root, t.id])]).filter(Boolean);
        const progress = ps.map((p) => p.lastProgressAt).filter((v) => v !== null);
        const lastProgressAt = progress.length ? Math.max(...progress) : null;
        let status, why;
        if (!online(r, now)) { status = 'unknown'; why = reason(r.ready ? 'snapshot_stale' : 'host_offline'); }
        else if (!root.available || now - root.at > this.evidenceBudget() || h.scanError || g.tasks.length && g.tasks.every((t) => t.missing)) { status = 'unknown'; why = reason('task_evidence_stale'); }
        else if (g.tasks.length && g.tasks.every((t) => FINAL.has(t.status))) { status = 'completed'; why = reason('task_completed'); }
        // Exit 7 = code committed, the dispatcher refused the verification evidence: the leader verifies it, nothing failed.
        else if (g.tasks.some((t) => t.blocked || t.tracks?.some((k) => k.state === 'blocked' || k.state === 'failed' && k.lastRound?.result !== '7' || (t.maxFix && k.fixRounds >= t.maxFix && OPEN_TRACK.has(k.state))))) {
          // Only failed tracks (no recorded blocker, budget left) is work the leader can fix itself; say so distinctly.
          const hard = g.tasks.some((t) => t.blocked || t.tracks?.some((k) => k.state === 'blocked' || (t.maxFix && k.fixRounds >= t.maxFix && OPEN_TRACK.has(k.state))));
          status = 'blocked'; why = reason(hard ? 'task_blocked' : 'task_track_failed');
        }
        else if (g.tasks.some((t) => /awaiting_.*approval|waiting_owner|awaiting_owner/.test(t.status)) || g.owner?.asking || g.owner?.aiStatus?.status === 'waiting') { status = 'waiting_owner'; why = reason('owner_decision'); }
        else if (!g.owner) { status = 'unknown'; why = reason(!g.tasks.length ? 'workspace_only' : this.state.autoEnroll ? 'owner_missing' : 'registration_required'); }
        else if (g.owner.aiStatus?.parked) { status = 'blocked'; why = reason('session_parked'); }
        else if (ps.length && now - (lastProgressAt ?? Math.min(...ps.map((p) => p.baselineAt))) >= STALL_MS) { status = 'stalled'; why = reason('no_task_progress', STALL_MS); }
        else if (lastProgressAt !== null) { status = 'progressing'; why = reason('task_evidence_changed'); }
        else if (g.owner.aiStatus?.status === 'idle') { status = 'idle'; why = reason('session_idle'); }
        else { status = 'unknown'; why = reason('awaiting_task_progress'); }
        const activeAt = Math.max(0, ...g.tasks.map((t) => Number(t.activeAt) || 0));
        out.push({ id: g.id, session: g.session, root: g.root, status, reason: why, lastProgressAt, activeAt,
          dormant: !g.owner && g.tasks.length > 0 && activeAt > 0 && now - activeAt > DORMANT_MS,
          lastAction: this.lastAction(h, g.id), requiresOwner: ['waiting_owner', 'blocked', 'stalled', 'unknown'].includes(status), taskIds: g.tasks.map((t) => t.id).sort() });
      }
    }
    return out;
  }
  registration(r, s) {
    const current = policy.liveIdentity(r, s);
    return policy.validIdentity(current) ? this.validated.get(JSON.stringify([r.cfg.id, policy.identityKey(current)])) : undefined;
  }
  recoveryTarget(r, s) {
    const l = this.registration(r, s), h = this.host(r.cfg.id), key = l && JSON.stringify([r.cfg.id, policy.identityKey(l.identity)]);
    const current = l && sessions(r).find(v => v.name === s?.name && policy.sameIdentity(l.identity, policy.liveIdentity(r, v)));
    const ambiguous = l && this.leadersFor(l.serverId).some(other => other !== l && other.serverId === l.serverId && other.root === l.root &&
      policy.identityKey(other.identity) !== policy.identityKey(l.identity) && other.taskIds.some(id => l.taskIds.includes(id)));
    const full = l && !h?.recoveries?.[policy.identityKey(l.identity)] && Object.keys(h?.recoveries || {}).length >= 1000;
    const code = full ? 'recovery_history_capacity' : ambiguous ? 'registration_ambiguous' : current && current.aiStatus?.at !== s?.aiStatus?.at ? 'observation_changed' : policy.recoveryEligibility({ r, s: current, registration: l, root: h?.roots[l?.root], now: this.now(),
      freshScan: this.scanned.has(r.cfg.id) && !h?.scanError, baselineAt: this.baselines.get(key) });
    return { eligible: this.enabled() && this.state.autoRecovery && !code, code: code || (!this.enabled() ? 'supervisor_disabled' : !this.state.autoRecovery ? 'recovery_disabled' : 'recovery_eligible'), registration: l };
  }
  async recover(r) {
    const id = r.cfg.id, now = this.now(), h = this.host(id); if (!h) return;
    for (const l of this.leadersFor(id)) {
      const key = policy.identityKey(l.identity), s = sessions(r).find(s => s.name === l.session), previous = h.recoveries?.[key];
      if (previous) {
        const changed = l.taskIds.some(taskId => (h.progress[JSON.stringify([l.root, taskId])]?.lastProgressAt || 0) > previous.at);
        const responded = policy.sameIdentity(l.identity, policy.liveIdentity(r, s)) && s.aiStatus?.status === 'busy' && r.lastPoll > previous.at;
        const patch = changed ? { progress: 'observed', progressAt: now, code: 'recovery_progress' } : now >= previous.deadline ?
          { progress: 'unverified', requiresOwner: true, auditRequested: true, code: 'recovery_no_progress' } : responded ?
          { responded: true, respondedAt: now, code: 'recovery_responded' } : previous.delivery === 'pending' ?
          { delivery: 'uncertain', requiresOwner: true, code: 'recovery_uncertain' } : null;
        if (patch && (!changed || previous.progress !== 'observed') && previous.code !== patch.code) await this.change(st => Object.assign(st.supervisor.hosts[id].recoveries[key], patch));
        // One bounded prompt per exact enrolled agent identity until meaningful progress; no continue spam after busy.
        if (!changed || ['pending', 'uncertain'].includes(previous.delivery)) continue;
        // Still deduplicate the exact idle event even after measured progress.
        if (previous.idleAt === s?.aiStatus?.at) continue;
      }
      const target = this.recoveryTarget(r, s); if (!target.eligible || now - s.aiStatus.at < 5 * 60000) continue;
      const sameWindow = previous && now - previous.windowStartedAt < 3600000;
      if (sameWindow && previous.attempts >= 3) continue;
      const ownership = this.ownership.get(JSON.stringify([id, l.root])); if (ownership?.code !== 'coordination_owner') continue;
      if (!this.io.recover) continue;
      const record = { session: l.session, root: l.root, identity: clone(l.identity), eventId: policy.eventKey(l.identity, s.aiStatus.at), idleAt: s.aiStatus.at,
        at: now, deadline: now + TIMEOUT_MS, delivery: 'pending', responded: null, progress: 'unknown', code: 'recovery_intent', requiresOwner: false,
        attempts: sameWindow ? previous.attempts + 1 : 1, windowStartedAt: sameWindow ? previous.windowStartedAt : now };
      await this.change(st => { (st.supervisor.hosts[id].recoveries ||= {})[key] = record; });
      if (!this.recoveryTarget(r, s).eligible) {
        await this.change(st => Object.assign(st.supervisor.hosts[id].recoveries[key], { delivery: 'not_sent', code: 'recovery_gated' })); continue;
      }
      let result;
      try { result = await this.io.recover(r, s, l, record, ownership.token, this.coordinatorId); }
      catch { result = { code: 'action_uncertain' }; }
      const delivery = result.code === 'action_delivered' ? 'delivered' : result.code === 'action_duplicate' ?
        result.receipt?.delivery === 'delivered' ? 'delivered' : 'uncertain' : result.code === 'action_uncertain' ? 'uncertain' : 'not_sent';
      const remoteAge = Number.isSafeInteger(result.remoteNow) && Number.isSafeInteger(result.receipt?.at) ? Math.max(0, result.remoteNow - result.receipt.at) : 0;
      const remaining = Number.isSafeInteger(result.remoteNow) && Number.isSafeInteger(result.receipt?.deadline) ? Math.max(0, Math.min(TIMEOUT_MS, result.receipt.deadline - result.remoteNow)) : TIMEOUT_MS;
      await this.change(st => Object.assign(st.supervisor.hosts[id].recoveries[key], { delivery,
        code: result.code, remoteReceipt: result.receipt || null, deliveredAt: result.receipt?.deliveredAt || null, requiresOwner: result.code !== 'action_delivered',
        ...(result.receipt?.kind === 'recovery_send' ? { at: this.now() - remoteAge, deadline: this.now() + remaining,
          attempts: result.receipt.attempts || record.attempts, windowStartedAt: result.receipt.windowStartedAt || record.windowStartedAt } : {}) }));
    }
  }
  lastAction(h, teamId) {
    const run = [h?.active, ...(h?.history || []).slice().reverse()].find((a) => a?.teamId === teamId);
    return run ? { code: run.lastAction?.code || 'audit_queued', at: run.lastAction?.at || run.createdAt, runId: run.runId, verification: run.verification || 'unverified' } : null;
  }
  async schedule(r, scope) {
    const h = this.host(r.cfg.id); if (!h || h.scanError) return;
    const now = this.now();
    // Dormant work (nobody leads it, untouched for days) and finished work are never audited: each audit opens a Claude
    // session and spends quota, and old leftovers on a machine with no team only produced timed-out audits.
    // The Ops hub's single Ops session audits the whole fleet when it is on; a per-workspace audit beside it is waste.
    if (this.io.hubAudits?.()) return;
    // An audit is opened and typed into under the coordination lease. Where the host cannot grant one (macOS, Windows),
    // the session would open and never receive its prompt, and time out every interval.
    const leased = (root) => this.ownership.get(JSON.stringify([r.cfg.id, root]))?.code === 'coordination_owner';
    const candidates = this.teams(r).filter((t) => leased(t.root) && !t.dormant && t.status !== 'completed' && this.host(r.cfg.id).roots[t.root].available && now - this.host(r.cfg.id).roots[t.root].at <= FRESH_MS && (!scope || t.root === scope));
    const last = (t) => h.coverage?.[t.id] || 0;
    candidates.sort((a, b) => last(a) - last(b) || a.id.localeCompare(b.id));
    const team = candidates.find((t) => scope || now - last(t) >= this.state.intervalMinutes * 60000);
    if (!team) return;
    const runId = this.newId(); if (!RUN_ID.test(runId) || Object.values(this.state.supervisor.hosts).some((v) =>
      v.active?.runId === runId || v.history.some((a) => a.runId === runId))) throw Error('invalid_run_id');
    const existing = sessions(r).find((s) => (s.name === 'tn-ops-audit' || s.name === auditSession(team.root)) && (s.aiCwd || s.path) === team.root);
    const run = { runId, serverId: r.cfg.id, root: team.root, teamId: team.id, teamSession: team.session, taskIds: team.taskIds,
      session: existing?.name || auditSession(team.root), createdAt: now, deadline: now + TIMEOUT_MS, phase: 'prepared', attempts: 0,
      reason: reason('audit_queued'), verification: 'unverified' };
    const enrolled = new Set(this.teams(r).map((t) => t.id));
    await this.change((s) => { const host = s.supervisor.hosts[r.cfg.id]; host.active = run; (host.coverage ||= {})[team.id] = now;
      for (const id of Object.keys(host.coverage)) if (!enrolled.has(id)) delete host.coverage[id]; });
    await this.advance(r);
  }
  async request(r, root) {
    this.ensure();
    if (!this.enabled()) throw Error('supervisor_disabled');
    if (!online(r, this.now()) || r.mode === 'powershell') throw Error('host_unavailable');
    const id = r.cfg.id;
    if (this.gates.has(id) || this.host(id)?.active) throw Error('audit_inflight');
    if (!this.host(id)?.roots[root]) throw Error('workspace_unknown');
    if (!this.host(id).roots[root].available || this.now() - this.host(id).roots[root].at > FRESH_MS || this.host(id).scanError) throw Error('workspace_unavailable');
    this.gates.add(id);
    try { await this.schedule(r, root); const a = this.host(id)?.active || this.host(id)?.history.at(-1); return { session: a?.session, runId: a?.runId }; }
    finally { this.gates.delete(id); }
  }
  async patch(id, patch) { await this.change((s) => Object.assign(s.supervisor.hosts[id].active, patch)); }
  async retireAudit(r, run) {
    if (!this.io.retireAudit || run.deliveryUncertain || run.phase === 'sending' || run.remoteReceipt && ['pending', 'uncertain'].includes(run.remoteReceipt.delivery)) return false;
    let proof;
    try { proof = await this.io.retireAudit(r, run); } catch { proof = { code: 'audit_death_unverified' }; }
    if (!this.enabled()) return false;
    if (proof.code !== 'audit_retired') {
      await this.patch(r.cfg.id, { retirementCode: proof.code, requiresOwner: true }); return false;
    }
    await this.patch(r.cfg.id, { ...(run.verification === 'reported' ? {} : { phase: 'failed', reason: reason('audit_identity_dead'), verification: 'unverified' }),
      retiredAt: this.now(), retirementProof: proof.proof, requiresOwner: run.verification !== 'reported' });
    await this.finish(r.cfg.id); return true;
  }
  async advance(r) {
    const id = r.cfg.id; let run = this.host(id).active, now = this.now();
    if (!run || !this.enabled() || !online(r, now)) return;
    const ownership = this.ownership.get(JSON.stringify([id, run.root]));
    if (ownership?.code !== 'coordination_owner') { await this.patch(id, { reason: reason(ownership?.code || 'coordination_unavailable'), requiresOwner: true }); return; }
    run = { ...run, token: ownership.token, coordinatorId: this.coordinatorId };
    let s = sessions(r).find((v) => v.name === run.session);
    if (run.phase === 'completed') {
      if (!s || identity(r, s) !== run.auditIdentity) { await this.retireAudit(r, run); return; }
      if (idle(s) && identity(r, s) === run.auditIdentity && r.lastPoll > run.completedAt) await this.finish(id);
      return;
    }
    if (['sending', 'delivered', 'running', 'uncertain', 'timeout'].includes(run.phase)) {
      let value; try { value = await this.io.report(r, run); } catch { value = { code: 'report_read_failed' }; }
      const report = validateReport(value, run, this.now());
      if (!this.enabled()) return;
      if (report.code === 'report_valid') {
        if (this.io.auditReported) {
          const ack = await this.io.auditReported(r, run);
          if (!this.enabled()) return;
          if (ack.code !== 'audit_acknowledged') { await this.patch(id, { reason: reason(ack.code), requiresOwner: true }); return; }
        }
        await this.patch(id, { phase: 'completed', reason: reason('report_valid'), verification: 'reported', completedAt: report.completedAt, findings: report.findings,
        lastAction: { code: 'report_valid', at: this.now() } });
      } else {
        const expired = this.now() >= run.deadline;
        const ack = s?.aiStatus?.status === 'busy' && r.lastPoll > (run.actionAt || run.createdAt);
        const held = !s ? 'audit_session_missing' : /quota|rate_limit|credits/i.test(s.aiStatus?.waitingFor || '') ? 'audit_quota_unavailable' : s.asking || s.aiStatus?.status === 'waiting' ? 'audit_waiting_owner' :
          s.aiStatus?.parked ? 'audit_parked' : !['idle', 'busy'].includes(s.aiStatus?.status) ? 'audit_unknown' : '';
        await this.patch(id, { phase: expired ? 'timeout' : run.phase === 'sending' ? 'uncertain' : ack ? 'running' : run.phase,
          reason: reason(expired ? 'audit_timeout' : run.phase === 'sending' ? 'delivery_uncertain' : held || (ack ? 'audit_running' : report.code)), reportCode: report.code,
          deliveryUncertain: !!run.deliveryUncertain || run.phase === 'sending',
          requiresOwner: expired || !!held || ['sending', 'uncertain'].includes(run.phase),
          ...(ack ? { acknowledgedAt: r.lastPoll } : {}) });
      }
      run = this.host(id).active;
      // A timeout/report is not authority to abandon a potentially live action. Require observed, same idle session.
      s = sessions(r).find((v) => v.name === run.session);
      if ((!s || run.auditIdentity && identity(r, s) !== run.auditIdentity) && await this.retireAudit(r, { ...run, token: ownership.token, coordinatorId: this.coordinatorId })) return;
      const reconciled = run.phase === 'completed' || !run.deliveryUncertain || !!run.acknowledgedAt;
      if (reconciled && ['completed', 'timeout'].includes(run.phase) && idle(s) && (identity(r, s) === run.auditIdentity ||
          (!run.sendIntent && (s.aiCwd || s.path) === run.root)) && r.lastPoll > (run.completedAt || run.deadline)) await this.finish(id);
      return;
    }
    if (now >= run.deadline) {
      await this.patch(id, { phase: 'timeout', reason: reason('audit_timeout') });
      // No action was sent in prepared/awaiting_idle. An observed idle audit can release this reservation safely.
      if (!s && ['opening', 'awaiting_idle'].includes(run.phase) && await this.retireAudit(r, run)) return;
      if (idle(s) && (s.aiCwd || s.path) === run.root) { await this.patch(id, { auditIdentity: identity(r, s) }); await this.finish(id); }
      return;
    }
    if (run.retryAt > now) return;
    const ready = this.io.auditReady ? await this.io.auditReady(r, run) : { code: 'audit_readiness_unknown' };
    if (ready.code !== 'audit_ready') { await this.patch(id, { reason: reason(ready.code), requiresOwner: true }); return; }
    if (!this.enabled()) return;
    // Hold every other visible audit on this host, including the legacy session. Do not launch a second audit beside it.
    const other = sessions(r).find((v) => v.name !== run.session && /^tn-ops-audit(?:-|$)/.test(v.name) && !idle(v));
    if (other) { await this.patch(id, { reason: reason('host_audit_held', other.name), requiresOwner: true }); return; }
    if (!s) {
      if (run.phase !== 'prepared' && run.phase !== 'retry_open') { await this.patch(id, { reason: reason('audit_session_missing'), requiresOwner: true }); return; }
      await this.patch(id, { phase: 'opening', actionAt: now, attempts: run.attempts + 1, reason: reason('session_open_intent'), lastAction: { code: 'session_open_intent', at: now } });
      if (!this.enabled() || !online(r, this.now())) return;
      try { await this.io.open(r, run); await this.patch(id, { phase: 'awaiting_idle', reason: reason('session_started'), lastAction: { code: 'session_started', at: this.now() } }); }
      catch (e) { await this.failed(id, 'open', e); }
      return;
    }
    if ((s.aiCwd || s.path) !== run.root) { await this.patch(id, { reason: reason('audit_root_mismatch'), requiresOwner: true }); return; }
    if (!idle(s)) { await this.patch(id, { reason: reason(s.asking || s.aiStatus?.status === 'waiting' ? 'audit_waiting_owner' : s.aiStatus?.parked ? 'audit_parked' : s.aiStatus?.status === 'busy' ? 'audit_busy' : 'audit_unknown'), requiresOwner: true }); return; }
    // Existing idle sessions are reused; ambiguous opening intents can reconcile to their observed session.
    await this.patch(id, { phase: 'sending', sendIntent: true, auditIdentity: identity(r, s), actionAt: this.now(), attempts: run.phase === 'retry_send' ? run.attempts + 1 : 1,
      reason: reason('prompt_send_intent'), requiresOwner: false, lastAction: { code: 'prompt_send_intent', at: this.now() } });
    if (!this.enabled() || !online(r, this.now())) return;
    const current = sessions(r).find((v) => v.name === run.session);
    if (!idle(current) || identity(r, current) !== this.host(id).active.auditIdentity || (current.aiCwd || current.path) !== run.root) {
      await this.failed(id, 'send', { noSideEffect: true }); return;
    }
    try { await this.io.send(r, current, auditPrompt(run), run); await this.patch(id, { phase: 'delivered', reason: reason('prompt_delivered'), deliveredAt: this.now(), actionAt: this.now(), lastAction: { code: 'prompt_delivered', at: this.now() } }); }
    catch (e) { await this.failed(id, 'send', e); }
  }
  async failed(id, action, error) {
    const run = this.host(id).active;
    // Only an adapter's definite pre-side-effect rejection is retryable. SSH errors/partial sends are ambiguous.
    const safe = error?.noSideEffect === true;
    if (safe && /^(audit_|coordination_|live_identity|process_identity|managed_task|agent_|workers_)/.test(error.code || '')) {
      await this.patch(id, { phase: action === 'open' ? 'prepared' : 'awaiting_idle', reason: reason(error.code), requiresOwner: true });
    }
    else if (safe && run.attempts < MAX_ATTEMPTS) await this.patch(id, { phase: 'retry_' + action, retryAt: this.now() + 1000 * 2 ** (run.attempts - 1), reason: reason(action + '_retry', run.attempts) });
    else if (safe) { await this.patch(id, { phase: 'failed', reason: reason(action + '_failed', run.attempts) }); await this.finish(id); }
    else await this.patch(id, { phase: action === 'send' ? 'uncertain' : 'opening', reason: reason(error?.code || action + '_uncertain'), requiresOwner: true,
      ...(error?.receipt ? { remoteReceipt: error.receipt } : {}),
      ...(action === 'send' ? { deliveryUncertain: true } : {}) });
  }
  async finish(id) {
    await this.change((s) => { const h = s.supervisor.hosts[id]; h.history.push(h.active); h.history = h.history.slice(-HISTORY_MAX); h.active = null; });
  }
  status(remotes) {
    try { this.ensure(); } catch (e) { return { enabled: false, intervalMinutes: 30, servers: [], errors: [reason(e.message === 'storage_corrupt' ? 'storage_corrupt' : 'storage_locked')] }; }
    const now = this.now();
    return { enabled: this.enabled(), intervalMinutes: this.state.intervalMinutes, autoEnroll: this.state.autoEnroll, excluded: clone(this.state.excluded), servers: remotes.filter((r) => r.cfg?.id).map((r) => {
      const h = this.host(r.cfg.id);
      return { id: r.cfg.id, name: r.snapshot?.hostname || r.cfg.name || r.cfg.host || r.cfg.id, online: online(r, now), observedAt: r.lastPoll || 0,
        freshness: { snapshotFresh: online(r, now), scannedAt: h?.scannedAt || 0, taskEvidenceFresh: !!h && !h.scanError && now - h.scannedAt <= this.evidenceBudget() && Object.values(h.roots).every((root) => root.available || !(root.tasks || []).some((t) => !t.missing)), maxAgeMs: FRESH_MS },
        discovered: this.discovered.get(r.cfg.id) || [],
        teams: this.teams(r).map(t => {
          const recovery = Object.values(h?.recoveries || {}).find(a => a.root === t.root && a.session === t.session);
          const target = this.recoveryTarget(r, sessions(r).find(s => s.name === t.session));
          const ownerRequired = t.status !== 'completed' && ['registration_required', 'registration_ambiguous', 'workers_unknown', 'registration_scope_mismatch',
            'idle_unknown', 'recovery_history_capacity'].includes(target.code);
          // Leader teams carry a small task summary (title, phase, track states) for the session side panel.
          const summary = t.session ? t.taskIds.map(id => Object.values(h?.roots || {}).flatMap(root => root.tasks).find(x => x.id === id)).filter(Boolean)
            .map(x => ({ id: x.id, title: String(x.title || '').slice(0, 160), status: x.status, tracks: (x.tracks || []).slice(0, 40).map(k => ({ id: k.id, state: k.state, fixRounds: k.fixRounds || 0, lastExit: k.lastRound ? String(k.lastRound.result || '') : '', verdict: k.verdict || '', proof: k.proof || null })) })) : [];
          return { ...t, tasks: summary, recoveryPolicy: { eligible: target.eligible, code: target.code }, requiresOwner: t.requiresOwner || ownerRequired || !!recovery?.requiresOwner,
            ...(recovery ? { recovery } : {}),
            ...(recovery?.code === 'recovery_no_progress' ? { status: 'stalled', reason: reason('recovery_no_progress') } : {}) };
        }), recoveries: Object.values(h?.recoveries || {}),
        coordination: Object.keys(h?.roots || {}).map(root => {
          const code = this.ownership.get(JSON.stringify([r.cfg.id, root]))?.code || 'coordination_unvalidated';
          return { root, code, requiresOwner: code !== 'coordination_owner', maintenanceRequired: code.startsWith('coordination_capacity') };
        }),
        audits: [...(h?.history || []).slice(-10), ...(h?.active ? [h.active] : [])].map((a) => {
          const active = a.runId === h.active?.runId, expired = active && now >= a.deadline && !['completed', 'failed'].includes(a.phase);
          return { ...a, ...(expired ? { phase: 'timeout', reason: reason('audit_timeout') } : {}), active, actionInFlight: active && this.gates.has(r.cfg.id),
            evidence: reportPath(a), requiresOwner: expired || !!a.requiresOwner || ['uncertain', 'timeout', 'opening'].includes(a.phase) };
        }),
        errors: [...(h?.scanError ? [reason(h.scanError)] : []), ...(this.errors.has(r.cfg.id) ? [this.errors.get(r.cfg.id)] : [])] };
    }), errors: [...this.errors.entries()].filter(([id]) => ['storage', 'configuration'].includes(id)).map(([, v]) => v) };
  }
  stop() { this.stopped = true; }
}

module.exports = { CrewSupervisor, reportRuntime, validateReport, auditPrompt, auditSession, identity, idle, validRoot, online,
  FRESH_MS, SCAN_MS, TIMEOUT_MS, STALL_MS, HISTORY_MAX, REPORT_MAX };
