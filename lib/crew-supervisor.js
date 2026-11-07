'use strict';
const crypto = require('node:crypto');
const path = require('node:path').posix;

const FINAL = new Set(['done', 'closed', 'abandoned', 'archived', 'merged']);
const OPEN_TRACK = new Set(['pending', 'queued', 'dispatched', 'running', 'fix', 'review', 'blocked']);
const FRESH_MS = 60000, SCAN_MS = 30000, TIMEOUT_MS = 10 * 60000, STALL_MS = 30 * 60000;
const REPORT_MAX = 65536, HISTORY_MAX = 60, MAX_ATTEMPTS = 3;
const RUN_ID = /^tn-[a-f0-9]{32}$/;
const clone = (v) => JSON.parse(JSON.stringify(v));
const reason = (code, ...params) => ({ code, params });
const hash = (v) => crypto.createHash('sha256').update(v).digest('hex').slice(0, 16);
const auditSession = (root) => 'tn-ops-audit-' + hash(root);
const validRoot = (v) => typeof v === 'string' && v.length > 1 && v.length <= 1024 && v.startsWith('/') &&
  !/[\x00-\x1f\x7f-\x9f;&|`$<>]/.test(v) && path.normalize(v) === v && !v.includes('\\');
const online = (r, now) => !!(r?.ready && Number.isFinite(r.lastPoll) && r.lastPoll > 0 && now >= r.lastPoll && now - r.lastPoll <= FRESH_MS);
const sessions = (r) => r?.snapshot?.sessions || [];
// Names are labels. Pane ids, tmux session id, creation time and boot id identify a live owner.
const identity = (r, s, pane) => JSON.stringify([r.snapshot?.bootId || '', s.id || '', s.created || 0, pane || [...(s.paneIds || [])].sort()]);
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
  }
  ensure() {
    if (this.state) return;
    const s = clone(this.load() || {});
    this.state = { ...s, enabled: s.enabled === true && !s.off, intervalMinutes: Number.isInteger(s.intervalMinutes) && s.intervalMinutes >= 1 && s.intervalMinutes <= 1440 ? s.intervalMinutes : 30,
      workspaces: Array.isArray(s.workspaces) ? s.workspaces.filter((w) => typeof w.serverId === 'string' && validRoot(w.root)) : [],
      supervisor: s.supervisor?.version === 1 ? s.supervisor : { version: 1, hosts: {} } };
    this.suppressed = !this.state.enabled;
    this.errors.delete('storage');
  }
  async change(fn) {
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
  async control(body, remotes) {
    this.ensure();
    if (!body || typeof body.enabled !== 'boolean' || (body.intervalMinutes !== undefined &&
        (!Number.isInteger(body.intervalMinutes) || body.intervalMinutes < 1 || body.intervalMinutes > 1440))) throw Error('invalid_control');
    if (body.workspaces !== undefined && (!Array.isArray(body.workspaces) || body.workspaces.length > 200 || body.workspaces.some((w) =>
      !w || typeof w.serverId !== 'string' || !remotes.some((r) => r.cfg?.id === w.serverId) || !validRoot(w.root) ||
      Object.keys(w).some((k) => !['serverId', 'root'].includes(k))))) throw Error('invalid_workspaces');
    const epoch = this.controlEpoch = (this.controlEpoch || 0) + 1;
    if (!body.enabled) this.suppressed = true; // Off cancels pending emissions even while a save/scan is awaiting.
    await this.change((s) => {
      s.enabled = body.enabled; s.off = !body.enabled;
      s.intervalMinutes = body.intervalMinutes ?? s.intervalMinutes;
      if (body.workspaces) s.workspaces = [...new Map(body.workspaces.map((w) => [JSON.stringify([w.serverId, w.root]), w])).values()];
    });
    if (!this.storageFault && epoch === this.controlEpoch) this.suppressed = !body.enabled;
    return { enabled: this.state.enabled && !this.suppressed, intervalMinutes: this.state.intervalMinutes, workspaces: clone(this.state.workspaces) };
  }
  host(id) { return this.state?.supervisor.hosts[id]; }
  async tick(remotes) {
    try { this.ensure(); } catch { this.errors.set('storage', reason('storage_locked')); return; }
    await Promise.allSettled(remotes.filter((r) => r.cfg?.id).map((r) => this.tickHost(r)));
  }
  async tickHost(r) {
    const id = r.cfg.id;
    if (!this.enabled() || this.gates.has(id) || !online(r, this.now()) || r.mode === 'powershell') return;
    this.gates.add(id); // Set synchronously, before any awaited read/save/open/send; never released by an age timer.
    try {
      const h = this.host(id);
      if (!h || this.now() - (h.scannedAt || 0) >= SCAN_MS) await this.scan(r);
      if (!this.enabled() || !online(r, this.now())) return;
      if (this.host(id)?.active) await this.advance(r);
      else await this.schedule(r);
      this.errors.delete(id);
    } catch { this.errors.set(id, reason(this.storageFault ? 'storage_failed' : 'host_io_failed')); }
    finally { this.gates.delete(id); }
  }
  async scan(r) {
    const id = r.cfg.id, h = this.host(id), now = this.now();
    if (h?.scanRetryAt > now) return;
    const roots = [...new Set([...this.state.workspaces.filter((w) => w.serverId === id).map((w) => w.root), ...Object.keys(h?.roots || {})])];
    const cwds = [...new Set(sessions(r).map((s) => s.aiCwd || s.path).filter(validRoot))];
    let data;
    try { data = await this.io.scan(r, { roots, cwds, days: this.state.days || 3 }); }
    catch {
      await this.change((s) => { const host = s.supervisor.hosts[id] ||= { roots: {}, progress: {}, history: [] };
        host.scanFailures = Math.min((host.scanFailures || 0) + 1, 8); host.scanRetryAt = now + Math.min(300000, 1000 * 2 ** host.scanFailures); host.scanError = 'scan_failed'; });
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
        const fingerprint = JSON.stringify([t.status, (t.tracks || []).map((k) => [k.id, k.state, k.lastRound || [k.rounds, k.fixRounds]]).sort((a, b) => a[0].localeCompare(b[0]))]);
        const p = host.progress[key];
        if (!p) host.progress[key] = { fingerprint, baselineAt: now, lastProgressAt: null };
        else if (!t.missing && root.available && p.fingerprint !== fingerprint) { p.fingerprint = fingerprint; p.lastProgressAt = now; }
      }
      const retained = new Set(Object.values(host.roots).flatMap((root) => root.tasks.map((t) => JSON.stringify([root.root, t.id]))));
      for (const key of Object.keys(host.progress)) if (!retained.has(key)) delete host.progress[key];
    });
  }
  teams(r) {
    const h = this.host(r.cfg.id), now = this.now(), out = [];
    for (const root of Object.values(h?.roots || {})) {
      const groups = new Map();
      for (const t of root.tasks) {
        const owners = (root.nudge || []).filter((n) => n[1] === t.id).flatMap(([pane]) => sessions(r).filter((s) => s.paneIds?.includes(pane)).map((s) => ({ s, pane })));
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
        else if (!root.available || now - root.at > FRESH_MS || h.scanError || g.tasks.some((t) => t.missing)) { status = 'unknown'; why = reason('task_evidence_stale'); }
        else if (g.tasks.length && g.tasks.every((t) => FINAL.has(t.status))) { status = 'completed'; why = reason('task_completed'); }
        else if (g.tasks.some((t) => t.blocked || t.tracks?.some((k) => ['blocked', 'failed'].includes(k.state) || (t.maxFix && k.fixRounds >= t.maxFix && OPEN_TRACK.has(k.state))))) { status = 'blocked'; why = reason('task_blocked'); }
        else if (g.tasks.some((t) => /awaiting_.*approval|waiting_owner|awaiting_owner/.test(t.status)) || g.owner?.asking || g.owner?.aiStatus?.status === 'waiting') { status = 'waiting_owner'; why = reason('owner_decision'); }
        else if (!g.owner) { status = 'unknown'; why = reason(g.tasks.length ? 'owner_missing' : 'workspace_only'); }
        else if (g.owner.aiStatus?.parked) { status = 'blocked'; why = reason('session_parked'); }
        else if (ps.length && now - (lastProgressAt ?? Math.min(...ps.map((p) => p.baselineAt))) >= STALL_MS) { status = 'stalled'; why = reason('no_task_progress', STALL_MS); }
        else if (lastProgressAt !== null) { status = 'progressing'; why = reason('task_evidence_changed'); }
        else if (g.owner.aiStatus?.status === 'idle') { status = 'idle'; why = reason('session_idle'); }
        else { status = 'unknown'; why = reason('awaiting_task_progress'); }
        out.push({ id: g.id, session: g.session, root: g.root, status, reason: why, lastProgressAt,
          lastAction: this.lastAction(h, g.id), requiresOwner: ['waiting_owner', 'blocked', 'stalled', 'unknown'].includes(status), taskIds: g.tasks.map((t) => t.id).sort() });
      }
    }
    return out;
  }
  lastAction(h, teamId) {
    const run = [h?.active, ...(h?.history || []).slice().reverse()].find((a) => a?.teamId === teamId);
    return run ? { code: run.lastAction?.code || 'audit_queued', at: run.lastAction?.at || run.createdAt, runId: run.runId, verification: run.verification || 'unverified' } : null;
  }
  async schedule(r, scope) {
    const h = this.host(r.cfg.id); if (!h || h.scanError) return;
    const now = this.now();
    const candidates = this.teams(r).filter((t) => this.host(r.cfg.id).roots[t.root].available && now - this.host(r.cfg.id).roots[t.root].at <= FRESH_MS && (!scope || t.root === scope));
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
  async advance(r) {
    const id = r.cfg.id; let run = this.host(id).active, now = this.now();
    if (!run || !this.enabled() || !online(r, now)) return;
    let s = sessions(r).find((v) => v.name === run.session);
    if (run.phase === 'completed') {
      if (idle(s) && identity(r, s) === run.auditIdentity && r.lastPoll > run.completedAt) await this.finish(id);
      return;
    }
    if (['sending', 'delivered', 'running', 'uncertain', 'timeout'].includes(run.phase)) {
      let value; try { value = await this.io.report(r, run); } catch { value = { code: 'report_read_failed' }; }
      const report = validateReport(value, run, this.now());
      if (!this.enabled()) return;
      if (report.code === 'report_valid') await this.patch(id, { phase: 'completed', reason: reason('report_valid'), verification: 'reported', completedAt: report.completedAt, findings: report.findings,
        lastAction: { code: 'report_valid', at: this.now() } });
      else {
        const expired = this.now() >= run.deadline;
        const ack = s?.aiStatus?.status === 'busy' && r.lastPoll > (run.actionAt || run.createdAt);
        const held = !s ? 'audit_session_missing' : s.asking || s.aiStatus?.status === 'waiting' ? 'audit_waiting_owner' :
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
      const reconciled = run.phase === 'completed' || !run.deliveryUncertain || !!run.acknowledgedAt;
      if (reconciled && ['completed', 'timeout'].includes(run.phase) && idle(s) && (identity(r, s) === run.auditIdentity ||
          (!run.sendIntent && (s.aiCwd || s.path) === run.root)) && r.lastPoll > (run.completedAt || run.deadline)) await this.finish(id);
      return;
    }
    if (now >= run.deadline) {
      await this.patch(id, { phase: 'timeout', reason: reason('audit_timeout') });
      // No action was sent in prepared/awaiting_idle. An observed idle audit can release this reservation safely.
      if (idle(s) && (s.aiCwd || s.path) === run.root) { await this.patch(id, { auditIdentity: identity(r, s) }); await this.finish(id); }
      return;
    }
    if (run.retryAt > now) return;
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
    try { await this.io.send(r, current, auditPrompt(run)); await this.patch(id, { phase: 'delivered', reason: reason('prompt_delivered'), deliveredAt: this.now(), actionAt: this.now(), lastAction: { code: 'prompt_delivered', at: this.now() } }); }
    catch (e) { await this.failed(id, 'send', e); }
  }
  async failed(id, action, error) {
    const run = this.host(id).active;
    // Only an adapter's definite pre-side-effect rejection is retryable. SSH errors/partial sends are ambiguous.
    const safe = error?.noSideEffect === true;
    if (safe && run.attempts < MAX_ATTEMPTS) await this.patch(id, { phase: 'retry_' + action, retryAt: this.now() + 1000 * 2 ** (run.attempts - 1), reason: reason(action + '_retry', run.attempts) });
    else if (safe) { await this.patch(id, { phase: 'failed', reason: reason(action + '_failed', run.attempts) }); await this.finish(id); }
    else await this.patch(id, { phase: action === 'send' ? 'uncertain' : 'opening', reason: reason(action + '_uncertain'), requiresOwner: true,
      ...(action === 'send' ? { deliveryUncertain: true } : {}) });
  }
  async finish(id) {
    await this.change((s) => { const h = s.supervisor.hosts[id]; h.history.push(h.active); h.history = h.history.slice(-HISTORY_MAX); h.active = null; });
  }
  status(remotes) {
    try { this.ensure(); } catch { return { enabled: false, intervalMinutes: 30, servers: [], errors: [reason('storage_locked')] }; }
    const now = this.now();
    return { enabled: this.enabled(), intervalMinutes: this.state.intervalMinutes, servers: remotes.filter((r) => r.cfg?.id).map((r) => {
      const h = this.host(r.cfg.id);
      return { id: r.cfg.id, name: r.snapshot?.hostname || r.cfg.name || r.cfg.host || r.cfg.id, online: online(r, now), observedAt: r.lastPoll || 0,
        freshness: { snapshotFresh: online(r, now), scannedAt: h?.scannedAt || 0, taskEvidenceFresh: !!h && !h.scanError && now - h.scannedAt <= FRESH_MS && Object.values(h.roots).every((root) => root.available), maxAgeMs: FRESH_MS },
        teams: this.teams(r), audits: [...(h?.history || []).slice(-10), ...(h?.active ? [h.active] : [])].map((a) => {
          const active = a.runId === h.active?.runId, expired = active && now >= a.deadline && !['completed', 'failed'].includes(a.phase);
          return { ...a, ...(expired ? { phase: 'timeout', reason: reason('audit_timeout') } : {}), active, actionInFlight: active && this.gates.has(r.cfg.id),
            evidence: reportPath(a), requiresOwner: expired || !!a.requiresOwner || ['uncertain', 'timeout', 'opening'].includes(a.phase) };
        }),
        errors: [...(h?.scanError ? [reason(h.scanError)] : []), ...(this.errors.has(r.cfg.id) ? [this.errors.get(r.cfg.id)] : [])] };
    }), errors: [...this.errors.entries()].filter(([id]) => id === 'storage').map(([, v]) => v) };
  }
  stop() { this.stopped = true; }
}

module.exports = { CrewSupervisor, reportRuntime, validateReport, auditPrompt, auditSession, identity, idle, validRoot, online,
  FRESH_MS, SCAN_MS, TIMEOUT_MS, STALL_MS, HISTORY_MAX, REPORT_MAX };
