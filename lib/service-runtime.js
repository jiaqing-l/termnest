'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { TextDecoder } = require('node:util');

const error = code => Object.assign(new Error(code), { code });
const unix = process.platform !== 'win32';
function protectedStat(st, directory = false) {
  if (!(directory ? st.isDirectory() : st.isFile())) throw error('RUNTIME_UNSAFE_FILE');
  if (unix && (Number(st.uid) !== process.getuid() || (Number(st.mode) & 0o077))) throw error('RUNTIME_UNSAFE_PERMISSIONS');
}

function sameFileVersion(a, b) {
  return ['dev', 'ino', 'size', 'nlink'].every(key => BigInt(a[key]) === BigInt(b[key])) &&
    ['birthtime', 'mtime', 'ctime'].every(key => a[key + 'Ns'] !== undefined && b[key + 'Ns'] !== undefined
      ? a[key + 'Ns'] === b[key + 'Ns'] : Number(a[key + 'Ms']) === Number(b[key + 'Ms']));
}

// Never read to EOF: a FIFO, a growing file or a swapped symlink cannot make startup wait or read arbitrary data.
function readProtected(file, maxBytes = 4096, io = fs) {
  let fd, pinnedFd, bytes;
  try {
    // Reject special files before opening, including on platforms without O_NONBLOCK/O_NOFOLLOW.
    // This preflight is not the identity snapshot; that observation must be made with a live reference.
    protectedStat(io.lstatSync(file, { bigint: true }));
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
    // Pin the inode BEFORE observing path identity. Linux can reuse an unlinked inode with identical timestamps,
    // even at nanosecond precision. Keeping this handle open prevents reuse across the lstat/open check.
    pinnedFd = io.openSync(file, flags);
    const pinned = io.fstatSync(pinnedFd, { bigint: true });
    protectedStat(pinned);
    if (Number(pinned.nlink) !== 1 || pinned.size > maxBytes) throw error('RUNTIME_UNSAFE_FILE');
    const before = io.lstatSync(file, { bigint: true });
    protectedStat(before);
    if (!sameFileVersion(pinned, before)) throw error('RUNTIME_FILE_CHANGED');
    fd = io.openSync(file, flags);
    const opened = io.fstatSync(fd, { bigint: true });
    protectedStat(opened);
    if (Number(opened.nlink) !== 1 || opened.size > maxBytes) throw error('RUNTIME_UNSAFE_FILE');
    if (!sameFileVersion(before, opened) || !sameFileVersion(pinned, io.fstatSync(pinnedFd, { bigint: true }))) throw error('RUNTIME_FILE_CHANGED');
    bytes = Buffer.alloc(maxBytes + 1);
    let count = 0, n;
    while (count < bytes.length && (n = io.readSync(fd, bytes, count, bytes.length - count, null))) count += n;
    const after = io.fstatSync(fd, { bigint: true }), current = io.lstatSync(file, { bigint: true });
    protectedStat(after); protectedStat(current);
    if (count > maxBytes || count !== Number(opened.size) || !sameFileVersion(opened, after) ||
        !sameFileVersion(opened, current) || !sameFileVersion(pinned, io.fstatSync(pinnedFd, { bigint: true }))) throw error('RUNTIME_FILE_CHANGED');
    return Buffer.from(bytes.subarray(0, count));
  } catch (e) { throw error(e.code?.startsWith('RUNTIME_') ? e.code : e.code === 'ELOOP' ? 'RUNTIME_UNSAFE_FILE' : 'RUNTIME_FILE_UNREADABLE'); }
  finally {
    if (bytes) bytes.fill(0);
    let closeFailed = false;
    for (const handle of [fd, pinnedFd]) if (handle !== undefined) { try { io.closeSync(handle); } catch { closeFailed = true; } }
    if (closeFailed) throw error('RUNTIME_FILE_UNREADABLE');
  }
}

function readPassword(file, io = fs) {
  const bytes = readProtected(file, 4096, io);
  try {
    let value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    value = value.replace(/\r?\n$/, '');
    if (!value.trim() || /[\x00-\x1f\x7f-\x9f\ufeff]/.test(value)) throw error('RUNTIME_PASSWORD_INVALID');
    return value;
  } catch { throw error('RUNTIME_PASSWORD_INVALID'); }
  finally { bytes.fill(0); }
}

function unlockFromFile(vault, file, initialize) {
  if (file === undefined) return false;
  let password;
  try {
    password = readPassword(file);
    // The interactive vault may recover backups. An unattended service requires a good primary and never repairs it.
    const { Vault } = require('./vault');
    const primary = readProtected(vault.file, 32 * 1024 * 1024);
    let data;
    try { data = Vault.read(primary.toString('utf8'), password); } finally { primary.fill(0); }
    if (!data || !Array.isArray(data.servers) || !vault.unlock(password) || vault.recovered) throw error('RUNTIME_UNLOCK_FAILED');
    password = undefined;
    initialize();
    return true;
  } catch { throw error('RUNTIME_UNLOCK_FAILED'); }
  finally { password = undefined; }
}

function processIdentity(pid) {
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() + '/' + stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    }
    if (process.platform === 'win32') return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}
function ownerDead(record) {
  if (!Number.isSafeInteger(record?.pid) || record.pid < 1 || typeof record.identity !== 'string' || !record.identity) return false;
  try { process.kill(record.pid, 0); }
  catch (e) { return e.code === 'ESRCH'; }
  const identity = processIdentity(record.pid);
  return !!identity && identity !== record.identity;
}

async function acquireDataLock(dir) {
  let arbiter;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    protectedStat(fs.lstatSync(dir), true);
    const canonical = fs.realpathSync(dir), digest = crypto.createHash('sha256').update(canonical).digest('hex');
    // A kernel-owned endpoint serializes *all* file inspection/replacement, including stale recovery. Unlike unlinking
    // a stale PID file directly this cannot delete another contender's newly acquired lock. Hash collisions refuse safely.
    // Windows pipes have kernel cleanup. Unix uses loopback TCP to avoid the stale Unix-socket unlink race entirely.
    arbiter = net.createServer(socket => socket.destroy());
    const address = unix ? { host: '127.0.0.1', port: 49152 + (parseInt(digest.slice(0, 8), 16) % 16384), exclusive: true }
      : `\\\\.\\pipe\\termnest-data-${digest}`;
    await new Promise((resolve, reject) => { arbiter.once('error', reject); arbiter.listen(address, resolve); });
    arbiter.unref();
    const file = path.join(canonical, 'service.lock');
    if (fs.existsSync(file)) {
      let old; try { old = JSON.parse(readProtected(file).toString('utf8')); } catch { throw error('RUNTIME_LOCK_UNCERTAIN'); }
      if (old.data !== digest || !ownerDead(old)) throw error('RUNTIME_LOCK_UNCERTAIN');
      fs.unlinkSync(file);
    }
    const record = { pid: process.pid, identity: processIdentity(process.pid), data: digest, token: crypto.randomUUID() };
    if (!record.identity) throw error('RUNTIME_LOCK_UNCERTAIN');
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      try {
        const current = JSON.parse(readProtected(file).toString('utf8'));
        if (current.token === record.token && current.pid === process.pid && current.identity === record.identity) fs.unlinkSync(file);
      } catch { /* An uncertain/replaced lock is never removed. */ }
      arbiter.close();
      process.removeListener('exit', release);
    };
    process.once('exit', release);
    return { release };
  } catch (e) {
    if (arbiter?.listening) arbiter.close();
    throw error(e.code?.startsWith('RUNTIME_') ? e.code : e.code === 'EADDRINUSE' ? 'RUNTIME_ALREADY_RUNNING' : 'RUNTIME_LOCK_FAILED');
  }
}

module.exports = { readProtected, readPassword, unlockFromFile, acquireDataLock };
