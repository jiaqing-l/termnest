'use strict';
// Agent Ops core: generic rules over what every TERMNEST snapshot already carries (session state, screen tail, machine load).
// It knows nothing about any project. A team adds its own checks as a JSON rule pack (screen-text rules) instead of code.
// Hard limits, whatever a pack says: a session showing a question or permission prompt is never typed into (the owner answers
// it), and nothing here kills, restarts or deploys anything. The strongest action is one suggested message the person clicks.

const LEVELS = ['off', 'notify', 'suggest'];
const SEVERITY = ['info', 'warn', 'urgent'];

// Built-in rules. `after` is in minutes; `level` is notify (show only) or suggest (show + one-click message).
const CORE_RULES = {
  asking: { level: 'notify', severity: 'urgent', after: 3 },
  finished: { level: 'notify', severity: 'info', after: 1 },
  dormant: { level: 'suggest', severity: 'warn', after: 30, template: 'continue' },
  error: { level: 'notify', severity: 'warn', after: 1 },
  exited: { level: 'notify', severity: 'warn', after: 0 },
  quota: { level: 'notify', severity: 'warn', after: 0 },
  context: { level: 'suggest', severity: 'warn', after: 0, below: 15, template: 'compact' },
  loop: { level: 'notify', severity: 'warn', after: 5, repeats: 4 },
  overload: { level: 'notify', severity: 'warn', after: 5, cpu: 90, ram: 90 },
  lost: { level: 'notify', severity: 'urgent', after: 0 },
  offline: { level: 'notify', severity: 'warn', after: 2 },
  unheard: { level: 'notify', severity: 'warn', after: 3 },
};
const CORE_TEMPLATES = {
  continue: 'Please continue the task you were working on. If you are blocked, state exactly what you are waiting for.',
  compact: '/compact',
  status: 'Give a short status: what is done, what is left, and anything blocking you.',
};
const DEFAULT_PACK = { name: 'core', version: 1, rules: CORE_RULES, templates: CORE_TEMPLATES, custom: [] };

const ERROR = /\b(Error:|ERROR\b|Exception\b|Traceback \(most recent call last\)|panic:|FATAL\b|Unhandled\b|failed with exit code)/;
const QUOTA = /usage limit|rate limit|limit reached|hit your limit|quota exceeded|out of credits|429 Too Many/i;
const CONTEXT = /(\d{1,3})% context left|auto-compact:?\s*(\d{1,3})%|context left[^\d]{0,20}(\d{1,3})%/i;
const AGENT = /claude|codex|^\d+\.\d+\.\d+$/i;
const SHELL = /^-?(bash|zsh|sh|dash|fish|pwsh|powershell)$/i;
const CHROME = /^[\s─━│┃╭╮╰╯┌┐└┘├┤═║▌▐█░▒▓·•…>❯›$#%-]*$/;

function num(v, lo, hi, d) { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; }
function str(v, max) { return typeof v === 'string' ? v.slice(0, max) : ''; }
function safeRegex(s) { if (typeof s !== 'string' || !s || s.length > 200) return null; try { return new RegExp(s, 'i'); } catch { return null; } }

// A pack from a file or another team: unknown keys are dropped, numbers are clamped, regexes must compile.
function cleanPack(raw) {
  const p = raw && typeof raw === 'object' ? raw : {}, rules = {}, templates = {};
  for (const [id, def] of Object.entries(CORE_RULES)) {
    const r = (p.rules && typeof p.rules[id] === 'object' && p.rules[id]) || {};
    const out = { ...def, level: LEVELS.includes(r.level) ? r.level : def.level, severity: SEVERITY.includes(r.severity) ? r.severity : def.severity, after: num(r.after, 0, 1440, def.after) };
    // Showing a question to the owner is all a rule may do with it: asking can never be "suggest".
    if (id === 'asking' && out.level === 'suggest') out.level = 'notify';
    if ('below' in def) out.below = num(r.below, 1, 90, def.below);
    if ('repeats' in def) out.repeats = num(r.repeats, 2, 20, def.repeats);
    if ('cpu' in def) { out.cpu = num(r.cpu, 10, 100, def.cpu); out.ram = num(r.ram, 10, 100, def.ram); }
    if ('template' in def) out.template = typeof r.template === 'string' && /^[\w-]{1,32}$/.test(r.template) ? r.template : def.template;
    rules[id] = out;
  }
  const t = { ...CORE_TEMPLATES, ...(p.templates && typeof p.templates === 'object' ? p.templates : {}) };
  for (const [k, v] of Object.entries(t)) if (/^[\w-]{1,32}$/.test(k) && typeof v === 'string' && v.trim() && v.length <= 1000 && !/[\x00-\x09\x0b-\x1f\x7f]/.test(v)) templates[k] = v;
  const custom = (Array.isArray(p.custom) ? p.custom : []).filter((c) => c && /^[\w-]{1,40}$/.test(c.id || '') && safeRegex(c.match) && typeof c.title === 'string').slice(0, 30).map((c) => ({
    id: c.id, title: str(c.title, 120), match: c.match, severity: SEVERITY.includes(c.severity) ? c.severity : 'warn',
    level: c.level === 'suggest' && templates[c.template] ? 'suggest' : c.level === 'off' ? 'off' : 'notify',
    after: num(c.after, 0, 1440, 0), ...(templates[c.template] ? { template: c.template } : {}),
  }));
  return { name: str(p.name, 60) || 'core', version: num(p.version, 1, 9999, 1), rules, templates, custom };
}

function tail(lines, n) { return (lines || []).slice(-n).filter((l) => l && !CHROME.test(l)); }
function repeated(lines, need) {
  const counts = new Map();
  for (const l of tail(lines, 24)) { const k = l.trim(); if (k.length < 12) continue; counts.set(k, (counts.get(k) || 0) + 1); }
  let best = 0; for (const c of counts.values()) best = Math.max(best, c); return best >= need ? best : 0;
}
function isAgent(s) { return AGENT.test(s.cmd || '') || !!s.aiTool; }

// Findings for one machine. `memo` carries what one snapshot cannot show (which sessions ran an agent, when a rule first held).
// Returns [{ key, rule, server, session, severity, level, since, params, template? }]; since = seconds the condition has held.
function evaluate({ server, snapshot, online, lost, pack, memo, now, nudges }) {
  const P = pack || DEFAULT_PACK, R = P.rules, out = [], seen = new Set();
  memo.first ||= {}; memo.agents ||= {};
  // `held`: how long the screen itself has stayed this way (seconds), so a restart of TERMNEST does not reset the clock.
  function hit(rule, session, params, def, extraKey, held) {
    const cfg = def || R[rule]; if (!cfg || cfg.level === 'off') return;
    const key = server + '/' + (session || '') + '/' + rule + (extraKey ? ':' + extraKey : '');
    seen.add(key); const first = memo.first[key] ||= now, since = Math.max(Math.round((now - first) / 1000), Math.round(held || 0));
    if (since < (cfg.after || 0) * 60) return;
    const f = { key, rule, server, session: session || '', severity: cfg.severity, level: cfg.level, since, params: params || [] };
    if (cfg.level === 'suggest' && cfg.template && P.templates[cfg.template]) f.template = cfg.template;
    out.push(f);
  }
  if (!online) hit('offline', '', []);
  for (const name of lost || []) hit('lost', name, []);
  const snap = online ? snapshot : null;
  if (snap) {
    const o = R.overload, cpu = snap.cpu, ram = snap.ram;
    if ((Number.isFinite(cpu) && cpu >= o.cpu) || (Number.isFinite(ram) && ram >= o.ram)) hit('overload', '', [Number.isFinite(cpu) ? cpu : '—', Number.isFinite(ram) ? ram : '—']);
    for (const s of snap.sessions || []) {
      const id = s.name + '/' + (s.created || ''), lines = s.lines || [], last = tail(lines, 10).join('\n');
      const agent = isAgent(s);
      if (agent) memo.agents[id] = now;
      if (s.dead || (SHELL.test(s.cmd || '') && memo.agents[id])) { hit('exited', s.name, [s.exitStatus == null ? '' : s.exitStatus]); continue; }
      if (s.state === 'wait' && s.asking) { hit('asking', s.name, [], null, '', s.activityAge); continue; }
      if (agent && QUOTA.test(last)) { hit('quota', s.name, []); continue; }
      if (agent && s.state !== 'run' && ERROR.test(last)) hit('error', s.name, [(tail(lines, 10).filter((l) => ERROR.test(l)).pop() || '').trim().slice(0, 120)], null, '', s.activityAge);
      const ctx = agent && CONTEXT.exec(tail(lines, 6).join('\n'));
      if (ctx) { const pct = Number(ctx[1] || ctx[2] || ctx[3]); if (pct <= R.context.below) hit('context', s.name, [pct]); }
      if (agent && s.state === 'run') { const n = repeated(lines, R.loop.repeats); if (n) hit('loop', s.name, [n]); }
      if (agent && s.state === 'wait' && !s.asking) {
        const idle = Math.max(s.activityAge || 0, 0);
        if (idle >= R.dormant.after * 60) hit('dormant', s.name, [Math.round(idle / 60)], { ...R.dormant, after: 0 }, '', idle);
        else hit('finished', s.name, [], null, '', idle);
      }
      for (const c of P.custom || []) { const re = safeRegex(c.match); if (re && re.test(last)) hit('custom', s.name, [c.title], c, c.id); }
    }
    // A sent message that did not move the session: say so once, never send it again on our own.
    for (const n of nudges || []) {
      if (n.server !== server || n.verified !== false) continue;
      if (now - n.at > 6 * 3600 * 1000) continue;
      hit('unheard', n.session, [n.template || ''], { ...R.unheard, after: 0 }, String(n.at));
    }
  }
  for (const k of Object.keys(memo.first)) if (k.startsWith(server + '/') && !seen.has(k)) delete memo.first[k];
  for (const k of Object.keys(memo.agents)) if (now - memo.agents[k] > 24 * 3600 * 1000) delete memo.agents[k];
  return out;
}

// Did a sent message land? True once the session shows activity after the send; false after `waitMin` with none.
function verify(nudge, session, now, waitMin) {
  if (nudge.verified != null) return nudge.verified;
  if (!session) return now - nudge.at > waitMin * 60000 ? false : null;
  const activeAt = now - (session.activityAge || 0) * 1000;
  if (session.state === 'run' || activeAt > nudge.at + 1500) return true;
  return now - nudge.at > waitMin * 60000 ? false : null;
}

// Whether a message may be typed into this session now: never into a pending question, never into a plain shell.
function canSend(session) {
  if (!session) return 'gone';
  if (session.asking) return 'asking';
  if (session.dead || !isAgent(session)) return 'no-agent';
  if (session.state === 'run') return 'busy';
  return '';
}

module.exports = { DEFAULT_PACK, CORE_RULES, CORE_TEMPLATES, LEVELS, cleanPack, evaluate, verify, canSend };
