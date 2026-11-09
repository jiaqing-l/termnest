'use strict';
const crypto = require('node:crypto');
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const CONFIG = /^\.claude(?:-[a-zA-Z0-9_.-]{1,60})?$/;
const TASK = /^[A-Za-z0-9][\w-]{0,127}$/;
const FINAL = new Set(['done', 'closed', 'abandoned', 'archived', 'merged']);
const OPEN = new Set(['pending', 'queued', 'dispatched', 'running', 'fix', 'review']);
function liveIdentity(r, s) {
  // On Windows+WSL the snapshot boot ID is "<windows>/<wsl>"; the guard runs inside WSL and sees only the WSL part.
  // A local backend prefixes the platform ("darwin:…", "linux:…"); the guard on the host reads the bare value.
  return { bootId: String(r?.snapshot?.bootId || '').split('/').pop().replace(/^(?:linux|darwin|win32):/, ''), sessionId: s?.id || '', created: s?.created,
    pane: s?.paneIds?.length === 1 ? s.paneIds[0] : '', agentPid: s?.aiPid,
    agentStartedAt: s?.aiStatus?.startedAt, config: s?.aiStatus?.cfg || '' };
}
function validIdentity(i) {
  return i && typeof i.bootId === 'string' && i.bootId.length > 0 && i.bootId.length < 128 &&
    /^\$\d+$/.test(i.sessionId) && /^%\d+$/.test(i.pane) && /^\d+$/.test(String(i.created)) &&
    Number(i.created) > 0 && Number.isSafeInteger(i.agentPid) && i.agentPid > 0 &&
    Number.isSafeInteger(i.agentStartedAt) && i.agentStartedAt > 0 && CONFIG.test(i.config);
}
const identityKey = i => digest([i.bootId, i.sessionId, String(i.created), i.pane, i.agentPid, i.agentStartedAt, i.config]);
const sameIdentity = (a, b) => validIdentity(a) && validIdentity(b) && identityKey(a) === identityKey(b);
const eventKey = (i, at) => digest(['idle/v1', identityKey(i), at]);
function recoveryEligibility({ r, s, registration, root, now, freshScan, baselineAt }) {
  if (!r?.ready || !r.lastPoll || now < r.lastPoll || now - r.lastPoll >= 60000) return 'host_unavailable';
  if (!freshScan || !root?.available || now - root.at >= 60000) return 'task_evidence_stale';
  if (!s || /^tn-ops-audit(?:-|$)/.test(s.name)) return 'leader_missing';
  if (!registration || !sameIdentity(registration.identity, liveIdentity(r, s))) return 'registration_required';
  const cwd = s.aiCwd || s.path;
  if (typeof cwd !== 'string' || cwd !== registration.root && !cwd.startsWith(registration.root + '/')) return 'registration_scope_mismatch';
  if (!baselineAt || now <= baselineAt || r.lastPoll <= baselineAt) return 'observation_baseline';
  if (s.asking || s.aiStatus?.waitingFor || s.aiStatus?.status === 'waiting') return 'owner_decision';
  if (s.aiStatus?.parked || s.dead) return 'session_parked';
  if (s.aiStatus?.tool !== 'claude' || s.aiStatus.status !== 'idle') return 'leader_not_idle';
  if (!Number.isSafeInteger(s.aiStatus.at) || s.aiStatus.at <= 0 || s.aiStatus.at > now) return 'idle_unknown';
  const tasks = registration.taskIds.map(id => root.tasks.find(t => t.id === id));
  if (!tasks.length || tasks.some(t => !t || t.missing || FINAL.has(t.status))) return 'managed_task_missing';
  if (tasks.some(t => t.blocked || /approval|waiting_owner|awaiting_owner|blocked/.test(t.status) ||
      t.tracks?.some(k => ['blocked', 'failed'].includes(k.state) || t.maxFix && k.fixRounds >= t.maxFix && OPEN.has(k.state)))) return 'managed_task_blocked';
  if (!tasks.some(t => t.tracks?.some(k => OPEN.has(k.state)))) return 'managed_task_not_open';
  // A missing process table cannot establish absence of live workers.
  if (!Array.isArray(r.snapshot?.workers)) return 'workers_unknown';
  if (r.snapshot.workers.some(w => !w.finishedAt && (registration.taskIds.includes(w.task) ||
      w.owner?.name === s.name && String(w.owner.created) === String(s.created)))) return 'live_worker';
  return '';
}
function recoveryPrompt(registration) {
  return 'Managed supervision check for tasks ' + registration.taskIds.join(', ') + '.\n' +
    'Remeasure the blocker using current evidence. Do only permitted independent work within the approved task. ' +
    'Report concrete evidence, the next safe step, and any owner decision needed. If blocked, stop and report. ' +
    'Do not answer approval dialogs, restart workers, change task status, release another team\'s lease, merge, deploy, or change credentials.';
}
// A dedicated timer uses this predicate, independently of HTTP/browser activity.
function pollUnattended(remotes, unlocked, enabled) {
  if (!unlocked || !enabled) return;
  for (const r of remotes) r.poll();
}
module.exports = { CONFIG, TASK, FINAL, liveIdentity, validIdentity, identityKey, sameIdentity, eventKey,
  recoveryEligibility, recoveryPrompt, digest, pollUnattended };
