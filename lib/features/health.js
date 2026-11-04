'use strict';
const { tr } = require('../i18n-server');
const { runOnHost, sessionCwd } = require('../file-viewer');
const { shq } = require('../parse');

// Host health plus a safe cleanup of crew worktrees. The cleanup is always one task at a time through the crew janitor,
// which itself refuses anything unmerged or dirty; Termnest only offers tasks whose tracks are all merged.
const TASK = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const TTL_MS = 8000;

// Self-contained so it runs on the session's host (see lib/file-viewer.js runOnHost).
function healthRuntime() {
  const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
  const exists = async (p) => { try { await fs.promises.access(p); return true; } catch { return false; } };
  const run = (cmd, args) => { try { return cp.execFileSync(cmd, args, { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; } };
  return async function read({ cwd }) {
    const out = { root: '', diskFreeGb: null, diskTotalGb: null, memFreePct: Math.round(os.freemem() / os.totalmem() * 100), load: os.loadavg()[0], cpus: os.cpus().length, candidates: [] };
    let dir = path.resolve(typeof cwd === 'string' && cwd ? cwd : '/'), root = '';
    for (let i = 0; i < 8; i++) { if (await exists(path.join(dir, '_crew', 'tasks'))) { root = dir; break; } const up = path.dirname(dir); if (up === dir) break; dir = up; }
    const df = run('df', ['-Pk', root || cwd || '/']).trim().split('\n')[1];
    if (df) { const f = df.split(/\s+/); out.diskTotalGb = +(f[1] / 1048576).toFixed(1); out.diskFreeGb = +(f[3] / 1048576).toFixed(1); }
    if (!root) return out;
    out.root = root;
    const tdir = path.join(root, '_crew', 'tasks'), names = await fs.promises.readdir(tdir);
    for (const name of names) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(name)) continue;
      let text; try { text = await fs.promises.readFile(path.join(tdir, name, 'MANIFEST.md'), 'utf8'); } catch { continue; }
      const states = [...text.slice(0, 8000).matchAll(/state:\s*([\w-]+)/g)].map((m) => m[1]);
      if (!states.length || states.some((s) => s !== 'merged')) continue;
      const wts = (await fs.promises.readdir(root)).filter((n) => n.startsWith('_wt-' + name + '-'));
      if (!wts.length) continue;
      let kb = 0; for (const w of wts) kb += parseInt(run('du', ['-sk', path.join(root, w)]), 10) || 0;
      out.candidates.push({ task: name, worktrees: wts.length, mb: Math.round(kb / 1024) });
    }
    out.candidates.sort((a, b) => b.mb - a.mb); out.candidates = out.candidates.slice(0, 30);
    return out;
  };
}

function level(h) {
  const reasons = [];
  if (h.diskFreeGb != null && h.diskFreeGb < 10) reasons.push(tr('srv.health.o_dia_con_it_gb', [h.diskFreeGb]));
  if (h.memFreePct < 10) reasons.push(tr('srv.health.ram_trong_duoi_10'));
  if (h.cpus && h.load / h.cpus > 1.5) reasons.push(tr('srv.health.may_dang_qua_tai_load', [h.load.toFixed(1)]));
  return { level: reasons.length ? (h.diskFreeGb != null && h.diskFreeGb < 5 ? 'bad' : 'warn') : 'ok', reasons };
}

module.exports = {
  name: 'health', healthRuntime, TASK, level,
  register(host) {
    const cache = new Map();
    async function data(backend, serverId, session, fresh) {
      const key = serverId + '|' + session, hit = cache.get(key);
      if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.value;
      const value = await runOnHost(backend, healthRuntime, { cwd: await sessionCwd(backend, session) });
      Object.assign(value, level(value)); cache.set(key, { at: Date.now(), value }); if (cache.size > 60) cache.delete(cache.keys().next().value);
      return value;
    }
    host.route('GET', '/data', async ({ res, url }) => {
      const serverId = url.searchParams.get('server') || '', session = url.searchParams.get('session') || '', backend = host.backendOf(serverId);
      if (!backend || !session || session.length > 128) { host.fail(res, 400, tr('srv.handoff.chua_chon_phien_hop_le')); return; }
      try { host.send(res, 200, await data(backend, serverId, session, url.searchParams.get('fresh') === '1')); } catch (e) { host.fail(res, 400, e.message); }
    });
    // step "preview" = janitor --dry-run (changes nothing); step "run" = janitor --yes for that single task.
    host.route('POST', '/clean', async ({ req, res }) => {
      const b = await host.readJson(req), backend = host.backendOf(b.server || ''), session = String(b.session || '');
      if (!backend || !session || session.length > 128 || !TASK.test(String(b.task || '')) || !['preview', 'run'].includes(b.step)) { host.fail(res, 400, tr('srv.health.yeu_cau_don_chua_dung')); return; }
      if (backend.mode === 'powershell') { host.fail(res, 400, tr('srv.health.may_nay_chua_ho_tro')); return; }
      try {
        const info = await data(backend, b.server, session, true);
        if (!info.root || !info.candidates.some((c) => c.task === b.task)) { host.fail(res, 409, tr('srv.health.task_nay_khong_con_du')); return; }
        const flag = b.step === 'run' ? '--yes' : '--dry-run';
        const out = await backend.exec(`cd ${shq(info.root)} && bash scripts/crew/crew-task.sh janitor --task ${b.task} ${flag} 2>&1 | tail -c 20000`, 180000, 4 * 1024 * 1024);
        cache.clear();
        host.send(res, 200, { step: b.step, ok: out.code === 0, text: out.out });
      } catch (e) { host.fail(res, 400, e.message); }
    });
  },
};
