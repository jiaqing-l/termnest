'use strict';
const { tr } = require('../i18n-server');
const { keysScript } = require('../keys');
const ops = require('../ops');

// "Vận hành": the generic Agent Ops board. Rules live in lib/ops.js; this file keeps the per-machine memory, the log of sent
// messages and the routes. Settings (the rule pack) are stored in the vault like every other feature's settings.
const LOG_MAX = 200, VERIFY_MIN = 3;

module.exports = {
  name: 'ops',
  register(host) {
    const memo = new Map(), findings = new Map(), dismissed = new Set();
    // Settings live in the vault, which is still locked while features load: read them on first use.
    const settings = () => { try { return host.settings.get(); } catch { return {}; } };
    let logCache = null;
    const logOf = () => {
      if (logCache) return logCache;
      let got; try { got = host.settings.get(); } catch { return []; }
      return (logCache = Array.isArray(got.log) ? got.log.slice(-LOG_MAX) : []);
    };
    const pack = () => ops.cleanPack(settings().pack);
    // Built-in nudge texts in a given language (the request's by default); a team's own templates are never translated.
    const defaults = (lang) => Object.fromEntries(Object.keys(ops.CORE_TEMPLATES).map((k) => [k, tr('ops.tpl.' + k, null, lang)]));
    const builtIn = (k, v) => v === ops.CORE_TEMPLATES[k] || ['vi', 'en'].some((l) => defaults(l)[k] === v);
    const save = (patch) => host.settings.set({ ...settings(), ...patch });
    const session = (r, name) => (r && r.snapshot && r.snapshot.sessions || []).find((s) => s.name === name);
    const online = (r) => !!(r && r.ready && r.lastPoll && Date.now() - r.lastPoll < 60000);

    function run(r) {
      const id = r.cfg && r.cfg.id; if (!id) return;
      const now = Date.now(); let changed = false;
      const log = logOf();
      for (const n of log) {
        if (n.server !== id || n.verified != null) continue;
        const v = ops.verify(n, session(r, n.session), now, VERIFY_MIN);
        if (v != null) { n.verified = v; changed = true; }
      }
      if (changed) save({ log });
      const m = memo.get(id) || {}; memo.set(id, m);
      const list = ops.evaluate({ server: id, snapshot: r.snapshot, online: online(r), lost: (r.lost || []).map((s) => s.name || s), pack: pack(), memo: m, now, nudges: log });
      findings.set(id, list);
      for (const k of [...dismissed]) if (k.startsWith(id + '/') && !list.some((f) => f.key === k)) dismissed.delete(k);
    }
    host.onSnapshot((r) => run(r));

    host.route('GET', '/board', ({ res }) => {
      const remotes = host.remotes(), servers = [];
      for (const r of remotes) {
        if (!r.cfg) continue;
        // A machine that stopped answering sends no snapshot, so judge it here too.
        if (!online(r)) run(r);
        const snap = r.snapshot || {}, list = (findings.get(r.cfg.id) || []).filter((f) => !dismissed.has(f.key));
        servers.push({ id: r.cfg.id, name: r.cfg.name || r.cfg.host || r.cfg.id, online: online(r), cpu: snap.cpu, ram: snap.ram,
          sessions: (snap.sessions || []).map((s) => ({ name: s.name, cmd: s.cmd, agent: /claude|codex|^\d+\.\d+\.\d+$/i.test(s.cmd || '') || !!s.aiTool, ai: s.aiStatus || null })),
          bg: (snap.bgAgents || []).map((b) => ({ name: b.name, status: b.status, at: b.at })), jobs: snap.jobs || [], findings: list });
      }
      host.send(res, 200, { servers, log: logOf().slice(-50).reverse(), pack: ops.withTemplates(pack(), defaults()), dismissed: dismissed.size });
    });

    host.route('POST', '/nudge', async ({ req, res }) => {
      const b = await host.readJson(req), r = host.backendOf(String(b.server || '')), p = pack();
      const f = (findings.get(String(b.server || '')) || []).find((x) => x.key === b.key);
      if (!r || !f || !f.template || f.level !== 'suggest') { host.fail(res, 409, tr('srv.ops.goi_y_da_het')); return; }
      const s = session(r, f.session), why = ops.canSend(s);
      if (why) { host.fail(res, 409, tr('srv.ops.khong_gui_' + why.replace('-', '_'))); return; }
      const text = ops.withTemplates(p, defaults()).templates[f.template];
      if (r.mode === 'powershell') r.keysPlain(f.session, text.replace(/\n/g, ' '), true);
      else { const out = await r.exec(keysScript(`=${f.session}:`, text, true)); if (out.code !== 0) { host.fail(res, 400, tr('srv.server.khong_gui_duoc_noi_dung')); return; } }
      const log = logOf(); log.push({ at: Date.now(), server: r.cfg.id, serverName: r.cfg.name || r.cfg.host, session: f.session, rule: f.rule, template: f.template, verified: null });
      logCache = log.slice(-LOG_MAX); save({ log: logCache });
      host.log(`nudge ${f.rule} -> ${f.session}`);
      host.send(res, 200, { ok: true });
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
    host.route('POST', '/log/clear', ({ res }) => { logCache = []; save({ log: [] }); host.send(res, 200, { ok: true }); });
  },
};
