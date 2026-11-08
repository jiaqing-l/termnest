'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Duplex } = require('node:stream');
const { SnapshotStore, LIMITS } = require('../lib/server-backup-store');
const { collect, sourceRuntime, EXCLUSIONS, runtimeProgram, remoteMessages } = require('../lib/server-backup-source');
function fixture(t, limits = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-backup-source-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home'), project = path.join(home, 'project'), data = path.join(dir, 'data'); fs.mkdirSync(project, { recursive: true });
  const write = (p, v) => { const f = path.join(home, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, v); return f; };
  const store = new SnapshotStore(data, crypto.randomBytes(32), limits); return { dir, home, project, store, write };
}
function direct(f, onMessage = () => {}) {
  return async function* transport(backend, config, signal) {
    const messages = []; await sourceRuntime({ ...config, home: f.home }, async m => { await onMessage(m); messages.push(m); });
    for (const m of messages) { if (signal?.aborted) throw Object.assign(Error('cancelled'), { code: 'cancelled' }); yield m; }
  };
}
const config = f => ({ serverId: 'vm', name: 'VM', roots: [f.project], includeChats: true, retention: 32 });
function fakeSSH(home) {
  let processes = 0; const children = new Set();
  const backend = { ready: true, cfg: { id: 'vm' }, client: { exec(cmd, cb) {
    processes++; const child = spawn('/bin/sh', ['-c', cmd], { env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] }); children.add(child); child.once('exit', () => children.delete(child));
    const channel = Duplex.from({ readable: child.stdout, writable: child.stdin }); channel.stderr = child.stderr;
    channel.signal = () => child.kill('SIGTERM'); channel.close = () => { child.stdin.end(); child.kill('SIGTERM'); }; cb(null, channel);
  } } };
  return { backend, count: () => processes, close: () => { for (const c of children) c.kill('SIGTERM'); } };
}

test('real source files pass through one streaming SSH helper to encrypted chat/file snapshots', { skip: process.platform !== 'linux' }, async t => {
  const f = fixture(t), ssh = fakeSSH(f.home); t.after(ssh.close);
  const expected = new Map();
  for (const p of ['.claude/projects/a/old.jsonl', '.claude-work/projects/z/nested/other.jsonl', '.codex/sessions/2020/a.jsonl', '.codex-extra/archived_sessions/old.jsonl', 'project/.env', 'project/.git/objects/history', 'project/.claude/commands/note.md']) expected.set(p, Buffer.from('SYNTHETIC-SECRET ' + p));
  expected.set('project/binary.dat', crypto.randomBytes(800000));
  for (const [p, b] of expected) f.write(p, b);
  f.write('.claude.json', 'PROFILE-CONFIG-NOT-A-DIRECTORY');
  f.write('.codex/auth.json', 'AUTH-MUST-NOT-READ'); f.write('.claude/token', 'TOKEN-MUST-NOT-READ'); f.write('project/node_modules/a.js', 'GENERATED');
  for (let i = 0; i < 180; i++) f.write('project/tiny/' + i, 'tiny-' + i);
  const snap = await collect(f.store, ssh.backend, config(f)); assert.equal(snap.complete, true); assert.equal(ssh.count(), 1);
  const m = f.store.manifest('vm', snap.id); assert.equal(m.entries.length, expected.size + 180);
  for (const [p, bytes] of expected) {
    const suffix = p.startsWith('project/') ? p.slice('project/'.length) : p;
    const file = m.entries.find(x => x.path.endsWith('/' + suffix)); assert.ok(file, p);
    assert.deepEqual(Buffer.concat([...f.store.fileBytes(file)]), bytes, p);
  }
  assert.ok(!m.entries.some(x => /auth\.json|token|node_modules/.test(x.path)));
  // Source deletion/disconnect never participates in saved reads.
  ssh.backend.ready = false; fs.rmSync(f.home, { recursive: true });
  assert.ok(f.store.preview('vm', snap.id, m.entries.find(f => f.kind === 'chat').id).text.includes('SYNTHETIC-SECRET'));
});

test('growing files are deferred, partial snapshots retain good history, and failed/empty listings cannot replace it', async t => {
  const f = fixture(t); const stable = f.write('project/stable.txt', 'good old'), changing = f.write('project/growing.jsonl', 'before');
  const first = await collect(f.store, {}, config(f), { transport: direct(f) });
  const mutate = m => { if (m.t === 'chunk' && Buffer.from(m.data, 'base64').toString() === 'before') fs.appendFileSync(changing, 'growth'); };
  const second = await collect(f.store, {}, config(f), { transport: direct(f, mutate) });
  assert.equal(second.complete, false); assert.equal(second.skipped, 1); assert.equal(second.reason, 'source_changed');
  assert.equal(f.store.manifest('vm', second.id).entries.length, 1); assert.ok(f.store.snapshots('vm').some(s => s.id === first.id));
  const failed = async function* () { yield { t: 'error', code: 'listing_failed' }; };
  await assert.rejects(collect(f.store, {}, config(f), { transport: failed }), { code: 'listing_failed' });
  fs.rmSync(stable); fs.rmSync(changing);
  await assert.rejects(collect(f.store, {}, config(f), { transport: direct(f) }), { code: 'empty' });
  assert.equal(f.store.snapshots('vm')[0].id, second.id);
});

test('selected-folder links/oversize/special files are explicit partial; broad roots and source replacement fail closed', async t => {
  const f = fixture(t, { fileBytes: 50 }); f.write('project/good', 'safe'); f.write('project/huge', 'x'.repeat(100));
  const outside = f.write('outside-secret', 'do not follow'); fs.symlinkSync(outside, path.join(f.project, 'escape')); fs.linkSync(outside, path.join(f.project, 'hardlink'));
  const snap = await collect(f.store, {}, config(f), { transport: direct(f) }); assert.equal(snap.complete, false); assert.equal(snap.skipped, 3); assert.equal(snap.files, 1);
  for (const root of ['/', f.home, path.dirname(f.home), '/etc']) {
    await assert.rejects(collect(f.store, {}, { ...config(f), roots: [root] }, { transport: direct(f) }), /unsafe_root/);
  }
  const alias = path.join(f.home, 'alias'); fs.symlinkSync(f.project, alias, 'dir');
  await assert.rejects(collect(f.store, {}, { ...config(f), roots: [alias] }, { transport: direct(f) }), /unsafe_source/);
  const replace = m => { if (m.t === 'file') { fs.renameSync(f.project, f.project + '-old'); fs.mkdirSync(f.project); } };
  await assert.rejects(collect(f.store, {}, config(f), { transport: direct(f, replace) }), /source_changed/);
  assert.equal(f.store.snapshots('vm')[0].id, snap.id);
});

test('unreadable source and scan/read quotas report failure without green replacement', async t => {
  const f = fixture(t); f.write('project/good', 'a good copy'); const first = await collect(f.store, {}, config(f), { transport: direct(f) });
  // Synthetic I/O failure is deterministic even when the test runner is root.
  const original = fs.promises.open; fs.promises.open = async (...args) => { if (args[0] === path.join(f.project, 'good')) throw Object.assign(Error('denied'), { code: 'EACCES' }); return original(...args); };
  try { await assert.rejects(collect(f.store, {}, config(f), { transport: direct(f) }), { code: 'empty' }); } finally { fs.promises.open = original; }
  f.store.limits.entries = 1; await assert.rejects(collect(f.store, {}, config(f), { transport: direct(f) }), /scan_limit/);
  assert.deepEqual(f.store.snapshots('vm').map(s => s.id), [first.id]);
});

test('stream cancellation and malformed/truncated protocol never publish', async t => {
  const f = fixture(t), ac = new AbortController(); f.write('project/good', crypto.randomBytes(600000));
  const cancel = async function* (b, c, signal) { for await (const m of direct(f)(b, c, signal)) { yield m; if (m.t === 'chunk') ac.abort(); } };
  await assert.rejects(collect(f.store, {}, config(f), { signal: ac.signal, transport: cancel }), { code: 'cancelled' }); assert.equal(f.store.snapshots('vm').length, 0);
  const truncated = async function* () { yield { t: 'file', path: 'files/x', kind: 'file', size: 10, mtimeMs: 1 }; yield { t: 'chunk', data: Buffer.from('short').toString('base64') }; yield { t: 'end' }; };
  await assert.rejects(collect(f.store, {}, config(f), { transport: truncated }), { code: 'incomplete_file' });
  const hostile = async function* () { yield { t: 'file', path: '../escape', kind: 'file', size: 10, mtimeMs: 1 }; };
  await assert.rejects(collect(f.store, {}, config(f), { transport: hostile }), { code: 'source_protocol' });
});

test('remote reader timeout/cancellation close the channel, including a channel opened after cancellation', async t => {
  let callback, closed = 0; const ac = new AbortController();
  const backend = { ready: true, cfg: {}, client: { exec(cmd, cb) { callback = cb; } } };
  const iterator = remoteMessages(backend, { limits: LIMITS, roots: [], includeChats: true, exclusions: EXCLUSIONS }, ac.signal);
  const pending = iterator.next(); ac.abort(); await assert.rejects(pending, { code: 'cancelled' });
  callback(null, { close() { closed++; } }); assert.equal(closed, 1);
});
