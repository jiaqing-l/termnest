'use strict';
// Agent Ops core: generic rules over facts every TERMNEST snapshot carries. It knows nothing about any project.
// Facts only, no guessing from screen text:
//   - working / waiting for you / done: the status the agent writes itself (Claude: ~/.claude/sessions/<pid>.json "status";
//     Codex: the last turn event in its rollout file). No such file → the session is shown as "status unknown", never guessed.
//   - agent exited: the agent process was seen in the pane and is gone now (process table), or the pane is dead (tmux).
//   - machine: CPU/RAM measured by the poll, sessions lost after a reboot, machine not answering.
// A team may add its own literal screen-text matches in a JSON pack ("custom"); those are labelled as text matches.
// Hard limits, whatever a pack says: nothing is typed into a session that is waiting for its owner or whose status is not
// known, and nothing here kills, restarts or deploys anything. The strongest action is one suggested message the person clicks.

const LEVELS = ['off', 'notify', 'suggest', 'auto'];
const SEVERITY = ['info', 'warn', 'urgent'];

// Built-in rules. `after` is in minutes; `level` is notify (show only), suggest (show + one-click message) or auto (TERMNEST sends
// the message itself, within the limits of `auto` below). Only a rule that carries a message can be suggest or auto.
const CORE_RULES = {
  asking: { level: 'notify', severity: 'urgent', after: 0 },
  finished: { level: 'notify', severity: 'info', after: 0 },
  dormant: { level: 'suggest', severity: 'warn', after: 30, template: 'continue' },
  aborted: { level: 'notify', severity: 'warn', after: 0 },
  unknown: { level: 'notify', severity: 'info', after: 1 },
  // Claude background jobs that Claude marks blocked (waiting for you), changed within the last `days` days.
  bgjob: { level: 'notify', severity: 'warn', after: 0, days: 7 },
  exited: { level: 'notify', severity: 'warn', after: 0 },
  overload: { level: 'notify', severity: 'warn', after: 5, cpu: 90, ram: 90 },
  lost: { level: 'notify', severity: 'urgent', after: 0 },
  offline: { level: 'notify', severity: 'warn', after: 2 },
  unheard: { level: 'notify', severity: 'warn', after: 3 },
  // An AI account close to its 5-hour or weekly limit (from TERMNEST's own token readings; checked in the page).
  quota: { level: 'notify', severity: 'warn', after: 0, pct: 90 },
};
// Automatic messages: at most `perHour` per session, never during the quiet hours (local time of the TERMNEST machine), and at most
// one per idle period of a session — if it did not move the session, nothing more is sent until the session works again.
const CORE_AUTO = { perHour: 2, quietFrom: '23:00', quietTo: '07:00' };
const CORE_TEMPLATES = {
  continue: 'Please continue the task you were working on. If you are blocked, state exactly what you are waiting for.',
  status: 'Give a short status: what is done, what is left, and anything blocking you.',
};
const DEFAULT_PACK = { name: 'core', version: 1, rules: CORE_RULES, templates: CORE_TEMPLATES, custom: [], auto: CORE_AUTO };

const AGENT = /claude|codex|^\d+\.\d+\.\d+$/i;
const SHELL = /^-?(bash|zsh|sh|dash|fish|pwsh|powershell)$/i;

function num(v, lo, hi, d) { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; }
function str(v, max) { return typeof v === 'string' ? v.slice(0, max) : ''; }
function safeRegex(s) { if (typeof s !== 'string' || !s || s.length > 200) return null; try { return new RegExp(s, 'i'); } catch { return null; } }

// A pack from a file or another team: unknown keys are dropped, numbers are clamped, regexes must compile.
function cleanPack(raw) {
  const p = raw && typeof raw === 'object' ? raw : {}, rules = {}, templates = {};
  for (const [id, def] of Object.entries(CORE_RULES)) {
    const r = (p.rules && typeof p.rules[id] === 'object' && p.rules[id]) || {};
    const out = { ...def, level: LEVELS.includes(r.level) ? r.level : def.level, severity: SEVERITY.includes(r.severity) ? r.severity : def.severity, after: num(r.after, 0, 1440, def.after) };
    // Only "dormant" carries a message; everything else may only be shown.
    if (!def.template && (out.level === 'suggest' || out.level === 'auto')) out.level = 'notify';
    if ('days' in def) out.days = num(r.days, 1, 365, def.days);
    if ('pct' in def) out.pct = num(r.pct, 50, 100, def.pct);
    if ('cpu' in def) { out.cpu = num(r.cpu, 10, 100, def.cpu); out.ram = num(r.ram, 10, 100, def.ram); }
    if ('template' in def) out.template = typeof r.template === 'string' && /^[\w-]{1,32}$/.test(r.template) ? r.template : def.template;
    rules[id] = out;
  }
  // Only templates the team wrote are kept; the built-in ones are filled in the reader's language (withTemplates).
  const t = p.templates && typeof p.templates === 'object' ? p.templates : {};
  for (const [k, v] of Object.entries(t)) if (/^[\w-]{1,32}$/.test(k) && typeof v === 'string' && v.trim() && v.length <= 1000 && !/[\x00-\x09\x0b-\x1f\x7f]/.test(v)) templates[k] = v;
  const custom = (Array.isArray(p.custom) ? p.custom : []).filter((c) => c && /^[\w-]{1,40}$/.test(c.id || '') && safeRegex(c.match) && typeof c.title === 'string').slice(0, 30).map((c) => ({
    id: c.id, title: str(c.title, 120), match: c.match, severity: SEVERITY.includes(c.severity) ? c.severity : 'warn',
    level: c.level === 'off' ? 'off' : 'notify', after: num(c.after, 0, 1440, 0),
  }));
  const a = p.auto && typeof p.auto === 'object' ? p.auto : {}, hhmm = (v, d) => (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : d);
  const auto = { perHour: num(a.perHour, 1, 10, CORE_AUTO.perHour), quietFrom: hhmm(a.quietFrom, CORE_AUTO.quietFrom), quietTo: hhmm(a.quietTo, CORE_AUTO.quietTo) };
  return { name: str(p.name, 60) || 'core', version: num(p.version, 1, 9999, 1), rules, templates, custom, auto };
}

function isAgent(s) { return AGENT.test(s.cmd || '') || !!s.aiTool || !!s.aiStatus; }

// Findings for one machine. `memo` carries what one snapshot cannot show (which panes ran an agent, when a rule first held).
// Returns [{ key, rule, server, session, severity, level, since, params, source, template? }]; since = seconds the fact has held.
// source: "status" (agent's own file), "process" (process table / tmux), "machine" (measured), "text" (a pack's text match).
function evaluate({ server, snapshot, online, lost, pack, memo, now, nudges }) {
  const P = pack || DEFAULT_PACK, R = P.rules, out = [], seen = new Set();
  memo.first ||= {}; memo.agents ||= {};
  const age = (st) => (st && st.at ? Math.max(0, (now - st.at) / 1000) : 0);
  // `held`: how long the fact itself has held (seconds), so a restart of TERMNEST does not reset the clock.
  function hit(rule, session, params, source, opts = {}) {
    const cfg = opts.def || R[rule]; if (!cfg || cfg.level === 'off') return;
    const key = server + '/' + (session || '') + '/' + rule + (opts.extra ? ':' + opts.extra : '');
    seen.add(key); const first = memo.first[key] ||= now, since = Math.max(Math.round((now - first) / 1000), Math.round(opts.held || 0));
    if (since < (cfg.after || 0) * 60) return;
    const f = { key, rule, server, session: session || '', severity: cfg.severity, level: cfg.level, since, params: params || [], source };
    if ((cfg.level === 'suggest' || cfg.level === 'auto') && cfg.template && (P.templates[cfg.template] || CORE_TEMPLATES[cfg.template])) f.template = cfg.template;
    out.push(f);
  }
  if (!online) hit('offline', '', [], 'machine');
  for (const name of lost || []) hit('lost', name, [], 'machine');
  const snap = online ? snapshot : null;
  if (snap) {
    const o = R.overload, cpu = snap.cpu, ram = snap.ram;
    if ((Number.isFinite(cpu) && cpu >= o.cpu) || (Number.isFinite(ram) && ram >= o.ram)) hit('overload', '', [Number.isFinite(cpu) ? Math.round(cpu) : '—', Number.isFinite(ram) ? Math.round(ram) : '—'], 'machine');
    for (const s of snap.sessions || []) {
      const id = s.name + '/' + (s.created || ''), st = s.aiStatus;
      const agent = isAgent(s);
      if (agent) memo.agents[id] = now;
      if (s.dead || (SHELL.test(s.cmd || '') && memo.agents[id])) { hit('exited', s.name, [s.exitStatus == null ? '' : s.exitStatus], 'process'); continue; }
      if (agent) {
        if (!st) hit('unknown', s.name, [], 'status');
        else if (st.parked) {
          // Conversation moved to Claude's background list: report the background process's status, but never offer to type
          // into this pane (it shows Claude's board; text typed there may start a new session).
          const j = st.job;
          if (j && j.status === 'waiting') hit('asking', s.name, j.waitingFor ? [j.waitingFor] : [], 'status', { held: age(j) });
          else if (j && j.status === 'idle') {
            const idle = age(j);
            if (idle >= R.dormant.after * 60) hit('dormant', s.name, [Math.round(idle / 60)], 'status', { def: { ...R.dormant, after: 0, level: R.dormant.level === 'off' ? 'off' : 'notify' }, held: idle });
            else hit('finished', s.name, [], 'status', { held: idle });
          }
        }
        else if (st.status === 'waiting') hit('asking', s.name, st.waitingFor ? [st.waitingFor] : [], 'status', { held: age(st) });
        else if (st.status === 'aborted') hit('aborted', s.name, [], 'status', { held: age(st) });
        // Opened but never given work: it has not finished anything and is not waiting for anyone.
        else if (st.status === 'idle' && st.fresh) { /* nothing to report */ }
        else if (st.status === 'idle') {
          const idle = age(st);
          if (idle >= R.dormant.after * 60) hit('dormant', s.name, [Math.round(idle / 60)], 'status', { def: { ...R.dormant, after: 0 }, held: idle });
          else hit('finished', s.name, [], 'status', { held: idle });
        }
      }
      const last = (s.lines || []).slice(-10).join('\n');
      for (const c of P.custom || []) { const re = safeRegex(c.match); if (re && re.test(last)) hit('custom', s.name, [c.title], 'text', { def: c, extra: c.id }); }
    }
    // Claude sessions running in the background (no terminal of their own): only "waiting for you" is worth a line.
    for (const b of (snap.bgAgents || []).slice(0, 20)) if (b.status === 'waiting') hit('asking', 'bg:' + b.name, b.waitingFor ? [b.waitingFor] : [], 'status', { extra: 'bg', held: age(b) });
    // Claude background jobs (~/.claude*/jobs/<id>/state.json): one line per job Claude marks "blocked" (needs you).
    for (const j of (snap.jobs || []).slice(0, 60)) {
      if (j.tempo !== 'blocked' || !(now - j.at <= R.bgjob.days * 86400000)) continue;
      hit('bgjob', 'job:' + (j.name || j.id), [j.name || j.id, j.needs || '', j.state || ''], 'status', { extra: j.id, held: age(j) });
    }
    // A sent message that did not move the session: say so once, never send it again on our own.
    for (const n of nudges || []) {
      if (n.server !== server || n.verified !== false || now - n.at > 6 * 3600 * 1000) continue;
      hit('unheard', n.session, [n.template || ''], 'status', { def: { ...R.unheard, after: 0 }, extra: String(n.at) });
    }
  }
  for (const k of Object.keys(memo.first)) if (k.startsWith(server + '/') && !seen.has(k)) delete memo.first[k];
  for (const k of Object.keys(memo.agents)) if (now - memo.agents[k] > 24 * 3600 * 1000) delete memo.agents[k];
  return out;
}

// Inside the quiet hours? `at` is a Date; from/to are "HH:MM"; a window may cross midnight (23:00 → 07:00).
function quiet(auto, at) {
  const m = at.getHours() * 60 + at.getMinutes(), t = (v) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3));
  const a = t(auto.quietFrom), b = t(auto.quietTo);
  return a === b ? false : a < b ? m >= a && m < b : m >= a || m < b;
}
// May TERMNEST send this finding's message by itself now? Returns '' when yes, else the reason it holds back.
// `log` holds earlier sends; one automatic message per idle period of a session (the period starts at the agent's own timestamp).
function autoGate(f, session, pack, log, now) {
  if (f.level !== 'auto' || !f.template) return 'not-auto';
  const why = canSend(session); if (why) return why;
  if (quiet(pack.auto, new Date(now))) return 'quiet';
  const mine = log.filter((n) => n.server === f.server && n.session === f.session);
  if (mine.filter((n) => n.why === 'auto' && now - n.at < 3600000).length >= pack.auto.perHour) return 'limit';
  const idleSince = session.aiStatus && session.aiStatus.at || 0;
  if (mine.some((n) => n.at >= idleSince)) return 'once';
  return '';
}

// Did the agent respond? Delivery is recorded separately. A changed status is response evidence, never business progress.
// No status change within `waitMin` → false.
function verify(nudge, session, now, waitMin) {
  if (nudge.verified != null) return nudge.verified;
  const st = session && session.aiStatus;
  if (st && st.at && st.at > nudge.at) return true;
  return now - nudge.at > waitMin * 60000 ? false : null;
}

// Whether a message may be typed into this session now: only when the agent itself says it is idle at its own prompt.
function canSend(session) {
  if (!session) return 'gone';
  if (session.dead || !isAgent(session)) return 'no-agent';
  const st = session.aiStatus;
  if (!st) return 'unknown';
  if (st.status === 'waiting') return 'asking';
  if (st.parked) return 'hub';
  if (st.status !== 'idle') return 'busy';
  return '';
}

// The pack with every template filled: the team's own text, else the built-in one from `defaults` (in the reader's language).
function withTemplates(pack, defaults) { return { ...pack, templates: { ...CORE_TEMPLATES, ...(defaults || {}), ...pack.templates } }; }

module.exports = { quiet, autoGate, CORE_AUTO, withTemplates, DEFAULT_PACK, CORE_RULES, CORE_TEMPLATES, LEVELS, cleanPack, evaluate, verify, canSend };
