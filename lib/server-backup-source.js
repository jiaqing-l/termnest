'use strict';
const { LIMITS, error, checkAbort, safePath } = require('./server-backup-store');
const { shq } = require('./parse');
const EXCLUSIONS = Object.freeze(['node_modules', 'bin', 'obj', 'target', '.venv', 'venv', '__pycache__', '.next', '.cache', '.termnest-trash']);
function validRoot(root) {
  return typeof root === 'string' && root.length > 1 && root.length <= 4096 && root.startsWith('/') &&
    !/[\x00-\x1f\x7f\\]/.test(root) && !root.split('/').some(p => p === '..' || p === '.') && !root.includes('//');
}
// Serialized into ONE Node process over the existing authenticated SSH connection. The protocol
// streams one bounded chunk at a time and uses stdout backpressure, never a whole-file JSON value.
// Only the synthetic harness supplies home. Production always uses the authenticated account home.
async function sourceRuntime(config, emit) {
  const fs = require('fs'), path = require('path'), os = require('os');
  if (process.platform !== 'linux') throw Error('unsupported_source');
  const home = config.home || os.homedir(), limits = config.limits, skipDirs = new Set(config.exclusions);
  const deadline = Date.now() + limits.jobMs, roots = [], paths = new Set();
  let visited = 0, files = 0, bytes = 0, skipped = 0, reason = '';
  const fail = code => { skipped++; reason ||= code; };
  const tick = () => { if (Date.now() > deadline) throw Error('timeout'); if (++visited > limits.entries) throw Error('scan_limit'); };
  const version = s => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String).join(':');
  const inode = s => `${s.dev}:${s.ino}`;
  const plain = p => !/[\x00-\x1f\x7f\\]/.test(p) && Buffer.byteLength(p) <= 4096;
  async function realDir(dir) {
    const s = await fs.promises.lstat(dir, { bigint: true });
    if (!s.isDirectory() || s.isSymbolicLink() || await fs.promises.realpath(dir) !== dir) throw Error('unsafe_source');
    return inode(s);
  }
  async function rootStill(root) { if (await realDir(root.dir) !== root.identity) throw Error('source_changed'); }
  const sensitive = name => /^(?:\.ssh|\.aws|\.azure|\.gnupg|\.kube|\.config|\.claude[^/]*|\.codex[^/]*)$/.test(name);
  const homeReal = await fs.promises.realpath(home);
  for (const [i, selected] of config.roots.entries()) {
    const dir = path.resolve(selected);
    if (!plain(dir) || dir === '/' || dir === homeReal || homeReal.startsWith(dir + '/') ||
      ['/home', '/Users', '/etc', '/proc', '/sys', '/dev', '/run', '/boot', '/usr', '/var'].some(p => dir === p || (p !== '/home' && p !== '/Users' && dir.startsWith(p + '/'))) ||
      (dir.startsWith(homeReal + '/') && sensitive(path.relative(homeReal, dir).split('/')[0]))) throw Error('unsafe_root');
    roots.push({ dir, identity: await realDir(dir), kind: 'file', prefix: `files/${i + 1}-${path.basename(dir)}` });
  }
  if (config.includeChats) {
    // opendir avoids allocating an unbounded directory listing, including for profile discovery.
    const handle = await fs.promises.opendir(homeReal);
    for await (const e of handle) {
      tick(); if (!/^\.(?:claude|codex)[^/]*$/.test(e.name)) continue;
      if (e.isSymbolicLink()) { fail('unsafe_source'); continue; }
      if (!e.isDirectory()) continue;
      const tool = e.name.startsWith('.claude') ? 'claude' : 'codex';
      for (const child of tool === 'claude' ? ['projects'] : ['sessions', 'archived_sessions']) {
        const dir = path.join(homeReal, e.name, child);
        try { roots.push({ dir, identity: await realDir(dir), kind: 'chat', tool, prefix: `chats/${tool}/${e.name}/${child}` }); }
        catch (e) { if (e.code !== 'ENOENT') fail('chat_listing_failed'); }
      }
    }
  }
  async function read(root, full, rel) {
    const archivePath = root.prefix + '/' + rel;
    if (paths.has(full)) return; paths.add(full);
    let fd, started = false;
    try {
      await rootStill(root);
      if (await fs.promises.realpath(full) !== full) throw Error('unsafe_source');
      const before = await fs.promises.lstat(full, { bigint: true });
      if (!before.isFile() || before.nlink !== 1n) throw Error('unsafe_source');
      if (before.size > BigInt(limits.fileBytes)) throw Error('file_limit');
      if (++files > limits.files || bytes + Number(before.size) > limits.jobBytes) throw Error('job_limit');
      fd = await fs.promises.open(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
      const opened = await fd.stat({ bigint: true });
      if (version(opened) !== version(before) || opened.nlink !== 1n || !opened.isFile()) throw Error('source_changed');
      started = true;
      await emit({ t: 'file', path: archivePath, kind: root.kind, ...(root.tool ? { tool: root.tool } : {}), size: Number(before.size), mtimeMs: Number(before.mtimeNs) / 1e6 });
      let offset = 0; const buffer = Buffer.alloc(limits.chunkBytes);
      while (offset < Number(before.size)) {
        if (Date.now() > deadline) throw Error('timeout');
        const size = Math.min(buffer.length, Number(before.size) - offset);
        let got = 0;
        while (got < size) {
          const r = await fd.read(buffer, got, size - got, offset + got); if (!r.bytesRead) throw Error('source_changed'); got += r.bytesRead;
          if (Date.now() > deadline) throw Error('timeout');
        }
        offset += got; await emit({ t: 'chunk', data: buffer.subarray(0, got).toString('base64') });
      }
      const after = await fd.stat({ bigint: true }), named = await fs.promises.lstat(full, { bigint: true });
      await rootStill(root);
      if (version(after) !== version(before) || version(named) !== version(before) || named.nlink !== 1n || await fs.promises.realpath(full) !== full) throw Error('source_changed');
      bytes += offset; await emit({ t: 'end' });
    } catch (e) {
      const codes = ['source_changed', 'unsafe_source', 'file_limit', 'job_limit', 'timeout'];
      const code = codes.includes(e.message) ? e.message : 'read_failed'; fail(code);
      if (started) await emit({ t: 'abort' });
      if (['job_limit', 'timeout'].includes(code)) throw Error(code);
    } finally { if (fd) await fd.close(); }
  }
  async function walk(root, dir, depth) {
    if (depth > limits.depth) { fail('depth_limit'); return; }
    await rootStill(root); const dirIdentity = await realDir(dir);
    let handle; try { handle = await fs.promises.opendir(dir); } catch { throw Error('listing_failed'); }
    for await (const e of handle) {
      tick(); const full = path.join(dir, e.name), rel = path.relative(root.dir, full).split(path.sep).join('/');
      if (!plain(rel) || rel.split('/').some(x => x.includes(':') || /[. ]$/.test(x) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(x))) { fail('unsafe_name'); continue; }
      if (e.isSymbolicLink()) { fail('symlink_skipped'); continue; }
      if (e.isDirectory()) {
        if (root.kind === 'file' && skipDirs.has(e.name)) continue;
        try { await walk(root, full, depth + 1); } catch (e) { if (['scan_limit', 'timeout', 'job_limit'].includes(e.message)) throw e; fail('listing_failed'); }
      } else if (e.isFile()) { if (root.kind !== 'chat' || e.name.endsWith('.jsonl')) await read(root, full, rel); }
      else fail('special_file_skipped');
    }
    await rootStill(root); if (await realDir(dir) !== dirIdentity) throw Error('source_changed');
  }
  for (const root of roots) await walk(root, root.dir, 0);
  await emit({ t: 'done', skipped, reason });
}
function runtimeProgram(config) {
  return `const {once}=require('events');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));process.stdout.on('error',()=>process.exit(1));const emit=async v=>{if(!process.stdout.write(JSON.stringify(v)+'\\n'))await once(process.stdout,'drain');};(${sourceRuntime.toString()})(${JSON.stringify(config)},emit).then(()=>process.stdout.end(()=>process.exit(0))).catch(async e=>{await emit({t:'error',code:['unsupported_source','unsafe_root','unsafe_source','source_changed','listing_failed','scan_limit','job_limit','timeout'].includes(e.message)?e.message:'source_failed'});process.stdout.end(()=>process.exit(1));});`;
}
// No new connection or remote file is created. Closing the SSH channel ends stdin and the helper.
async function* remoteMessages(backend, config, signal) {
  if (!backend?.ready || !backend.client?.exec || backend.cfg?.local) throw error('unsupported_source');
  checkAbort(signal);
  let channel, timer, pendingReject, opening = true;
  const abort = () => { if (channel) { try { channel.signal?.('TERM'); channel.close(); } catch { /* closed */ } } pendingReject?.(error('cancelled')); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    channel = await new Promise((resolve, reject) => {
      pendingReject = reject;
      timer = setTimeout(() => { opening = false; reject(error('timeout')); }, 15000);
      backend.client.exec('node -e ' + shq(runtimeProgram(config)), (err, ch) => {
        clearTimeout(timer); if (err) return reject(error('source_unavailable'));
        if (!opening || signal?.aborted) { ch.close(); return reject(error('cancelled')); } opening = false; resolve(ch);
      });
    });
    pendingReject = null;
    timer = setTimeout(() => { try { channel.close(); } catch { /* closed */ } }, config.limits.jobMs);
    // stderr is deliberately discarded: shell errors must not reach logs, metadata or the browser.
    channel.stderr?.resume();
    let buffer = Buffer.alloc(0), done = false;
    for await (const chunk of channel) {
      checkAbort(signal); buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > config.limits.chunkBytes * 3 + 65536) throw error('protocol_limit');
      let at;
      while ((at = buffer.indexOf(10)) !== -1) {
        const line = buffer.subarray(0, at); buffer = buffer.subarray(at + 1);
        let msg; try { msg = JSON.parse(line.toString('utf8')); } catch { throw error('source_protocol'); }
        if (done) throw error('source_protocol');
        if (msg.t === 'done') done = true;
        yield msg;
      }
    }
    checkAbort(signal); if (!done || buffer.length) throw error('source_unavailable');
  } finally { opening = false; clearTimeout(timer); signal?.removeEventListener('abort', abort); if (channel) { try { channel.close(); } catch { /* closed */ } } }
}
async function collect(store, backend, config, { signal, transport = remoteMessages, progress = () => {}, beforeCommit = () => {} } = {}) {
  const limits = store.limits;
  const source = { roots: config.roots, includeChats: config.includeChats, exclusions: EXCLUSIONS, limits };
  const tx = store.begin(config.serverId, config.name || config.serverId);
  let current = null, size = 0, done = false, result;
  const deadline = Date.now() + limits.jobMs;
  for await (const m of transport(backend, source, signal)) {
    checkAbort(signal); if (Date.now() > deadline) throw error('timeout');
    if (done || !m || typeof m !== 'object') throw error('source_protocol');
    if (m.t === 'error') throw error(['unsupported_source', 'unsafe_root', 'unsafe_source', 'source_changed', 'listing_failed', 'scan_limit', 'job_limit', 'timeout'].includes(m.code) ? m.code : 'source_failed');
    if (m.t === 'file') {
      if (current || !safePath(m.path) || !Number.isSafeInteger(m.size) || m.size < 0 || m.size > limits.fileBytes || tx.files.length >= limits.files || tx.bytes + m.size > limits.jobBytes ||
        !['chat', 'file'].includes(m.kind) || !Number.isFinite(m.mtimeMs) || (m.kind === 'chat' && !['claude', 'codex'].includes(m.tool))) throw error('source_protocol');
      current = { path: m.path, kind: m.kind, ...(m.tool ? { tool: m.tool } : {}), size: m.size, mtimeMs: m.mtimeMs, chunks: [] }; size = 0;
    } else if (m.t === 'chunk') {
      if (!current || typeof m.data !== 'string' || m.data.length > Math.ceil(limits.chunkBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(m.data)) throw error('source_protocol');
      const bytes = Buffer.from(m.data, 'base64'); if (!bytes.length || bytes.length > limits.chunkBytes || size + bytes.length > current.size) throw error('source_protocol');
      if (current.chunks.length >= Math.ceil(current.size / limits.chunkBytes) + 16) throw error('protocol_limit');
      current.chunks.push(store.chunk(bytes)); size += bytes.length;
    } else if (m.t === 'end') {
      if (!current || size !== current.size) throw error('incomplete_file'); store.add(tx, current); current = null; progress({ files: tx.files.length, bytes: tx.bytes });
    } else if (m.t === 'abort') { if (!current) throw error('source_protocol'); current = null; }
    else if (m.t === 'done') {
      if (current || !Number.isSafeInteger(m.skipped) || m.skipped < 0) throw error('source_protocol');
      const reasons = ['unsafe_source', 'chat_listing_failed', 'source_changed', 'file_limit', 'read_failed', 'depth_limit', 'unsafe_name', 'symlink_skipped', 'credential_directory_skipped', 'listing_failed', 'special_file_skipped'];
      result = { skipped: m.skipped, reason: m.skipped ? (reasons.includes(m.reason) ? m.reason : 'source_partial') : '' }; done = true;
    } else throw error('source_protocol');
  }
  if (!done) throw error('source_unavailable'); checkAbort(signal);
  beforeCommit();
  return store.commit(tx, { ...result, retention: config.retention || 32, signal });
}
module.exports = { EXCLUSIONS, validRoot, sourceRuntime, runtimeProgram, remoteMessages, collect };
