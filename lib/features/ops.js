'use strict';
const { tr } = require('../i18n-server');
const { keysScript } = require('../keys');
const ops = require('../ops');

// "Vận hành": the generic Agent Ops board. Rules live in lib/ops.js; this file keeps the per-machine memory, the log of sent
// messages and the routes. Settings (the rule pack) are stored in the vault like every other feature's settings.
// The server's browser-independent snapshot poll is once a minute; allow one poll plus bounded scheduling slack.
const LOG_MAX = 200, VERIFY_MIN = 3, TICK_MS = 15000, FRESH_MS = 90000, MAX_ATTEMPTS = 3;
let currentRuntime = { monitoring: false, error: false, pending: 0 };
let readRuntime = () => currentRuntime;
let stopRuntime = () => {};
const failure = code => Object.assign(new Error(code), { code });

module.exports = {
  name: 'ops',
  runtimeStatus: () => ({ ...readRuntime() }),
  stop: () => stopRuntime(),
  register(host, clock = {}) {
    const nowOf = clock.now || Date.now, interval = clock.setInterval || setInterval;
    const memo = new Map(), findings = new Map(), dismissed = new Set(), inflight = new Set();
    let stopped = false, persistenceBlocked = false, lastTick = 0, errorCode = '';
    const settings = () => { try { return host.settings.get(); } catch { return null; } };
    const logOf = () => Array.isArray(settings()?.log) ? settings().log.slice(-LOG_MAX) : [];
    const pack = () => ops.cleanPack(settings()?.pack);
    const defaults = (lang) => Object.fromEntries(Object.keys(ops.CORE_TEMPLATES).map((k) => [k, tr('ops.tpl.' + k, null, lang)]));
    const builtIn = (k, v) => v === ops.CORE_TEMPLATES[k] || ['vi', 'en'].some((l) => defaults(l)[k] === v);
    function save(patch) {
      const before = settings();
      if (!before || persistenceBlocked) throw failure('OPS_PERSISTENCE_FAILED');
      try { host.settings.set({ ...before, ...patch }); }
      catch {
        // The feature host changes vault memory before fsync. Restore its prior value on a failed save, then fail closed.
        try { host.settings.set(before); } catch { /* The disk is unavailable; no more sends in this process. */ }
        persistenceBlocked = true; errorCode = 'OPS_PERSISTENCE_FAILED';
        throw failure(errorCode);
      }
    }
    const session = (r, name) => (r?.snapshot?.sessions || []).find((s) => s.name === name);
    const online = r => !!(r?.ready && r.lastPoll && nowOf() >= r.lastPoll && nowOf() - r.lastPoll < FRESH_MS);
    const keyOf = (r, name) => JSON.stringify([r.cfg.id, name]);
    const identity = (r, s) => JSON.stringify([r.snapshot?.bootId || r.boot || '', s?.created, s?.aiPid || '', s?.aiSessionId || '', s?.aiStatus?.startedAt || '']);
    const validIdle = s => s && (typeof s.created === 'string' && s.created.length > 0 || Number.isFinite(s.created)) &&
      Number.isFinite(s.aiStatus?.at) && s.aiStatus.at > 0 && s.aiStatus.at <= nowOf();
    const intents = () => settings()?.intents || {};
    function store(record) {
      const next = { ...intents(), [record.key]: record };
      const log = logOf().filter(n => n.id !== record.id).concat(record).slice(-LOG_MAX);
      const rateHistory = (settings()?.rateHistory || []).filter(n => nowOf() - n.at < 3600000 && n.id !== record.id);
      if (!['failed', 'cancelled', 'exhausted'].includes(record.delivery)) rateHistory.push({ id: record.id, at: record.at, server: record.server, session: record.session, why: record.why });
      save({ intents: next, log, rateHistory });
    }
    function state() {
      return { monitoring: !stopped && !!settings() && !persistenceBlocked, error: !!errorCode, pending: inflight.size,
        code: errorCode || (stopped ? 'OPS_STOPPED' : settings() ? 'OPS_MONITORING' : 'OPS_LOCKED'), lastTick, quota: 'unknown' };
    }
    readRuntime = state;
    const publish = () => { currentRuntime = state(); };
    function observe(r) {
      const id = r.cfg?.id; if (!id || stopped || !settings()) { publish(); return; }
      const now = nowOf(); lastTick = now;
      // A process that died between intent and acknowledgement cannot know whether input landed. Never replay it.
      for (const record of Object.values(intents())) {
        if (record.server !== id || inflight.has(record.key)) continue;
        if (record.delivery === 'pending') store({ ...record, delivery: 'uncertain', code: 'OPS_DELIVERY_UNCERTAIN' });
      }
      for (const n of logOf()) {
        if (n.server !== id || (n.delivery && n.delivery !== 'delivered') || n.verified != null || !online(r)) continue;
        const s = session(r, n.session);
        if (!s || (n.identity && n.identity !== identity(r, s))) continue;
        const v = ops.verify(n, s, now, VERIFY_MIN);
        if (v != null) {
          const updated = { ...n, verified: v, responded: v, progress: 'unknown', code: v ? 'OPS_AGENT_RESPONDED' : 'OPS_NO_RESPONSE' };
          // Do not overwrite a newer idle period's reservation when verifying an older log entry.
          const records = { ...intents() };
          if (n.key && records[n.key]?.id === n.id) records[n.key] = updated;
          save({ intents: records, log: logOf().map(x => n.id ? (x.id === n.id ? updated : x) : (x.server === n.server && x.session === n.session && x.at === n.at ? updated : x)) });
        }
      }
      const m = memo.get(id) || {}; memo.set(id, m);
      const list = ops.evaluate({ server: id, snapshot: r.snapshot, online: online(r), lost: (r.lost || []).map(s => s.name || s), pack: pack(), memo: m, now, nudges: logOf() });
      for (const f of list) if (f.template) {
        const s = session(r, f.session);
        f.identity = identity(r, s); f.idleAt = s?.aiStatus?.at;
      }
      for (const n of Object.values(intents())) if (n.server === id && ['uncertain', 'exhausted'].includes(n.delivery)) {
        list.push({ key: id + '/' + n.session + '/delivery', server: id, session: n.session, rule: 'unheard', severity: 'urgent', level: 'notify', source: 'status', params: [], code: n.code });
      }
      findings.set(id, list);
      for (const f of list) {
        if (f.level !== 'auto' || ops.autoGate(f, session(r, f.session), pack(), logOf().filter(n => !n.delivery), now)) continue;
        deliver(r, f, 'auto').catch(e => { if (!['OPS_SEND_GATED', 'OPS_ONCE', 'OPS_INFLIGHT', 'OPS_RETRY_WAIT'].includes(e.code)) host.log(e.code || 'OPS_DELIVERY_FAILED'); });
      }
      for (const k of [...dismissed]) if (k.startsWith(id + '/') && !list.some(f => f.key === k)) dismissed.delete(k);
      publish();
    }
    function run(r) {
      try { observe(r); }
      catch { errorCode = 'OPS_PERSISTENCE_FAILED'; publish(); }
    }
    async function deliver(r, f, why) {
      const key = keyOf(r, f.session);
      if (stopped || persistenceBlocked || !settings() || !online(r)) throw failure('OPS_SEND_GATED');
      if (inflight.has(key)) throw failure('OPS_INFLIGHT');
      const s = session(r, f.session), now = nowOf();
      if (ops.canSend(s) || !validIdle(s)) throw failure('OPS_SEND_GATED');
      const stamp = identity(r, s), idleAt = s.aiStatus.at, previous = intents()[key];
      if (f.identity !== stamp || f.idleAt !== idleAt) throw failure('OPS_SEND_GATED');
      const same = previous && previous.identity === stamp && previous.idleAt === idleAt;
      if (same && previous.delivery !== 'failed') throw failure('OPS_ONCE');
      if (previous && previous.identity === stamp && previous.idleAt > idleAt) throw failure('OPS_ONCE');
      // Even an unacknowledged send remains reserved across a subsequent idle timestamp. Only a known failure may retry.
      if (previous && ['pending', 'uncertain', 'exhausted'].includes(previous.delivery) && previous.identity === stamp) throw failure('OPS_ONCE');
      if (same && now < previous.retryAt) throw failure('OPS_RETRY_WAIT');
      const p = pack(), text = ops.withTemplates(p, defaults()).templates[f.template];
      const rule = p.rules[f.rule];
      if (!text || !rule || !['auto', 'suggest'].includes(rule.level) || rule.template !== f.template || now - idleAt < rule.after * 60000) throw failure('OPS_SEND_GATED');
      if (why === 'auto') {
        const recent = (settings()?.rateHistory || []).filter(n => n.why === 'auto' && n.server === r.cfg.id && n.session === f.session && now - n.at < 3600000);
        if (ops.quiet(p.auto, new Date(now)) || recent.length >= p.auto.perHour || p.rules[f.rule]?.level !== 'auto') throw failure('OPS_SEND_GATED');
      }
      inflight.add(key); publish();
      let record = { id: same ? previous.id : require('node:crypto').randomUUID(), key, at: now, server: r.cfg.id,
        serverName: r.snapshot?.hostname || r.cfg.name || r.cfg.host, session: f.session, identity: stamp, idleAt,
        rule: f.rule, template: f.template, verified: null, responded: null, progress: 'unknown', why,
        attempts: same ? previous.attempts + 1 : 1, delivery: 'pending', code: 'OPS_DELIVERY_PENDING' };
      try {
        store(record); // Durable intent, before any side effect or await.
        const latest = session(r, f.session);
        if (stopped || !online(r) || host.backendOf(r.cfg.id) !== r || ops.canSend(latest) || !validIdle(latest) || identity(r, latest) !== stamp || latest.aiStatus.at !== idleAt) {
          record = { ...record, delivery: 'cancelled', code: 'OPS_SEND_GATED' }; store(record);
          throw failure('OPS_SEND_GATED');
        }
        let result;
        try {
          if (r.mode === 'powershell') {
            await r.keysPlain(f.session, text.replace(/\n/g, ' '), true);
            result = { code: 0 };
          } else {
            // Check tmux creation identity at execution time too: SSH channel queues may outlive a replaced pane.
            const { shq } = require('../parse');
            const target = shq(`=${f.session}:`);
            const script = `if [ "$(tmux display-message -p -t ${target} '#{session_created}' 2>/dev/null)" != ${shq(String(latest.created))} ]; then printf '%s' TW_OPS_NOT_SENT; exit 75; fi; ` + keysScript(`=${f.session}:`, text, true);
            result = await r.exec(script);
          }
        } catch {
          record = { ...record, delivery: 'uncertain', code: 'OPS_DELIVERY_UNCERTAIN' }; store(record);
          throw failure(record.code);
        }
        if (result?.code !== 0) {
          const failed = result?.code === 75 && result?.out === 'TW_OPS_NOT_SENT';
          record = { ...record, delivery: failed ? (record.attempts >= MAX_ATTEMPTS ? 'exhausted' : 'failed') : 'uncertain',
            code: failed ? 'OPS_NOT_SENT' : 'OPS_DELIVERY_UNCERTAIN', retryAt: nowOf() + Math.min(60000, 15000 * 2 ** (record.attempts - 1)) };
          store(record); throw failure(record.code);
        }
        record = { ...record, at: nowOf(), delivery: 'delivered', code: 'OPS_DELIVERED' }; store(record);
        host.log('OPS_DELIVERED');
        return record;
      } finally { inflight.delete(key); publish(); }
    }
    host.onSnapshot(r => run(r));
    const timer = interval(() => { for (const r of host.remotes()) run(r); publish(); }, TICK_MS);
    timer.unref?.();
    stopRuntime = () => { stopped = true; (clock.clearInterval || clearInterval)(timer); publish(); };
    publish();
    host.route('GET', '/runtime', ({ res }) => host.send(res, 200, state()));

    host.route('GET', '/board', ({ res }) => {
      const remotes = host.remotes(), servers = [];
      for (const r of remotes) {
        if (!r.cfg) continue;
        // A machine that stopped answering sends no snapshot, so judge it here too.
        run(r);
        const snap = r.snapshot || {}, list = (findings.get(r.cfg.id) || []).filter((f) => !dismissed.has(f.key));
        servers.push({ id: r.cfg.id, name: (r.snapshot && r.snapshot.hostname) || r.cfg.name || r.cfg.host || r.cfg.id, online: online(r), cpu: snap.cpu, ram: snap.ram,
          sessions: (snap.sessions || []).map((s) => ({ name: s.name, cmd: s.cmd, agent: /claude|codex|^\d+\.\d+\.\d+$/i.test(s.cmd || '') || !!s.aiTool, ai: s.aiStatus || null,
            // Agents running in the background under this session (codex exec, claude -p …), from the process table.
            bgAgents: (snap.workers || []).filter((w) => w.owner && w.owner.name === s.name && w.owner.created === s.created).map((w) => ({ kind: w.kind || '', task: w.task || '', track: w.track || '', elapsed: w.elapsed || 0 })) })),
          bg: (snap.bgAgents || []).map((b) => ({ name: b.name, status: b.status, at: b.at })), jobs: snap.jobs || [], findings: list });
      }
      host.send(res, 200, { servers, log: logOf().slice(-50).reverse(), pack: ops.withTemplates(pack(), defaults()), dismissed: dismissed.size, dismissedKeys: [...dismissed].filter((k) => k.startsWith('acct/')) });
    });

    host.route('POST', '/nudge', async ({ req, res }) => {
      const b = await host.readJson(req), r = host.backendOf(String(b.server || ''));
      const f = (findings.get(String(b.server || '')) || []).find((x) => x.key === b.key);
      if (!r || !f || !f.template || (f.level !== 'suggest' && f.level !== 'auto')) { host.fail(res, 409, tr('srv.ops.goi_y_da_het'), { code: 'OPS_FINDING_EXPIRED' }); return; }
      const s = session(r, f.session), why = ops.canSend(s);
      if (why) { host.fail(res, 409, tr('srv.ops.khong_gui_' + why.replace('-', '_')), { code: 'OPS_SEND_GATED' }); return; }
      try { await deliver(r, f, 'manual'); } catch (e) { host.fail(res, 409, tr('srv.server.khong_gui_duoc_noi_dung'), { code: e.code || 'OPS_DELIVERY_FAILED' }); return; }
      host.send(res, 200, { ok: true, delivery: 'delivered', responded: null, progress: 'unknown', code: 'OPS_DELIVERED' });
    });

    host.route('POST', '/dismiss', async ({ req, res }) => {
      const b = await host.readJson(req);
      if (b.all) dismissed.clear(); else if (typeof b.key === 'string' && b.key.length < 400) dismissed.add(b.key);
      host.send(res, 200, { ok: true });
    });

    host.route('GET', '/pack', ({ res }) => host.send(res, 200, ops.withTemplates(pack(), defaults())));
    host.route('POST', '/pack', async ({ req, res }) => {
      const b = await host.readJson(req), clean = ops.cleanPack(b.reset ? {} : b.pack);
      // A built-in text sent back unchanged stays built-in, so it keeps following the language the person picks.
      for (const [k, v] of Object.entries(clean.templates)) if (builtIn(k, v)) delete clean.templates[k];
      save({ pack: clean }); for (const m of memo.values()) m.first = {};
      host.send(res, 200, clean);
    });
    host.route('POST', '/log/clear', ({ res }) => { save({ log: [] }); host.send(res, 200, { ok: true }); });
    return { run, stop: stopRuntime, status: state };
  },
};
