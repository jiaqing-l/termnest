'use strict';
const { runOnHost } = require('../file-viewer');

// Rule watchdog: a periodic process scan on each host against declarative rules. It only reports; freezing, resuming or
// stopping a process is an explicit click, and only for a pid the latest scan flagged with the same command line.
// Limit: it samples every ~20 s, so a process that starts and exits between two scans is never seen.
const EVERY_MS = 20000;
const MARK = '__tw_watchdog__';
const DEFAULT_RULES = [
  { id: 'bare-build', severity: 'warn', title: 'dotnet build/test chạy trực tiếp, dễ làm treo máy', argsRegex: '(^|/)dotnet\\s+(build|publish|test|msbuild)\\b', unlessRegex: 'crew-build|xqa' },
  { id: 'ef-update', severity: 'urgent', title: 'Migration/DbMigrator đang chạy: chỉ được dùng DB cá nhân', argsRegex: 'dotnet\\s+ef\\s+database\\s+update|DbMigrator' },
  { id: 'big-memory', severity: 'warn', title: 'Một tiến trình dùng trên 6 GB RAM', rssMbOver: 6000 },
  { id: 'hot-cpu', severity: 'warn', title: 'Một tiến trình ngốn CPU quá lâu (trên 350% suốt hơn 2 phút)', cpuOver: 350, minAgeSec: 120 },
  { id: 'many-compilers', severity: 'warn', title: 'Quá nhiều tiến trình biên dịch cùng lúc', countRegex: '(^|/)(csc|VBCSCompiler|MSBuild)(\\.dll|\\s|$)|dotnet\\s.*(csc|MSBuild)', maxCount: 6 },
];
const ACTIONS = { freeze: 'STOP', resume: 'CONT', stop: 'TERM' };

function cleanRules(list) {
  if (!Array.isArray(list)) return DEFAULT_RULES;
  const re = (s) => typeof s === 'string' && s.length <= 200;
  return list.filter((r) => r && /^[\w-]{1,40}$/.test(r.id || '') && ['info', 'warn', 'urgent'].includes(r.severity) && typeof r.title === 'string').slice(0, 20).map((r) => ({
    id: r.id, severity: r.severity, title: r.title.slice(0, 160),
    ...(re(r.argsRegex) ? { argsRegex: r.argsRegex } : {}), ...(re(r.unlessRegex) ? { unlessRegex: r.unlessRegex } : {}), ...(re(r.countRegex) ? { countRegex: r.countRegex } : {}),
    ...(Number.isFinite(r.rssMbOver) ? { rssMbOver: r.rssMbOver } : {}), ...(Number.isFinite(r.cpuOver) ? { cpuOver: r.cpuOver } : {}),
    ...(Number.isFinite(r.minAgeSec) ? { minAgeSec: r.minAgeSec } : {}), ...(Number.isFinite(r.maxCount) ? { maxCount: r.maxCount } : {}),
  }));
}

// Self-contained so it runs on the session's host (see lib/file-viewer.js runOnHost). Parses `ps` output; never executes anything it matches.
function scanRuntime() {
  const cp = require('child_process');
  return async function scan({ rules, mark, signal }) {
    const text = cp.execFileSync('ps', ['-eo', 'pid=,ppid=,pcpu=,rss=,etime=,args='], { encoding: 'utf8', timeout: 8000, maxBuffer: 16 * 1024 * 1024 });
    const procs = [];
    for (const line of text.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s+(.*)$/.exec(line);
      if (!m || +m[1] === process.pid || m[9].includes(mark)) continue;
      // etime is [[dd-]hh:]mm:ss on both Linux and macOS (etimes is Linux only).
      const age = (+m[5] || 0) * 86400 + (+m[6] || 0) * 3600 + +m[7] * 60 + +m[8];
      procs.push({ pid: +m[1], cpu: +m[3], rssMb: Math.round(+m[4] / 1024), age, args: m[9].slice(0, 300) });
    }
    const safe = (s) => { try { return new RegExp(s); } catch { return null; } };
    const found = [];
    for (const r of rules) {
      const args = r.argsRegex && safe(r.argsRegex), unless = r.unlessRegex && safe(r.unlessRegex), count = r.countRegex && safe(r.countRegex);
      if (r.argsRegex && !args) continue;
      if (count) {
        const hit = procs.filter((p) => count.test(p.args));
        if (hit.length > (r.maxCount || 6)) hit.slice(0, 10).forEach((p) => found.push({ rule: r.id, severity: r.severity, title: r.title + ' (' + hit.length + ')', ...p }));
        continue;
      }
      for (const p of procs) {
        if (args && !args.test(p.args)) continue;
        if (unless && unless.test(p.args)) continue;
        if (r.rssMbOver != null && !(p.rssMb > r.rssMbOver)) continue;
        if (r.cpuOver != null && !(p.cpu > r.cpuOver && p.age >= (r.minAgeSec || 0))) continue;
        if (!args && r.rssMbOver == null && r.cpuOver == null) continue;
        found.push({ rule: r.id, severity: r.severity, title: r.title, ...p });
      }
    }
    if (signal && signal.pid) {
      const target = procs.find((p) => p.pid === signal.pid && p.args === signal.args);
      if (!target) return { sent: false };
      try { process.kill(signal.pid, 'SIG' + signal.name); return { sent: true, found }; } catch { return { sent: false }; }
    }
    return { found: found.slice(0, 50) };
  };
}

module.exports = {
  name: 'watchdog', DEFAULT_RULES, cleanRules, scanRuntime, ACTIONS,
  register(host) {
    const state = new Map(); // serverId -> { at, found, error }
    const running = new Set();
    const rules = () => cleanRules(host.settings.get().rules);
    async function scan(backend, id, extra) {
      return runOnHost(backend, scanRuntime, { rules: rules(), mark: MARK, ...extra });
    }
    host.onSnapshot((remote) => {
      const id = remote.cfg && remote.cfg.id; if (!id || running.has(id) || remote.mode === 'powershell') return;
      const last = state.get(id); if (last && Date.now() - last.at < EVERY_MS) return;
      running.add(id);
      scan(remote, id).then((r) => state.set(id, { at: Date.now(), found: r.found || [] }))
        .catch((e) => state.set(id, { at: Date.now(), found: (last && last.found) || [], error: e.message }))
        .finally(() => running.delete(id));
    });
    host.route('GET', '/data', ({ res }) => {
      const servers = {}; for (const [id, s] of state) servers[id] = s;
      host.send(res, 200, { servers, rules: rules().map((r) => ({ id: r.id, severity: r.severity, title: r.title })) });
    });
    host.route('POST', '/act', async ({ req, res }) => {
      const b = await host.readJson(req), backend = host.backendOf(b.server || ''), known = state.get(b.server || '');
      const hit = known && known.found.find((f) => f.pid === b.pid && f.args === b.args);
      if (!backend || !ACTIONS[b.action] || !hit) { host.fail(res, 409, 'Tiến trình này không còn trong danh sách vi phạm.'); return; }
      try {
        const r = await scan(backend, b.server, { signal: { pid: b.pid, args: b.args, name: ACTIONS[b.action] } });
        host.log(`${b.action} pid ${b.pid} (${hit.rule}) sent=${!!r.sent}`);
        if (r.found) state.set(b.server, { at: Date.now(), found: r.found });
        host.send(res, 200, { sent: !!r.sent });
      } catch (e) { host.fail(res, 400, e.message); }
    });
  },
};
