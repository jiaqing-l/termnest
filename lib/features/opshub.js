'use strict';
const crypto = require('crypto'), zlib = require('zlib');
const { tr } = require('../i18n-server');
const { keysScript } = require('../keys');
const { shq } = require('../parse');
const { runOnHost } = require('../file-viewer');
const { online } = require('../crew-supervisor');
const { classify } = require('./crewpack');

// Ops hub ("Trạm Ops"): the owner's crew-ops-audit flow, run by Termnest.
//  1. Fleet: every machine, session, crew task/track and pending question, from data Termnest already polls (0 token).
//  2. Rule report: BLOCKER / WASTE / DRIFT / INFO from that data, every N minutes, with history (0 token).
//  3. One Ops session (Claude, `tn-ops`) on a chosen machine: Termnest writes fleet.json beside it, asks it to run the
//     ops-audit skill or to answer a question, and reads the result file back. It never answers owner prompts.
//  4. Messages out (Telegram / Teams / webhook) for questions waiting on the owner, blockers, the Ops session stopping,
//     and a daily summary.
const OPS = 'tn-ops', TICK_MS = 15000, AUDIT_MS = 20 * 60000, ASK_MS = 12 * 60000, OPEN_WAIT_MS = 3 * 60000, RESULT_GRACE_MS = 45000;
const SWITCH_GAP_MS = 5 * 60000, REPORTS_MAX = 24, ASKS_MAX = 30, FINDINGS_MAX = 40, SENT_MAX = 600, PER_HOUR = 20;
const CATS = ['BLOCKER', 'WASTE', 'DRIFT', 'INFO'], OWNERS = ['you', 'leader', 'tooling', 'none'];
const FINAL = ['done', 'closed', 'abandoned', 'archived', 'merged'], OPEN_TRACK = ['pending', 'queued', 'dispatched', 'running', 'fix', 'review', 'blocked'];
const DORMANT_MS = 48 * 3600000, IDLE_LONG_MIN = 120;
const QUOTA_STATUS = /quota|rate_limit|credits|usage_limit/i;
const QUOTA_SCREEN = /hit your (?:[a-z]+ )?limit|usage limit (?:reached|exceeded)|rate limit reached|out of (?:usage )?credits|limit · resets/i;
const SECRET = /(glpat-[\w-]{10,}|gh[pousr]_[\w]{20,}|sk-[\w-]{16,}|xox[abpr]-[\w-]{10,}|eyJ[\w-]{20,}\.[\w-]{10,}\.[\w-]{10,}|(?:password|passwd|token|secret)\s*[:=]\s*\S+)/gi;
const BOX = /[│┃║╭╮╰╯─━═┌┐└┘├┤┬┴┼▐▛▜▝▘▌█▔▁⎿❯›>•✻·]+/g;

const now0 = () => Date.now();
const num = (v) => Number.isFinite(v) ? Math.round(v) : null;
const clip = (v, n) => String(v == null ? '' : v).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ').slice(0, n);
const mask = (v) => String(v || '').replace(SECRET, '•••');

// What a session is doing, from the agent's own status first (the screen only for quota wording and sessions without one).
function stateOf(s) {
  const st = s.aiStatus, screen = (s.lines || []).slice(-16).join('\n');
  if (st) {
    if (st.parked) return 'parked';
    const asking = st.status === 'waiting' || s.asking;
    if (QUOTA_STATUS.test(st.waitingFor || '') || (asking || st.status === 'idle') && QUOTA_SCREEN.test(screen)) return 'quota';
    if (asking) return 'asking';
    if (st.status === 'busy') return 'busy';
    if (st.fresh) return 'fresh';
    if (st.status === 'idle' || st.status === 'aborted') return 'idle';
    return 'unknown';
  }
  if (!s.aiTool && !/claude|codex/i.test(s.cmd || '')) return 'shell';
  if (s.asking) return QUOTA_SCREEN.test(screen) ? 'quota' : 'asking';
  return s.state === 'run' ? 'busy' : s.state === 'wait' ? 'idle' : 'unknown';
}

// The question on screen, in plain text: the last line ending in "?", else the last meaningful lines. Secrets masked.
function questionOf(s) {
  const lines = (s.lines || []).map((l) => String(l).replace(BOX, ' ').replace(/\s+/g, ' ').trim()).filter((l) => l.length > 1 && !/^(\d\.|esc|enter|tab|shift|ctrl)\b/i.test(l));
  const q = lines.filter((l) => /\?\s*$/.test(l)).slice(-1)[0] || lines.slice(-2).join(' · ');
  return clip(mask(q), 240);
}

// The screen line that says the limit was hit (e.g. "You've hit your weekly limit · resets Nov 11 at 1pm").
function quotaLine(s) {
  const line = (s.lines || []).slice(-16).map((l) => String(l).replace(/[│┃║╭╮╰╯─━═┌┐└┘├┤┬┴┼▐▛▜▝▘▌█▔▁⎿❯›>•✻]+/g, ' ').replace(/\s+/g, ' ').trim()).filter((l) => QUOTA_SCREEN.test(l)).slice(-1)[0];
  return clip(mask(line || ''), 200);
}

const sinceOf = (s) => {
  const st = s.aiStatus;
  return st ? (st.parked && st.job && st.job.at) || st.at || 0 : s.stateSince || 0;
};

// One picture of the whole fleet. crewOf(serverId) gives that machine's scanned crew roots.
function buildFleet(remotes, crewOf, now) {
  const machines = [], sessions = [], tasks = [];
  for (const r of remotes) {
    if (!r || !r.cfg) continue;
    const snap = r.snapshot || {}, on = online(r, now), id = r.cfg.id, name = clip(snap.hostname || r.cfg.name || r.cfg.host || id, 80);
    machines.push({ id, name, online: on, local: !!r.cfg.local, cpu: num(snap.cpu), ram: num(snap.ram), sessions: on ? (snap.sessions || []).length : 0 });
    const roots = crewOf(id) || [], byPane = new Map(), live = new Set();
    for (const root of roots) for (const t of root.tasks || []) if (!FINAL.includes(t.status) && t.activeAt && now - t.activeAt <= DORMANT_MS && (t.tracks || []).some((k) => OPEN_TRACK.includes(k.state) || k.state === 'failed')) live.add(root.root + '|' + t.id);
    for (const root of roots) for (const [pane, task] of root.nudge || []) byPane.set(pane, { root: root.root, task });
    const leaderOf = new Map();
    for (const s of on ? snap.sessions || [] : []) {
      const lead = (s.paneIds || []).map((p) => byPane.get(p)).find((x) => x && live.has(x.root + '|' + x.task));
      if (lead) leaderOf.set(lead.root + '|' + lead.task, s.name);
      const state = stateOf(s);
      sessions.push({ machine: id, machineName: name, name: clip(s.name, 80), tool: (s.aiStatus && s.aiStatus.tool) || s.aiTool || ((/claude|codex/i.exec(s.cmd || '') || [''])[0].toLowerCase()), state,
        since: sinceOf(s), cwd: clip(s.aiCwd || s.path || '', 300), account: clip(s.aiStatus && s.aiStatus.cfg || '', 40),
        question: state === 'quota' ? quotaLine(s) : state === 'asking' ? questionOf(s) : '', task: lead ? lead.task : '', root: lead ? lead.root : '',
        workers: (snap.workers || []).filter((w) => w.owner && w.owner.name === s.name).map((w) => ({ kind: w.kind || '', task: w.task || '', track: w.track || '', elapsed: w.elapsed || 0 })).slice(0, 12) });
    }
    for (const root of roots) for (const t of root.tasks || []) {
      const enrolled = (root.nudge || []).some((x) => x[1] === t.id), final = FINAL.includes(t.status);
      if (final && now - (t.activeAt || t.updated || 0) > 86400000) continue;
      // A team is running only while it has unfinished tracks and moved within 48 h. An old task left "open" in its
      // MANIFEST, still listed in nudge.conf (whose pane ids tmux later reuses for other sessions), is not a team.
      const openTracks = (t.tracks || []).filter((k) => OPEN_TRACK.includes(k.state) || k.state === 'failed');
      if (!final && (!t.activeAt || now - t.activeAt > DORMANT_MS || (t.tracks || []).length && !openTracks.length)) continue;
      tasks.push({ machine: id, machineName: name, root: root.root, id: t.id, title: clip(t.title, 160), status: t.status || '', activeAt: t.activeAt || 0,
        blocked: clip(t.blocked, 200), leader: leaderOf.get(root.root + '|' + t.id) || '', enrolled, maxFix: t.maxFix || 0,
        heartbeat: t.heartbeat ? { armed: !!t.heartbeat.armed, alive: !!t.heartbeat.alive, at: t.heartbeat.at || 0 } : null,
        // Finished tasks only count (the daily summary); their tracks would cost the Ops session tokens for nothing.
        ...(final ? { trackCount: (t.tracks || []).length } : {}),
        tracks: final ? [] : (t.tracks || []).map((k) => ({ id: k.id, state: k.state, rounds: k.rounds || 0, fixRounds: k.fixRounds || 0,
          lastExit: k.lastRound ? clip(k.lastRound.result, 12) : '', verdict: clip(k.verdict, 20), proof: k.proof ? { file: clip(k.proof.file, 120), at: k.proof.at || 0, passed: k.proof.passed || 0, failed: k.proof.failed || 0, line: clip(k.proof.line, 160) } : null, lastKind: k.lastRound ? clip(k.lastRound.kind, 20) : '', lastAt: k.lastEnd || 0, branch: clip(k.branch, 200) })) });
    }
  }
  tasks.sort((a, b) => b.activeAt - a.activeAt);
  return { at: now, machines, sessions, tasks, waiting: sessions.filter((s) => s.state === 'asking' || s.state === 'quota') };
}

// Rule findings (no AI): the crew rules the board already uses, plus session-level ones the ops-audit skill looks for.
function ruleFindings(remotes, crewOf, fleet, now) {
  const out = [], add = (f) => out.push({ owner: 'leader', ...f });
  for (const m of fleet.machines) if (!m.online) add({ key: m.id + '|offline', cat: 'BLOCKER', code: 'machine_offline', machine: m.id, machineName: m.name, params: [m.name], owner: 'you' });
  for (const s of fleet.sessions) {
    const mins = s.since ? Math.max(0, Math.round((now - s.since) / 60000)) : 0, base = { machine: s.machine, machineName: s.machineName, session: s.name, task: s.task };
    if (s.state === 'asking') add({ ...base, key: s.machine + '|' + s.name + '|ask', cat: 'BLOCKER', code: 'owner_question', params: [s.name, mins, s.question], owner: 'you' });
    else if (s.state === 'quota') add({ ...base, key: s.machine + '|' + s.name + '|quota', cat: 'BLOCKER', code: 'quota', params: [s.name, s.account || '—', s.question], owner: 'you' });
    else if (s.state === 'idle' && !s.task && s.tool && s.name !== OPS && mins >= IDLE_LONG_MIN) add({ ...base, key: s.machine + '|' + s.name + '|idle', cat: 'WASTE', code: 'idle_long', params: [s.name, mins], owner: 'none' });
  }
  for (const r of remotes) {
    if (!r || !r.cfg || !online(r, now)) continue;
    const m = fleet.machines.find((x) => x.id === r.cfg.id);
    for (const f of classify({ roots: crewOf(r.cfg.id) || [] }, (r.snapshot || {}).sessions || [], now)) {
      if (!fleet.tasks.some((x) => x.machine === r.cfg.id && x.id === f.task && x.root === f.root && !FINAL.includes(x.status))) continue;
      // Exit 7 = code committed, the verification evidence was refused: "to verify", not a failure (shown below).
      if (f.code === 'track_failed') {
        const t = fleet.tasks.find((x) => x.machine === r.cfg.id && x.id === f.task && x.root === f.root);
        const failed = t ? t.tracks.filter((k) => k.state === 'failed' && k.lastExit !== '7').map((k) => k.id) : null;
        if (failed && !failed.length) continue;
        if (failed) f.params = [failed.join(', '), failed.length];
      }
      add({ key: r.cfg.id + '|' + f.key, cat: f.cat, code: f.code, machine: r.cfg.id, machineName: m ? m.name : r.cfg.id, session: f.session, task: f.task,
        title: clip(f.title, 160), params: (f.params || []).map((p) => typeof p === 'number' ? p : clip(p, 200)), owner: f.code === 'blocked' ? 'you' : f.code === 'done_enrolled' || f.code === 'not_enrolled' ? 'tooling' : 'leader' });
    }
  }
  // Tracks waiting on something the exit code names, one line per task.
  for (const t of fleet.tasks) {
    if (FINAL.includes(t.status)) continue;
    const open = t.tracks.filter((k) => OPEN_TRACK.includes(k.state) || k.state === 'failed'), by = (code) => open.filter((k) => k.lastExit === code).map((k) => k.id);
    const base = { machine: t.machine, machineName: t.machineName, session: t.leader, task: t.id, title: t.title };
    // Without a verdict (an older scan) exit 7 still reads as "to verify".
    const vd = (code) => t.tracks.filter((k) => (k.verdict || (code === 'unverified' && k.state === 'failed' && k.lastExit === '7' ? 'unverified' : '')) === code).map((k) => k.id);
    if (vd('unverified').length + vd('coded').length) add({ ...base, key: t.machine + '|' + t.id + '|unverified', cat: 'INFO', code: 'track_unverified', params: [vd('unverified').concat(vd('coded')).join(', ')] });
    if (vd('verify_failed').length) add({ ...base, key: t.machine + '|' + t.id + '|verifyfail', cat: 'BLOCKER', code: 'track_verify_failed', params: [vd('verify_failed').join(', ')] });
    if (vd('blocked').length) add({ ...base, key: t.machine + '|' + t.id + '|blocked', cat: 'BLOCKER', code: 'track_blocked', params: [vd('blocked').join(', '), (t.tracks.find((k) => k.verdict === 'blocked').proof || {}).line || ''] });
    if (by('8').length) add({ ...base, key: t.machine + '|' + t.id + '|queued', cat: 'WASTE', code: 'track_queued', params: [by('8').join(', ')] });
    if (by('11').length) add({ ...base, key: t.machine + '|' + t.id + '|quota', cat: 'BLOCKER', code: 'track_quota', params: [by('11').join(', ')], owner: 'you' });
  }
  const rank = { BLOCKER: 0, WASTE: 1, DRIFT: 2, INFO: 3 };
  return out.sort((a, b) => rank[a.cat] - rank[b.cat]).slice(0, FINDINGS_MAX);
}

const counts = (list) => Object.fromEntries(CATS.map((c) => [c, list.filter((f) => f.cat === c).length]));

// The AI report, as the Ops session wrote it: only known fields, bounded.
function cleanAiReport(text, id) {
  let v; try { v = JSON.parse(String(text).replace(/^﻿/, '').replace(/^```(?:json)?\s*|\s*```\s*$/g, '')); } catch { return null; }
  if (!v || typeof v !== 'object' || (v.id && v.id !== id) || !Array.isArray(v.findings)) return null;
  return { summary: clip(mask(v.summary), 1200),
    findings: v.findings.slice(0, FINDINGS_MAX).filter((f) => f && typeof f === 'object').map((f) => ({
      cat: CATS.includes(String(f.cat).toUpperCase()) ? String(f.cat).toUpperCase() : 'INFO', session: clip(f.session, 80), machine: clip(f.machine, 80), task: clip(f.task, 128),
      problem: clip(mask(f.problem), 600), cause: clip(mask(f.cause), 600), next: clip(mask(f.next), 400), owner: OWNERS.includes(f.owner) ? f.owner : 'none', evidence: clip(mask(f.evidence), 400) })) };
}

function auditPrompt(dir, id) {
  return `/xspire-devkit:xspire-crew-ops-audit Termnest Ops run ${id}. Start from the fleet snapshot ${dir}/fleet.json (every machine, session, crew task and track, ` +
    'questions waiting on the owner and rule findings, collected by Termnest moments ago) instead of re-collecting it; verify only what you need to find causes and progress against each plan. ' +
    'Read-only: do not answer owner prompts, type into other sessions, merge, deploy, release leases or change anything. ' +
    `When done write ONLY the file ${dir}/reports/${id}.json as JSON: {"id":"${id}","summary":"at most 3 sentences in Vietnamese","findings":[{"cat":"BLOCKER|WASTE|DRIFT|INFO",` +
    '"machine":"","session":"","task":"","problem":"Vietnamese","cause":"","next":"next action","owner":"you|leader|tooling|none","evidence":"file:line, task/track, time"}]}. ' +
    'Write the file even when the audit is partial.';
}

function askPrompt(dir, id, q) {
  return `Termnest Ops question ${id}: «${q}». Use the fleet snapshot ${dir}/fleet.json first, then read crew files (MANIFEST, ROUNDS, PLAN, tracker) only as needed. ` +
    'Read-only: change nothing, answer no owner prompt. Answer in Vietnamese, short, with evidence (file:line, task/track, times). ' +
    `Write the answer as Markdown to ${dir}/answers/${id}.md and do nothing else.`;
}

// Runs on the Ops machine (locally or over SSH through node): put fleet.json, read one result file.
function hubRuntime() {
  return async function hub(a) {
    const fs = require('fs'), path = require('path'), zlib = require('zlib');
    if (!path.isAbsolute(a.dir) || !/\/_crew\/ops-hub$/.test(a.dir.replace(/\\/g, '/'))) return { error: 'dir' };
    if (a.op === 'put') {
      fs.mkdirSync(path.join(a.dir, 'reports'), { recursive: true }); fs.mkdirSync(path.join(a.dir, 'answers'), { recursive: true });
      const tmp = path.join(a.dir, '.fleet.json.tmp');
      fs.writeFileSync(tmp, zlib.gunzipSync(Buffer.from(a.gz, 'base64'))); fs.renameSync(tmp, path.join(a.dir, 'fleet.json'));
      return { ok: true };
    }
    if (a.op === 'get' && /^[a-z0-9-]{8,48}$/.test(a.id)) {
      const f = path.join(a.dir, a.kind === 'report' ? 'reports' : 'answers', a.id + (a.kind === 'report' ? '.json' : '.md'));
      try { const st = fs.statSync(f); if (st.size > 262144) return { found: true, error: 'too_big' }; return { found: true, text: fs.readFileSync(f, 'utf8') }; }
      catch { return { found: false }; }
    }
    return { error: 'op' };
  };
}

// ---------- messages out ----------
function message(kind, p) {
  const t = (k, params) => tr('hub.msg.' + k, params);
  if (kind === 'owner_question') return t('owner_question', [p.session, p.machine, p.question || tr('hub.msg.no_text')]);
  if (kind === 'quota') return t('quota', [p.session, p.machine, p.account || '—']);
  if (kind === 'blocker') return t('blocker', [p.where, p.text]);
  if (kind === 'ops_down') return t('ops_down', [tr('hub.code.' + p.code)]);
  if (kind === 'daily') return t('daily', [p.machines, p.sessions, p.teams, p.done, p.waiting, p.blockers]);
  return t('test');
}

async function post(fetchImpl, url, body) {
  const res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw Error('notify_http_' + res.status);
}
async function deliver(fetchImpl, n, text) {
  const tasks = [];
  if (n.telegram && n.telegram.token && n.telegram.chat) tasks.push(post(fetchImpl, `https://api.telegram.org/bot${n.telegram.token}/sendMessage`, { chat_id: n.telegram.chat, text, disable_web_page_preview: true }));
  if (n.webhook && n.webhook.url) {
    const body = n.webhook.kind === 'teams' ? { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: { $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4', body: [{ type: 'TextBlock', text, wrap: true }] } }] } : { text };
    tasks.push(post(fetchImpl, n.webhook.url, body));
  }
  if (!tasks.length) throw Error('notify_no_channel');
  const done = await Promise.allSettled(tasks);
  if (done.every((d) => d.status === 'rejected')) throw done[0].reason;
}

// ---------- settings ----------
const DEF_CFG = { enabled: false, server: '', root: '', accounts: [], model: 'sonnet', perm: 'auto', interval: 30 };
const DEF_NOTIFY = { telegram: null, webhook: null, events: { owner_question: true, quota: true, blocker: true, ops_down: true, daily: true }, dailyHour: 18 };
function cleanCfg(b, old) {
  const c = { ...DEF_CFG, ...(old || {}) };
  if ('enabled' in b) c.enabled = b.enabled === true;
  if ('server' in b) { if (typeof b.server !== 'string' || b.server.length > 80) throw Error('invalid_server'); c.server = b.server; }
  if ('root' in b) { if (typeof b.root !== 'string' || (b.root && (!b.root.startsWith('/') || b.root.length > 400 || /[\n\r'"`$\\]/.test(b.root) || b.root.split('/').includes('..')))) throw Error('invalid_root'); c.root = b.root.replace(/\/+$/, ''); }
  if ('accounts' in b) { if (!Array.isArray(b.accounts) || b.accounts.length > 8 || !b.accounts.every((a) => typeof a === 'string' && /^\.(claude|config\/claude)[\w.-]{0,40}$/.test(a))) throw Error('invalid_accounts'); c.accounts = [...new Set(b.accounts)]; }
  if ('model' in b) { if (!/^[a-z0-9][a-z0-9.\-[\]]{1,48}$/i.test(String(b.model))) throw Error('invalid_model'); c.model = b.model; }
  if ('perm' in b) { // Claude Code permission modes. "auto" lets Claude approve safe read-only commands itself (the audit needs shell reads).
    if (!['auto', 'dontAsk', 'acceptEdits', 'manual'].includes(b.perm)) throw Error('invalid_perm'); c.perm = b.perm; }
  if ('interval' in b) { if (![15, 30, 60, 120].includes(Number(b.interval))) throw Error('invalid_interval'); c.interval = Number(b.interval); }
  if (c.enabled && (!c.server || !c.root)) throw Error('invalid_scope');
  return c;
}
function cleanNotify(b, old) {
  const n = { ...DEF_NOTIFY, ...(old || {}), events: { ...DEF_NOTIFY.events, ...((old && old.events) || {}) } };
  if ('telegram' in b) {
    if (b.telegram === null) n.telegram = null;
    else {
      const token = b.telegram.token === undefined && n.telegram ? n.telegram.token : String(b.telegram.token || ''), chat = String(b.telegram.chat || '');
      if (!/^\d{5,15}:[\w-]{20,60}$/.test(token) || !/^-?\d{3,20}$|^@[\w]{4,40}$/.test(chat)) throw Error('invalid_telegram');
      n.telegram = { token, chat };
    }
  }
  if ('webhook' in b) {
    if (b.webhook === null) n.webhook = null;
    else {
      const url = b.webhook.url === undefined && n.webhook ? n.webhook.url : String(b.webhook.url || ''), kind = ['teams', 'text'].includes(b.webhook.kind) ? b.webhook.kind : 'text';
      let u; try { u = new URL(url); } catch { throw Error('invalid_webhook'); }
      if (u.protocol !== 'https:' || url.length > 1000) throw Error('invalid_webhook');
      n.webhook = { url, kind };
    }
  }
  if (b.events && typeof b.events === 'object') for (const k of Object.keys(DEF_NOTIFY.events)) if (k in b.events) n.events[k] = b.events[k] === true;
  if ('dailyHour' in b) { const h = Number(b.dailyHour); if (!Number.isInteger(h) || h < 0 || h > 23) throw Error('invalid_hour'); n.dailyHour = h; }
  return n;
}
// Never send a token back to the page.
const publicNotify = (n) => ({ telegram: n.telegram ? { chat: n.telegram.chat, token: '••••' + n.telegram.token.slice(-4) } : null,
  webhook: n.webhook ? { kind: n.webhook.kind, url: n.webhook.url.replace(/^(https:\/\/[^/]+\/).*$/, '$1…') } : null, events: n.events, dailyHour: n.dailyHour });

module.exports = {
  name: 'opshub', stateOf, questionOf, buildFleet, ruleFindings, cleanAiReport, cleanCfg, cleanNotify, publicNotify, hubRuntime, auditPrompt, askPrompt, message,
  register(host, options = {}) {
    const now = options.now || now0, run = options.runOnHost || runOnHost, fetchImpl = options.fetch || ((...a) => fetch(...a));
    const newId = options.newId || (() => crypto.randomBytes(6).toString('hex') + '-' + Date.now().toString(36));
    const sup = () => host.service && host.service('supervision');
    const crewOf = (id) => { try { return (sup() && sup().crew && sup().crew(id)) || []; } catch { return []; } };
    const get = () => { try { return host.settings.get() || {}; } catch { return {}; } };
    const save = (patch) => host.settings.set({ ...get(), ...patch });
    const cfg = () => ({ ...DEF_CFG, ...(get().cfg || {}) });
    const notifyCfg = () => cleanNotify({}, get().notify);
    let busy = false, stopped = false, lastFleet = null, lastFindings = [], offlineSince = 0;
    // Runtime of the Ops session, kept in memory and mirrored to settings when it changes.
    const ops = { phase: 'off', code: '', at: 0, ...(get().ops || {}) };
    const setOps = (patch) => {
      const before = JSON.stringify([ops.phase, ops.code, ops.account, ops.job && ops.job.id]);
      Object.assign(ops, patch, { at: now() });
      if (before !== JSON.stringify([ops.phase, ops.code, ops.account, ops.job && ops.job.id])) { try { save({ ops: { ...ops } }); } catch { host.log('opshub_save_failed'); } }
    };
    const backend = () => host.remotes().find((r) => r.cfg && r.cfg.id === cfg().server);
    const dirOf = (c) => c.root + '/_crew/ops-hub';
    const opsSession = (r) => ((r && r.snapshot && r.snapshot.sessions) || []).find((s) => s.name === OPS);

    function fleet() {
      const t = now(), remotes = host.remotes();
      lastFleet = buildFleet(remotes, crewOf, t);
      lastFindings = ruleFindings(remotes, crewOf, lastFleet, t);
      return lastFleet;
    }

    // ---- reports ----
    function makeReport(trigger) {
      const f = fleet(), c = cfg(), id = newId();
      const report = { id, at: now(), trigger, counts: counts(lastFindings), findings: lastFindings,
        stats: { machines: f.machines.length, online: f.machines.filter((m) => m.online).length, sessions: f.sessions.filter((s) => s.tool).length, tasks: f.tasks.filter((t) => !FINAL.includes(t.status)).length, waiting: f.waiting.length },
        ai: c.enabled ? { status: 'queued', code: '' } : null };
      // Pressing "Report now" again within two minutes refreshes the newest report instead of adding a duplicate.
      const list = get().reports || [], last = list[0];
      if (trigger === 'manual' && last && report.at - last.at < 120000) {
        const merged = { ...report, id: last.id, trigger: last.trigger, ai: last.ai && last.ai.status !== 'skipped' ? last.ai : report.ai };
        save({ reports: [merged, ...list.slice(1)], lastReportAt: report.at });
        return merged;
      }
      save({ reports: [report, ...list].slice(0, REPORTS_MAX), lastReportAt: report.at });
      notifyBlockers(report);
      return report;
    }
    const patchReport = (id, ai) => save({ reports: (get().reports || []).map((r) => r.id === id ? { ...r, ai: { ...(r.ai || {}), ...ai } } : r) });
    const patchAsk = (id, v) => save({ asks: (get().asks || []).map((a) => a.id === id ? { ...a, ...v } : a) });

    // ---- the Ops session ----
    async function open(r, c) {
      const account = c.accounts[(ops.account || 0) % Math.max(1, c.accounts.length)] || '';
      await host.sessions.start(r, { name: OPS, dir: c.root, run: 'shell' });
      const env = account ? `CLAUDE_CONFIG_DIR="$HOME/${account}" ` : '';
      const res = await r.exec(keysScript(`=${OPS}:`, `${env}claude --model ${c.model} --permission-mode ${c.perm} --name ${OPS}`, true));
      if (!res || res.code !== 0) throw Error('ops_open_failed');
      setOps({ phase: 'opening', code: 'ops_opening', openedAt: now(), accountName: account });
      if (r.poll) await r.poll().catch(() => {});
    }
    async function send(r, s, text) {
      const target = shq(`=${OPS}:`);
      const res = await r.exec(`if [ "$(tmux display-message -p -t ${target} '#{session_created}' 2>/dev/null)" != ${shq(String(s.created))} ]; then exit 75; fi; ` + keysScript(`=${OPS}:`, text, true));
      if (!res || res.code !== 0) throw Error(res && res.code === 75 ? 'ops_session_replaced' : 'ops_send_failed');
    }
    async function putFleet(r, c) {
      const f = lastFleet || fleet(), body = { ...f, findings: lastFindings, generatedBy: 'termnest' };
      const gz = zlib.gzipSync(Buffer.from(JSON.stringify(body))).toString('base64');
      const v = await run(r, hubRuntime, { op: 'put', dir: dirOf(c), gz }, { timeout: 20000, maxBuffer: 10000 });
      if (!v || !v.ok) throw Error('ops_fleet_write_failed');
    }
    function finishJob(result) {
      const job = ops.job; if (!job) return;
      if (job.kind === 'audit') patchReport(job.id, result);
      else patchAsk(job.id, result.status === 'done' ? { state: 'done', answer: result.answer, doneAt: now() } : { state: 'failed', code: result.code, doneAt: now() });
      setOps({ phase: 'ready', code: result.status === 'done' ? 'ops_ready' : result.code, job: null, switches: result.status === 'done' ? 0 : ops.switches || 0 });
    }

    async function opsTick() {
      const c = cfg();
      if (!c.enabled) { if (ops.phase !== 'off') setOps({ phase: 'off', code: '', job: null }); return; }
      const r = backend(), t = now();
      // A slow poll on a loaded machine is not an outage: say "offline" only after two minutes without one.
      if (!r || !online(r, t)) { offlineSince = offlineSince || t; if (t - offlineSince > 120000) setOps({ phase: 'error', code: 'ops_machine_offline' }); return; }
      offlineSince = 0;
      if (r.mode === 'powershell') { setOps({ phase: 'error', code: 'ops_platform_unsupported' }); return; }
      const s = opsSession(r);
      if (!s) {
        if (ops.job) finishJob({ status: 'failed', code: 'ops_session_died' });
        if (ops.phase === 'opening' && t - (ops.openedAt || 0) < 30000) return;
        try { await open(r, c); } catch (e) { setOps({ phase: 'error', code: /^ops_/.test(e.message) ? e.message : 'ops_open_failed' }); }
        return;
      }
      const state = stateOf(s);
      if (state === 'quota') {
        if (ops.job) finishJob({ status: 'failed', code: 'ops_quota' });
        const n = c.accounts.length;
        if (n > 1 && (ops.switches || 0) < n - 1 && t - (ops.switchedAt || 0) > SWITCH_GAP_MS) {
          await host.sessions.stop(r, OPS).catch(() => {});
          setOps({ phase: 'switching', code: 'ops_account_switched', account: ((ops.account || 0) + 1) % n, switches: (ops.switches || 0) + 1, switchedAt: t });
          notify('ops_down', 'switch|' + t, { code: 'ops_account_switched' });
          return;
        }
        setOps({ phase: 'paused', code: 'ops_quota' }); notify('ops_down', 'quota|' + new Date(t).toDateString(), { code: 'ops_quota' });
        return;
      }
      if (state === 'asking') { setOps({ phase: 'waiting', code: 'ops_waiting_owner' }); notify('ops_down', 'ask|' + (s.aiStatus && s.aiStatus.at), { code: 'ops_waiting_owner' }); return; }
      if (state === 'shell' || state === 'unknown' && !s.aiStatus) {
        // Claude has not started yet, or it exited: give it time, then start it again in the same pane.
        if (t - (ops.openedAt || 0) < OPEN_WAIT_MS) return;
        if (ops.job) finishJob({ status: 'failed', code: 'ops_agent_exited' });
        await host.sessions.stop(r, OPS).catch(() => {}); setOps({ phase: 'error', code: 'ops_agent_exited', openedAt: 0 });
        return;
      }
      const job = ops.job;
      if (job) {
        const v = await run(r, hubRuntime, { op: 'get', dir: dirOf(c), id: job.id, kind: job.kind === 'audit' ? 'report' : 'answer' }, { timeout: 15000, maxBuffer: 400000 }).catch(() => null);
        if (v && v.found) {
          if (v.error) { finishJob({ status: 'failed', code: 'ops_result_too_big' }); return; }
          if (job.kind === 'audit') {
            const ai = cleanAiReport(v.text, job.id);
            finishJob(ai ? { status: 'done', code: '', at: now(), summary: ai.summary, findings: ai.findings, model: c.model, account: ops.accountName || '' } : { status: 'failed', code: 'ops_result_invalid' });
          } else finishJob({ status: 'done', answer: clip(mask(v.text), 20000) });
          return;
        }
        const turnEnded = (state === 'idle' || state === 'fresh') && s.aiStatus && s.aiStatus.at > job.sentAt + 2000;
        if (t - job.sentAt > (job.kind === 'audit' ? AUDIT_MS : ASK_MS)) finishJob({ status: 'failed', code: 'ops_timeout' });
        else if (turnEnded && t - s.aiStatus.at > RESULT_GRACE_MS) finishJob({ status: 'failed', code: 'ops_no_result' });
        return;
      }
      if (state !== 'idle' && state !== 'fresh') {
        // Claude draws its first screen as "busy": still opening, not busy with something else.
        const starting = ops.openedAt && t - ops.openedAt < OPEN_WAIT_MS;
        if (!starting && ops.phase !== 'busy') setOps({ phase: 'busy', code: 'ops_busy_other' });
        return;
      }
      // Ready: questions first (someone is waiting), then the newest queued audit.
      const ask = (get().asks || []).slice().reverse().find((a) => a.state === 'queued');
      const rep = (get().reports || []).find((x) => x.ai && x.ai.status === 'queued');
      const next = ask ? { kind: 'ask', id: ask.id, q: ask.q } : rep ? { kind: 'audit', id: rep.id } : null;
      if (!next) { if (ops.phase !== 'ready') setOps({ phase: 'ready', code: 'ops_ready', switches: 0 }); return; }
      // Older queued audits are replaced by the newest one.
      if (next.kind === 'audit') save({ reports: (get().reports || []).map((x) => x.id !== next.id && x.ai && x.ai.status === 'queued' ? { ...x, ai: { status: 'skipped', code: 'ops_superseded' } } : x) });
      try {
        await putFleet(r, c);
        const sentAt = now();
        await send(r, s, next.kind === 'audit' ? auditPrompt(dirOf(c), next.id) : askPrompt(dirOf(c), next.id, next.q));
        setOps({ phase: 'running', code: next.kind === 'audit' ? 'ops_auditing' : 'ops_answering', job: { ...next, sentAt } });
        if (next.kind === 'audit') patchReport(next.id, { status: 'running', sentAt }); else patchAsk(next.id, { state: 'sent', sentAt });
      } catch (e) {
        const code = /^ops_/.test(e.message) ? e.message : 'ops_send_failed';
        if (next.kind === 'audit') patchReport(next.id, { status: 'failed', code }); else patchAsk(next.id, { state: 'failed', code });
        setOps({ phase: 'error', code });
      }
    }

    // ---- messages out ----
    function notify(kind, key, params) {
      const n = notifyCfg(), events = n.events || {};
      if (!events[kind] || !(n.telegram || n.webhook)) return;
      const st = get(), sent = st.sent || {}, k = kind + '|' + key, t = now();
      if (sent[k]) return;
      const hour = Object.values(sent).filter((at) => t - at < 3600000).length;
      if (hour >= PER_HOUR) return;
      const keep = Object.entries({ ...sent, [k]: t }).filter(([, at]) => t - at < 7 * 86400000).sort((a, b) => b[1] - a[1]).slice(0, SENT_MAX);
      try { save({ sent: Object.fromEntries(keep) }); } catch { return; }
      deliver(fetchImpl, n, message(kind, params)).catch((e) => { host.log(e.message || 'notify_failed'); save({ notifyError: { at: now(), code: String(e.message || 'notify_failed').slice(0, 60) } }); });
    }
    function notifyQuestions(f) {
      for (const s of f.waiting) notify(s.state === 'quota' ? 'quota' : 'owner_question', s.machine + '|' + s.name + '|' + s.since, { session: s.name, machine: s.machineName, question: s.question, account: s.account });
    }
    function notifyBlockers(report) {
      for (const x of report.findings.filter((y) => y.cat === 'BLOCKER' && !['owner_question', 'quota'].includes(y.code))) {
        notify('blocker', x.key, { where: [x.session || x.task, x.machineName].filter(Boolean).join(' · '), text: tr('cp.c.' + x.code, x.params) !== 'cp.c.' + x.code ? tr('cp.c.' + x.code, x.params) : tr('hub.f.' + x.code, x.params) });
      }
    }
    function dailyTick() {
      const n = notifyCfg(), d = new Date(now()), day = d.toISOString().slice(0, 10);
      if (!n.events.daily || d.getHours() !== n.dailyHour || get().lastDaily === day || !lastFleet) return;
      save({ lastDaily: day });
      const reps = (get().reports || []).filter((r) => now() - r.at < 86400000);
      const done = lastFleet.tasks.filter((t) => FINAL.includes(t.status)).length;
      notify('daily', day, { machines: lastFleet.machines.length, sessions: lastFleet.sessions.filter((s) => s.tool).length, teams: lastFleet.tasks.filter((t) => !FINAL.includes(t.status)).length,
        done, waiting: lastFleet.waiting.length, blockers: reps.length ? reps[0].counts.BLOCKER : 0 });
    }

    async function tick() {
      if (busy || stopped) return; busy = true;
      try {
        const f = fleet(), c = cfg(), last = get().lastReportAt || 0;
        if (now() - last >= c.interval * 60000) makeReport('schedule');
        notifyQuestions(f); dailyTick();
        await opsTick();
      } catch (e) { host.log('opshub_tick_failed ' + (e && e.message)); }
      finally { busy = false; }
    }
    // The crew supervisor leaves fleet audits to this hub while its Ops session is on.
    host.provide?.('opshub', { audits: () => cfg().enabled });
    const timer = (options.setInterval || setInterval)(() => { tick(); }, TICK_MS); if (timer && timer.unref) timer.unref();

    // ---- routes ----
    const choices = () => host.remotes().filter((r) => r.cfg).map((r) => {
      const snap = r.snapshot || {}, accounts = new Set(['.claude']);
      // Profiles seen in use: ~/.claude-<name>, or ~/.config/claude-<name> (its folder name starts without a dot).
      for (const s of snap.sessions || []) { const c = s.aiStatus && s.aiStatus.cfg; if (c && /^\.claude/.test(c)) accounts.add(c); else if (c && /^claude[\w.-]*$/.test(c)) accounts.add('.config/' + c); }
      const roots = new Set(crewOf(r.cfg.id).map((x) => x.root));
      return { id: r.cfg.id, name: snap.hostname || r.cfg.name || r.cfg.host || r.cfg.id, online: online(r, now()), windows: r.mode === 'powershell', roots: [...roots], accounts: [...accounts] };
    });
    const opsView = () => {
      const c = cfg(), st = get();
      return { cfg: c, phase: ops.phase, code: ops.code, at: ops.at, account: c.accounts.length ? c.accounts[(ops.account || 0) % c.accounts.length] : '', job: ops.job ? { kind: ops.job.kind, id: ops.job.id, sentAt: ops.job.sentAt } : null,
        session: OPS, lastReportAt: st.lastReportAt || 0, nextReportAt: (st.lastReportAt || 0) + c.interval * 60000 };
    };
    host.route('GET', '/state', ({ res }) => {
      const f = lastFleet && now() - lastFleet.at < 5000 ? lastFleet : fleet(), st = get();
      host.send(res, 200, { fleet: f, findings: lastFindings, ops: opsView(), report: (st.reports || [])[0] || null, asks: (st.asks || []).slice(0, 10), notify: publicNotify(notifyCfg()), notifyError: st.notifyError || null });
    });
    // Reports made seconds apart (repeated clicks before this fix) show as one: the newest of each run.
    host.route('GET', '/reports', ({ res }) => host.send(res, 200, { reports: (get().reports || []).filter((r, i, all) => i === 0 || all[i - 1].at - r.at >= 120000) }));
    host.route('GET', '/config', ({ res }) => host.send(res, 200, { cfg: cfg(), notify: publicNotify(notifyCfg()), choices: choices() }));
    host.route('POST', '/config', async ({ req, res }) => {
      const b = await host.readJson(req);
      let c; try { c = cleanCfg(b || {}, get().cfg); } catch (e) { host.fail(res, 400, e.message, { code: e.message }); return; }
      const before = cfg();
      save({ cfg: c });
      if (before.server !== c.server || before.root !== c.root || before.accounts.join() !== c.accounts.join()) setOps({ account: 0, switches: 0 });
      host.send(res, 200, { cfg: c, ops: opsView() });
    });
    host.route('POST', '/notify', async ({ req, res }) => {
      const b = await host.readJson(req);
      let n; try { n = cleanNotify(b || {}, get().notify); } catch (e) { host.fail(res, 400, e.message, { code: e.message }); return; }
      save({ notify: n, notifyError: null }); host.send(res, 200, publicNotify(n));
    });
    host.route('POST', '/notify/test', async ({ res }) => {
      try { await deliver(fetchImpl, notifyCfg(), message('test')); host.send(res, 200, { ok: true }); }
      catch (e) { const code = String(e.message || 'notify_failed').slice(0, 60); host.fail(res, 502, code, { code }); }
    });
    host.route('POST', '/audit', ({ res }) => { host.send(res, 200, { report: makeReport('manual') }); });
    host.route('POST', '/ask', async ({ req, res }) => {
      const b = await host.readJson(req), q = clip(String((b && b.q) || '').replace(/\s+/g, ' ').trim(), 500);
      if (q.length < 3) { host.fail(res, 400, 'invalid_question', { code: 'invalid_question' }); return; }
      const c = cfg();
      const ask = { id: newId(), q, at: now(), state: c.enabled ? 'queued' : 'unavailable', code: c.enabled ? '' : 'ops_off' };
      save({ asks: [ask, ...(get().asks || [])].slice(0, ASKS_MAX) });
      host.send(res, 200, { ask });
    });
    host.route('POST', '/ops/restart', async ({ res }) => {
      const r = backend();
      if (!r) { host.fail(res, 409, 'ops_machine_offline', { code: 'ops_machine_offline' }); return; }
      if (ops.job) finishJob({ status: 'failed', code: 'ops_restarted' });
      await host.sessions.stop(r, OPS).catch(() => {});
      setOps({ phase: 'off', code: 'ops_restarted', switches: 0, openedAt: 0 });
      host.send(res, 200, { ops: opsView() });
    });
    host.route('POST', '/ops/account', async ({ req, res }) => {
      const b = await host.readJson(req), c = cfg(), i = c.accounts.indexOf(b && b.account);
      if (i < 0) { host.fail(res, 400, 'invalid_accounts', { code: 'invalid_accounts' }); return; }
      const r = backend(); if (r) await host.sessions.stop(r, OPS).catch(() => {});
      if (ops.job) finishJob({ status: 'failed', code: 'ops_account_switched' });
      setOps({ phase: 'switching', code: 'ops_account_switched', account: i, switches: 0, switchedAt: now() });
      host.send(res, 200, { ops: opsView() });
    });
    return { tick, fleet, makeReport, ops, stop: () => { stopped = true; (options.clearInterval || clearInterval)(timer); } };
  },
};
