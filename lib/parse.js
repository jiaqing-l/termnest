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

function elapsedSec(t) {
  const [d, rest] = t.includes('-') ? t.split('-') : ['0', t];
  return rest.split(':').map(Number).reduce((n, x) => n * 60 + x, 0) + Number(d) * 86400;
}
const { safeFlags } = require('./agent-flags');
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
// Claude writes its session files under the config folder of the account it runs as (~/.claude, ~/.claude-<account>,
// CLAUDE_CONFIG_DIR), so every such folder is read.
// One AGENTIDS line → { tool, id, cwd }: Claude's "<sessionId> <cwd>" or a Codex rollout file name ending in the conversation id.
function agentId(tool, text) {
  if (tool === 'codex') { const m = text.match(/([a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})\.jsonl$/i); return m ? { tool, id: m[1] } : null; }
  const m = text.match(/^(\S+)(?: (.*))?$/), cwd = m?.[2] || '';
  return m && UUID.test(m[1]) ? { tool, id: m[1], cwd: cwd.startsWith('/') && validDir(cwd) ? cwd : '' } : null;
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

// One awk per kind of file instead of a dozen grep/cut/tr per file, and on macOS (no /proc) one lsof and one ps for all Codex
// processes instead of two lsof per process: a full poll went from ~2.3 s to ~0.5 s on a Mac with 20 Claude and 3 Codex sessions. Output lines are exactly the ones parsePoll reads (see AGENTIDS/JOBS).
// The profile is the config folder as a path below HOME (".claude-x", ".config/claude-x", or wherever the env setting
// points), so every machine layout is reported as it really is. Values are taken the same way as before: the first match of each key in the first 4000 bytes (Claude), 20000 (jobs).
// Regexes are strings: an /re/ argument would be evaluated as $0 ~ /re/ by POSIX awk.
const AWK_VAL = 'function g(s,r){return match(s,r)?substr(s,RSTART,RLENGTH):""} function v(m){sub(/^"[^"]*":"?/,"",m);sub(/"$/,"",m);return m}';
const CLAUDE_AWK = AWK_VAL + String.raw` function out(){if(f=="")return;b=substr(b,1,4000);p=f;sub(/.*\//,"",p);sub(/[.]json$/,"",p);x=f;sub(/\/[^\/]*\/[^\/]*$/,"",x);if(home!=""&&index(x,home "/")==1)x=substr(x,length(home)+2);else sub(/.*\//,"",x);gsub(/[^A-Za-z0-9_.\/-]/,"_",x);cf=substr(x,1,80);i=v(g(b,"\"sessionId\":\"[0-9a-fA-F-]*\""));c=v(g(b,"\"cwd\":\"[^\"]*\""));if(i!="")printf "claude %s %s %s\n",p,i,c;st=v(g(b,"\"status\":\"[a-z_]*\""));if(st=="")return;k=v(g(b,"\"kind\":\"[a-z]*\""));su=v(g(b,"\"statusUpdatedAt\":[0-9]*"));w=v(g(b,"\"waitingFor\":\"[^\"]*\""));gsub(/[^A-Za-z0-9_.:-]/,"_",w);w=substr(w,1,60);n=substr(v(g(b,"\"name\":\"[^\"]*\"")),1,80);pk=match(b,"\"parkedJobId\":\"[^\"]")?1:0;sa=v(g(b,"\"startedAt\":[0-9]*"));printf "claudestat %s %s %s %s %s %s %s %s %s\n",p,(k==""?"x":k),st,(su==""?0:su),(w==""?"-":w),pk,(sa==""?0:sa),cf,n} FNR==1{out();f=FILENAME;b=""} {if(length(b)<4000)b=b $0} END{out()}`;
// Codex rollouts arrive as "@@M <mtime> <path>" lines, then per file "@@F <path>", its first 4000 bytes, "@@T", its last 64 KiB.
const CODEX_AWK = AWK_VAL + String.raw` function done(){if(f=="")return;b=f;sub(/.*\//,"",b);printf "codexroll %s %s %s %s %s\n",(f in m?m[f]:0),(t==""?"-":t),(e==""?"-":e),b,c;f=""} /^@@M /{x=substr($0,5);y=x;sub(/ .*/,"",y);sub(/^[^ ]* /,"",x);m[x]=y;next} /^@@F /{done();f=substr($0,5);st="H";ts=0;t="";c="";e="";next} /^@@T$/{st="T";next} st=="H"{s=$0;if(c==""&&match(s,"\"cwd\":\"[^\"]*\""))c=v(substr(s,RSTART,RLENGTH));while(match(s,"\"timestamp\":\"[^\"]*\"")){ts++;if(ts==2)t=v(substr(s,RSTART,RLENGTH));s=substr(s,RSTART+RLENGTH)};next} st=="T"{s=$0;while(match(s,"\"type\":\"(task_started|task_complete|turn_aborted)\"")){e=v(substr(s,RSTART,RLENGTH));s=substr(s,RSTART+RLENGTH)}} END{done()}`;
const JOBS_AWK = String.raw`function out(){if(f=="")return;b=substr(b,1,20000);while(match(b,"\"(state|tempo|updatedAt|needs|detail|name)\": *\"[^\"]*\"|\"tasks\": *[0-9]+")){print substr(b,RSTART,RLENGTH);b=substr(b,RSTART+RLENGTH)}} FNR==1{out();f=FILENAME;id=f;sub(/\/state[.]json$/,"",id);sub(/.*\//,"",id);print "@@J " id;b=""} {if(length(b)<20000)b=b $0} END{out()}`;

const POLL_SCRIPT = [
  `echo '@@HOST'; hostname`,
  `echo '@@CPU'; head -1 /proc/stat`,
  `echo '@@MEM'; grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo 2>/dev/null`,
  `echo '@@LOAD'; cat /proc/loadavg 2>/dev/null`,
  `echo '@@CORES'; nproc 2>/dev/null`,
  `echo '@@UPTIME'; cat /proc/uptime 2>/dev/null`,
  `echo '@@NET'; cat /proc/net/dev 2>/dev/null`,
  `echo '@@BOOT'; cat /proc/sys/kernel/random/boot_id 2>/dev/null || sysctl -n kern.bootsessionuuid 2>/dev/null`,
  `echo '@@TOP'; ps -eo pcpu=,pmem=,rss=,comm= --sort=-pcpu 2>/dev/null | head -5`,
  `echo '@@DISK'; df -P / | tail -1`,
  // Only what TERMNEST reads leaves the machine: processes below a tmux pane, and crew dispatches/workers (they may be
  // detached from tmux) with their children. A full ps of a busy host is ~200 KB every poll; this is usually a few KB.
  `echo '@@PS'; psout=$(ps -eo pid=,ppid=,etimes=,args= 2>/dev/null || ps -eo pid=,ppid=,etime=,args= 2>/dev/null) && { roots=$(tmux list-panes -a -F '#{pane_pid}' 2>/dev/null | tr '\\n' ' '); printf '%s\\n' "$psout" | awk -v roots="$roots" 'BEGIN{n=split(roots,r," ");for(i=1;i<=n;i++)keep[r[i]]=1} {pid[NR]=$1;pp[NR]=$2;line[NR]=$0;if($0~/crew-dispatch|crew-watch|crew-upstream|codex exec|claude (--print|-p)/)keep[$1]=1} END{do{c=0;for(i=1;i<=NR;i++)if(!(pid[i] in keep)&&(pp[i] in keep)){keep[pid[i]]=1;c=1}}while(c);for(i=1;i<=NR;i++)if(pid[i] in keep)print substr(line[i],1,400)}'; echo '@@PSOK'; echo 1; }`,
  `echo '@@FOREGROUND'; ps -eo pid=,pgid=,tpgid= 2>/dev/null`,
  `echo '@@CWD'; for p in $(pgrep -f 'codex exec|claude (--print|-p)|crew-dispatch[.]sh' 2>/dev/null); do printf '%s %s\\n' "$p" "$(readlink "/proc/$p/cwd" 2>/dev/null)"; done`,
  // setsid detaches a dispatch from its tmux ancestors but not from its environment: TMUX_PANE still names the pane.
  `echo '@@PANEENV'; for p in $(pgrep -f 'codex exec|claude (--print|-p)|crew-dispatch[.]sh' 2>/dev/null); do printf '%s %s\\n' "$p" "$(tr '\\0' '\\n' < "/proc/$p/environ" 2>/dev/null | sed -n 's/^TMUX_PANE=//p' | head -n 1)"; done`,
  // Which conversation each live agent holds, so a reboot can resume it: Claude keeps <pid>.json with its sessionId and cwd,
  // Codex keeps its rollout file open (Linux /proc only). Only the id and the folder leave the machine, never the rest of the
  // file; files of processes that are gone are skipped and only the newest 32 are looked at.
  `echo '@@AGENTIDS'; for d in "$HOME/.claude/sessions" "$HOME"/.claude-*/sessions "$HOME"/.config/claude*/sessions "\${CLAUDE_CONFIG_DIR:-/nonexistent}/sessions"; do [ -d "$d" ] || continue; set --; for f in $(ls -t "$d" 2>/dev/null | grep -E '^[0-9]+[.]json$' | head -n 32); do p=\${f%.json}; kill -0 "$p" 2>/dev/null && set -- "$@" "$d/$f"; done; [ $# -gt 0 ] && awk -v home="$HOME" '${CLAUDE_AWK}' "$@" 2>/dev/null; done; cx=''; CP=$(pgrep codex 2>/dev/null | head -n 16); LS=''; ET=''; if [ -n "$CP" ] && [ ! -d /proc/self/fd ]; then CL=$(printf '%s' "$CP" | tr '\\n' ','); LS=$(lsof -n -P -p "$CL" -Fpfn 2>/dev/null); ET=$(ps -o pid=,etime= -p "$CL" 2>/dev/null); fi; for p in $CP; do if [ -d /proc/self/fd ]; then fds=$(ls -l "/proc/$p/fd" 2>/dev/null); else fds=$(printf '%s\\n' "$LS" | awk -v p="p$p" '/^p/{on=($0==p);next} on&&/^n/'); fi; [ -n "$fds" ] || continue; rp=$(printf '%s\\n' "$fds" | grep -o '/[^ ]*rollout-[^ ]*[.]jsonl' | head -n 1); if [ -n "$rp" ]; then printf 'codex %s %s\\n' "$p" "\${rp##*/}"; e=$(tail -c 65536 "$rp" 2>/dev/null | grep -oE '"type":"(task_started|task_complete|turn_aborted)"' | tail -n 1 | cut -d'"' -f4); m=$(stat -c %Y "$rp" 2>/dev/null || stat -f %m "$rp" 2>/dev/null); [ -n "$e" ] && printf 'codexstat %s %s %s\\n' "$p" "$e" "\${m:-0}"; continue; fi; w=$(readlink "/proc/$p/cwd" 2>/dev/null || printf '%s\\n' "$LS" | awk -v p="p$p" '/^p/{on=($0==p);c=0;next} /^f/{c=on&&$0=="fcwd";next} c&&/^n/{print substr($0,2);exit}'); et=$(printf '%s\\n' "$ET" | awk -v p="$p" '$1==p{print $2;exit}'); [ -n "$et" ] || et=$(ps -o etime= -p "$p" 2>/dev/null | tr -d ' '); if [ -n "$w" ] && [ -n "$et" ]; then printf 'codexproc %s %s %s\\n' "$p" "$et" "$w"; cx=1; fi; done; if [ -n "$cx" ]; then printf 'codexnow %s\\n' "$(date +%s)"; set --; for f in $(find "\${CODEX_HOME:-$HOME/.codex}/sessions" -name 'rollout-*.jsonl' -mmin -4320 2>/dev/null | xargs ls -t 2>/dev/null | head -n 16); do set -- "$@" "$f"; done; [ $# -gt 0 ] && { if stat -c %Y / >/dev/null 2>&1; then stat -c '@@M %Y %n' "$@" 2>/dev/null; else stat -f '@@M %m %N' "$@" 2>/dev/null; fi; for f; do printf '\\n@@F %s\\n' "$f"; head -c 4000 "$f" 2>/dev/null; printf '\\n@@T\\n'; tail -c 65536 "$f" 2>/dev/null; done; } | awk '${CODEX_AWK}'; fi; :`,
  // Claude background jobs ("moved to the background"): ~/.claude*/jobs/<id>/state.json as Claude writes it — state, tempo
  // (active / blocked / idle), what it needs from you, its last line of work. Newest 30 per account folder.
  `echo '@@JOBS'; for d in "$HOME/.claude/jobs" "$HOME"/.claude-*/jobs "\${CLAUDE_CONFIG_DIR:-/nonexistent}/jobs"; do [ -d "$d" ] || continue; set --; for f in $(ls -t "$d"/*/state.json 2>/dev/null | head -n 20); do set -- "$@" "$f"; done; [ $# -gt 0 ] && awk '${JOBS_AWK}' "$@" 2>/dev/null; done; :`,
  `command -v tmux >/dev/null 2>&1 || { echo '@@NOTMUX'; exit 0; }`,
  `echo '@@SESS'`,
  `tmux -u list-sessions -F '#{session_id}${SEP}#{session_name}${SEP}#{session_attached}${SEP}#{session_created}${SEP}#{session_activity}${SEP}#{pane_current_command}${SEP}#{pane_width}x#{pane_height}${SEP}#{pane_current_path}' 2>/dev/null`,
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
    aiAccounts: [], sound: false, autoRestoreLocal: false, autoRestoreRemote: false, backupMinutes: 60, allowPassword: false, pets: {}, commands: ['git status', 'git pull', 'npm test'] };
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
  if (input.autoRestoreRemote !== undefined) {
    if (typeof input.autoRestoreRemote !== 'boolean') throw new Error('Invalid auto restore');
    out.autoRestoreRemote = input.autoRestoreRemote;
  }
  if (input.allowPassword !== undefined) {
    if (typeof input.allowPassword !== 'boolean') throw new Error('Invalid password policy');
    out.allowPassword = input.allowPassword;
  }
  if (input.backupMinutes !== undefined) {
    if (![15, 60, 360, 1440].includes(input.backupMinutes)) throw new Error('Invalid backup interval');
    out.backupMinutes = input.backupMinutes;
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
function syncKnown(known, bootId, liveSessions, now = Date.now()) {
  const before = known || { bootId: '', sessions: {} };
  const sessions = { ...before.sessions };
  const lost = new Set(before.lost || []);
  const live = new Set(liveSessions.map((s) => s.name));
  // macOS boot ids moved from drifting kern.boottime seconds ("darwin:1793880616") to the boot session UUID: that one
  // change of format is not a reboot (it would mark stopped sessions as lost and could auto-restore them).
  const reformatted = /^darwin:\d+$/.test(before.bootId || '') && /^darwin:[0-9a-f-]{36}$/i.test(bootId || '');
  const reboot = !!(bootId && before.bootId && bootId !== before.bootId && !reformatted);
  for (const name of Object.keys(sessions)) {
    if (live.has(name)) lost.delete(name);
    else if (reboot) lost.add(name);
    else if (bootId && before.bootId && !lost.has(name)) delete sessions[name];
  }
  for (const s of liveSessions) {
    const prev = Object.hasOwn(sessions, s.name) ? sessions[s.name] : null;
    // What runs now decides what a restore starts: the agent and its conversation, a shell, or (another program) what it was.
    // A shell replaces a recorded agent only once the session is older than two minutes: right after a (re)start the pane shows
    // the shell before the agent comes up, and that moment must not forget the conversation.
    // It must also stay a shell for a minute: a reboot can stop the agent a moment before tmux, and one poll then sees a shell.
    const settled = s.created > 0 && now / 1000 - s.created > 120;
    const atShell = SHELLS.test(s.cmd) && !s.aiTool;
    const shellAt = atShell && settled && prev?.resume ? prev.shellAt || now : 0;
    const shell = atShell && (!prev || prev.run === 'shell' || (prev.resume ? shellAt && now - shellAt >= 60000 : settled));
    const run = s.aiTool || (CLAUDE.test(s.cmd) ? 'claude' : /codex/i.test(s.cmd) ? 'codex' : shell || !prev ? 'shell' : prev.run);
    const next = { dir: (s.aiTool && s.aiCwd) || prev?.dir || s.path, run };
    const resume = s.aiTool ? s.aiSessionId : run === prev?.run ? prev?.resume : '';
    if (resume && UUID.test(resume)) { next.resume = resume; if (shellAt && run !== 'shell') next.shellAt = shellAt; }
    const flags = s.aiTool ? s.aiFlags : run === prev?.run ? prev?.flags : null;
    if (Array.isArray(flags) && flags.length) next.flags = flags.slice(0, 12);
    if (!prev || JSON.stringify(prev) !== JSON.stringify(next)) {
      Object.defineProperty(sessions, s.name, { value: next, enumerable: true, configurable: true, writable: true });
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
const CHROME = /auto mode|shift\+tab|for shortcuts|esc to interrupt|bypass permissions|accept edits|ctrl\+[a-z]|⏵⏵|▸▸|new task\?|\/clear to save|auto-updating|update installed|restart to update|update available|^[\s─━═\-_•·|]+$|^\s*[❯>]\s*$/i;   // the footer notices ("new task? /clear…", "Auto-updating…") come and go on their own
const WORKING = /esc to interrupt|ctrl\+c to interrupt/i;
function isWorking(lines) { return lines.slice(-8).some((line) => WORKING.test(line)); }
function contentSignature(lines) {
  return lines.filter((line) => line.trim() && !CHROME.test(line)).slice(-10)
    .map((line) => line.toLowerCase().replace(/[\d\u2800-\u28ff✻✶✳✢✽*·•|/\\—–…\-]/g, '').replace(/\s+/g, ' ').trim()).join('\n');
}
// The lines a screen shows, as the signature sees them (no digits, glyphs or status bars): each with the start of the line
// (its identity, kept when the line is cut at the edge) and its words of at least 3 letters.
function screenLines(lines) {
  return lines.filter((line) => line.trim() && !CHROME.test(line)).map((line) => {
    const norm = line.toLowerCase().replace(/[\d\u2800-\u28ff✻✶✳✢✽*·•|/\\—–…\-]/g, ' ').replace(/\s+/g, ' ').trim();
    return { key: norm.slice(0, 14), words: norm.split(' ').filter((w) => w.length >= 3) };
  }).filter((l) => l.key);
}
const SEEN_MAX = 2500;
// rec: what was seen so far ({sig, at, words, list, keys}); returns the new record and how long the session has really been quiet (seconds).
// A session counts as active only when a line it never showed before carries words it never showed before. Opening it in a terminal,
// resizing, or another client attaching reflows and truncates the text (a line cut at the edge and later shown in full, a paragraph
// wrapped differently, older lines scrolling into the window) and that must not look like work.
function screenQuiet(rec, lines, activityAge, nowMs, size = '') {
  const sig = contentSignature(lines), rows = screenLines(lines);
  let at, list, known, keys;
  if (!rec) {
    // First look (server just started): tmux's own activity clock also moves when a terminal attaches, detaches or resizes,
    // so it cannot be trusted to say the session is working. Real work shows as new words on the next look (or "esc to interrupt").
    at = nowMs - Math.max(activityAge, CLAUDE_QUIET_SECONDS) * 1000; list = []; known = new Set(); keys = new Set();
    for (const r of rows) { keys.add(r.key); for (const w of r.words) if (!known.has(w)) { known.add(w); list.push(w); } }
  } else {
    list = rec.list || []; known = rec.words || new Set(list); keys = rec.keys || new Set();
    let text = null, fresh = false;
    for (const r of rows) {
      const newLine = !keys.has(r.key); keys.add(r.key);
      for (const w of r.words) {
        if (known.has(w)) continue;
        if (newLine && !fresh) { text = text === null ? list.join(' ') : text; if (!text.includes(w)) fresh = true; }   // a piece of a known word is not new either
        known.add(w); list.push(w);
      }
    }
    // The pane changed size (a terminal attached, the window was resized): the text is laid out again and older lines scroll into
    // view, none of which is work. Learn the new text, but do not count it.
    const resized = Boolean(size && rec.size && size !== rec.size);
    at = fresh && !resized ? nowMs : rec.at;
    if (list.length > SEEN_MAX) { list = list.slice(-Math.floor(SEEN_MAX * 0.8)); known = new Set(list); }
    if (keys.size > SEEN_MAX) keys = new Set(Array.from(keys).slice(-Math.floor(SEEN_MAX * 0.8)));
  }
  return { rec: { sig, at, words: known, list, keys, size }, quiet: isWorking(lines) ? 0 : Math.max(0, (nowMs - at) / 1000) };
}
function classify({ cmd, lines, activityAge }) {
  const tail = screenTail({ cmd, lines });
  if (ASKING.test(tail)) return 'wait';
  if (SHELLS.test(cmd)) return 'idle';
  const agent = AGENT_CMD.test(cmd) || CODEX_SCREEN.test(lines.slice(-8).join('\n'));
  if (agent && activityAge >= CLAUDE_QUIET_SECONDS) return 'wait';
  return 'run';
}

// The agent's own status file, when there is one, decides run / wait / idle for every view (sidebar, cards, filters, Ops);
// the screen-based classification is kept only for sessions without such a file. stateSource says which one decided.
//   busy → run · waiting → wait + asking · idle → wait (done, waiting for the next instruction)
//   aborted (Codex) → wait · conversation moved to Claude's background list → idle (nothing runs in this pane)
// Claude writes "idle" a fraction of a second after it starts (and again when a conversation is resumed). That status
// means "ready", not "finished a turn": no turn can start and end within this window of the process starting.
const FRESH_START_MS = 5000;
function freshStart(startedAt, at) { return startedAt > 0 && at >= startedAt && at - startedAt < FRESH_START_MS; }

// "[[dd-]hh:]mm:ss" from ps -o etime, in seconds.
function elapsed(t) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(t || '');
  return m ? ((Number(m[1] || 0) * 24 + Number(m[2] || 0)) * 60 + Number(m[3])) * 60 + Number(m[4]) : -1;
}

// Match each Codex process to its own rollout: same folder, created after the process started (Codex writes the session's
// start time in the first line). The most recently started process chooses first, so two Codex in one folder do not share
// a rollout. "Fresh" (opened, no turn yet) is decided only when every rollout written since the process started was seen.
function matchCodex(procs, rolls, now, agentIds, agentStats, resumeOf = () => '') {
  if (!now || !procs.length) return;
  const taken = new Set(), oldest = rolls.length ? Math.min(...rolls.map((r) => r.mtime)) : Infinity, full = rolls.length < 16;
  for (const p of procs.filter((x) => x.age >= 0).sort((a, b) => a.age - b.age)) {
    const start = now - p.age;
    // "codex resume <id>" continues an older rollout: that file, by its id.
    const resumed = resumeOf(p.pid), mine = resumed ? rolls.find((r) => r.file.includes(resumed)) :
      rolls.filter((r) => !taken.has(r.file) && r.cwd === p.cwd && r.created >= start - 2).sort((a, b) => b.mtime - a.mtime)[0];
    if (mine) {
      taken.add(mine.file);
      const id = agentId('codex', mine.file); if (id) agentIds.set(p.pid, id);
      if (mine.event !== '-') agentStats.set(p.pid, { tool: 'codex', status: mine.event === 'task_started' ? 'busy' : mine.event === 'turn_aborted' ? 'aborted' : 'idle', at: mine.mtime * 1000 });
      else agentStats.set(p.pid, { tool: 'codex', status: 'idle', at: 0, fresh: true });
    } else if (!resumed && (full && p.age < 4300 * 60 || oldest < start)) agentStats.set(p.pid, { tool: 'codex', status: 'idle', at: 0, fresh: true });
  }
}

function officialState(s) {
  const st = s.aiStatus;
  if (!st) {
    s.stateSource = 'screen';
    // An agent whose own status cannot be read is never declared finished or asking from what its screen shows
    // (an old "done 3:46 AM" line, a pause while the owner types). Activity on screen may still read as running.
    if (s.aiTool || AGENT_CMD.test(s.cmd || '')) { if (s.state === 'wait') s.state = 'idle'; s.asking = false; s.statusUnknown = true; }
    else delete s.statusUnknown;
    return;
  }
  delete s.statusUnknown;
  s.stateSource = 'status';
  if (st.parked) {
    const j = st.job;   // the background process holding the conversation, when there is one
    if (!j) { s.state = 'idle'; s.asking = false; return; }
    s.state = j.status === 'busy' ? 'run' : 'wait'; s.asking = j.status === 'waiting'; return;
  }
  if (st.status === 'busy') { s.state = 'run'; s.asking = false; return; }
  if (st.status === 'waiting') { s.state = 'wait'; s.asking = true; return; }
  // Opened but never given work: nothing finished and nothing is waiting for the owner.
  if (st.fresh) { s.state = 'idle'; s.asking = false; return; }
  s.state = 'wait'; s.asking = false;
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

// The model the running agent was started with ("--model X" / "-m X"): only this derived token leaves the machine, never the command line.
function modelOf(args) { const m = /(?:^|\s)(?:--model|-m)(?:=|\s+)([\w./:-]{2,60})(?=\s|$)/.exec(args); return m ? m[1] : ''; }

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
    if (owner) { owner.kind = kind; owner.model = modelOf(p.args); }
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
  const agentIds = new Map(), agentStats = new Map();
  const codexProcs = [], codexRolls = []; let codexNow = 0;
  res.bgAgents = []; res.jobs = [];
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
      // Linux prints seconds (etimes); macOS has no etimes and prints [[dd-]hh:]mm:ss (etime).
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+((?:\d+-)?(?:\d+:){0,2}\d+)\s+(.*)$/);
      if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), elapsed: elapsedSec(m[3]), args: m[4] });
    } else if (section === 'PSOK') {
      if (line.trim() === '1') res.workersReliable = true;
    } else if (section === 'FOREGROUND') {
      const f = line.trim().split(/\s+/).map(Number);
      if (f.length === 3 && f[1] > 0 && f[1] === f[2]) foreground.add(f[0]);
    } else if (section === 'PANEENV') {
      const m = line.match(/^(\d+)\s+(%\d+)$/);
      if (m) paneEnv.set(Number(m[1]), m[2]);
    } else if (section === 'AGENTIDS') {
      // Official state the agent writes itself: Claude's session file status, Codex's last turn event in its rollout.
      // pid kind status statusUpdatedAt waitingFor parked startedAt configFolder name
      // Any status word Claude writes. "shell" (newer Claude Code: its turn ended while background shells still run) is work
      // in progress, so it reads as busy and is never reminded; an unknown word stays as is and never counts as idle.
      const st = line.match(/^claudestat (\d+) ([a-z]+) ([a-z_]{1,20}) (\d+) (\S+) ([01]) (\d+) ([\w./-]{1,80}) ?(.*)$/);
      if (st) { const v = { tool: 'claude', kind: st[2], status: st[3] === 'shell' ? 'busy' : st[3], at: Number(st[4]) || 0, waitingFor: st[5] === '-' ? '' : st[5], parked: st[6] === '1', startedAt: Number(st[7]) || 0, cfg: st[8], name: st[9].slice(0, 80), pid: Number(st[1]) }; if (v.status === 'idle' && freshStart(v.startedAt, v.at)) v.fresh = true; agentStats.set(Number(st[1]), v); if (v.kind === 'bg') res.bgAgents.push(v); continue; }
      const cs = line.match(/^codexstat (\d+) (task_started|task_complete|turn_aborted) (\d+)$/);
      if (cs) { agentStats.set(Number(cs[1]), { tool: 'codex', status: cs[2] === 'task_started' ? 'busy' : cs[2] === 'turn_aborted' ? 'aborted' : 'idle', at: Number(cs[3]) * 1000 }); continue; }
      // Newer Codex closes its rollout between writes: the process (age, folder) and the recent rollouts, matched after the loop.
      const cp = line.match(/^codexproc (\d+) ([\d:-]{1,16}) (\/.*)$/);
      if (cp) { codexProcs.push({ pid: Number(cp[1]), age: elapsed(cp[2]), cwd: cp[3] }); continue; }
      const cr = line.match(/^codexroll (\d+) (\S+) (task_started|task_complete|turn_aborted|-) (rollout-\S+\.jsonl) (\/.*)$/);
      if (cr) { codexRolls.push({ mtime: Number(cr[1]), created: Date.parse(cr[2]) / 1000 || 0, event: cr[3], file: cr[4], cwd: cr[5] }); continue; }
      const cn = line.match(/^codexnow (\d+)$/);
      if (cn) { codexNow = Number(cn[1]); continue; }
      const m = line.match(/^(claude|codex) (\d+) (.+)$/);
      if (m) { const id = agentId(m[1], m[3]); if (id) agentIds.set(Number(m[2]), id); }
    } else if (section === 'JOBS') {
      // "@@J <id>" starts a job; the next lines are its "key": "value" pairs as grep found them in state.json.
      const head = /^@@J ([\w-]{1,64})$/.exec(line);
      if (head) { res.jobs.push({ id: head[1], state: '', tempo: '', at: 0, tasks: 0, needs: '', detail: '', name: '' }); continue; }
      const kv = /^"(state|tempo|updatedAt|needs|detail|name|tasks)": *"?([^"]*)"?$/.exec(line), job = res.jobs[res.jobs.length - 1];
      if (kv && job) {
        const max = { state: 20, tempo: 20, needs: 160, detail: 160, name: 80 };
        if (kv[1] === 'updatedAt') job.at = Date.parse(kv[2]) || 0;
        else if (kv[1] === 'tasks') job.tasks = Number(kv[2]) || 0;
        else if (!job[kv[1]]) job[kv[1]] = kv[2].slice(0, max[kv[1]]);
      }
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
      const sized = /^\d+x\d+$/.test(f[6] || '');   // the pane size comes before the path (older replies have no size)
      const s = {
        id: f[0], name: f[1], attached: Number(f[2]) || 0, created: Number(f[3]) || 0,
        activity: Number(f[4]) || 0, cmd: f[5], size: sized ? f[6] : '', path: f.slice(sized ? 7 : 6).join(SEP), lines: [],
      };
      byId.set(s.id, s);
      res.sessions.push(s);
    } else if (section === 'OWNERS') {
      const f = line.split(SEP), session = byId.get(f[0]);
      if (session && /^\d+$/.test(f[1])) {
        const paneId = /^%\d+$/.test(f[2] || '') ? f[2] : '';
        owners.push({ ...session, panePid: Number(f[1]), paneId });
        if (paneId) (session.paneIds ||= []).push(paneId);   // tmux pane ids, as crew's nudge.conf names them
      }
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
  matchCodex(codexProcs, codexRolls, codexNow, agentIds, agentStats, (pid) => {
    const p = procs.find((x) => x.pid === pid), m = p && /(?:^|\/)codex\s+resume\s+([a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})(?:\s|$)/i.exec(p.args);
    return m ? m[1] : '';
  });
  const byPidAll = new Map(procs.map((p) => [p.pid, p]));
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
    for (const p of procs) {
      // A stale <pid>.json from before a reboot may name a pid now reused by something else: the process must be that agent.
      const known = descendants.has(p.pid) && agentIds.get(p.pid);
      if (known && !(known.tool === 'claude' ? CLAUDE : /codex/i).test(p.args.split(/\s+/).slice(0, 2).join(' '))) continue;
      if (known) { s.aiTool = known.tool; s.aiSessionId = known.id; if (known.cwd) s.aiCwd = known.cwd; }
      const stat = descendants.has(p.pid) && agentStats.get(p.pid);
      if (stat && (!known || known.tool === stat.tool)) (s._stats ||= []).push(stat);
    }
    // A pane may hold two Claude processes: the interactive one and, once its conversation was moved to the background, the
    // background process that now holds that conversation. The interactive one is the session; while it is parked, the
    // background one's status is the status of the conversation shown there.
    if (s._stats) {
      const inter = s._stats.find((x) => x.kind !== 'bg' && !x.fresh) || s._stats.find((x) => x.kind !== 'bg'), bg = s._stats.find((x) => x.kind === 'bg'), main = inter || bg;
      if (main.pid) s.aiPid = main.pid;   // the agent's own process: its binary is the one to ask about plugins
      s.aiStatus = { tool: main.tool, status: main.status, at: main.at, waitingFor: main.waitingFor || '', ...(main.fresh && !main.parked ? { fresh: true } : {}), ...(main.parked ? { parked: true } : {}), ...(main.startedAt ? { startedAt: main.startedAt, cfg: main.cfg } : {}),
        ...(inter && inter.parked && bg ? { job: { status: bg.status, at: bg.at, waitingFor: bg.waitingFor || '', ...(bg.startedAt ? { startedAt: bg.startedAt } : {}) } } : {}) };
      delete s._stats;
    }
    officialState(s);
    // Launch options worth keeping across a restore (model, permission mode), from the agent's own command line.
    if (s.aiTool) {
      const ap = (s.aiPid && byPidAll.get(s.aiPid)) || procs.find((p) => descendants.has(p.pid) && (s.aiTool === 'claude' ? CLAUDE : /codex/i).test(p.args.split(/\s+/).slice(0, 2).join(' ')));
      const flags = ap ? safeFlags(s.aiTool, ap.args.replace(/^\S*\/(node|bun)\s+\S*\//, '')) : [];
      if (flags.length) s.aiFlags = flags;
    }
    s.petActivity = s.state === 'run' ? activity(s.cmd) : 'normal';
    if (s.state === 'run') for (const p of procs) {
      if (descendants.has(p.pid) && foreground.has(p.pid) && activity(p.args) !== 'normal') s.petActivity = activity(p.args);
    }
    s.pane_pid = s.panePid;
    delete s.panePid;
    // Keep the tmux session id ($N): a crew leader's live identity needs it. Deleting it made every real leader
    // identity invalid, so neither registration nor auto-enrolment ever matched outside the test fixtures.
  }
  return res;
}

module.exports = { freshStart, officialState, agentId, SLOW_SCRIPT, cleanPrefs, mergePrefs, networkSpeed, parseSlow, syncKnown, POLL_SCRIPT, claudeSessionId, classify, isAsking, isWorking, contentSignature, screenQuiet, findWorkers, parseDirs, parsePoll, shq, validDir, validHost, validName, validUser };
