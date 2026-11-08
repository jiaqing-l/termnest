'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CrewSupervisor, auditSession } = require('../lib/crew-supervisor');
const policy = require('../lib/supervision-state');
const clone = v => JSON.parse(JSON.stringify(v));

test('SIMULATION: real supervisor engine, 3 VMs × 3 managed leaders × 24 virtual hours, faults and coordinator restarts', async () => {
  const start = 1800000000000; let now = start, serial = 0, disk, core;
  const receipts = new Map(), leases = new Map(), actionLog = [], coverage = new Set(), faults = new Set(), auditDeliveries = new Map();
  const response = new Map(), reports = new Map(), epochs = new Map();
  const remotes = Array.from({ length: 3 }, (_, h) => ({ cfg: { id: 'vm' + h }, ready: true, lastPoll: now,
    snapshot: { bootId: 'boot-' + h, workers: [], sessions: Array.from({ length: 3 }, (_, n) => ({ name: 'leader' + n, id: '$' + n,
      created: 100 + n, paneIds: ['%' + n], path: '/work' + n, aiPid: 700 + n,
      aiStatus: { tool: 'claude', status: 'idle', cfg: '.claude', startedAt: start - 3600000, at: start - 600000 } })) } }));
  const data = new Map(remotes.map(r => [r.cfg.id, { roots: Array.from({ length: 3 }, (_, n) => ({ root: '/work' + n,
    nudge: [['%' + n, 'task' + n]], tasks: [{ id: 'task' + n, title: 'Managed simulation task', status: 'executing', blocked: '',
      tracks: [{ id: 'W1', state: 'pending', rounds: 0, fixRounds: 0, lastRound: { round: '0', result: '', kind: 'new' } }], heartbeat: {} }] })) }]));
  const registrations = () => remotes.flatMap(r => r.snapshot.sessions.filter(s => s.name.startsWith('leader')).map((s, n) =>
    ({ serverId: r.cfg.id, session: s.name, root: s.path, taskIds: ['task' + n], identity: { ...policy.liveIdentity(r, s), processStart: '23' } })));
  disk = { enabled: true, autoRecovery: true, intervalMinutes: 30, leaders: registrations() };
  const scope = (r, root) => JSON.stringify([r.cfg.id, root]);
  const hour = () => (now - start) / 3600000;
  const coordinate = async (r, root, coordinatorId) => {
    const key = scope(r, root), old = leases.get(key);
    if (old && old.expiresAt > now && old.coordinatorId !== coordinatorId) return { code: 'coordination_owned' };
    let epoch = epochs.get(key) || 0;
    if (!old || old.expiresAt <= now || old.coordinatorId !== coordinatorId) { epoch++; epochs.set(key, epoch); }
    const token = { coordinatorId, epoch, expiresAt: now + 45000 }; leases.set(key, token); return { code: 'coordination_owner', token };
  };
  const fenced = (r, root, token, coordinatorId) => {
    const lease = leases.get(scope(r, root)); return !!lease && lease.coordinatorId === coordinatorId && token.epoch === lease.epoch && lease.expiresAt > now;
  };
  const reserve = (r, root, token, coordinatorId, eventId) => {
    assert.equal(fenced(r, root, token, coordinatorId), true, 'every send requires current remote fencing ownership');
    const key = scope(r, root) + eventId;
    if (receipts.has(key)) return null;
    const receipt = { eventId, at: now, delivery: 'pending' }; receipts.set(key, receipt); return receipt;
  };
  const io = {
    scan: async r => clone(data.get(r.cfg.id)),
    validateLeader: async () => ({ processStart: '23' }), coordinate,
    auditReady: async r => ({ code: r.cfg.id === 'vm2' && hour() >= 14 && hour() < 15 ? 'audit_skill_missing' : 'audit_ready' }),
    revoke: async (rs, id) => { for (const [key, l] of leases) if (l.coordinatorId === id) leases.set(key, { ...l, expiresAt: 0 }); },
    open: async (r, run) => {
      assert.equal(fenced(r, run.root, run.token, run.coordinatorId), true);
      assert.equal(r.ready, true); assert.equal(core.enabled(), true);
      r.snapshot.sessions.push({ name: run.session, id: '$90' + serial, created: now, paneIds: ['%90' + serial], path: run.root, aiPid: 990 + serial,
        aiStatus: { tool: 'claude', cfg: '.claude', startedAt: now, status: 'idle', at: now } });
    },
    send: async (r, s, prompt, run) => {
      assert.equal(s.aiStatus.status, 'idle'); assert.equal(!!s.asking || !!s.aiStatus.parked, false);
      const eventId = policy.digest(['audit', policy.liveIdentity(r, s), s.aiStatus.at]);
      const receipt = reserve(r, run.root, run.token, run.coordinatorId, eventId);
      if (!receipt) throw Error('duplicate audit receipt');
      actionLog.push({ kind: 'audit', host: r.cfg.id, at: now, eventId });
      if (r.cfg.id === 'vm0' && hour() >= 10 && !faults.has('partial-audit')) {
        faults.add('partial-audit'); receipt.delivery = 'uncertain'; throw Error('partial typed audit');
      }
      receipt.delivery = 'delivered'; s.aiStatus.status = 'busy'; s.aiStatus.at = now;
      auditDeliveries.set(run.runId, { run: clone(run), r, s, at: now });
      coverage.add('audit:' + r.cfg.id + ':' + run.root);
    },
    recover: async (r, s, l, record, token, coordinatorId) => {
      assert.equal(core.recoveryTarget(r, s).eligible, true);
      assert.equal(s.aiStatus.status, 'idle'); assert.equal(!!s.asking || !!s.aiStatus.parked, false);
      assert.equal(r.snapshot.workers.some(w => l.taskIds.includes(w.task)), false);
      const receipt = reserve(r, l.root, token, coordinatorId, record.eventId);
      if (!receipt) return { code: 'action_duplicate', receipt: { delivery: 'uncertain' } };
      actionLog.push({ kind: 'recovery', host: r.cfg.id, session: s.name, at: now, eventId: record.eventId });
      coverage.add('recovery:' + r.cfg.id + ':' + s.name);
      if (r.cfg.id === 'vm2' && s.name === 'leader1' && hour() >= 12 && !faults.has('partial-recovery')) {
        faults.add('partial-recovery'); receipt.delivery = 'uncertain'; return { code: 'action_uncertain', receipt };
      }
      receipt.delivery = 'delivered'; receipt.deliveredAt = now;
      s.aiStatus.status = 'busy'; s.aiStatus.at = now; response.set(r.cfg.id + s.name, { r, s, root: l.root, at: now });
      return { code: 'action_delivered', receipt };
    },
    report: async (r, run) => reports.get(run.runId) || { code: 'report_missing' },
  };
  const construct = () => new CrewSupervisor({ load: () => clone(disk), save: s => { disk = clone(s); }, io, now: () => now,
    newId: () => 'tn-' + (++serial).toString(16).padStart(32, '0') });
  core = construct();
  for (let tick = 0; tick <= 5760; tick++) {
    now = start + tick * 15000; const h = hour();
    if (tick === 1920 || tick === 3840) { core.stop(); core = construct(); assert.equal(core.validated.size, 0); faults.add('restart'); }
    if (tick === 2160) { remotes[1].snapshot.bootId = 'rebooted'; faults.add('pane-reuse'); }
    if (tick === 2280) { await core.control({ enabled: true, leaders: registrations() }, remotes); faults.add('explicit-reregistration'); }
    if (tick === 3600) { await core.control({ enabled: false }, remotes); faults.add('off'); }
    if (tick === 3720) await core.control({ enabled: true }, remotes);
    for (let host = 0; host < remotes.length; host++) {
      const r = remotes[host]; r.ready = !(host === 0 && h >= 1 && h < 1.5);
      if (!r.ready) faults.add('offline');
      if (!(host === 1 && h >= 2 && h < 2.5)) r.lastPoll = now; else faults.add('stale');
      r.snapshot.workers = host === 1 && h >= 5 && h < 6 ? [{ task: 'task0' }] : [];
      if (r.snapshot.workers.length) faults.add('live-worker');
      for (let n = 0; n < 3; n++) {
        const s = r.snapshot.sessions[n];
        s.asking = host === 0 && n === 1 && h >= 3 && h < 4;
        if (s.asking) faults.add('owner-prompt');
        s.aiStatus.parked = host === 2 && n === 2 && h >= 6 && h < 7;
        if (s.aiStatus.parked) faults.add('parked');
        if (host === 0 && n === 2 && h >= 7 && h < 7.5) { s.aiStatus.status = 'unknown'; faults.add('unknown'); }
        else if (s.aiStatus.status === 'unknown') { s.aiStatus.status = 'idle'; s.aiStatus.at = now; }
        if (host === 1 && h >= 9 && h < 9.5) {
          assert.equal(core.recoveryTarget(r, s).eligible, false, 'old registration cannot act on pane reuse');
        }
      }
    }
    for (const [key, a] of response) if (now - a.at >= 60000) {
      const noProgress = a.r.cfg.id === 'vm0' && a.s.name === 'leader0' && h >= 20 && h < 21;
      if (noProgress) { faults.add('busy-no-progress'); continue; }
      const task = data.get(a.r.cfg.id).roots.find(r => r.root === a.root).tasks[0];
      task.tracks[0].lastRound.round = String(Number(task.tracks[0].lastRound.round) + 1);
      a.s.aiStatus.status = 'idle'; a.s.aiStatus.at = now; response.delete(key);
    }
    for (const [runId, a] of auditDeliveries) if (now - a.at >= 30000) {
      const corrupt = a.r.cfg.id === 'vm1' && h >= 11 && h < 11.5;
      if (corrupt) { faults.add('corrupt-report'); reports.set(runId, { text: '{broken' }); continue; }
      reports.set(runId, { text: JSON.stringify({ schemaVersion: 1, runId, serverId: a.run.serverId, root: a.run.root,
        teamId: a.run.teamId, startedAt: a.run.createdAt, completedAt: now, coverage: { taskIds: a.run.taskIds }, result: 'completed', findings: [] }) });
      a.s.aiStatus.status = 'idle'; a.s.aiStatus.at = now; auditDeliveries.delete(runId);
    }
    if (h >= 14 && h < 15) faults.add('missing-skill');
    await core.tick(remotes);
    for (const r of remotes) if (Object.values(core.host(r.cfg.id)?.recoveries || {}).some(a => a.code === 'recovery_no_progress' && a.responded && a.auditRequested)) coverage.add('busy-escalation');
    // Heartbeat/updated churn never fabricates progress.
    for (const v of data.values()) for (const root of v.roots) { root.tasks[0].updated = now; root.tasks[0].heartbeat = { at: now, alive: true }; }
    if (!core.enabled()) assert.equal(actionLog.some(a => a.at === now), false, 'OFF cancels all automatic actions');
  }
  assert.equal(hour(), 24);
  for (const r of remotes) for (let n = 0; n < 3; n++) {
    assert.equal(coverage.has('audit:' + r.cfg.id + ':/work' + n), true);
    assert.equal(coverage.has('recovery:' + r.cfg.id + ':leader' + n), true);
  }
  for (const fault of ['offline', 'stale', 'owner-prompt', 'live-worker', 'parked', 'unknown', 'restart', 'pane-reuse',
    'explicit-reregistration', 'partial-audit', 'partial-recovery', 'corrupt-report', 'missing-skill', 'off', 'busy-no-progress']) assert.equal(faults.has(fault), true, fault);
  const ids = actionLog.map(a => JSON.stringify([a.kind, a.host, a.eventId])); assert.equal(new Set(ids).size, ids.length, 'no duplicated idle/audit event');
  assert.ok(actionLog.filter(a => a.kind === 'recovery').length >= 18, 'liveness across progress cycles and restarts');
  assert.ok([...epochs.values()].every(epoch => epoch >= 3), 'coordinator restarts actually transferred fenced epochs');
  assert.ok(core.status(remotes).servers.every(s => s.audits.length <= 11));
  assert.ok(core.status(remotes).servers.some(s => s.recoveries.some(a => a.delivery === 'uncertain')), 'uncertain receipt survives restarts');
  assert.equal(coverage.has('busy-escalation'), true, 'busy response without task progress escalates and requests audit');
  assert.ok(remotes.every(r => core.host(r.cfg.id).history.some(a => a.verification === 'reported')), 'every VM actually validates structured audit completion');
});
