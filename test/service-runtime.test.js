'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { readPassword, readProtected, unlockFromFile, acquireDataLock, validateWindowsSecurity, directoryIdentity, processIdentity } = require('../lib/service-runtime');
const { Vault } = require('../lib/vault');
function privateWindowsDirectory(dir) {
  // Native fixture only. Fixed SID-based ACL on a newly-created temp directory, no existing accounts/files.
  const ps = `[Console]::InputEncoding=New-Object Text.UTF8Encoding($false);$p=[Console]::In.ReadToEnd();$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;
$a=New-Object Security.AccessControl.DirectorySecurity;$a.SetOwner($sid);$a.SetAccessRuleProtection($true,$false);
foreach($id in @($sid.Value,'S-1-5-18','S-1-5-32-544')) {
$r=New-Object Security.AccessControl.FileSystemAccessRule(([Security.Principal.SecurityIdentifier]$id),'FullControl','ContainerInherit,ObjectInherit','None','Allow');$a.AddAccessRule($r)};
Set-Acl -LiteralPath $p -AclObject $a`;
  execFileSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')],
    { input: dir, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
}
const ROOT = path.resolve(__dirname, '..'), SECRET = 'fixture-secret-never-log-this';
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termnest-runtime-'));
  fs.chmodSync(dir, 0o700);
  if (process.platform === 'win32') privateWindowsDirectory(dir);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'password');
  fs.writeFileSync(file, SECRET + '\n', { mode: 0o600 });
  return { dir, file };
}
function noLeak(fn, pattern, message) {
  assert.throws(fn, e => { assert.doesNotMatch(e.message + JSON.stringify(e), new RegExp(SECRET)); return pattern.test(e.code); }, message);
}

test('protected reader accepts owner-only regular files, bounded UTF-8 and a single optional line ending', t => {
  const f = fixture(t);
  assert.equal(readPassword(f.file), SECRET);
  const io = Object.create(fs);
  io.lstatSync = p => fs.lstatSync(p);
  io.fstatSync = fd => fs.fstatSync(fd);
  if (process.platform !== 'win32') assert.equal(readPassword(f.file, io), SECRET, 'injected numeric Stats remain supported');
  // NTFS 64-bit file IDs require BigInt: rounding numeric Stats cannot establish security identity.
  else if (fs.lstatSync(f.file, { bigint: true }).ino > BigInt(Number.MAX_SAFE_INTEGER)) {
    assert.throws(() => readPassword(f.file, io), { code: 'RUNTIME_UNSAFE_PERMISSIONS' });
  } else assert.equal(readPassword(f.file, io), SECRET);
  for (const text of ['Tiếng Việt secret\r\n', ' space preserved ', 'x']) {
    fs.writeFileSync(f.file, text); assert.equal(readPassword(f.file), text.replace(/\r?\n$/, ''));
  }
  for (const value of ['', '  \n', 'one\ntwo\n', 'one\r', '\ufeffx', '\u0000x', 'x'.repeat(4097), Buffer.from([0xff, 0xfe])]) {
    fs.writeFileSync(f.file, value); noLeak(() => readPassword(f.file), /^RUNTIME_/);
  }
  noLeak(() => readPassword(path.join(f.dir, SECRET)), /^RUNTIME_/);
  noLeak(() => readPassword(f.dir), /^RUNTIME_/);
});

test('symlinks, hardlinks, unsafe Unix mode and owner are refused without printing content', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t), symlink = path.join(f.dir, 'symlink'), hardlink = path.join(f.dir, 'hardlink');
  fs.symlinkSync(f.file, symlink);
  noLeak(() => readPassword(symlink), /RUNTIME_UNSAFE/);
  fs.linkSync(f.file, hardlink); noLeak(() => readPassword(hardlink), /RUNTIME_UNSAFE/); fs.unlinkSync(hardlink);
  for (const mode of [0o644, 0o640, 0o660, 0o604]) { fs.chmodSync(f.file, mode); noLeak(() => readPassword(f.file), /RUNTIME_UNSAFE_PERMISSIONS/); }
  fs.chmodSync(f.file, 0o600);
  const io = Object.create(fs);
  io.lstatSync = p => { const st = fs.lstatSync(p); Object.defineProperty(st, 'uid', { value: process.getuid() + 1 }); return st; };
  noLeak(() => readPassword(f.file, io), /RUNTIME_UNSAFE_PERMISSIONS/);
});

test('bounded nofollow reader catches swap before open, replacement after read and growth during read', t => {
  const f = fixture(t), other = path.join(f.dir, 'other');
  fs.writeFileSync(other, SECRET, { mode: 0o600 });
  for (const moment of ['open', 'read']) {
    fs.writeFileSync(f.file, SECRET, { mode: 0o600 });
    const io = Object.create(fs); let swapped = false, replacementBlocked;
    const replace = p => {
      try { fs.unlinkSync(p); fs.copyFileSync(other, p); }
      catch (e) { if (process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) replacementBlocked = e.code; throw e; }
    };
    io.openSync = (p, flags) => {
      assert.ok(process.platform === 'win32' || (flags & fs.constants.O_NOFOLLOW));
      if (moment === 'open') replace(p);
      return fs.openSync(p, flags);
    };
    io.readSync = (...args) => {
      assert.ok(args[3] <= 4097);
      const n = fs.readSync(...args);
      if (moment === 'read' && !swapped) { swapped = true; replace(f.file); }
      return n;
    };
    noLeak(() => readPassword(f.file, io), { test: code => /RUNTIME_(UNSAFE_FILE|FILE_CHANGED)/.test(code) ||
      // Windows may refuse replacement of a still-open NTFS name; that OS refusal must also fail closed.
      !!replacementBlocked && code === 'RUNTIME_FILE_UNREADABLE' }, moment);
  }
  const io = Object.create(fs); let grew = false;
  io.readSync = (...args) => { if (!grew) { grew = true; fs.appendFileSync(f.file, 'x'.repeat(20000)); } return fs.readSync(...args); };
  noLeak(() => readPassword(f.file, io), /RUNTIME_FILE_CHANGED/);
});

test('reader rejects reused inode metadata with changes below millisecond precision before reading any content', t => {
  const f = fixture(t), base = fs.lstatSync(f.file, { bigint: process.platform === 'win32' });
  // Model inode reuse deterministically: identity/size and every millisecond field match, but one ns field differs.
  // Numeric Stats also exercise injected IO implementations that do not honor the bigint option.
  for (const field of ['birthtime', 'ctime', 'mtime']) {
    const before = Object.assign(Object.create(Object.getPrototypeOf(base)), base);
    for (const key of ['birthtime', 'ctime', 'mtime']) {
      before[key + 'Ms'] = 1800000000000;
      before[key + 'Ns'] = 1800000000000000001n;
    }
    const replaced = Object.assign(Object.create(Object.getPrototypeOf(before)), before, { [field + 'Ns']: before[field + 'Ns'] + 1n });
    assert.equal(before.dev, replaced.dev); assert.equal(before.ino, replaced.ino);
    assert.equal(before[field + 'Ms'], replaced[field + 'Ms']);
    const io = Object.create(fs), closed = []; let reads = 0;
    io.openSync = () => 71;
    io.lstatSync = () => before;
    io.fstatSync = () => replaced;
    io.readSync = (_fd, bytes, offset) => ++reads === 1 ? bytes.write(SECRET + '\n', offset) : 0;
    io.closeSync = fd => closed.push(fd);
    noLeak(() => readPassword(f.file, io), /RUNTIME_FILE_CHANGED/, field);
    assert.equal(reads, 0); assert.deepEqual(closed, [71]);
  }
});

test('reader pins the observed inode across path/open replacement even when all timestamps are identical', t => {
  const f = fixture(t), other = path.join(f.dir, 'replacement');
  fs.writeFileSync(other, SECRET + '\n', { mode: 0o600 });
  const io = Object.create(fs), handles = [], closed = []; let reads = 0, observed = false, replaced = false, replacementBlocked;
  const fixedTimes = st => {
    for (const key of ['birthtime', 'ctime', 'mtime']) { st[key + 'Ns'] = 1800000000000000000n; st[key + 'Ms'] = 1800000000000n; }
    return st;
  };
  io.lstatSync = (p, options) => {
    if (handles.length === 0) return fixedTimes(fs.lstatSync(p, options)); // Special-file preflight only.
    assert.equal(handles.length, 1, 'the reference must exist before observing the path');
    observed = true; return fixedTimes(fs.lstatSync(p, options));
  };
  io.openSync = (p, flags) => {
    if (handles.length === 1) {
      assert.equal(observed, true);
      const pinned = fs.fstatSync(handles[0], { bigint: true });
      try { fs.unlinkSync(p); }
      catch (e) { if (process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) replacementBlocked = e.code; throw e; }
      if (process.platform !== 'win32') assert.equal(fs.fstatSync(handles[0], { bigint: true }).nlink, 0n);
      try { fs.copyFileSync(other, p); }
      catch (e) { if (process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) replacementBlocked = e.code; throw e; }
      // The still-open reference makes inode reuse impossible; no filesystem clock resolution is assumed.
      assert.notEqual(fs.lstatSync(p, { bigint: true }).ino, pinned.ino);
      replaced = true;
    }
    const fd = fs.openSync(p, flags); handles.push(fd); return fd;
  };
  io.fstatSync = (fd, options) => fixedTimes(fs.fstatSync(fd, options));
  io.readSync = (...args) => { reads++; return fs.readSync(...args); };
  io.closeSync = fd => { closed.push(fd); fs.closeSync(fd); };
  noLeak(() => readPassword(f.file, io), { test: code => code === 'RUNTIME_FILE_CHANGED' ||
    !!replacementBlocked && code === 'RUNTIME_FILE_UNREADABLE' });
  assert.ok(replaced || process.platform === 'win32' && replacementBlocked, 'replacement must occur or be refused by NTFS'); assert.equal(reads, 0);
  assert.deepEqual(closed.sort(), handles.sort());
});

test('reader releases both descriptors after open, read or close failure without exposing content', t => {
  const f = fixture(t);
  for (const failure of ['open', 'read', 'close']) {
    const io = Object.create(fs), handles = [], closed = [];
    io.openSync = (...args) => {
      if (failure === 'open' && handles.length === 1) throw Error(SECRET);
      const fd = fs.openSync(...args); handles.push(fd); return fd;
    };
    io.readSync = (...args) => { if (failure === 'read') throw Error(SECRET); return fs.readSync(...args); };
    io.closeSync = fd => {
      fs.closeSync(fd); closed.push(fd);
      if (failure === 'close' && closed.length === 1) throw Error(SECRET);
    };
    noLeak(() => readPassword(f.file, io), /RUNTIME_FILE_UNREADABLE/, failure);
    assert.deepEqual(closed.sort(), handles.sort());
    for (const fd of handles) assert.throws(() => fs.fstatSync(fd), { code: 'EBADF' });
  }
});

test('FIFO credential never blocks startup', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t), fifo = path.join(f.dir, 'fifo');
  execFileSync('mkfifo', [fifo]); fs.chmodSync(fifo, 0o600);
  const started = Date.now(); noLeak(() => readPassword(fifo), /RUNTIME_UNSAFE_FILE/); assert.ok(Date.now() - started < 1000);
});

test('headless unlock validates the primary, initializes once and never writes plaintext or repairs corrupt primary', t => {
  const f = fixture(t), file = path.join(f.dir, 'vault.json');
  new Vault(file).create(SECRET, { servers: [], marker: 'fixture' });
  let calls = 0;
  const vault = new Vault(file);
  assert.equal(unlockFromFile(vault, undefined, () => calls++), false);
  assert.equal(vault.unlocked, false);
  assert.equal(unlockFromFile(vault, f.file, () => calls++), true);
  assert.equal(calls, 1); assert.equal(vault.data.marker, 'fixture');
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), new RegExp(SECRET));
  fs.writeFileSync(f.file, 'wrong');
  noLeak(() => unlockFromFile(new Vault(file), f.file, () => calls++), /RUNTIME_UNLOCK_FAILED/);
  fs.writeFileSync(f.file, SECRET);
  fs.writeFileSync(file, '{corrupt');
  noLeak(() => unlockFromFile(new Vault(file), f.file, () => calls++), /RUNTIME_UNLOCK_FAILED/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{corrupt'); assert.equal(calls, 1);
  fs.unlinkSync(file);
  noLeak(() => unlockFromFile(new Vault(file), f.file, () => calls++), /RUNTIME_UNLOCK_FAILED/);
});

async function freePort() {
  const s = net.createServer(); await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  const port = s.address().port; await new Promise(resolve => s.close(resolve)); return port;
}
// Exercise real server startup without touching tmux, SSH, agents or account directories.
const serverProgram = `
const Module = require('node:module'), load = Module._load;
if(process.env.TW_FIXTURE_FAST_TIMERS==='1'){
 const native=setInterval, clock=Date.now()+2*3600000;
 global.setInterval=(fn,ms,...args)=>{
  process.send?.({event:'timer',ms});
  return native(ms===15000?()=>{Date.now=()=>clock;fn(...args);}:fn,ms===15000?30:ms,...args);
 };
}
Module._load = function(name, parent, main) {
 if (name === './lib/backends' && parent.filename.endsWith('server.js')) {
  const real = load.apply(this, arguments);
  return {...real, createBackend: cfg => ({cfg, ready:false, snapshot:null, longHistory:[], lost:[], canAutoConnect:true,
   async connect(){this.ready=true;process.send?.({event:'connect',id:cfg.id});},
   async poll(){if(process.env.TW_FIXTURE_FAST_TIMERS==='1')process.send?.({event:'poll',id:cfg.id,at:Date.now()});},
   scheduleRetry(){}, close(){this.ready=false;}})};
 }
 return load.apply(this, arguments);
};
require('./server');`;
function child(t, f, env = {}) {
  const port = env.TW_PORT || '0';
  const c = spawn(process.execPath, ['-e', serverProgram], { cwd: ROOT, env: { ...process.env, TW_PASSWORD_FILE: f.file, TW_DATA: f.dir, TW_PORT: port, ...env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  c.output = ''; c.events = [];
  c.stdout.on('data', d => { c.output += d; }); c.stderr.on('data', d => { c.output += d; });
  c.on('message', m => c.events.push(m));
  c.done = once(c, 'exit');
  t.after(async () => { if (c.exitCode === null && c.signalCode === null) { c.kill('SIGKILL'); await c.done; } });
  return c;
}
async function waitFor(fn, c) {
  const until = Date.now() + (process.platform === 'win32' ? 90000 : 10000);
  while (!fn()) {
    if (c?.exitCode != null) throw Error('child exited: ' + c.output);
    if (Date.now() > until) throw Error('timed out: ' + (c?.output || ''));
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('boot existing vault unlocks and connects without creating any browser cookie; SIGTERM releases lock', async t => {
  const f = fixture(t), port = await freePort();
  new Vault(path.join(f.dir, 'vault.json')).create(SECRET, { servers: [{ id: 'fixture-remote', auth: 'key' }] });
  const c = child(t, f, { TW_PORT: String(port) });
  await waitFor(() => c.output.includes('Termnest:'), c);
  await waitFor(() => c.events.filter(e => e.event === 'connect').length === 2, c);
  const response = await fetch(`http://127.0.0.1:${port}/api/supervisor/status`);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.deepEqual(await response.json(), { processAlive: true, unlocked: true, monitoring: true, error: false, observationsFresh: false, validatedAuditCompletion: false });
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/status`)).json()).authed, false);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/state`)).status, 401);
  const result = await execFile(process.execPath, ['scripts/supervisor-check.js', '--port', String(port)], { cwd: ROOT });
  assert.deepEqual(JSON.parse(result.stdout), { state: 'monitoring', unlocked: true, monitoring: true, error: false, processAlive: true, observationsFresh: false, validatedAuditCompletion: false });
  assert.doesNotMatch(c.output + result.stdout, new RegExp(SECRET));
  c.kill('SIGTERM');
  const exit = (await c.done)[0];
  if (process.platform === 'win32') {
    assert.notEqual(exit, 0, 'Windows kill uses TerminateProcess rather than POSIX SIGTERM');
    const recovered = await acquireDataLock(f.dir); recovered.release(); await tick();
  } else assert.equal(exit, 0);
  assert.equal(fs.existsSync(path.join(f.dir, 'service.lock')), false);
});

test('enabled unattended server polls on its 15s schedule past browser inactivity with injected timer/clock and no HTTP requests', async t => {
  const f = fixture(t), before = Date.now();
  new Vault(path.join(f.dir, 'vault.json')).create(SECRET, { servers: [{ id: 'fixture-remote', auth: 'key' }], features: { crewpack: { enabled: true } } });
  const c = child(t, f, { TW_FIXTURE_FAST_TIMERS: '1' });
  const unattended = () => c.events.filter(e => e.event === 'poll' && e.at - before >= 3600000);
  await waitFor(() => unattended().length >= 4, c);
  assert.ok(c.events.filter(e => e.event === 'timer' && e.ms === 15000).length >= 2);
  assert.ok(unattended().length >= 4, 'repeated polls run after lastSeen is long stale');
  assert.deepEqual(new Set(unattended().map(e => e.id)), new Set([require('../lib/backends').LOCAL_ID, 'fixture-remote']));
  c.kill('SIGTERM'); const [code] = await c.done; if (process.platform !== 'win32') assert.equal(code, 0); assert.doesNotMatch(c.output, new RegExp(SECRET));
});

test('boot wrong credential, corrupt primary or missing credential fails closed, without a listener or connection', async t => {
  for (const kind of ['wrong', 'corrupt', 'missing']) {
    const f = fixture(t); new Vault(path.join(f.dir, 'vault.json')).create(SECRET, { servers: [] });
    if (kind === 'wrong') fs.writeFileSync(f.file, 'wrong');
    if (kind === 'corrupt') fs.writeFileSync(path.join(f.dir, 'vault.json'), '{corrupt');
    if (kind === 'missing') fs.unlinkSync(f.file);
    const c = child(t, f); assert.equal((await c.done)[0], 1);
    assert.equal(c.events.length, 0); assert.equal(c.output.trim(), 'RUNTIME_UNLOCK_FAILED');
    assert.equal(fs.existsSync(path.join(f.dir, 'service.lock')), false);
  }
});

test('no password-file env retains the interactive locked API and health behavior', async t => {
  const f = fixture(t), port = await freePort();
  new Vault(path.join(f.dir, 'vault.json')).create(SECRET, { servers: [] });
  const c = child(t, f, { TW_PASSWORD_FILE: undefined, TW_PORT: String(port) });
  await waitFor(() => c.output.includes('Termnest:'), c);
  assert.equal(c.events.length, 0);
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/api/supervisor/status`)).json(), { processAlive: true, unlocked: false, monitoring: false, error: false, observationsFresh: false, validatedAuditCompletion: false });
  const login = await fetch(`http://127.0.0.1:${port}/api/login`, { method: 'POST', body: JSON.stringify({ password: SECRET }) });
  assert.equal(login.status, 200); assert.match(login.headers.get('set-cookie'), /tw_sid=/);
  await waitFor(() => c.events.length === 1, c);
});

test('one DATA lock rejects same/different HTTP ports and recovers only after actual process death', async t => {
  const f = fixture(t), port = await freePort();
  new Vault(path.join(f.dir, 'vault.json')).create(SECRET, { servers: [] });
  const owner = child(t, f, { TW_PORT: String(port) }); await waitFor(() => owner.output.includes('Termnest:'), owner);
  const lock = path.join(f.dir, 'service.lock'), record = JSON.parse(fs.readFileSync(lock));
  // A very old mtime must not evict a live owner.
  fs.utimesSync(lock, new Date(0), new Date(0));
  for (const conflictPort of [port, await freePort()]) {
    const contender = child(t, f, { TW_PORT: String(conflictPort) });
    assert.equal((await contender.done)[0], 1); assert.match(contender.output, /RUNTIME_ALREADY_RUNNING/);
    assert.equal(JSON.parse(fs.readFileSync(lock)).token, record.token);
  }
  owner.kill('SIGKILL'); await owner.done;
  assert.equal(fs.existsSync(lock), true);
  const recovered = child(t, f, { TW_PORT: String(port) }); await waitFor(() => recovered.output.includes('Termnest:'), recovered);
  assert.notEqual(JSON.parse(fs.readFileSync(lock)).token, record.token);
  recovered.kill('SIGTERM');
  const code = (await recovered.done)[0];
  if (process.platform !== 'win32') assert.equal(code, 0);
  else { const final = await acquireDataLock(f.dir); final.release(); await tick(); }
});

test('lock ownership uncertainty fails closed and release never removes a replaced lock', async t => {
  const f = fixture(t), lock = path.join(f.dir, 'service.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  await assert.rejects(acquireDataLock(f.dir), { code: 'RUNTIME_LOCK_UNCERTAIN' });
  fs.unlinkSync(lock);
  const owner = await acquireDataLock(f.dir);
  const original = JSON.parse(fs.readFileSync(lock));
  fs.writeFileSync(lock, JSON.stringify({ ...original, token: 'replaced' }));
  owner.release(); await tick();
  assert.equal(JSON.parse(fs.readFileSync(lock)).token, 'replaced');
  assert.equal(readProtected(lock).length > 0, true);
});

test('installer dry-run is deterministic, secret-free and does not create state/config or invoke systemd', { skip: process.platform !== 'linux' }, async t => {
  const f = fixture(t), home = path.join(f.dir, 'fake home'), data = path.join(home, 'data % $ " tiếng Việt');
  const env = { ...process.env, HOME: home, XDG_STATE_HOME: path.join(home, 'state'), XDG_CONFIG_HOME: path.join(home, 'config') };
  const args = ['scripts/install-supervisor.sh', '--dry-run', '--password-file', f.file, '--data-dir', data, '--port', '8765'];
  const a = await execFile('bash', args, { cwd: ROOT, env });
  const b = await execFile('bash', args, { cwd: ROOT, env });
  assert.equal(a.stdout, b.stdout); assert.doesNotMatch(a.stdout, new RegExp(SECRET));
  assert.match(a.stdout, /TW_PORT=8765/); assert.match(a.stdout, /Restart=on-failure/); assert.match(a.stdout, /StandardInput=null/);
  assert.match(a.stdout, /KillMode=process/);
  assert.match(a.stdout, /data %% \$ \\" tiếng Việt/); assert.equal(fs.existsSync(home), false);
  assert.equal(fs.readFileSync(f.file, 'utf8'), SECRET + '\n');
  const missing = await execFile('bash', ['scripts/install-supervisor.sh', '--dry-run'], { cwd: ROOT, env });
  assert.match(missing.stdout, /termnest\/password/); assert.equal(fs.existsSync(home), false);
  fs.chmodSync(f.file, 0o644);
  if (process.platform !== 'win32') await assert.rejects(execFile('bash', args, { cwd: ROOT, env }), e => e.stderr.trim() === 'RUNTIME_PASSWORD_FILE_INVALID');
});

test('installer repeated writes preserve vault and secret and refuse unmanaged units using a fake user manager', { skip: process.platform !== 'linux' }, async t => {
  const f = fixture(t), bin = path.join(f.dir, 'bin'), home = path.join(f.dir, 'home'), data = path.join(f.dir, 'data');
  fs.mkdirSync(bin); fs.mkdirSync(data, { mode: 0o700 });
  const vault = path.join(data, 'vault.json'); fs.writeFileSync(vault, 'encrypted-fixture', { mode: 0o600 });
  fs.writeFileSync(path.join(bin, 'uname'), "#!/bin/sh\nif [ \"$1\" = -m ]; then /usr/bin/uname -m; else printf '%s\\n' Linux; fi\n", { mode: 0o700 });
  fs.writeFileSync(path.join(bin, 'systemctl'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  fs.writeFileSync(path.join(bin, 'loginctl'), '#!/bin/sh\nprintf "yes\\n"\n', { mode: 0o700 });
  // Only the temporary fake user manager is ever called; this is not a VM installation.
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'), XDG_STATE_HOME: path.join(home, 'state'), PATH: bin + path.delimiter + process.env.PATH };
  const args = ['scripts/install-supervisor.sh', '--password-file', f.file, '--data-dir', data];
  await execFile('bash', args, { cwd: ROOT, env });
  const unit = path.join(env.XDG_CONFIG_HOME, 'systemd/user/termnest-supervisor.service');
  const before = fs.readFileSync(unit, 'utf8'), stat = fs.statSync(unit);
  await execFile('bash', args, { cwd: ROOT, env });
  assert.equal(fs.readFileSync(unit, 'utf8'), before); assert.equal(fs.statSync(unit).mtimeMs, stat.mtimeMs);
  assert.equal(fs.readFileSync(vault, 'utf8'), 'encrypted-fixture'); assert.equal(fs.readFileSync(f.file, 'utf8'), SECRET + '\n');
  fs.writeFileSync(unit, '# someone else owns this');
  await assert.rejects(execFile('bash', args, { cwd: ROOT, env }), e => e.stderr.includes('RUNTIME_EXISTING_UNIT_UNMANAGED'));
  assert.equal(fs.readFileSync(unit, 'utf8'), '# someone else owns this');
});

test('Linux unit PATH discovers the selected Node and user-local Claude from a manager-like environment without copying secrets', { skip: process.platform !== 'linux' }, async t => {
  const f = fixture(t), home = path.join(f.dir, 'home % $ " Việt'), runtime = path.join(f.dir, 'runtime % $ " Việt');
  const inheritedBin = path.join(f.dir, 'unrelated-login-bin'), node = path.join(runtime, 'node');
  fs.mkdirSync(runtime); fs.symlinkSync(process.execPath, node);
  const managerEnv = { HOME: home, PATH: '/usr/local/bin:/usr/bin:/bin' };
  const result = await execFile('/bin/bash', ['scripts/install-supervisor.sh', '--dry-run', '--password-file', f.file,
    '--data-dir', path.join(home, 'data'), '--node-path', node], { cwd: ROOT, env: {
    ...managerEnv, PATH: inheritedBin + ':' + managerEnv.PATH, UNRELATED_SECRET: SECRET,
    XDG_CONFIG_HOME: path.join(home, 'config'), XDG_STATE_HOME: path.join(home, 'state'),
  } });
  assert.equal(fs.existsSync(home), false, 'dry-run must not create HOME, profile, state or config directories');
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(SECRET));
  assert.ok(!result.stdout.includes(inheritedBin), 'installer login PATH is not copied');
  const declared = Object.fromEntries(result.stdout.split('\n').filter(line => line.startsWith('Environment=')).map(line => {
    // Decode the quoted systemd literal and its escaped percent specifiers; Environment does not expand shell variables.
    const value = JSON.parse(line.slice('Environment='.length)).replace(/%%/g, '%'), split = value.indexOf('=');
    return [value.slice(0, split), value.slice(split + 1)];
  }));
  assert.deepEqual(Object.keys(declared).sort(), ['PATH', 'TW_DATA', 'TW_PASSWORD_FILE', 'TW_PORT']);
  assert.deepEqual(declared.PATH.split(':'), [...new Set([runtime, path.join(home, '.local/bin'),
    '/usr/local/bin', '/usr/bin', '/bin', '/usr/local/sbin', '/usr/sbin', '/sbin'])]);
  assert.ok(!managerEnv.PATH.split(':').includes(path.join(home, '.local/bin')));
  fs.mkdirSync(path.join(home, '.local/bin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.local/bin/claude'), '#!/bin/sh\nprintf "synthetic-claude-only\\n"\n', { mode: 0o700 });
  const serviceEnv = { ...managerEnv, ...declared };
  assert.equal((await execFile('claude', ['--version'], { env: serviceEnv })).stdout, 'synthetic-claude-only\n');
  assert.equal((await execFile('node', ['-p', 'process.versions.node'], { env: serviceEnv })).stdout.trim(), process.versions.node);
  assert.equal(fs.existsSync(path.join(home, 'config')), false);
  assert.equal(fs.existsSync(path.join(home, 'state')), false);
  assert.equal(fs.readFileSync(f.file, 'utf8'), SECRET + '\n');
});

test('installer refuses Linger=no or unverifiable linger before any mutation; dry-run does not query the user manager', { skip: process.platform !== 'linux' }, async t => {
  const f = fixture(t), bin = path.join(f.dir, 'fake-bin'), home = path.join(f.dir, 'home'), marker = path.join(f.dir, 'login-called');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\nif [ "$1" = -m ]; then /usr/bin/uname -m; else printf "Linux\\n"; fi\n', { mode: 0o700 });
  fs.writeFileSync(path.join(bin, 'systemctl'), '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'), XDG_STATE_HOME: path.join(home, 'state'), PATH: bin + path.delimiter + process.env.PATH };
  const args = ['scripts/install-supervisor.sh', '--password-file', f.file, '--data-dir', path.join(home, 'data')];
  fs.writeFileSync(path.join(bin, 'loginctl'), '#!/bin/sh\nprintf "called" > ' + JSON.stringify(marker) + '\nprintf "no\\n"\n', { mode: 0o700 });
  await execFile('bash', [...args, '--dry-run'], { cwd: ROOT, env }); assert.equal(fs.existsSync(marker), false); assert.equal(fs.existsSync(home), false);
  await assert.rejects(execFile('bash', args, { cwd: ROOT, env }), e => e.stderr.trim() === 'RUNTIME_LINGER_REQUIRED');
  assert.equal(fs.existsSync(marker), true); assert.equal(fs.existsSync(home), false);
  fs.writeFileSync(path.join(bin, 'loginctl'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  await assert.rejects(execFile('bash', args, { cwd: ROOT, env }), e => e.stderr.trim() === 'RUNTIME_LINGER_UNKNOWN');
  assert.equal(fs.existsSync(home), false); assert.equal(fs.readFileSync(f.file, 'utf8'), SECRET + '\n');
});

test('simultaneous fresh processes elect exactly one backend per DATA', async t => {
  const f = fixture(t); new Vault(path.join(f.dir, 'vault.json')).create(SECRET, { servers: [] });
  const contenders = Array.from({ length: 4 }, () => child(t, f));
  await waitFor(() => contenders.every(c => c.output.includes('Termnest:') || c.exitCode !== null));
  const winners = contenders.filter(c => c.output.includes('Termnest:'));
  assert.equal(winners.length, 1);
  for (const c of contenders.filter(c => c !== winners[0])) { assert.equal((await c.done)[0], 1); assert.match(c.output, /RUNTIME_ALREADY_RUNNING/); }
  const owner = winners[0], lock = path.join(f.dir, 'service.lock');
  owner.kill('SIGKILL'); await owner.done;
  // Port zero intentionally chooses a different actual HTTP port after recovery.
  const recovered = child(t, f); await waitFor(() => recovered.output.includes('Termnest:'), recovered);
  assert.equal(JSON.parse(fs.readFileSync(lock)).pid, recovered.pid);
  recovered.kill('SIGTERM'); await recovered.done;
});

test('unsafe DATA directories and symlinked lock files fail closed', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t);
  fs.chmodSync(f.dir, 0o755);
  await assert.rejects(acquireDataLock(f.dir), { code: 'RUNTIME_UNSAFE_PERMISSIONS' });
  fs.chmodSync(f.dir, 0o700);
  const alias = path.join(f.dir, 'alias'); fs.symlinkSync(f.dir, alias);
  await assert.rejects(acquireDataLock(alias), { code: 'RUNTIME_UNSAFE_FILE' });
  const lock = path.join(f.dir, 'service.lock'); fs.symlinkSync(f.file, lock);
  await assert.rejects(acquireDataLock(f.dir), { code: 'RUNTIME_LOCK_UNCERTAIN' });
  assert.equal(fs.readFileSync(f.file, 'utf8'), SECRET + '\n');
});

test('installer quotes special application paths for systemd and never creates data in dry-run', { skip: process.platform !== 'linux' }, async t => {
  const f = fixture(t), app = path.join(f.dir, 'app % $ " Việt'), scripts = path.join(app, 'scripts');
  fs.mkdirSync(scripts, { recursive: true }); fs.mkdirSync(path.join(app, 'lib'));
  fs.copyFileSync(path.join(ROOT, 'scripts/install-supervisor.sh'), path.join(scripts, 'install-supervisor.sh'));
  fs.copyFileSync(path.join(ROOT, 'lib/service-runtime.js'), path.join(app, 'lib/service-runtime.js'));
  const data = path.join(f.dir, 'missing-data');
  const result = await execFile('bash', [path.join(scripts, 'install-supervisor.sh'), '--dry-run', '--password-file', f.file, '--data-dir', data], { cwd: ROOT });
  assert.match(result.stdout, /WorkingDirectory="[^\n]*app %% \$ \\" Việt"/);
  assert.match(result.stdout, /ExecStart=[^\n]*app %% \$\$ \\" Việt\/server.js"/);
  assert.equal(fs.existsSync(data), false); assert.doesNotMatch(result.stdout, new RegExp(SECRET));
});

test('health CLI reports only fixed states for disconnected or invalid backend responses', async t => {
  const http = require('node:http');
  const server = http.createServer((req, res) => res.end(JSON.stringify({ password: SECRET, error: SECRET })));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  await assert.rejects(execFile(process.execPath, ['scripts/supervisor-check.js', '--port', String(port)], { cwd: ROOT }), e => {
    assert.equal(e.code, 1); assert.equal(e.stderr, '');
    assert.deepEqual(JSON.parse(e.stdout), { state: 'error', unlocked: false, monitoring: false, error: true, processAlive: false, observationsFresh: false, validatedAuditCompletion: false });
    assert.doesNotMatch(e.stdout, new RegExp(SECRET)); return true;
  });
  const absent = await freePort();
  await assert.rejects(execFile(process.execPath, ['scripts/supervisor-check.js', '--port', String(absent)], { cwd: ROOT }), e => JSON.parse(e.stdout).state === 'error');
});

test('mock Windows SID ACL branch refuses broad grants, other owners, reparse and wrong physical identity before content access', t => {
  const f = fixture(t), st = fs.lstatSync(f.file, { bigint: true }), sid = 'S-1-5-21-1-2-3-1001';
  const good = { currentSid: sid, ownerSid: sid, inode: String(st.ino), volume: String(st.dev), links: 1,
    directory: false, reparse: false, entries: [sid, 'S-1-5-18', 'S-1-5-32-544'].map(sid => ({ sid, type: 'AccessAllowed', mask: 2032127 })) };
  assert.doesNotThrow(() => validateWindowsSecurity(good, st));
  const io = Object.create(fs); let reads = 0;
  io.readSync = (...args) => { reads++; return fs.readSync(...args); };
  const bad = [
    { ...good, ownerSid: 'S-1-5-21-9-9-9-1002' }, { ...good, reparse: true }, { ...good, links: 2 },
    { ...good, inode: String(st.ino + 1n) }, { ...good, volume: String(st.dev + 1n) },
    { ...good, entries: [] },
    { ...good, entries: [...good.entries, { sid: 'S-1-1-0', type: 'AccessAllowed', mask: 1 }] },
    { ...good, entries: [...good.entries, { sid: 'S-1-5-32-545', type: 'AccessAllowed', mask: 1 }, { sid: 'S-1-5-32-545', type: 'AccessDenied', mask: 1 }] },
  ];
  for (const snapshot of bad) {
    noLeak(() => readPassword(f.file, io, { platform: 'win32', windowsProbe: () => snapshot }), /RUNTIME_UNSAFE_PERMISSIONS/);
    assert.equal(reads, 0);
  }
  noLeak(() => readPassword(f.file, io, { platform: 'win32', windowsProbe: () => { throw Error(SECRET); } }), /RUNTIME_FILE_UNREADABLE/);
  assert.equal(reads, 0);
});

test('native Windows ACL refuses Everyone read on secret, primary vault, DATA and lock; hardlinks and junctions fail closed',
  { skip: process.platform !== 'win32' ? 'requires actual Windows NTFS ACL/Win32 APIs' : false }, async t => {
    const f = fixture(t), vaultFile = path.join(f.dir, 'vault.json');
    new Vault(vaultFile).create(SECRET, { servers: [] });
    assert.equal(readPassword(f.file), SECRET);
    const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    function grant(file, add) {
      const ps = `[Console]::InputEncoding=New-Object Text.UTF8Encoding($false);$p=[Console]::In.ReadToEnd();$a=Get-Acl -LiteralPath $p;
$r=New-Object Security.AccessControl.FileSystemAccessRule(([Security.Principal.SecurityIdentifier]'S-1-1-0'),'Read','Allow');
${add ? '$a.AddAccessRule($r)' : '$a.RemoveAccessRuleSpecific($r)'};Set-Acl -LiteralPath $p -AclObject $a`;
      execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')],
        { input: file, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
    }
    grant(f.file, true); noLeak(() => readPassword(f.file), /RUNTIME_UNSAFE_PERMISSIONS/); grant(f.file, false);
    grant(vaultFile, true); noLeak(() => unlockFromFile(new Vault(vaultFile), f.file, () => assert.fail()), /RUNTIME_UNLOCK_FAILED/); grant(vaultFile, false);
    grant(f.dir, true); await assert.rejects(acquireDataLock(f.dir), { code: 'RUNTIME_UNSAFE_PERMISSIONS' }); grant(f.dir, false);
    const owner = await acquireDataLock(f.dir), lock = path.join(f.dir, 'service.lock');
    grant(lock, true); noLeak(() => readProtected(lock), /RUNTIME_UNSAFE_PERMISSIONS/);
    owner.release(); await tick(); assert.equal(fs.existsSync(lock), true, 'uncertain lock retained');
    grant(lock, false); fs.unlinkSync(lock);
    const hard = path.join(f.dir, 'hard'); fs.linkSync(f.file, hard);
    noLeak(() => readPassword(f.file), /RUNTIME_UNSAFE/); fs.unlinkSync(hard);
    const junction = path.join(f.dir, 'junction'); fs.symlinkSync(f.dir, junction, 'junction');
    const physicalOwner = await acquireDataLock(f.dir);
    try {
      // Fails closed either way: the junction check or the Windows security check (which runs first on a junction) refuses it.
      await assert.rejects(acquireDataLock(junction), e => ['RUNTIME_UNSAFE_FILE', 'RUNTIME_WINDOWS_SECURITY_UNAVAILABLE'].includes(e.code));
      noLeak(() => readPassword(path.join(junction, 'password')), /RUNTIME_WINDOWS_SECURITY_UNAVAILABLE/);
      await assert.rejects(acquireDataLock(f.dir), { code: 'RUNTIME_ALREADY_RUNNING' });
    } finally { physicalOwner.release(); await tick(); }
  });

test('directory identity uses exact BigInt device/inode and refuses uncertain identity', () => {
  assert.equal(directoryIdentity({ dev: 12n, ino: 9007199254740993n }), 'directory-v2:12:9007199254740993');
  for (const st of [{ dev: 1, ino: 2 }, { dev: 1n, ino: 0n }, { dev: -1n, ino: 2n }]) {
    assert.throws(() => directoryIdentity(st), { code: 'RUNTIME_LOCK_UNCERTAIN' });
  }
  assert.ok(processIdentity(process.pid)); assert.equal(processIdentity(-1), '');
  assert.equal(processIdentity('1; exit'), '');
});

test('legacy path-hash locks, including dead/uncertain records, are never erased automatically during identity migration', async t => {
  const f = fixture(t), lock = path.join(f.dir, 'service.lock');
  const data = require('node:crypto').createHash('sha256').update(fs.realpathSync(f.dir)).digest('hex');
  const text = JSON.stringify({ pid: 2147483647, identity: 'old-identity', data, token: 'legacy' });
  fs.writeFileSync(lock, text, { mode: 0o600 });
  await assert.rejects(acquireDataLock(f.dir), { code: 'RUNTIME_LOCK_UNCERTAIN' });
  assert.equal(fs.readFileSync(lock, 'utf8'), text);
});

for (const kind of ['case', 'unicode']) {
  test(`native ${kind} aliases share the physical arbiter across simultaneous starts`, async t => {
    if (kind === 'unicode' && process.platform !== 'darwin') return t.skip('macOS normalization-alias filesystem test');
    const f = fixture(t), real = path.join(f.dir, kind === 'case' ? 'DataCase' : 'Dátá');
    const alias = path.join(f.dir, kind === 'case' ? 'datacase' : 'Dátá'.normalize('NFD'));
    fs.mkdirSync(real, { mode: 0o700 });
    if (!fs.existsSync(alias) || fs.statSync(real, { bigint: true }).ino !== fs.statSync(alias, { bigint: true }).ino) {
      return t.skip('filesystem does not support this physical alias');
    }
    assert.equal(directoryIdentity(fs.statSync(real, { bigint: true })), directoryIdentity(fs.statSync(alias, { bigint: true })));
    const program = `const {acquireDataLock}=require('./lib/service-runtime');
acquireDataLock(process.argv[1]).then(lock=>{process.send('owner');process.on('message',()=>{lock.release();process.exit(0)})},e=>{process.send(e.code);process.exit(1)});`;
    const children = [real, alias, real, alias].map(dir => spawn(process.execPath, ['-e', program, dir], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
    const exits = children.map(c => once(c, 'exit'));
    t.after(async () => { children.forEach(c => { if (c.exitCode === null && !c.signalCode) c.kill(); }); await Promise.all(exits); });
    const states = await Promise.all(children.map(c => once(c, 'message').then(([m]) => m)));
    assert.equal(states.filter(s => s === 'owner').length, 1);
    assert.ok(states.filter(s => s !== 'owner').every(s => s === 'RUNTIME_ALREADY_RUNNING'));
    children[states.indexOf('owner')].send('release'); await Promise.all(exits);
  });
}

test('native symlink alias is refused while physical DATA remains exclusively owned', { skip: process.platform === 'win32' ? 'Windows junction covered by native ACL test' : false }, async t => {
  const f = fixture(t), alias = path.join(f.dir, 'symbolic');
  fs.symlinkSync(f.dir, alias);
  const owner = await acquireDataLock(f.dir);
  try {
    await assert.rejects(acquireDataLock(alias), { code: 'RUNTIME_UNSAFE_FILE' });
    await assert.rejects(acquireDataLock(f.dir), { code: 'RUNTIME_ALREADY_RUNNING' });
  } finally { owner.release(); await tick(); }
});

test('native Windows fresh DATA receives a private inherited ACL without a boot-secret file',
  { skip: process.platform !== 'win32' ? 'requires actual Windows ACL creation' : false }, async t => {
    const f = fixture(t), data = path.join(f.dir, 'fresh DATA Việt & $ %');
    const lock = await acquireDataLock(data);
    assert.ok(fs.existsSync(path.join(data, 'service.lock')));
    assert.equal(fs.existsSync(path.join(data, 'password')), false);
    lock.release(); await tick(); assert.equal(fs.existsSync(path.join(data, 'service.lock')), false);
  });

test('unattended unlock uses only the pinned primary bytes and never calls the interactive backup reader', t => {
  const f = fixture(t), file = path.join(f.dir, 'vault.json');
  new Vault(file).create(SECRET, { servers: [], prefs: { marker: true } });
  const bytes = fs.readFileSync(file), vault = new Vault(file);
  vault.unlock = () => { throw Error('interactive reopen must not happen'); };
  assert.equal(unlockFromFile(vault, f.file, () => {}), true);
  assert.equal(vault.unlocked, true); assert.equal(vault.data.prefs.marker, true); assert.equal(vault.recovered, null);
  assert.deepEqual(fs.readFileSync(file), bytes);
  const extra = vault.sealExtra({ marker: true }); assert.deepEqual(vault.openExtra(extra), { marker: true });
  vault.save(); const reopened = new Vault(file); assert.equal(reopened.unlock(SECRET), true);
  assert.equal(reopened.data.prefs.marker, true);
});

test('Linux installer selects adjacent native Node without PATH Node, supports explicit override, and rejects missing/incompatible runtime before mutations', { skip: process.platform !== 'linux' }, async t => {
  const f = fixture(t), app = path.join(f.dir, 'native payload'), scripts = path.join(app, 'scripts'), bin = path.join(f.dir, 'minimal-bin'), home = path.join(f.dir, 'untouched-home');
  fs.mkdirSync(scripts, { recursive: true }); fs.mkdirSync(path.join(app, 'lib')); fs.mkdirSync(bin);
  const installer = path.join(scripts, 'install-supervisor.sh');
  fs.copyFileSync(path.join(ROOT, 'scripts/install-supervisor.sh'), installer);
  fs.copyFileSync(path.join(ROOT, 'lib/service-runtime.js'), path.join(app, 'lib/service-runtime.js'));
  for (const command of ['dirname', 'uname']) fs.symlinkSync(execFileSync('/usr/bin/which', [command], { encoding: 'utf8' }).trim(), path.join(bin, command));
  const marker = path.join(f.dir, 'manager-called');
  fs.writeFileSync(path.join(bin, 'systemctl'), '#!/bin/sh\necho called > "$TN_INSTALL_MARKER"\nexit 99\n', { mode: 0o700 });
  fs.writeFileSync(path.join(bin, 'loginctl'), '#!/bin/sh\necho called > "$TN_INSTALL_MARKER"\necho yes\n', { mode: 0o700 });
  const bundled = path.join(app, 'node-' + process.arch); fs.copyFileSync(process.execPath, bundled); fs.chmodSync(bundled, 0o700);
  const env = { ...process.env, PATH: bin, HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'), XDG_STATE_HOME: path.join(home, 'state'), TN_INSTALL_MARKER: marker };
  const args = [installer, '--password-file', f.file, '--data-dir', path.join(home, 'data')];
  const result = await execFile('/bin/bash', [...args, '--dry-run'], { cwd: ROOT, env });
  assert.ok(result.stdout.includes('ExecStart="' + bundled + '"')); assert.equal(fs.existsSync(home), false); assert.equal(fs.existsSync(marker), false);
  const explicit = await execFile('/bin/bash', [...args, '--dry-run', '--node-path', process.execPath], { cwd: ROOT, env });
  assert.ok(explicit.stdout.includes('ExecStart="' + process.execPath + '"'));
  fs.unlinkSync(bundled);
  for (const dry of [[], ['--dry-run']]) {
    await assert.rejects(execFile('/bin/bash', [...args, ...dry], { cwd: ROOT, env }), e => e.stderr.trim() === 'RUNTIME_NODE_REQUIRED');
    await assert.rejects(execFile('/bin/bash', [...args, ...dry, '--node-path', path.join(f.dir, 'absent')], { cwd: ROOT, env }), e => e.stderr.trim() === 'RUNTIME_NODE_REQUIRED');
  }
  // Execute the actual probe with one incompatible Node property. Removing any guard makes this assertion fail.
  const shellQuote = value => "'" + value.replace(/'/g, "'\\''") + "'";
  for (const mutation of ['Object.defineProperty(process, "arch", {value:"wrong"})', 'Object.defineProperty(process, "platform", {value:"darwin"})', 'Object.defineProperty(process.versions, "node", {value:"16.0.0"})']) {
    const source = 'const source=process.argv[1];process.argv.splice(1,1);' + mutation + ';eval(source)';
    fs.writeFileSync(bundled, '#!/bin/sh\nexec ' + shellQuote(process.execPath) + ' -e ' + shellQuote(source) + ' "$2" "$3"\n', { mode: 0o700 });
    await assert.rejects(execFile('/bin/bash', [...args, '--dry-run'], { cwd: ROOT, env }), e => e.stderr.trim() === 'RUNTIME_NODE_INCOMPATIBLE', mutation);
  }
  fs.writeFileSync(bundled, '#!/bin/sh\nexit 2\n', { mode: 0o700 });
  for (const dry of [[], ['--dry-run']]) await assert.rejects(execFile('/bin/bash', [...args, ...dry], { cwd: ROOT, env }), e => e.stderr.trim() === 'RUNTIME_NODE_INCOMPATIBLE');
  assert.equal(fs.existsSync(home), false); assert.equal(fs.existsSync(marker), false); assert.equal(fs.readFileSync(f.file, 'utf8'), SECRET + '\n');
});
