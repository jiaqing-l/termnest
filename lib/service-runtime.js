'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { TextDecoder } = require('node:util');

const error = code => Object.assign(new Error(code), { code });
// The probe is fixed code, never shell-expanded path text, and never opens a file for content access.
// GetSecurityInfo reads the descriptor of the SAME Win32 handle as the file identity. No localized ACL text.
const WINDOWS_SECURITY_PROBE = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
try {
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
public static class TermnestSecurity {
 [StructLayout(LayoutKind.Sequential)] public struct Info {
  public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
  public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
 }
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 static extern SafeFileHandle CreateFile(string p, uint a, uint s, IntPtr sa, uint c, uint f, IntPtr t);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h, out Info i);
 [DllImport("advapi32.dll")] static extern uint GetSecurityInfo(SafeFileHandle h, int type, uint si, out IntPtr o, out IntPtr g, out IntPtr d, out IntPtr s, out IntPtr sd);
 [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr sd);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
 public static object Probe(string p, bool createDirectory) {
  p = Path.GetFullPath(p);
  if (p.Length < 3 || p[1] != ':' || new DriveInfo(Path.GetPathRoot(p)).DriveFormat != "NTFS") throw new Exception();
  // Validate existing ancestors before any optional directory creation, including dangling reparse points.
  for(string a=Path.GetDirectoryName(p); a != null; a=Path.GetDirectoryName(a)) {
   try { if((File.GetAttributes(a) & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException(); }
   catch(FileNotFoundException) {} catch(DirectoryNotFoundException) {}
  }
  if(createDirectory && !Directory.Exists(p)) {
   var user=WindowsIdentity.GetCurrent().User;
   var acl=new DirectorySecurity(); acl.SetOwner(user); acl.SetAccessRuleProtection(true,false);
   foreach(string sid in new string[] { user.Value, "S-1-5-18", "S-1-5-32-544" }) {
    acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid), FileSystemRights.FullControl,
      InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
   }
   Directory.CreateDirectory(p,acl);
  }
  for (string a=p; a != null; a=Path.GetDirectoryName(a)) {
   if ((File.GetAttributes(a) & FileAttributes.ReparsePoint) != 0) throw new Exception();
  }
  // READ_CONTROL | FILE_READ_ATTRIBUTES; BACKUP_SEMANTICS | OPEN_REPARSE_POINT; share read/write/delete.
  using (var h=CreateFile(p, 0x20080, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
   Info i; if(h.IsInvalid || !GetFileInformationByHandle(h, out i) || (i.Attributes & 0x400) != 0) throw new Exception();
   IntPtr o,g,d,s,sd;
   if(GetSecurityInfo(h, 1, 5, out o, out g, out d, out s, out sd) != 0) throw new Exception();
   try {
    var b=new byte[GetSecurityDescriptorLength(sd)]; Marshal.Copy(sd,b,0,b.Length);
    var descriptor=new RawSecurityDescriptor(b,0);
    if(descriptor.DiscretionaryAcl == null) throw new Exception();
    var entries=new System.Collections.Generic.List<object>();
    foreach(GenericAce ace in descriptor.DiscretionaryAcl) {
     var known=ace as CommonAce;
     if(known == null || known.IsCallback) throw new Exception();
     entries.Add(new {sid=known.SecurityIdentifier.Value, type=known.AceQualifier.ToString(), mask=known.AccessMask});
    }
    return new { currentSid=WindowsIdentity.GetCurrent().User.Value, ownerSid=descriptor.Owner.Value,
     inode=(((ulong)i.IndexHigh << 32) | i.IndexLow).ToString(), volume=i.Volume.ToString(),
     links=i.Links, directory=(i.Attributes & 16) != 0, reparse=false, entries=entries.ToArray() };
   } finally { LocalFree(sd); }
  }
 }
}
'@
$p = [Console]::In.ReadToEnd() | ConvertFrom-Json
[TermnestSecurity]::Probe([string]$p.path, [bool]$p.createDirectory) | ConvertTo-Json -Compress -Depth 5
} catch { [Console]::Error.WriteLine('RUNTIME_WINDOWS_SECURITY_UNAVAILABLE'); exit 1 }
`;
function windowsPowerShell() {
  // Do not trust PATH, ComSpec, or a pretend platform environment variable.
  const root = process.env.SystemRoot;
  if (!root || !/^[a-z]:[\\/]/i.test(root)) throw error('RUNTIME_WINDOWS_SECURITY_UNAVAILABLE');
  return path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
function probeWindowsSecurity(file, createDirectory = false) {
  try {
    if (!/^[a-z]:[\\/]/i.test(file) || file.slice(2).includes(':') || /[\x00-\x1f]/.test(file)) throw error('RUNTIME_UNSAFE_FILE');
    return JSON.parse(execFileSync(windowsPowerShell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(WINDOWS_SECURITY_PROBE, 'utf16le').toString('base64')], {
      input: JSON.stringify({ path: file, createDirectory }), encoding: 'utf8', timeout: 10000, maxBuffer: 32768,
      windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    }).replace(/^\ufeff/, '').trim());
  } catch { throw error('RUNTIME_WINDOWS_SECURITY_UNAVAILABLE'); }
}
function validateWindowsSecurity(snapshot, st, directory = false) {
  const allowed = new Set([snapshot?.currentSid, 'S-1-5-18', 'S-1-5-32-544']);
  // Injected numeric Stats must not silently round NTFS's 64-bit file IDs.
  if ((typeof st.ino !== 'bigint' && !Number.isSafeInteger(st.ino)) ||
      (typeof st.dev !== 'bigint' && !Number.isSafeInteger(st.dev))) throw error('RUNTIME_UNSAFE_PERMISSIONS');
  if (!/^S-1-5-/.test(snapshot?.currentSid || '') || snapshot.ownerSid !== snapshot.currentSid ||
      snapshot.reparse !== false || snapshot.directory !== directory || !Array.isArray(snapshot.entries) ||
      !snapshot.entries.length || !/^[0-9]+$/.test(snapshot.inode || '') || BigInt(snapshot.inode) !== BigInt(st.ino) ||
      !/^[0-9]+$/.test(snapshot.volume || '') || BigInt(snapshot.volume) !== BigInt(st.dev) ||
      (!directory && (snapshot.links !== 1 || Number(st.nlink) !== 1))) throw error('RUNTIME_UNSAFE_PERMISSIONS');
  // Conservative: even an unrelated metadata-only allow ACE is refused. Denies never cancel a broad allow.
  for (const ace of snapshot.entries) {
    if (!['AccessAllowed', 'AccessDenied'].includes(ace.type) || typeof ace.sid !== 'string' ||
        !Number.isInteger(ace.mask) || (ace.type === 'AccessAllowed' && ace.mask !== 0 && !allowed.has(ace.sid))) {
      throw error('RUNTIME_UNSAFE_PERMISSIONS');
    }
  }
}
function protectedStat(st, directory = false, platform = process.platform) {
  if (!(directory ? st.isDirectory() : st.isFile())) throw error('RUNTIME_UNSAFE_FILE');
  if (platform !== 'win32' && (Number(st.uid) !== process.getuid() || (Number(st.mode) & 0o077))) throw error('RUNTIME_UNSAFE_PERMISSIONS');
}
function assertPrivatePath(file, options = {}) {
  const { directory = false, io = fs, platform = process.platform, windowsProbe = probeWindowsSecurity } = options;
  const st = io.lstatSync(file, { bigint: true });
  protectedStat(st, directory, platform);
  if (platform === 'win32') validateWindowsSecurity(windowsProbe(file), st, directory);
  return st;
}

function sameFileVersion(a, b) {
  return ['dev', 'ino', 'size', 'nlink'].every(key => BigInt(a[key]) === BigInt(b[key])) &&
    ['birthtime', 'mtime', 'ctime'].every(key => a[key + 'Ns'] !== undefined && b[key + 'Ns'] !== undefined
      ? a[key + 'Ns'] === b[key + 'Ns'] : Number(a[key + 'Ms']) === Number(b[key + 'Ms']));
}

// Never read to EOF: a FIFO, a growing file or a swapped symlink cannot make startup wait or read arbitrary data.
function readProtected(file, maxBytes = 4096, io = fs, options = {}) {
  let fd, pinnedFd, bytes;
  const checkPath = () => assertPrivatePath(file, { ...options, io });
  const checkStat = st => protectedStat(st, false, options.platform || process.platform);
  try {
    // Reject special files before opening, including on platforms without O_NONBLOCK/O_NOFOLLOW.
    // This preflight is not the identity snapshot; that observation must be made with a live reference.
    checkPath();
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
    // Pin the inode BEFORE observing path identity. Linux can reuse an unlinked inode with identical timestamps,
    // even at nanosecond precision. Keeping this handle open prevents reuse across the lstat/open check.
    pinnedFd = io.openSync(file, flags);
    const pinned = io.fstatSync(pinnedFd, { bigint: true });
    checkStat(pinned);
    if (Number(pinned.nlink) !== 1 || pinned.size > maxBytes) throw error('RUNTIME_UNSAFE_FILE');
    const before = checkPath();
    if (!sameFileVersion(pinned, before)) throw error('RUNTIME_FILE_CHANGED');
    fd = io.openSync(file, flags);
    const opened = io.fstatSync(fd, { bigint: true });
    checkStat(opened);
    if (Number(opened.nlink) !== 1 || opened.size > maxBytes) throw error('RUNTIME_UNSAFE_FILE');
    if (!sameFileVersion(before, opened) || !sameFileVersion(pinned, io.fstatSync(pinnedFd, { bigint: true }))) throw error('RUNTIME_FILE_CHANGED');
    if (!sameFileVersion(opened, checkPath())) throw error('RUNTIME_FILE_CHANGED');
    bytes = Buffer.alloc(maxBytes + 1);
    let count = 0, n;
    while (count < bytes.length && (n = io.readSync(fd, bytes, count, bytes.length - count, null))) count += n;
    const after = io.fstatSync(fd, { bigint: true }), current = checkPath();
    checkStat(after); checkStat(current);
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

function readPassword(file, io = fs, options = {}) {
  const bytes = readProtected(file, 4096, io, options);
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
    let data, raw, key;
    try {
      const text = primary.toString('utf8');
      data = Vault.read(text, password); raw = JSON.parse(text);
      if (!data || !Array.isArray(data.servers)) throw error('RUNTIME_UNLOCK_FAILED');
      const salt = Buffer.from(raw.salt, 'base64');
      key = crypto.scryptSync(password, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
      vault.salt = salt; vault.key = key; vault.data = data; vault.recovered = null; vault.copyNext = true;
    } finally { primary.fill(0); }
    password = undefined;
    initialize();
    return true;
  } catch { throw error('RUNTIME_UNLOCK_FAILED'); }
  finally { password = undefined; }
}

function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return '';
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() + '/' + stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    }
    if (process.platform === 'win32') return execFileSync(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`], { encoding: 'utf8', timeout: 3000, maxBuffer: 4096, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 3000, maxBuffer: 4096, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}
function ownerDead(record) {
  if (!Number.isSafeInteger(record?.pid) || record.pid < 1 || typeof record.identity !== 'string' || !record.identity) return false;
  try { process.kill(record.pid, 0); }
  catch (e) { return e.code === 'ESRCH'; }
  const identity = processIdentity(record.pid);
  return !!identity && identity !== record.identity;
}

function directoryIdentity(st) {
  if (typeof st.dev !== 'bigint' || typeof st.ino !== 'bigint' || st.dev < 0n || st.ino <= 0n) throw error('RUNTIME_LOCK_UNCERTAIN');
  return `directory-v2:${st.dev}:${st.ino}`;
}

async function acquireDataLock(dir) {
  let arbiter, directoryFd;
  try {
    if (process.platform === 'win32') probeWindowsSecurity(dir, true);
    else fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') directoryFd = fs.openSync(dir, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NONBLOCK || 0));
    const observed = assertPrivatePath(dir, { directory: true });
    if (directoryFd !== undefined && directoryIdentity(fs.fstatSync(directoryFd, { bigint: true })) !== directoryIdentity(observed)) throw error('RUNTIME_LOCK_UNCERTAIN');
    const canonical = fs.realpathSync(dir);
    // Physical identity survives case/normalization aliases on macOS and Windows; never lowercase POSIX paths.
    const identity = directoryIdentity(observed);
    const digest = crypto.createHash('sha256').update(identity).digest('hex');
    // A kernel-owned endpoint serializes *all* file inspection/replacement, including stale recovery. Unlike unlinking
    // a stale PID file directly this cannot delete another contender's newly acquired lock. Hash collisions refuse safely.
    // Loopback TCP provides one exclusive kernel arbiter on every platform, with no stale pipe/socket deletion.
    arbiter = net.createServer(socket => socket.destroy());
    const address = { host: '127.0.0.1', port: 49152 + (parseInt(digest.slice(0, 8), 16) % 16384), exclusive: true };
    await new Promise((resolve, reject) => { arbiter.once('error', reject); arbiter.listen(address, resolve); });
    arbiter.unref();
    if (directoryIdentity(assertPrivatePath(canonical, { directory: true })) !== identity) throw error('RUNTIME_LOCK_UNCERTAIN');
    const file = path.join(canonical, 'service.lock');
    if (fs.existsSync(file)) {
      let old; try { old = JSON.parse(readProtected(file).toString('utf8')); } catch { throw error('RUNTIME_LOCK_UNCERTAIN'); }
      // V1 path-hash records fail closed, even if dead: an older binary may use a different arbiter.
      // Migrate only while all old supervisors are stopped, by explicitly removing their dead lock.
      if (old.data !== digest || !ownerDead(old)) throw error('RUNTIME_LOCK_UNCERTAIN');
      fs.unlinkSync(file);
    }
    const record = { pid: process.pid, identity: processIdentity(process.pid), data: digest, token: crypto.randomUUID() };
    if (!record.identity) throw error('RUNTIME_LOCK_UNCERTAIN');
    const fd = fs.openSync(file, 'wx', 0o600);
    try {
      const current = assertPrivatePath(file);
      if (BigInt(current.ino) !== fs.fstatSync(fd, { bigint: true }).ino) throw error('RUNTIME_LOCK_UNCERTAIN');
      if (directoryIdentity(assertPrivatePath(canonical, { directory: true })) !== identity) throw error('RUNTIME_LOCK_UNCERTAIN');
      fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      try {
        if (directoryIdentity(assertPrivatePath(canonical, { directory: true })) !== identity) throw error('RUNTIME_LOCK_UNCERTAIN');
        const current = JSON.parse(readProtected(file).toString('utf8'));
        if (current.token === record.token && current.pid === process.pid && current.identity === record.identity) fs.unlinkSync(file);
      } catch { /* An uncertain/replaced lock is never removed. */ }
      arbiter.close();
      if (directoryFd !== undefined) { try { fs.closeSync(directoryFd); } catch {} directoryFd = undefined; }
      process.removeListener('exit', release);
    };
    process.once('exit', release);
    return { release };
  } catch (e) {
    if (arbiter?.listening) arbiter.close();
    if (directoryFd !== undefined) { try { fs.closeSync(directoryFd); } catch {} }
    throw error(e.code?.startsWith('RUNTIME_') ? e.code : e.code === 'EADDRINUSE' ? 'RUNTIME_ALREADY_RUNNING' : ['ELOOP', 'ENOTDIR'].includes(e.code) ? 'RUNTIME_UNSAFE_FILE' : 'RUNTIME_LOCK_FAILED');
  }
}

module.exports = { readProtected, readPassword, unlockFromFile, acquireDataLock, assertPrivatePath,
  validateWindowsSecurity, directoryIdentity, processIdentity };
