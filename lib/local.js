'use strict';
const { tr } = require('./i18n-server');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');
const { StringDecoder } = require('string_decoder');
const { Backend } = require('./backend');
const { shq, claudeSessionId, parsePoll } = require('./parse');


const PLAIN_REPLAY = 8 * 1048576;
// The replayed output of a plain session. When old output was dropped, start at a line boundary so the first line is not
// half an escape sequence.
function plainReplay(session) {
  const all = session.chunks.join('');
  if (!session.trimmed) return all;
  const nl = all.indexOf('\n');
  return nl >= 0 && nl < 4096 ? all.slice(nl + 1) : all;
}

function command(file, args, timeout = 10000, maxBuffer = 4 * 1024 * 1024, input = null) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { encoding: 'utf8', timeout, maxBuffer, windowsHide: true }, (err, out, stderr) => {
      if (err && typeof err.code !== 'number') { reject(err); return; }
      resolve({ code: err?.code || 0, out, err: stderr });
    });
    if (input != null) { child.stdin.on('error', () => { /* the child exited before reading everything */ }); child.stdin.end(input); }
  });
}
function psQuote(value) { return "'" + String(value).replace(/'/g, "''") + "'"; }
const PS_UTF8 = '[Console]::InputEncoding = [Console]::OutputEncoding = $OutputEncoding = New-Object System.Text.UTF8Encoding; ';
async function selectMode(platform, run = command) {
  if (platform !== 'win32') return 'native';
  try { if ((await run('wsl.exe', ['--exec', 'sh', '-c', 'true'])).code === 0) return 'wsl'; } catch { /* WSL not installed */ }
  return 'powershell';
}
async function bootId(platform, run = command) {
  try {
    // macOS: the boot session UUID. kern.boottime seconds drift with clock corrections, so they cannot identify a boot.
    const spec = platform === 'darwin' ? ['/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']] :
      platform === 'win32' ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_UTF8 + '(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString("o")']] :
        ['cat', ['/proc/sys/kernel/random/boot_id']];
    const result = await run(...spec);
    if (result.code !== 0) return '';
    const value = result.out.trim();
    return value ? `${platform}:${value}` : '';
  } catch { return ''; }
}

// macOS has no /proc. ps reports per-core process CPU; normalize by logical cores.
async function darwinMetrics(run=command) {
  const results=await Promise.allSettled([
    run('/usr/sbin/sysctl',['-n','hw.memsize','hw.logicalcpu']),
    run('/usr/bin/vm_stat',[]),run('/bin/ps',['-A','-o','%cpu='])
  ]);
  const out=i=>results[i].status==='fulfilled' && results[i].value.code===0 ? results[i].value.out : '';
  const hardware=out(0).trim().split(/\s+/).map(Number),total=hardware[0],cores=hardware[1];
  const pages=Number(out(1).match(/page size of (\d+) bytes/)?.[1]);
  const counts=['Pages active','Pages wired down','Pages occupied by compressor'].map(k=>Number(out(1).match(new RegExp(k+':\\s+(\\d+)'))?.[1]));
  const used=pages>0 && counts.every(Number.isFinite)?counts.reduce((a,b)=>a+b,0)*pages:null;
  const cpus=out(2).trim()?out(2).trim().split(/\s+/).map(Number):[];
  return {cpu:cores>0 && cpus.length && cpus.every(n=>Number.isFinite(n)&&n>=0)?Math.min(100,cpus.reduce((a,b)=>a+b,0)/cores):null,
    ram:total>0 && used!==null?Math.min(100,used/total*100):null,ramUsedGb:used===null?null:used/1024**3,ramTotalGb:total>0?total/1024**3:null,cores:cores>0?cores:null};
}

// Adapt node-pty to the stream contract also implemented by ssh2 channels.
function terminalStream(terminal, detach = true) {
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  const decoder = new StringDecoder('utf8');
  stream.write = (data) => terminal.write(Buffer.isBuffer(data) ? decoder.write(data) : data);
  stream.setWindow = (rows, cols) => terminal.resize(cols, rows);
  const data = terminal.onData((text) => stream.emit('data', Buffer.from(text, 'utf8')));
  const exit = terminal.onExit(() => stream.emit('close'));
  stream.close = () => { data.dispose(); exit.dispose(); if (detach) terminal.kill(); };
  return stream;
}

class Local extends Backend {
  constructor(cfg, onLearn, onPoll, options = {}) {
    super(cfg, onLearn, onPoll);
    this.platform = options.platform || process.platform;
    this.command = options.command || command;
    this.pty = options.pty || (() => require('node-pty'));
    this.mode = 'native';
    this.socket = process.env.TW_TMUX_SOCKET || '';
    this.terminals = new Set();
    this.plain = new Map();
    this.pendingPlain = new Set();
    this.instanceId = crypto.randomUUID();
  }
  get canAutoConnect() { return true; }
  async connect() {
    this.mode = await selectMode(this.platform, this.command);
    this.boot = await bootId(this.platform, this.command);
    this.ready = true; this.closing = false; this.error = '';
  }
  scheduleRetry() { /* Explicit reconnect is available when OS execution fails. */ }
  // A private socket is selected with a quoted wrapper, never by rewriting user input.
  exec(cmd, timeout = 10000, maxBuffer = 4 * 1024 * 1024, input = null) {
    if (!this.ready) return Promise.reject(Error('Local backend is not ready.'));
    if (this.mode === 'powershell') return Promise.reject(Error('Plain sessions do not support tmux commands.'));
    const prefix = this.socket ? `if command -v tmux >/dev/null 2>&1; then tmux() { command tmux -L ${shq(this.socket)} "$@"; }; fi\n` : '';
    // Internal callers use sh -c <script>. Add the same wrapper inside that shell.
    const wrapped = prefix ? `${prefix}sh() { command sh -c ${shq(prefix)}"$2"; };\n${cmd}` : cmd;
    return this.mode === 'wsl' ? this.command('wsl.exe', ['--exec', 'sh', '-c', wrapped], timeout, maxBuffer, input) : this.command('/bin/sh', ['-c', wrapped], timeout, maxBuffer, input);
  }
  async decorateSnapshot(snap) {
    snap.hostname = this.cfg.host;
    // Include WSL's own boot ID: a WSL restart also destroys its tmux server.
    snap.bootId = this.mode === 'wsl' ? [this.boot, snap.bootId].filter(Boolean).join('/') : this.boot;
    if (this.mode === 'native') {
      snap.sys.os = `${os.type()} ${os.release()}`;
      snap.sys.cores = os.cpus().length;
      if(this.platform==='darwin') { const metrics=await darwinMetrics(this.command);snap.cpu=metrics.cpu;snap.ram=metrics.ram;Object.assign(snap.sys,{ramUsedGb:metrics.ramUsedGb,ramTotalGb:metrics.ramTotalGb,cores:metrics.cores}); }
    }
  }
  async poll() {
    if (this.mode !== 'powershell') return super.poll();
    if (!this.ready || this.polling) return;
    const snap = parsePoll('@@HOST\n' + this.cfg.host + '\n@@END', Math.floor(Date.now() / 1000));
    snap.bootId = `${this.boot}/tool:${this.instanceId}`;
    snap.sessions = [...this.plain.values()].map((s) => ({ name: s.name, path: s.dir, cmd: s.run === 'shell' ? 'powershell' : s.run,
      created: s.created, attached: s.attachments, state: s.run === 'shell' ? 'idle' : 'run', lines: [], stateSince: s.created * 1000 }));
    this.snapshot = snap; this.lastPoll = Date.now(); this.onPoll(this, snap, this.sessionVersion);
  }
  spawn(file, args, cols, rows, cwd) {
    const terminal = this.pty().spawn(file, args, { name: 'xterm-256color', cols, rows,
      cwd: cwd || os.homedir(), env: { ...process.env, LANG: process.env.LANG || 'en_US.UTF-8' } });
    this.terminals.add(terminal);
    terminal.onExit(() => this.terminals.delete(terminal));
    return terminal;
  }
  attach(name, cols, rows, callback) {
    // The option must be in place before the client attaches (see remote.js): otherwise the first attach is sized by the smaller viewer.
    this.sized ||= new Set();
    if (this.mode === 'powershell' || this.sized.has(name)) { this.attachNow(name, cols, rows, callback); return; }
    this.sized.add(name);
    this.exec(`tmux set-option -q -t ${shq(`=${name}`)} window-size latest`, 5000).catch(() => { /* older tmux: option unknown */ }).then(() => this.attachNow(name, cols, rows, callback));
  }
  attachNow(name, cols, rows, callback) {
    try {
      if (this.mode === 'powershell') {
        const session = this.plain.get(name);
        if (!session) throw Error(tr('srv.local.khong_thay_phien'));
        session.attachments++;
        session.terminal.resize(cols, rows);
        const stream = terminalStream(session.terminal, false);
        const close = stream.close;
        stream.close = () => { close(); session.attachments--; };
        callback(null, stream);
        // Replay bounded output when attaching/reconnecting.
        queueMicrotask(() => stream.emit('data', Buffer.from(plainReplay(session), 'utf8')));
        return;
      }
      // Two viewers of one session otherwise shrink it to the smaller one and fill the rest with dots.
      const args = [...(this.socket ? ['-L', this.socket] : []), '-u', 'attach-session', '-t', `=${name}`];
      const terminal = this.mode === 'wsl' ? this.spawn('wsl.exe', ['--exec', 'tmux', ...args], cols, rows) : this.spawn('tmux', args, cols, rows);
      callback(null, terminalStream(terminal));
    } catch (err) { callback(err); }
  }
  async codexLaunch(restoring) {
    if (!restoring) return 'codex';
    try {
      const help = this.mode === 'powershell'
        ? await this.command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_UTF8 + '& codex resume --help'])
        : await this.exec('codex resume --help');
      // The picker is cwd-filtered; never use --last (two sessions may share a directory).
      if (help.code === 0 && /Usage:\s*codex resume\b/i.test(help.out)) return 'codex resume';
    } catch { /* CLI not installed or this version cannot resume */ }
    return 'codex';
  }
  async startPlain(options) {
    if (this.pendingPlain.has(options.name)) throw Error('Session creation is already in progress.');
    this.pendingPlain.add(options.name);
    try { return await this.createPlain(options); }
    finally { this.pendingPlain.delete(options.name); }
  }
  async createPlain({ name, dir, run, restoring }) {
    if (this.plain.has(name)) throw Error(tr('srv.server.ten_nay_da_co'));
    const resolved = await fs.promises.realpath(dir || os.homedir());
    if (!(await fs.promises.stat(resolved)).isDirectory()) throw Error(tr('srv.server.khong_thay_thu_muc_nay'));
    let script = PS_UTF8;
    if (run === 'claude') {
      const id = claudeSessionId(resolved, name);
      script += `$root = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }; ` +
        `$saved = Get-ChildItem -LiteralPath (Join-Path $root 'projects') -Filter ${psQuote(id + '.jsonl')} -Recurse -ErrorAction SilentlyContinue; ` +
        `if ($saved) { & claude --resume ${psQuote(id)} } else { & claude --session-id ${psQuote(id)} --name ${psQuote(name)} }`;
    } else if (run === 'codex') script += '& ' + await this.codexLaunch(restoring);
    const terminal = this.spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NoExit', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], 100, 30, resolved);
    const session = { name, dir: resolved, run, terminal, created: Math.floor(Date.now() / 1000), attachments: 0, chunks: [], size: 0, trimmed: false };
    this.plain.set(name, session);
    // A plain (PowerShell) session has no tmux history: what a reopened view can scroll back through is this replay.
    // Keep the last ~8 MB (tens of thousands of lines) in chunks (no copy of the whole buffer per write); the oldest chunks drop off whole.
    terminal.onData((text) => {
      session.chunks.push(text); session.size += text.length;
      while (session.size > PLAIN_REPLAY && session.chunks.length > 1) { session.size -= session.chunks.shift().length; session.trimmed = true; }
    });
    terminal.onExit(() => this.plain.delete(name));
    return resolved;
  }
  killPlain(name) {
    const session = this.plain.get(name);
    if (!session) return false;
    this.plain.delete(name); session.terminal.kill(); return true;
  }
  // "Xóa lịch sử cuộn" on a plain session: forget the replay, so a reopened view starts from the current screen.
  clearPlain(name) {
    const session = this.plain.get(name);
    if (!session) return false;
    session.chunks = []; session.size = 0; session.trimmed = false; return true;
  }
  keysPlain(name, text, enter) {
    const session = this.plain.get(name);
    if (!session) throw Error(tr('srv.local.khong_thay_phien'));
    session.terminal.write(text + (enter ? '\r' : ''));
  }
  async listPlainDirs(dir) {
    const resolved = await fs.promises.realpath(dir || os.homedir());
    const all = (await fs.promises.readdir(resolved, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    // Every drive that answers (C:, D:, a mapped network drive …), so the browser is not stuck on the drive it opened on.
    const drives = process.platform !== 'win32' ? [] : (await Promise.all('CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) =>
      fs.promises.access(l + ':\\').then(() => ({ label: l + ':', path: l + ':\\' }), () => null)))).filter(Boolean);
    return { path: resolved, parent: path.dirname(resolved) === resolved ? null : path.dirname(resolved), dirs: all.slice(0, 500), truncated: all.length > 500, drives };
  }
  publicView() {
    return { ...super.publicView(), local: true, name: tr('srv.local.may_nay'), hostname: this.cfg.host, mode: this.mode,
      persistent: this.mode !== 'powershell',
      guidance: this.mode === 'powershell' ? tr('srv.local.phien_thuong_dong_tool_la') :
        this.mode === 'wsl' ? tr('srv.local.cai_trong_wsl_sudo_apt') : this.platform === 'darwin' ? 'brew install tmux' : 'sudo apt install tmux (Ubuntu/Debian); sudo dnf install tmux (Fedora)' };
  }
  close() {
    this.closing = true; this.ready = false;
    for (const terminal of this.terminals) { try { terminal.kill(); } catch { /* already exited */ } }
    this.terminals.clear(); this.plain.clear();
  }
}
module.exports = { plainReplay, PLAIN_REPLAY, darwinMetrics, Local, command, selectMode, bootId, psQuote, terminalStream };
