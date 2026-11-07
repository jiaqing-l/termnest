'use strict';
const { tr } = require('../i18n-server');
const { keysScript } = require('../keys');
const { shq } = require('../parse');

// "Plugin & skill": which Claude Code plugins each machine runs, which open Claude sessions started before a plugin changed,
// and a way to bring them up to date without closing them (`/reload-plugins`, Claude Code's own command).
// Facts only: the plugin list comes from `claude plugin list --json` (Claude Code itself), a session's start time from its own
// session file, a folder plugin's change time from the files on disk. Nothing is typed into a session that is working,
// waiting for its owner or showing a moved-to-background board; those wait in a queue until Claude reports idle.
const EVERY_MS = 10 * 60 * 1000, LOG_MAX = 100, NAME = /^[\w.@-]{1,120}$/;

// Runs on the host. `claude plugin list --json` answers for the folder it runs in (project plugins are on only inside their
// project), so it runs once per (config folder, working folder) that an open Claude session uses, plus once in $HOME per
// config folder to list what is installed at all.
function listScript(pairs) {
  // Ask the very binary the session runs (a login shell may find an older `claude` first on PATH).
  // Linux: /proc/<pid>/exe; macOS: the process's executable from lsof (ps shows only the name there).
  const bin = (pid) => `$(readlink "/proc/${pid}/exe" 2>/dev/null || lsof -a -p ${pid} -d txt -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)`;
  const first = pairs.find((p) => p.pid);
  const head = [
    `C=${first ? bin(first.pid) : ''}; [ -x "$C" ] || C=$(command -v claude 2>/dev/null || ls "$HOME/.local/bin/claude" "$HOME/.npm-global/bin/claude" /usr/local/bin/claude 2>/dev/null | head -n 1)`,
    '[ -n "$C" ] || { echo "@@NOCLAUDE"; exit 0; }',
    'run() { B="$3"; [ -x "$B" ] || B="$C"; if [ "$1" = ".claude" ]; then (cd "$2" 2>/dev/null && env -u CLAUDE_CONFIG_DIR "$B" plugin list --json 2>/dev/null); else (cd "$2" 2>/dev/null && CLAUDE_CONFIG_DIR="$HOME/$1" "$B" plugin list --json 2>/dev/null); fi; echo; }',
    'for d in "$HOME/.claude" "$HOME"/.claude-*; do [ -d "$d/plugins" ] || continue; b=$(basename "$d"); echo "@@CFG $b|"; run "$b" "$HOME" "$C"; done',
  ];
  for (const p of pairs) head.push(`echo ${shq('@@CFG ' + p.cfg + '|' + p.cwd)}; run ${shq(p.cfg)} ${shq(p.cwd)} "${p.pid ? bin(p.pid) : '$C'}"`);
  return head.join('\n');
}
const LIST_SCRIPT = listScript([]);
function mtimeScript(folders) {
  // GNU find prints times directly; macOS falls back to stat -f. Newest file wins; .git is skipped.
  return folders.map((f) => `m=$(find ${shq(f)} -path '*/.git' -prune -o -type f -printf '%T@\\n' 2>/dev/null | sort -rn | head -n 1); [ -n "$m" ] || m=$(find ${shq(f)} -path '*/.git' -prune -o -type f -exec stat -f %m {} + 2>/dev/null | sort -rn | head -n 1); echo "@@M \${m:-0} ${f.replace(/\n/g, '')}"`).join('\n');
}

function parseList(out) {
  if (/@@NOCLAUDE/.test(out)) return { noClaude: true, accounts: [] };
  const accounts = [];
  for (const part of out.split(/^@@CFG /m).slice(1)) {
    const nl = part.indexOf('\n'), tag = part.slice(0, nl).trim(), cfg = tag.split('|')[0], cwd = tag.slice(cfg.length + 1), body = part.slice(nl + 1).trim();
    let j = null; try { j = JSON.parse(body); } catch { /* not JSON: skip this account */ }
    const list = Array.isArray(j) ? j : (j && Array.isArray(j.installed) ? j.installed : []);
    accounts.push({ cfg, cwd, plugins: list.filter((p) => p && NAME.test(p.id || '')).map((p) => ({
      id: p.id, version: String(p.version || ''), running: String(p.folderVersion || p.version || ''), folder: typeof p.readFromFolder === 'string' ? p.readFromFolder : '',
      scope: p.scope || 'user', projectPath: typeof p.projectPath === 'string' ? p.projectPath : '', enabled: p.enabled !== false && p.projectEnabled !== false,
      lastUpdated: Date.parse(p.lastUpdated || '') || 0,
    })) });
  }
  return { accounts };
}

function cwdOf(s) { return s.aiCwd || s.path || ''; }
// Sessions that started (or were last reloaded by TERMNEST) before a plugin they use changed. "Use" is Claude Code's own answer
// for that session's config folder and working folder (enabled there), not a rule of ours.
function staleSessions(state, snapshot, reloadedAt) {
  const out = [];
  for (const s of (snapshot && snapshot.sessions) || []) {
    const st = s.aiStatus; if (!st || st.tool !== 'claude' || !st.startedAt) continue;
    const acc = state.accounts.find((a) => a.cfg === st.cfg && a.cwd === cwdOf(s)); if (!acc) continue;
    // A parked pane's conversation runs in the background process: that process's start time is the one that counts.
    const started = st.parked && st.job && st.job.startedAt ? st.job.startedAt : st.startedAt;
    const since = Math.max(started, reloadedAt[s.name + '/' + st.startedAt] || 0);
    const changed = acc.plugins.filter((p) => p.enabled).map((p) => ({ id: p.id, at: p.folder ? (state.mtimes[p.folder] || 0) : p.lastUpdated })).filter((p) => p.at > since);
    if (changed.length) out.push({ session: s.name, key: s.name + '/' + st.startedAt, status: st.status, parked: !!st.parked, plugins: changed.map((p) => p.id), changedAt: Math.max(...changed.map((p) => p.at)) });
  }
  return out;
}
// Typing `/reload-plugins` is safe only when Claude itself reports idle at its own prompt.
function readyFor(s) { const st = s && s.aiStatus; return !!st && st.tool === 'claude' && st.status === 'idle' && !st.parked && !s.asking; }

module.exports = {
  name: 'plugins', parseList, staleSessions, readyFor, listScript, LIST_SCRIPT,
  register(host) {
    const state = new Map(), running = new Set(), pending = new Map(), reloadedAt = {};
    const settings = () => { try { return host.settings.get(); } catch { return {}; } };
    let logCache = null;
    const logOf = () => { if (logCache) return logCache; let s; try { s = host.settings.get(); } catch { return []; } return (logCache = Array.isArray(s.log) ? s.log.slice(-LOG_MAX) : []); };
    const save = (patch) => host.settings.set({ ...settings(), ...patch });
    const session = (r, name) => ((r.snapshot && r.snapshot.sessions) || []).find((s) => s.name === name);

    async function scan(r) {
      const id = r.cfg.id; if (running.has(id) || r.mode === 'powershell') return; running.add(id);
      try {
        const pairs = [], seen = new Set();
        for (const x of (r.snapshot && r.snapshot.sessions) || []) {
          const st = x.aiStatus, cwd = cwdOf(x); if (!st || st.tool !== 'claude' || !st.cfg || !cwd || cwd.length > 400 || /[\x00-\x1f]/.test(cwd)) continue;
          const k = st.cfg + '|' + cwd; if (!seen.has(k) && pairs.length < 12) { seen.add(k); pairs.push({ cfg: st.cfg, cwd, pid: Number(x.aiPid) || 0 }); }
        }
        const script = listScript(pairs), out = await r.exec(`bash -lc ${shq(script)} 2>/dev/null || sh -lc ${shq(script)}`);
        const res = parseList(out.out || ''), folders = [...new Set(res.accounts.flatMap((a) => a.plugins.map((p) => p.folder)).filter(Boolean))].slice(0, 20), mtimes = {};
        if (folders.length) {
          const m = await r.exec(`sh -c ${shq(mtimeScript(folders))}`);
          for (const line of (m.out || '').split('\n')) { const x = /^@@M (\d+(?:\.\d+)?) (.+)$/.exec(line); if (x) mtimes[x[2]] = Math.round(Number(x[1]) * 1000); }
        }
        state.set(id, { at: Date.now(), ...res, mtimes });
      } catch (e) { state.set(id, { at: Date.now(), accounts: [], mtimes: {}, error: e.message }); }
      finally { running.delete(id); }
    }
    async function send(r, s, why) {
      if (r.mode === 'powershell') r.keysPlain(s.name, '/reload-plugins', true);
      else { const out = await r.exec(keysScript(`=${s.name}:`, '/reload-plugins', true)); if (out.code !== 0) throw new Error(tr('srv.server.khong_gui_duoc_noi_dung')); }
      reloadedAt[s.name + '/' + s.aiStatus.startedAt] = Date.now();
      const log = logOf(); log.push({ at: Date.now(), server: r.cfg.id, serverName: r.cfg.name || r.cfg.host, session: s.name, why }); logCache = log.slice(-LOG_MAX); save({ log: logCache });
      host.log(`reload-plugins -> ${s.name} (${why})`);
    }

    host.onSnapshot((r) => {
      const id = r.cfg && r.cfg.id; if (!id) return;
      const st = state.get(id);
      if (!st || Date.now() - st.at > EVERY_MS) scan(r);
      // Auto mode queues every stale session; the queue sends only when Claude reports idle.
      if (st && settings().autoReload) for (const x of staleSessions(st, r.snapshot, reloadedAt)) if (!pending.has(id + '|' + x.key)) pending.set(id + '|' + x.key, { server: id, session: x.session, key: x.key, why: 'auto' });
      for (const [k, q] of pending) {
        if (q.server !== id) continue;
        const s = session(r, q.session);
        if (!s || !s.aiStatus || s.name + '/' + s.aiStatus.startedAt !== q.key) { pending.delete(k); continue; }
        if (!readyFor(s)) continue;
        pending.delete(k); send(r, s, q.why).catch((e) => host.log(`reload failed ${q.session}: ${e.message}`));
      }
    });

    host.route('GET', '/data', ({ res }) => {
      const servers = [];
      for (const r of host.remotes()) {
        if (!r.cfg) continue; const st = state.get(r.cfg.id);
        servers.push({ id: r.cfg.id, local: !!r.cfg.local, name: r.cfg.name || r.cfg.host || r.cfg.id, scanned: st ? st.at : 0, error: st && st.error || '', noClaude: !!(st && st.noClaude), windows: r.mode === 'powershell',
          // Per config folder: every plugin installed, with the version actually loaded where a session uses it.
          accounts: st ? st.accounts.filter((a) => !a.cwd).map((a) => ({ cfg: a.cfg, plugins: a.plugins.map((p) => {
            const used = st.accounts.filter((b) => b.cfg === a.cfg && b.cwd).map((b) => b.plugins.find((q) => q.id === p.id && q.enabled)).filter(Boolean)[0];
            const q = used || p; return { ...q, usedBySessions: !!used, changedAt: q.folder ? (st.mtimes[q.folder] || 0) : q.lastUpdated };
          }) })) : [],
          stale: st ? staleSessions(st, r.snapshot, reloadedAt).map((x) => ({ ...x, queued: pending.has(r.cfg.id + '|' + x.key) })) : [] });
      }
      host.send(res, 200, { servers, autoReload: !!settings().autoReload, log: logOf().slice(-30).reverse() });
    });
    host.route('POST', '/refresh', async ({ req, res }) => {
      const b = await host.readJson(req), r = host.backendOf(String(b.server || ''));
      if (!r) { host.fail(res, 404, tr('srv.server.khong_tim_thay')); return; }
      await scan(r); host.send(res, 200, { ok: true });
    });
    // Reload one session, or every stale one on a machine: idle ones now, the rest as soon as Claude reports idle.
    host.route('POST', '/reload', async ({ req, res }) => {
      const b = await host.readJson(req), r = host.backendOf(String(b.server || '')), st = r && state.get(r.cfg.id);
      if (!r || !st) { host.fail(res, 404, tr('srv.server.khong_tim_thay')); return; }
      const targets = staleSessions(st, r.snapshot, reloadedAt).filter((x) => b.all || x.session === b.session);
      let now = 0, queued = 0;
      for (const x of targets) {
        const s = session(r, x.session);
        if (readyFor(s)) { await send(r, s, 'manual'); now++; } else { pending.set(r.cfg.id + '|' + x.key, { server: r.cfg.id, session: x.session, key: x.key, why: 'manual' }); queued++; }
      }
      host.send(res, 200, { now, queued });
    });
    host.route('POST', '/auto', async ({ req, res }) => { const b = await host.readJson(req); save({ autoReload: b.on === true }); host.send(res, 200, { autoReload: b.on === true }); });
    // Update a marketplace plugin with Claude Code's own command, in a visible tmux session the person can watch.
    host.route('POST', '/update', async ({ req, res }) => {
      const b = await host.readJson(req), r = host.backendOf(String(b.server || '')), st = r && state.get(r.cfg.id);
      const acc = st && st.accounts.find((a) => a.cfg === b.cfg), p = acc && acc.plugins.find((x) => x.id === b.id);
      if (!r || !p || p.folder || !/^\.claude(-[\w.-]+)?$/.test(acc.cfg) || r.mode === 'powershell') { host.fail(res, 409, tr('srv.plugins.khong_cap_nhat_duoc')); return; }
      const name = 'tn-plugin-update', env = acc.cfg === '.claude' ? '' : `CLAUDE_CONFIG_DIR="$HOME/${acc.cfg}" `, market = p.id.split('@')[1] || '';
      if (!((r.snapshot && r.snapshot.sessions) || []).some((s) => s.name === name)) await host.sessions.start(r, { name, dir: '', run: 'shell' });
      const cmd = `${env}claude plugin marketplace update ${shq(market)} && ${env}claude plugin update ${shq(p.id)}`;
      const out = await r.exec(keysScript(`=${name}:`, cmd, true));
      if (out.code !== 0) { host.fail(res, 400, tr('srv.server.khong_gui_duoc_noi_dung')); return; }
      setTimeout(() => { scan(r); }, 60000);
      host.send(res, 200, { session: name });
    });
  },
};
