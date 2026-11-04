'use strict';
const crypto = require('crypto');
const { activity } = require('../public/pet-state');
// Pure helpers: shell quoting, input rules, parsing the poll output, guessing a session's state.

const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
const SEP = '|~|';
const SHELLS = /^-?(bash|zsh|sh|dash|fish)$/;
// Claude rewrites its process title, so tmux reports either "claude" or a bare version number.
const CLAUDE = /claude|^\d+\.\d+\.\d+$/i;
const AGENT_CMD = /claude|codex|^\d+\.\d+\.\d+$/i;
// Codex runs as plain `node`, so it is recognised by its own prompt as well.
const CODEX_SCREEN = /ask codex to do anything|codex\b.*(?:high|medium|low)\s*·|›\s*ask codex/i;
const ASKING = /\[y\/n\]|\(y\/n\)|\byes\/no\b|do you want|press enter|password:|mật khẩu:|❯\s*1\./i;
const CLAUDE_QUIET_SECONDS = 20;

function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function claudeSessionId(dir, name) {
  const bytes = crypto.createHash('sha256').update(dir + '\0' + name).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function validName(n) { return typeof n === 'string' && NAME_RE.test(n); }

function validDir(d) {
  return d === '' || (typeof d === 'string' && d.length <= 512 && !/[\x00-\x1f\x7f]/.test(d));
}

function validHost(h) { return typeof h === 'string' && /^[A-Za-z0-9.:_-]{1,255}$/.test(h); }
function validUser(u) { return typeof u === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(u); }

// pwd contributes one newline; NUL separates records, including names containing newlines.
function parseDirs(out) {
  const records = out.split('\0');
  const path = records.shift().replace(/\n$/, '');
  const dirs = records.filter((name) => name !== '').sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b));
  const parent = path === '/' ? null : path.slice(0, path.lastIndexOf('/')) || '/';
  return { path, parent, dirs: dirs.slice(0, 500), truncated: dirs.length > 500 };
}

const POLL_SCRIPT = [
  `echo '@@HOST'; hostname`,
  `echo '@@CPU'; head -1 /proc/stat`,
  `echo '@@MEM'; grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo 2>/dev/null`,
  `echo '@@LOAD'; cat /proc/loadavg 2>/dev/null`,
  `echo '@@CORES'; nproc 2>/dev/null`,
  `echo '@@UPTIME'; cat /proc/uptime 2>/dev/null`,
  `echo '@@NET'; cat /proc/net/dev 2>/dev/null`,
  `echo '@@BOOT'; cat /proc/sys/kernel/random/boot_id 2>/dev/null`,
  `echo '@@TOP'; ps -eo pcpu=,pmem=,rss=,comm= --sort=-pcpu 2>/dev/null | head -5`,
  `echo '@@DISK'; df -P / | tail -1`,
  `echo '@@PS'; psout=$(ps -eo pid=,ppid=,etimes=,args= 2>/dev/null) && { printf '%s\\n' "$psout" | cut -c1-400; echo '@@PSOK'; echo 1; }`,
  `echo '@@FOREGROUND'; ps -eo pid=,pgid=,tpgid= 2>/dev/null`,
  `echo '@@CWD'; for p in $(pgrep -f 'codex exec|claude (--print|-p)|crew-dispatch[.]sh' 2>/dev/null); do printf '%s %s\\n' "$p" "$(readlink "/proc/$p/cwd" 2>/dev/null)"; done`,
  // setsid detaches a dispatch from its tmux ancestors but not from its environment: TMUX_PANE still names the pane.
  `echo '@@PANEENV'; for p in $(pgrep -f 'codex exec|claude (--print|-p)|crew-dispatch[.]sh' 2>/dev/null); do printf '%s %s\\n' "$p" "$(tr '\\0' '\\n' < "/proc/$p/environ" 2>/dev/null | sed -n 's/^TMUX_PANE=//p' | head -n 1)"; done`,
  `command -v tmux >/dev/null 2>&1 || { echo '@@NOTMUX'; exit 0; }`,
  `echo '@@SESS'`,
  `tmux -u list-sessions -F '#{session_id}${SEP}#{session_name}${SEP}#{session_attached}${SEP}#{session_created}${SEP}#{session_activity}${SEP}#{pane_current_command}${SEP}#{pane_current_path}' 2>/dev/null`,
  `tmux list-sessions -F '#{session_id}' 2>/dev/null | while read -r id; do echo "@@PANE $id"; tmux -u capture-pane -p -t "$id:" 2>/dev/null | grep -v '^[[:space:]]*$' | tail -n 8; done`,
  `echo '@@DETAIL'; tmux list-sessions -F '#{session_id}${SEP}#{pane_pid}${SEP}#{pane_dead}${SEP}#{pane_dead_status}' 2>/dev/null`,
  `echo '@@OWNERS'; tmux list-panes -a -F '#{session_id}${SEP}#{pane_pid}${SEP}#{pane_id}' 2>/dev/null`,
  `echo '@@END'`,
].join('\n');

const SLOW_SCRIPT = [
  `echo '@@OS'; ( . /etc/os-release; printf '%s\\n' "$PRETTY_NAME" ) 2>/dev/null`,
  `echo '@@DISKS'; df -Pk -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null`,
  `echo '@@FAILED'; systemctl --failed --no-legend --plain 2>/dev/null`,
  `echo '@@REBOOT'; if [ -f /var/run/reboot-required ]; then echo 1; else echo 0; fi`,
  `echo '@@UPDATES'; cat /var/lib/update-notifier/updates-available 2>/dev/null`,
  `echo '@@END'`,
].join('\n');

const GB_KB = 1024 * 1024;
function emptySys() {
  return { os: '', cores: null, uptimeSec: null, load1: null, ramUsedGb: null,
    ramTotalGb: null, swapUsedGb: null, swapTotalGb: null, downMBs: 0, upMBs: 0,
    net: [], top: [], disks: [], failed: [], rebootRequired: false, updates: 0 };
}

function parseSlow(out) {
  const res = { os: '', disks: [], failed: [], rebootRequired: false, updates: 0 };
  let section = '';
  for (const line of out.split('\n')) {
    if (/^@@[A-Z]+$/.test(line)) { section = line.slice(2); continue; }
    if (section === 'OS' && line.trim()) res.os = line.trim();
    if (section === 'DISKS') {
      const m = line.match(/^\S+\s+(\d+)\s+(\d+)\s+\d+\s+(\d+)%\s+(.+)$/);
      if (m) res.disks.push({ mount: m[4], usedGb: Number(m[2]) / GB_KB,
        totalGb: Number(m[1]) / GB_KB, pct: Number(m[3]) });
    }
    if (section === 'FAILED') {
      const m = line.trim().replace(/^[●*]\s*/, '').match(/^(\S+\.(?:service|socket|target|mount|automount|swap|timer|path|slice|scope|device))\s/);
      if (m) res.failed.push(m[1]);
    }
    if (section === 'REBOOT' && /^[01]$/.test(line.trim())) res.rebootRequired = line.trim() === '1';
    if (section === 'UPDATES') {
      const m = line.match(/^\s*(\d+)\s+(?:updates?|packages?)\b/i) || line.match(/^\s*(\d+)\s*$/);
      if (m && res.updates === 0) res.updates = Number(m[1]);
    }
  }
  return res;
}

// Counter resets, newly added interfaces and nonpositive intervals contribute no traffic.
function networkSpeed(previous, current, elapsedMs) {
  let down = 0, up = 0;
  if (previous && current && elapsedMs > 0) {
    for (const [name, bytes] of Object.entries(current)) {
      if (name === 'lo' || !previous[name]) continue;
      down += Math.max(0, bytes.rx - previous[name].rx);
      up += Math.max(0, bytes.tx - previous[name].tx);
    }
  }
  return { downMBs: down / (1024 * 1024) / (elapsedMs / 1000 || 1),
    upMBs: up / (1024 * 1024) / (elapsedMs / 1000 || 1) };
}

function defaultPrefs() {
  return { limits: { cpu: 95, ram: 90, disk: 90 }, templates: [], recentDirs: [],
    aiAccounts: [], sound: false, autoRestoreLocal: false, pets: {}, commands: ['git status', 'git pull', 'npm test'] };
}

function mergePrefs(saved) {
  const defaults = defaultPrefs();
  return { ...defaults, ...saved, limits: { ...defaults.limits, ...saved?.limits } };
}

// Only user-editable fields are accepted; recent directories always come from server state.
function cleanPrefs(input, saved) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid preferences');
  const out = mergePrefs(saved);
  if (input.aiAccounts !== undefined) out.aiAccounts = require('./tokens').cleanAccounts(input.aiAccounts);
  if (input.autoRestoreLocal !== undefined) {
    if (typeof input.autoRestoreLocal !== 'boolean') throw new Error('Invalid auto restore');
    out.autoRestoreLocal = input.autoRestoreLocal;
  }
  if (input.sound !== undefined) {
    if (typeof input.sound !== 'boolean') throw new Error('Invalid sound');
    out.sound = input.sound;
  }
  if (input.pets !== undefined) {
    if (!input.pets || typeof input.pets !== 'object' || Array.isArray(input.pets) || Object.keys(input.pets).length > 500) throw new Error('Invalid pets');
    out.pets = {};
    for (const [key, value] of Object.entries(input.pets)) {
      if (!/^[0-9a-f-]{36}\/[A-Za-z0-9_-]{1,32}$/.test(key) || !value ||
          typeof value.name !== 'string' || value.name.length > 40 || /[\x00-\x1f\x7f]/.test(value.name) ||
          !require('./pet-kinds').ALL.includes(value.kind) ||
          !['', 'flower', 'summer', 'pumpkin', 'winter'].includes(value.hat)) throw new Error('Invalid pet');
      out.pets[key] = { name: value.name, kind: value.kind, hat: value.hat };
    }
  }
  if (input.limits !== undefined) {
    if (!input.limits || typeof input.limits !== 'object' || Array.isArray(input.limits)) throw new Error('Invalid limits');
    out.limits = { ...out.limits, ...input.limits };
    for (const k of ['cpu', 'ram', 'disk']) {
      if (!Number.isInteger(out.limits[k]) || out.limits[k] < 50 || out.limits[k] > 100) throw new Error('Invalid limits');
    }
    out.limits = Object.fromEntries(['cpu', 'ram', 'disk'].map((k) => [k, out.limits[k]]));
  }
  if (input.templates !== undefined) {
    if (!Array.isArray(input.templates) || input.templates.length > 20) throw new Error('Invalid templates');
    out.templates = input.templates.map((t) => {
      if (!t || !validName(t.name) || !validDir(t.dir) || !['shell', 'claude', 'codex'].includes(t.run)) throw new Error('Invalid template');
      return { name: t.name, dir: t.dir, run: t.run };
    });
  }
  if (input.commands !== undefined) {
    if (!Array.isArray(input.commands) || input.commands.length > 20 || input.commands.some((c) =>
      typeof c !== 'string' || c.length < 1 || c.length > 200 || /[\x00-\x1f\x7f-\x9f]/.test(c))) throw new Error('Invalid commands');
    out.commands = input.commands.slice();
  }
  return out;
}

// lost names must survive subsequent polls on the new boot, including a service restart.
function syncKnown(known, bootId, liveSessions) {
  const before = known || { bootId: '', sessions: {} };
  const sessions = { ...before.sessions };
  const lost = new Set(before.lost || []);
  const live = new Set(liveSessions.map((s) => s.name));
  const reboot = !!(bootId && before.bootId && bootId !== before.bootId);
  for (const name of Object.keys(sessions)) {
    if (live.has(name)) lost.delete(name);
    else if (reboot) lost.add(name);
    else if (bootId && before.bootId && !lost.has(name)) delete sessions[name];
  }
  for (const s of liveSessions) {
    if (!Object.hasOwn(sessions, s.name)) {
      Object.defineProperty(sessions, s.name, { value: { dir: s.path, run: CLAUDE.test(s.cmd) ? 'claude' : /codex/i.test(s.cmd) ? 'codex' : 'shell' },
        enumerable: true, configurable: true, writable: true });
    }
  }
  const record = { bootId: bootId || before.bootId || '', sessions, lost: [...lost].filter((n) => Object.hasOwn(sessions, n)) };
  return { record, changed: JSON.stringify(before) !== JSON.stringify(record) };
}

function screenTail({ cmd, lines }) { return SHELLS.test(cmd) ? lines.filter((line) => line.trim()).slice(-1).join('\n') : lines.slice(-4).join('\n'); }
// True only when the screen really asks something (y/n, a menu, a password). A quiet Claude is also "waiting", but a Yes/No
// would then be typed into its prompt as a chat message.
function isAsking({ cmd, lines }) { return ASKING.test(screenTail({ cmd, lines })); }
// Claude and Codex redraw clocks, token counters and status bars on their own, which keeps tmux's "last activity" fresh while
// nothing is happening. The screen is therefore compared without digits, glyphs and status bars: only a change in the actual
// words counts as the session doing something. The "esc to interrupt" hint is the one reliable sign of real work.
const CHROME = /auto mode|shift\+tab|for shortcuts|esc to interrupt|bypass permissions|accept edits|ctrl\+[a-z]|⏵⏵|▸▸|^[\s─━═\-_•·|]+$|^\s*[❯>]\s*$/i;
const WORKING = /esc to interrupt|ctrl\+c to interrupt/i;
function isWorking(lines) { return lines.slice(-8).some((line) => WORKING.test(line)); }
function contentSignature(lines) {
  return lines.filter((line) => line.trim() && !CHROME.test(line)).slice(-10)
    .map((line) => line.toLowerCase().replace(/[\d\u2800-\u28ff✻✶✳✢✽*·•|/\\—–…\-]/g, '').replace(/\s+/g, ' ').trim()).join('\n');
}
// rec: what was seen last time ({sig, at}); returns the new record and how long the session has really been quiet (seconds).
function screenQuiet(rec, lines, activityAge, nowMs) {
  const sig = contentSignature(lines), at = !rec ? nowMs - activityAge * 1000 : rec.sig === sig ? rec.at : nowMs;
  return { rec: { sig, at }, quiet: isWorking(lines) ? 0 : Math.max(0, (nowMs - at) / 1000) };
}
function classify({ cmd, lines, activityAge }) {
  const tail = screenTail({ cmd, lines });
  if (ASKING.test(tail)) return 'wait';
  if (SHELLS.test(cmd)) return 'idle';
  const agent = AGENT_CMD.test(cmd) || CODEX_SCREEN.test(lines.slice(-8).join('\n'));
  if (agent && activityAge >= CLAUDE_QUIET_SECONDS) return 'wait';
  return 'run';
}

function agentKind(args) {
  // npm-installed agents run as "node /path/codex exec", so look past the interpreter.
  const tokens = args.trim().split(/\s+/);
  const base = (t) => String(t || '').split('/').pop();
  const first = /^(node|bash|sh|python3?)$/.test(base(tokens[0])) ? base(tokens[1]) : base(tokens[0]);
  if (first === 'codex' && /\sexec(\s|$)/.test(args)) return 'codex';
  if (first === 'claude' && /\s(--print|-p)(\s|$)/.test(args)) return 'claude';
  return '';
}

function flag(args, name) {
  const m = args.match(new RegExp(`--${name}[= ]([A-Za-z0-9_.-]+)`));
  return m ? m[1] : '';
}

/**
 * Crew workers run detached, outside tmux, so they are found from the process table.
 * Only derived fields leave this function: raw command lines may carry secrets.
 */
function findWorkers(procs, cwds, panes = [], paneEnv = new Map()) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const runs = new Map();
  const paneOwners = new Map(panes.map((s) => [s.panePid, { name: s.name, created: s.created }]));
  const paneIdOwners = new Map(panes.filter((s) => s.paneId).map((s) => [s.paneId, { name: s.name, created: s.created }]));
  const envOwner = (pid) => paneIdOwners.get(paneEnv.get(pid)) || null;
  function sessionOwner(pid) {
    const seen = new Set();
    while (pid && !seen.has(pid)) {
      if (paneOwners.has(pid)) return paneOwners.get(pid);
      seen.add(pid); pid = byPid.get(pid)?.ppid;
    }
    return null;
  }
  for (const p of procs) {
    if (!/crew-dispatch\.sh\b/.test(p.args) || agentKind(p.args)) continue;
    const task = flag(p.args, 'task');
    const track = flag(p.args, 'track');
    if (!task || !track) continue;
    const key = `${task}/${track}`;
    const cur = runs.get(key);
    const run = cur || { kind: '', task, track, elapsed: -1, cwd: '', dispatcherPid: p.pid, owner: sessionOwner(p.pid) || envOwner(p.pid), pids: new Set() };
    if (p.elapsed > run.elapsed) { run.elapsed = p.elapsed; run.cwd = cwds.get(p.pid) || run.cwd; }
    run.pids.add(p.pid);
    if (!run.owner) run.owner = sessionOwner(p.pid) || envOwner(p.pid);
    runs.set(key, run);
  }
  const out = [...runs.values()];
  for (const p of procs) {
    const kind = agentKind(p.args);
    if (!kind) continue;
    let owner = null;
    for (let cur = p, hops = 0; cur && hops < 12 && !owner; cur = byPid.get(cur.ppid), hops += 1) {
      owner = out.find((r) => r.pids.has(cur.pid)) || null;
    }
    if (owner) owner.kind = kind;
    else out.push({ kind, task: '', track: '', elapsed: p.elapsed, cwd: cwds.get(p.pid) || '', pids: new Set() });
  }
  return out.map(({ pids, ...w }) => w).sort((a, b) => b.elapsed - a.elapsed);
}

/** Returns the raw snapshot. CPU is the raw counters: a percentage needs the previous sample. */
function parsePoll(out, nowSec) {
  const res = { hostname: '', cpuTicks: null, ram: null, disk: null, hasTmux: true, sessions: [], sys: emptySys(), netBytes: {}, bootId: '' };
  const byId = new Map();
  let section = '';
  let pane = null;
  let mem = {};
  const procs = [];
  const foreground = new Set();
  const owners = [];
  const cwds = new Map();
  const paneEnv = new Map();
  for (const line of out.split('\n')) {
    if (line.startsWith('@@PANE ')) { pane = byId.get(line.slice(7).trim()) || null; section = 'PANE'; continue; }
    if (/^@@[A-Z]+$/.test(line)) {
      section = line.slice(2);
      if (section === 'NOTMUX') res.hasTmux = false;
      continue;
    }
    if (section === 'LOAD' && line.trim()) res.sys.load1 = Number(line.trim().split(/\s+/)[0]) || 0;
    else if (section === 'CORES' && /^\d+$/.test(line.trim())) res.sys.cores = Number(line.trim());
    else if (section === 'UPTIME' && line.trim()) res.sys.uptimeSec = Number(line.trim().split(/\s+/)[0]) || 0;
    else if (section === 'BOOT' && line.trim()) res.bootId = line.trim();
    else if (section === 'NET') {
      const m = line.match(/^\s*([^:]+):\s*(.*)$/);
      if (m && m[1] !== 'lo') {
        const v = m[2].trim().split(/\s+/).map(Number);
        if (v.length >= 16 && v.every(Number.isFinite)) res.netBytes[m[1]] = { rx: v[0], tx: v[8] };
      }
    } else if (section === 'TOP' && res.sys.top.length < 5) {
      const m = line.match(/^\s*([\d.]+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
      if (m) res.sys.top.push({ cmd: m[4], cpu: Number(m[1]), memGb: Number(m[3]) / GB_KB });
    } else if (section === 'HOST' && line) res.hostname = line.trim();
    else if (section === 'PS') {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
      if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), elapsed: Number(m[3]), args: m[4] });
    } else if (section === 'PSOK') {
      if (line.trim() === '1') res.workersReliable = true;
    } else if (section === 'FOREGROUND') {
      const f = line.trim().split(/\s+/).map(Number);
      if (f.length === 3 && f[1] > 0 && f[1] === f[2]) foreground.add(f[0]);
    } else if (section === 'PANEENV') {
      const m = line.match(/^(\d+)\s+(%\d+)$/);
      if (m) paneEnv.set(Number(m[1]), m[2]);
    } else if (section === 'CWD') {
      const m = line.match(/^(\d+)\s+(.+)$/);
      if (m) cwds.set(Number(m[1]), m[2]);
    } else if (section === 'CPU' && line.startsWith('cpu')) {
      const v = line.trim().split(/\s+/).slice(1).map(Number);
      res.cpuTicks = { idle: v[3] + (v[4] || 0), total: v.reduce((a, b) => a + b, 0) };
    } else if (section === 'MEM') {
      const m = line.match(/^(\w+):\s+(\d+)/);
      if (m) mem[m[1]] = Number(m[2]);
    } else if (section === 'DISK' && line) {
      const m = line.match(/(\d+)%/);
      if (m) res.disk = Number(m[1]);
    } else if (section === 'SESS' && line) {
      const f = line.split(SEP);
      if (f.length < 7) continue;
      const s = {
        id: f[0], name: f[1], attached: Number(f[2]) || 0, created: Number(f[3]) || 0,
        activity: Number(f[4]) || 0, cmd: f[5], path: f.slice(6).join(SEP), lines: [],
      };
      byId.set(s.id, s);
      res.sessions.push(s);
    } else if (section === 'OWNERS') {
      const f = line.split(SEP), session = byId.get(f[0]);
      if (session && /^\d+$/.test(f[1])) owners.push({ ...session, panePid: Number(f[1]), paneId: /^%\d+$/.test(f[2] || '') ? f[2] : '' });
    } else if (section === 'DETAIL') {
      const f = line.split(SEP), session = byId.get(f[0]);
      if (session) { session.panePid = Number(f[1]); session.dead = f[2] === '1'; session.exitStatus = /^\d+$/.test(f[3]) ? Number(f[3]) : null; }
    } else if (section === 'PANE' && pane) {
      pane.lines.push(line.replace(/\s+$/, '').slice(0, 220));
    }
  }
  res.workers = findWorkers(procs, cwds, owners.length ? owners : res.sessions, paneEnv);
  if (mem.MemTotal && mem.MemAvailable !== undefined) {
    res.ram = Math.round((1 - mem.MemAvailable / mem.MemTotal) * 100);
    res.sys.ramUsedGb = (mem.MemTotal - mem.MemAvailable) / GB_KB;
    res.sys.ramTotalGb = mem.MemTotal / GB_KB;
  }
  if (mem.SwapTotal !== undefined && mem.SwapFree !== undefined) {
    res.sys.swapTotalGb = mem.SwapTotal / GB_KB;
    res.sys.swapUsedGb = (mem.SwapTotal - mem.SwapFree) / GB_KB;
  }
  for (const s of res.sessions) {
    s.activityAge = Math.max(0, nowSec - s.activity);
    s.state = classify({ cmd: s.cmd, lines: s.lines, activityAge: s.activityAge });
    s.asking = s.state === 'wait' && isAsking({ cmd: s.cmd, lines: s.lines });
    // Inspect descendants of the pane's shell; publish only the lookup result, never arguments.
    const descendants = new Set([s.panePid]);
    for (let depth = 0; depth < 12; depth++) {
      for (const p of procs) if (descendants.has(p.ppid)) descendants.add(p.pid);
    }
    for (const p of procs) {
      if (!descendants.has(p.pid) || !foreground.has(p.pid)) continue;
      const resume=p.args.match(/^(?:\S*\/)?(codex)\s+resume\s+([a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})(?:\s|$)/i);
      if (resume) { s.aiTool=resume[1].toLowerCase();s.aiSessionId=resume[2]; }
    }
    s.petActivity = s.state === 'run' ? activity(s.cmd) : 'normal';
    if (s.state === 'run') for (const p of procs) {
      if (descendants.has(p.pid) && foreground.has(p.pid) && activity(p.args) !== 'normal') s.petActivity = activity(p.args);
    }
    s.pane_pid = s.panePid;
    delete s.panePid;
    delete s.id;
  }
  return res;
}

module.exports = { SLOW_SCRIPT, cleanPrefs, mergePrefs, networkSpeed, parseSlow, syncKnown, POLL_SCRIPT, claudeSessionId, classify, isAsking, isWorking, contentSignature, screenQuiet, findWorkers, parseDirs, parsePoll, shq, validDir, validHost, validName, validUser };
