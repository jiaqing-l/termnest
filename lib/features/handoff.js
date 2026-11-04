'use strict';
const { tr } = require('../i18n-server');
const { runOnHost, sessionCwd } = require('../file-viewer');
const { fetchCrew } = require('./crew');

// Opening a fresh session from the current one (feature 14, step 2). Everything here is plain code: it reads files, git and the
// screen, decides whether a new session can start safely, and builds the single-line prompt that goes into it. No AI is involved.
const MAX_PROMPT = 1000; // the keys endpoint refuses longer text
const SNAPSHOT_PROMPT = tr('srv.handoff.ghi_snapshot_trang_thai_theo');

// Self-contained so it runs on the session's host (see lib/file-viewer.js runOnHost).
function factsRuntime() {
  const fs = require('fs'), path = require('path'), cp = require('child_process');
  const run = (cmd, args, opts) => { try { return cp.execFileSync(cmd, args, { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024, ...opts }); } catch { return null; } };
  const CHROME = /auto mode|shells?\b|esc to|shift\+tab|for shortcuts|Sautéed|Crunched|Churned|Baked|Cooked|✻|⏵|─|╭|╰|│|new task\?|ctrl\+|to cycle|Background|active shell|^❯|\s{2,}running$|Update installed|Ask Codex|GPT-[\d.]+|for agents|tab to queue|esc to interrupt|^[›>]\s*$/i;
  // Windows temp/home folders have 8.3 aliases and git prints forward slashes: compare canonical paths, show forward slashes.
  const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
  const show = (from, to) => path.relative(from, to).split(path.sep).join('/');
  return async function facts({ cwd, session, socket, sinceMs, ignore, dirs, home }) {
    const cwdReal = real(cwd);
    const out = { git: { ok: false, repos: [] }, screen: { shells: 0, last: '' }, baseline: null };
    // The session folder is often not a repo itself (a workspace of repos), so look at the repos its state files live in too.
    const roots = [];
    for (const d of [cwd, ...(Array.isArray(dirs) ? dirs : [])].slice(0, 12)) {
      const top = typeof d === 'string' && path.isAbsolute(d) ? run('git', ['-C', d, 'rev-parse', '--show-toplevel']) : null;
      if (top && !roots.includes(real(top.trim()))) roots.push(real(top.trim()));
      if (roots.length >= 3) break;
    }
    const skip = new Set((Array.isArray(ignore) ? ignore : []).map(real));
    for (const root of roots) {
      const g = { root: show(cwdReal, root) || '.', branch: (run('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD']) || '').trim(), dirty: [], commits: [], commitsAfter: 0 };
      const status = (run('git', ['-C', root, 'status', '--porcelain=v1', '-z']) || '').split('\0').filter(Boolean);
      for (let i = 0; i < status.length && g.dirty.length < 40; i++) {
        const entry = status[i], code = entry.slice(0, 2), rel = entry.slice(3), abs = path.join(root, rel);
        if (/[RC]/.test(code)) i++; // the next record is the original path
        let at = 0; try { at = fs.statSync(abs).mtimeMs; } catch { /* deleted or a folder */ }
        g.dirty.push({ path: show(cwdReal, abs) || rel, at, state: code.trim(), state_file: skip.has(real(abs)) });
      }
      g.dirtyTotal = status.length;
      g.commits = (run('git', ['-C', root, 'log', '-5', '--format=%h\t%s']) || '').split('\n').filter(Boolean).map((l) => { const [sha, ...t] = l.split('\t'); return { sha, subject: t.join('\t').slice(0, 120) }; });
      // Commits after the snapshot that touched more than state files: committing the snapshot itself is not a reason to call it stale.
      if (Number.isFinite(sinceMs) && sinceMs > 0) {
        let sha = '', files = []; const commits = [];
        for (const line of (run('git', ['-C', root, 'log', '--since=' + new Date(sinceMs).toISOString(), '--name-only', '--format=@%h']) || '').split('\n')) {
          if (line.startsWith('@')) { if (sha) commits.push(files); sha = line.slice(1); files = []; } else if (line) files.push(real(path.join(root, line)));
        }
        if (sha) commits.push(files);
        g.commitsAfter = commits.filter((fs0) => fs0.length === 0 || fs0.some((f) => !skip.has(f))).length;
      }
      out.git.repos.push(g);
    }
    out.git.ok = out.git.repos.length > 0;
    if (typeof session === 'string' && session) {
      const text = run('tmux', (socket ? ['-L', socket] : []).concat(['capture-pane', '-p', '-J', '-S', '-60', '-t', '=' + session + ':'])) || '';
      const lines = text.split('\n'), tail = lines.slice(-40).join('\n'), m = [...tail.matchAll(/(\d+)\s+(?:active\s+)?shells?\b/gi)].pop();
      out.screen.shells = m ? Number(m[1]) : 0;
      const real = lines.map((l) => l.trim()).filter((l) => l.length >= 8 && !CHROME.test(l));
      out.screen.last = real.slice(-6).join(' ').replace(/\s+/g, ' ').slice(-300);
    }
    // A fresh session starts at the workspace's own baseline (CLAUDE.md, skills, memory): the median of recent first turns.
    try {
      const base = typeof home === 'string' && home ? home : require('os').homedir(), encoded = cwd.replace(/[^A-Za-z0-9]/g, '-'), firsts = [];
      for (const d of fs.readdirSync(base).filter((n) => /^\.claude(-[\w.-]+)?$/.test(n))) {
        const dir = path.join(base, d, 'projects', encoded); let files = [];
        try { files = fs.readdirSync(dir).filter((n) => /\.jsonl$/.test(n)).map((n) => ({ f: path.join(dir, n), at: fs.statSync(path.join(dir, n)).mtimeMs })); } catch { continue; }
        for (const { f } of files.sort((a, b) => b.at - a.at).slice(0, 8)) {
          const fd = fs.openSync(f, 'r'); const buf = Buffer.alloc(400 * 1024); const n = fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
          for (const line of buf.toString('utf8', 0, n).split('\n')) {
            let o; try { o = JSON.parse(line); } catch { continue; }
            const u = o && o.type === 'assistant' && o.message && o.message.model !== '<synthetic>' && o.message.usage;
            const t = u ? (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) : 0;
            if (t > 0) { firsts.push(t); break; }
          }
        }
      }
      firsts.sort((a, b) => a - b); if (firsts.length >= 3) out.baseline = firsts[Math.floor(firsts.length / 2)];
    } catch { /* no history */ }
    return out;
  };
}

const ago = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return m < 60 ? tr('srv.handoff.phut', [m]) : m < 1440 ? tr('srv.handoff.gio', [Math.round(m / 60)]) : tr('srv.handoff.ngay', [Math.round(m / 1440)]); };
const isSnapshot = (p) => /(CONTEXT-SNAPSHOT|SNAPSHOT|TRACKING)/i.test(p);

// Pure: one view over every repo that was read.
function gitSummary(git) {
  const repos = (git && git.repos) || [];
  return { ok: repos.length > 0, repos, dirty: repos.flatMap((r) => r.dirty || []), dirtyTotal: repos.reduce((n, r) => n + (r.dirtyTotal || 0), 0), commitsAfter: repos.reduce((n, r) => n + (r.commitsAfter || 0), 0) };
}

// Pure: turns what was read into checks (green/amber/red), the files to hand over and whether a new session may open.
function evaluate({ crew, facts, now = Date.now() }) {
  const checks = [], files = [], state = (crew && crew.stateFiles) || [];
  const primary = state.filter((f) => isSnapshot(f.path)).sort((a, b) => b.at - a.at)[0] || null;
  const tasks = ((crew && crew.tasks) || []).filter((t) => t.mentioned);
  const git = gitSummary(facts && facts.git);
  let needsSnapshot = false;
  if (!primary) {
    needsSnapshot = true;
    checks.push({ id: 'snapshot', level: 'bad', title: tr('srv.handoff.chua_thay_snapshot_hoac_tracker'), detail: tr('srv.handoff.phien_chua_nhac_toi_file') });
  } else {
    const newer = git.dirty.filter((d) => !d.state_file && d.at > primary.at), after = git.commitsAfter;
    if (newer.length || after) {
      needsSnapshot = true;
      checks.push({ id: 'snapshot', level: 'bad', title: tr('srv.handoff.snapshot_cu_hon_cac_thay'), detail: tr('srv.handoff.sua_truoc_sau_do_co', [primary.path, ago(now - primary.at), newer.length, after]), path: primary.path });
    } else checks.push({ id: 'snapshot', level: 'ok', title: tr('srv.handoff.snapshot_tim_thay_va_con'), detail: tr('srv.handoff.sua_truoc', [primary.path, ago(now - primary.at)]), path: primary.path });
    files.push(primary.path);
    for (const f of state.filter((x) => x !== primary).slice(0, 2)) files.push(f.path);
  }
  for (const t of tasks.slice(0, 2)) if (crew.root) files.push(`_crew/tasks/${t.task}/MANIFEST.md`);
  if (tasks.length) {
    const running = tasks.flatMap((t) => t.tracks.filter((x) => ['dispatched', 'queued'].includes(x.state)).map((x) => `${t.task}/${x.id}`));
    checks.push(running.length
      ? { id: 'crew', level: 'warn', title: tr('srv.handoff.crew_dang_chay_track', [running.length]), detail: tr('srv.handoff.phien_moi_chi_doc_manifest', [running.slice(0, 4).join(', ')]) }
      : { id: 'crew', level: 'ok', title: 'Crew', detail: tasks.map((t) => `${t.task}: ${t.tracks.filter((x) => ['merged', 'done'].includes(x.state)).length}/${t.tracks.length} track xong`).join('; ') });
  }
  if (git.ok) {
    const n = git.dirtyTotal, branches = git.repos.map((r) => `${r.root}: ${r.branch}`).join(' · ');
    checks.push(n ? { id: 'git', level: 'warn', title: tr('srv.handoff.git_file_chua_commit', [n]), detail: `${branches}. ${git.dirty.slice(0, 3).map((d) => d.path).join(', ')}${n > 3 ? '…' : ''}` } : { id: 'git', level: 'ok', title: tr('srv.handoff.git_sach'), detail: branches });
  }
  const shells = (facts && facts.screen && facts.screen.shells) || 0;
  if (shells) checks.push({ id: 'shells', level: 'warn', title: tr('srv.handoff.shell_nen_dang_chay', [shells]), detail: tr('srv.handoff.phien_cu_duoc_giu_chay') });
  const last = (facts && facts.screen && facts.screen.last) || '';
  if (/\?\s*$|\?["”]?\s*$/.test(last)) checks.push({ id: 'question', level: 'warn', title: tr('srv.handoff.co_cau_hoi_dang_cho'), detail: last.length > 160 ? '…' + last.slice(-160).replace(/^\S*\s+/, '') : last });
  return { checks, files, needsSnapshot, canOpen: !needsSnapshot, shells, tasks: tasks.map((t) => t.task) };
}

// Pure: one line, no control characters, never over MAX_PROMPT; the tail (last message) is what gets cut first.
function buildPrompt({ files, git, last }) {
  const clean = (s) => String(s || '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim();
  const head = [tr('srv.handoff.doc_theo_thu_tu_khong', [(files || []).map(clean).filter(Boolean).slice(0, 4).join('; ') || tr('srv.handoff.chua_co_file_trang_thai')])];
  const g = gitSummary(git);
  if (g.ok) {
    const per = g.repos.map((r) => tr('srv.handoff.nhanh_file_chua_commit', [clean(r.root), clean(r.branch), r.dirtyTotal || 0, r.dirtyTotal ? ' (' + (r.dirty || []).slice(0, 3).map((d) => clean(d.path)).join(', ') + ')' : ''])).join('; ');
    head.push(tr('srv.handoff.doi_chieu_git_status_voi', [per]));
  } else head.push(tr('srv.handoff.neu_thong_tin_trong_file'));
  const fixed = head.join(' '), tail = clean(last);
  if (!tail) return fixed.slice(0, MAX_PROMPT);
  const room = MAX_PROMPT - fixed.length - tr('srv.handoff.tin_nhan_cuoi_cua_phien').length;
  return room > 40 ? tr('srv.handoff.tin_nhan_cuoi_cua_phien_2', [fixed, tail.length > room ? '…' + tail.slice(-(room - 1)) : tail]) : fixed.slice(0, MAX_PROMPT);
}

function guessTool(session) { const c = String(session && session.cmd || ''), screen = ((session && session.lines) || []).join('\n'); return /claude/i.test(c) || /claude/i.test(screen) ? 'claude' : /codex/i.test(screen) ? 'codex' : 'claude'; }

module.exports = {
  name: 'handoff', factsRuntime, evaluate, buildPrompt, gitSummary, guessTool, SNAPSHOT_PROMPT, MAX_PROMPT,
  register(host) {
    host.route('GET', '/check', async ({ res, url }) => {
      const backend = host.backendOf(url.searchParams.get('server') || ''), session = url.searchParams.get('session') || '';
      if (!backend || backend.mode === 'powershell' || !session || session.length > 128) { host.fail(res, 400, tr('srv.handoff.chua_chon_phien_hop_le')); return; }
      try {
        const cwd = await sessionCwd(backend, session), crew = await fetchCrew(backend, session);
        const primary = (crew.stateFiles || []).filter((f) => isSnapshot(f.path)).sort((a, b) => b.at - a.at)[0];
        const abs = (f) => require('path').join(crew.root || cwd, f.path);
        const facts = await runOnHost(backend, factsRuntime, { cwd, session, socket: backend.socket || '', sinceMs: primary ? primary.at : 0, ignore: (crew.stateFiles || []).map(abs), dirs: (crew.stateFiles || []).map((f) => require('path').dirname(abs(f))) });
        const result = evaluate({ crew, facts });
        const sess = backend.snapshot && backend.snapshot.sessions && backend.snapshot.sessions.find((s) => s.name === session);
        host.send(res, 200, { ...result, cwd, tool: guessTool(sess), prompt: buildPrompt({ files: result.files, git: facts.git, last: facts.screen.last }), snapshotPrompt: SNAPSHOT_PROMPT, baseline: facts.baseline, git: gitSummary(facts.git).ok ? { repos: facts.git.repos.map((r) => ({ root: r.root, branch: r.branch, dirty: r.dirtyTotal || 0 })), dirty: gitSummary(facts.git).dirtyTotal } : null });
      } catch (e) { host.fail(res, 400, e.message); }
    });
  },
};
