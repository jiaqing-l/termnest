'use strict';
const { tr } = require('../i18n-server');
const { runOnHost } = require('../file-viewer');
const detect = require('../crew-detect');

// Rule watchdog: a periodic process scan on each host against declarative rules. It only reports; freezing, resuming or
// stopping a process is an explicit click, and only for a pid the latest scan flagged with the same command line.
// Limit: it samples every ~20 s, so a process that starts and exits between two scans is never seen.
const EVERY_MS = 20000;
const MARK = '__tw_watchdog__';
// A migration actually running: `dotnet ef database update`, or the DbMigrator program itself (its executable or .dll as
// the command). Building, restoring or testing the DbMigrator project is not a migration.
const MIGRATE_RE = 'dotnet\\s+ef\\s+database\\s+update|(^|/)HQSOFT\\.Xspire\\.DbMigrator(\\.dll)?(\\s|$)';
const MIGRATE_UNLESS = '(^|\\s|/)(build|restore|publish|test|pack|clean|msbuild)(\\s|$)|MSBuild\\.dll|VBCSCompiler|csc\\.dll|crew-build';
const OLD_MIGRATE_RE = 'dotnet\\s+ef\\s+database\\s+update|DbMigrator';
const DEFAULT_RULES = [
  { id: 'bare-build', severity: 'warn', title: tr('srv.watchdog.dotnet_build_test_chay_truc'), argsRegex: '(^|/)dotnet\\s+(build|publish|test|msbuild)\\b', unlessRegex: 'crew-build|xqa' },
  { id: 'ef-update', severity: 'urgent', title: tr('srv.watchdog.migration_dbmigrator_dang_chay_c'), argsRegex: MIGRATE_RE, unlessRegex: MIGRATE_UNLESS, sharedDbOnly: true },
  { id: 'big-memory', severity: 'warn', title: tr('srv.watchdog.mot_tien_trinh_dung_tren'), rssMbOver: 6000 },
  { id: 'hot-cpu', severity: 'warn', title: tr('srv.watchdog.mot_tien_trinh_ngon_cpu'), cpuOver: 350, minAgeSec: 120 },
  { id: 'many-compilers', severity: 'warn', title: tr('srv.watchdog.qua_nhieu_tien_trinh_bien'), countRegex: '(^|/)(csc|VBCSCompiler|MSBuild)(\\.dll|\\s|$)|dotnet\\s.*(csc|MSBuild)', maxCount: 6 },
];
const ACTIONS = { freeze: 'STOP', resume: 'CONT', stop: 'TERM' };
// .NET / Xspire-crew rules: active only on machines where the crew pack has seen a `_crew` workspace. Other teams get the
// generic memory / CPU rules alone.
const CREW_ONLY = new Set(['bare-build', 'ef-update', 'many-compilers']);

function cleanRules(list) {
  if (!Array.isArray(list)) return DEFAULT_RULES;
  const re = (s) => typeof s === 'string' && s.length <= 200;
  return list.filter((r) => r && /^[\w-]{1,40}$/.test(r.id || '') && ['info', 'warn', 'urgent'].includes(r.severity) && typeof r.title === 'string').slice(0, 20).map((r) => ({
    id: r.id, severity: r.severity, title: r.title.slice(0, 160),
    // A saved copy of the old built-in migration pattern (it also matched builds) is upgraded to the current one.
    ...(r.id === 'ef-update' && r.argsRegex === OLD_MIGRATE_RE ? { argsRegex: MIGRATE_RE, unlessRegex: MIGRATE_UNLESS } :
      { ...(re(r.argsRegex) ? { argsRegex: r.argsRegex } : {}), ...(re(r.unlessRegex) ? { unlessRegex: r.unlessRegex } : {}) }), ...(re(r.countRegex) ? { countRegex: r.countRegex } : {}),
    ...(Number.isFinite(r.rssMbOver) ? { rssMbOver: r.rssMbOver } : {}), ...(Number.isFinite(r.cpuOver) ? { cpuOver: r.cpuOver } : {}),
    ...(Number.isFinite(r.minAgeSec) ? { minAgeSec: r.minAgeSec } : {}), ...(Number.isFinite(r.maxCount) ? { maxCount: r.maxCount } : {}),
    ...(r.sharedDbOnly === true || (r.id === 'ef-update' && r.sharedDbOnly !== false) ? { sharedDbOnly: true } : {}),
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
      procs.push({ pid: +m[1], ppid: +m[2], cpu: +m[3], rssMb: Math.round(+m[4] / 1024), age, args: m[9].slice(0, 300), full: m[9] });
    }
    const safe = (s) => { try { return new RegExp(s); } catch { return null; } };
    const byPid = new Map(procs.map((p) => [p.pid, p]));
    // Which tmux session runs a process: walk its parents up to a pane's shell. Names only; no screen content.
    let panes = null;
    const paneOf = () => {
      if (panes) return panes; panes = new Map();
      try { for (const l of cp.execFileSync('tmux', ['list-panes', '-a', '-F', '#{pane_pid} #{session_name}'], { encoding: 'utf8', timeout: 4000 }).split('\n')) { const i = l.indexOf(' '); if (i > 0) panes.set(+l.slice(0, i), l.slice(i + 1)); } } catch { /* no tmux */ }
      return panes;
    };
    const where = (p) => {
      let session = '', task = '';
      for (let q = p, n = 0; q && n < 40; q = byPid.get(q.ppid), n++) {
        if (!task) task = (/(?:--task(?:=|\s+)|_crew\/tasks\/|_wt-)(\d{8}-[a-z0-9-]+?)(?:[\s/]|-w\d|-s\d|$)/.exec(q.full) || [])[1] || '';
        const name = paneOf().get(q.pid); if (name) { session = name; break; }
      }
      return { session, task };
    };
    // The database a migration process really targets, from its own environment (never printed beyond the name).
    const dbOf = (p) => {
      let env = '';
      try { env = require('fs').readFileSync('/proc/' + p.pid + '/environ', 'utf8').split('\0').join(' '); }
      catch { try { env = cp.execFileSync('ps', ['eww', '-o', 'command=', '-p', String(p.pid)], { encoding: 'utf8', timeout: 4000 }); } catch { /* unreadable */ } }
      const m = /ConnectionStrings__Default=[^\s]*?Database=([^;\s]+)/i.exec(env) || /--connection\s+\S*?Database=([^;\s"']+)/i.exec(p.full);
      if (m) return m[1];
      // No override in its environment: the program reads appsettings*.json from its working folder.
      let cwd = '';
      try { cwd = require('fs').readlinkSync('/proc/' + p.pid + '/cwd'); }
      catch { try { cwd = (cp.execFileSync('lsof', ['-a', '-p', String(p.pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 4000 }).split('\n').find((l) => l[0] === 'n') || '').slice(1); } catch { /* unknown */ } }
      for (const f of cwd ? ['appsettings.Development.json', 'appsettings.json'] : []) {
        try { const t = require('fs').readFileSync(require('path').join(cwd, f), 'utf8').slice(0, 65536), x = /"Default"\s*:\s*"[^"]*?Database=([^;"]+)/i.exec(t); if (x) return x[1]; } catch { /* next */ }
      }
      return '';
    };
    const personal = (db) => /^Xspire_dev_/i.test(db);
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
        let extra = {};
        if (r.sharedDbOnly) {
          // Only a database proven shared breaks the rule: a personal Xspire_dev_* one is the intended use, and an unknown
          // one is never reported as a violation (no guessing).
          const db = dbOf(p); if (!db || personal(db)) continue;
          extra = { db, dbUnknown: !db };
        }
        found.push({ rule: r.id, severity: r.severity, title: r.title, ...p, ...extra, ...(args ? where(p) : {}) });
      }
    }
    if (signal && signal.pid) {
      const target = procs.find((p) => p.pid === signal.pid && p.args === signal.args);
      if (!target) return { sent: false };
      try { process.kill(signal.pid, 'SIG' + signal.name); return { sent: true, found: found.map(({ full, ppid, ...f }) => f) }; } catch { return { sent: false }; }
    }
    return { found: found.slice(0, 50).map(({ full, ppid, ...f }) => f) };
  };
}

module.exports = {
  name: 'watchdog', DEFAULT_RULES, CREW_ONLY, cleanRules, scanRuntime, ACTIONS,
  register(host) {
    const state = new Map(); // serverId -> { at, found, error }
    const running = new Set();
    const rules = (serverId) => cleanRules(host.settings.get().rules).filter((r) => !CREW_ONLY.has(r.id) || (serverId && detect.has(serverId)));
    async function scan(backend, id, extra) {
      return runOnHost(backend, scanRuntime, { rules: rules(id), mark: MARK, ...extra });
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
      host.send(res, 200, { servers, rules: rules('').map((r) => ({ id: r.id, severity: r.severity, title: r.title })) });
    });
    host.route('POST', '/act', async ({ req, res }) => {
      const b = await host.readJson(req), backend = host.backendOf(b.server || ''), known = state.get(b.server || '');
      const hit = known && known.found.find((f) => f.pid === b.pid && f.args === b.args);
      if (!backend || !ACTIONS[b.action] || !hit) { host.fail(res, 409, tr('srv.watchdog.tien_trinh_nay_khong_con')); return; }
      try {
        const r = await scan(backend, b.server, { signal: { pid: b.pid, args: b.args, name: ACTIONS[b.action] } });
        host.log(`${b.action} pid ${b.pid} (${hit.rule}) sent=${!!r.sent}`);
        if (r.found) state.set(b.server, { at: Date.now(), found: r.found });
        host.send(res, 200, { sent: !!r.sent });
      } catch (e) { host.fail(res, 400, e.message); }
    });
  },
};
