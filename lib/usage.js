'use strict';
const { tr } = require('./i18n-server');
const { shq } = require('./parse');

// Cost and per-model token usage come from ccusage run on the host that owns each AI account, so the
// numbers match what the owner sees in a terminal and prices are never hard-coded here.
const VERSION = /^\d+\.\d+\.\d+$/.test(process.env.TW_CCUSAGE_VERSION || '') ? process.env.TW_CCUSAGE_VERSION : '20.0.48';
const TTL_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 180000;
const MAX_DAYS = 366;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CONFIG_ENV = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' };

function dayMs(day) { return Date.parse(day + 'T00:00:00Z'); }
function validRange(from, to) {
  if (!DAY.test(from || '') || !DAY.test(to || '')) throw new Error('Invalid range');
  const a = dayMs(from), b = dayMs(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a > b || (b - a) / 86400000 >= MAX_DAYS) throw new Error('Invalid range');
  return { from, to };
}

// "~/" is expanded by the remote shell, so it cannot sit inside the quotes.
function dirExpr(dir) { return dir.startsWith('~/') ? `"$HOME"/${shq(dir.slice(2))}` : shq(dir); }

function usageScript(cfg, from, to, zone) {
  const env = CONFIG_ENV[cfg.tool];
  if (!env) throw new Error('Invalid tool');
  validRange(from, to);
  const compact = (d) => d.replace(/-/g, '');
  return `command -v npx >/dev/null 2>&1 || { echo NO_NPX; exit 0; }
${env}=${dirExpr(cfg.directory)} npx -y ccusage@${VERSION} ${cfg.tool} daily --json --breakdown --since ${compact(from)} --until ${compact(to)} --timezone ${shq(zone)} --no-color 2>/dev/null`;
}

const num = (x) => (Number.isFinite(x) && x >= 0 ? x : 0);
function modelRow(model, m, cost) {
  const row = { model, input: num(m.inputTokens), output: num(m.outputTokens), cacheCreate: num(m.cacheCreationTokens), cacheRead: num(m.cacheReadTokens), cost };
  row.total = row.input + row.output + row.cacheCreate + row.cacheRead;
  return row;
}

// Claude reports a cost per model; Codex reports one per day only, so its model rows carry cost null.
function normalize(tool, json) {
  const days = Array.isArray(json?.daily) ? json.daily : [];
  return days.filter((d) => DAY.test(d?.date || '')).map((d) => {
    if (tool === 'claude') {
      const models = (Array.isArray(d.modelBreakdowns) ? d.modelBreakdowns : []).map((m) => modelRow(String(m.modelName || 'unknown').replace(/^claude-/, ''), m, num(m.cost)));
      return { day: d.date, cost: num(d.totalCost), models };
    }
    const models = Object.entries(d.models && typeof d.models === 'object' ? d.models : {}).map(([name, m]) => modelRow(name, m || {}, null));
    return { day: d.date, cost: num(d.costUSD), models };
  }).sort((a, b) => a.day.localeCompare(b.day));
}

function parseReport(out) {
  const text = String(out || '');
  if (text.trim() === 'NO_NPX') return { error: tr('srv.usage.may_nay_chua_co_npx') };
  const start = text.indexOf('{');
  if (start < 0) return { error: tr('srv.usage.ccusage_khong_tra_du_lieu') };
  try { return { json: JSON.parse(text.slice(start)) }; }
  catch { return { error: tr('srv.usage.khong_doc_duoc_ket_qua') }; }
}

function labelOf(cfg, emails) {
  return cfg.nickname || emails?.get(cfg.id) || cfg.directory.replace(/[\\/]+$/, '').split(/[\\/]/).pop().replace(/^\./, '') || cfg.id;
}

class UsageService {
  constructor({ now = Date.now, ttl = TTL_MS } = {}) {
    this.now = now; this.ttl = ttl;
    this.cache = new Map(); this.inflight = new Map(); this.hostQueue = new Map();
  }

  // One ccusage at a time per host: parallel runs on one machine only compete for the same logs.
  queue(hostId, task) {
    const run = (this.hostQueue.get(hostId) || Promise.resolve()).catch(() => {}).then(task);
    this.hostQueue.set(hostId, run);
    return run;
  }

  async one(backend, cfg, from, to, zone, refresh) {
    const key = [cfg.hostId, cfg.tool, cfg.directory, from, to, zone].join('|');
    const hit = this.cache.get(key);
    if (!refresh && hit && this.now() - hit.at < this.ttl) return hit.value;
    if (this.inflight.has(key)) return this.inflight.get(key);
    const job = this.queue(cfg.hostId, async () => {
      let value;
      try {
        const out = await backend.exec(`sh -c ${shq(usageScript(cfg, from, to, zone))}`, TIMEOUT_MS, 8 * 1024 * 1024);
        const parsed = parseReport(out.out);
        value = parsed.error ? { error: parsed.error } : { days: normalize(cfg.tool, parsed.json) };
      } catch (e) {
        value = { error: /timed? ?out/i.test(e.message) ? tr('srv.usage.ccusage_chay_qua_lau') : tr('srv.usage.khong_chay_duoc_ccusage_tren') };
      }
      const stale = this.cache.get(key);
      // A failed refresh keeps showing the last good numbers, marked stale.
      if (value.error && stale?.value.days) value = { ...stale.value, stale: true, error: value.error };
      else this.cache.set(key, { at: this.now(), value });
      return value;
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, job);
    return job;
  }

  async get(backendOf, accounts, { from, to, zone = 'UTC', refresh = false, emails = new Map() }) {
    validRange(from, to);
    const rows = await Promise.all(accounts.map(async (cfg) => {
      const base = { id: cfg.id, tool: cfg.tool, hostId: cfg.hostId, label: labelOf(cfg, emails) };
      const backend = backendOf(cfg.hostId);
      if (!backend) return { ...base, hostName: '', error: tr('srv.server.may_chu_chua_ket_noi'), days: [] };
      const value = await this.one(backend, cfg, from, to, zone, refresh);
      return { ...base, hostName: backend.cfg?.name || backend.cfg?.host || '', days: value.days || [], error: value.error || '', stale: !!value.stale };
    }));
    return { at: this.now(), from, to, zone, accounts: rows };
  }
}

module.exports = { UsageService, usageScript, normalize, parseReport, validRange, labelOf, VERSION, MAX_DAYS };
