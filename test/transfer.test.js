'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), cp = require('node:child_process');
const T = require('../lib/transfer');
const { Vault } = require('../lib/vault');

const shq = (x) => "'" + String(x).replace(/'/g, "'\\''") + "'";
function machine(home, sessions, extraEnv = {}) {
  return { ready: true, mode: 'native', cfg: { id: 'local' }, snapshot: { sessions },
    exec: async (cmd, t, m, input) => { const r = cp.spawnSync('sh', ['-c', cmd], { env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', ...extraEnv }, input, maxBuffer: 256 * 1024 * 1024 }); return { code: r.status, out: String(r.stdout), err: String(r.stderr) }; } };
}
function repo(dir, origin) { fs.mkdirSync(path.join(dir, '.git'), { recursive: true }); fs.writeFileSync(path.join(dir, '.git', 'config'), `[remote "origin"]\n\turl = ${origin}\n`); }

test('moving to a new computer: the old computer\'s chats travel in one encrypted file and land in the same repositories there', { skip: process.platform === 'win32' }, async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tn-xfer-'))), A = path.join(base, 'a'), B = path.join(base, 'b');
  try {
    const id1 = '1cbf2a9d-d71e-4998-868f-d2953df55c34', id2 = '2cbf2a9d-d71e-4998-868f-d2953df55c35';
    const srcRepo = path.join(A, 'Documents', 'ws', 'app'), dstRepo = path.join(B, 'code', 'app');
    fs.mkdirSync(srcRepo, { recursive: true }); fs.mkdirSync(dstRepo, { recursive: true });
    repo(srcRepo, 'git@github.com:me/app.git'); repo(dstRepo, 'https://github.com/me/app.git');
    const lonely = path.join(A, 'Documents', 'other'); fs.mkdirSync(lonely, { recursive: true }); repo(lonely, 'git@github.com:me/other.git');
    for (const [id, dir] of [[id1, srcRepo], [id2, lonely]]) {
      const p = path.join(A, '.claude', 'projects', dir.replace(/[^A-Za-z0-9]/g, '-')); fs.mkdirSync(p, { recursive: true });
      fs.writeFileSync(path.join(p, id + '.jsonl'), JSON.stringify({ cwd: dir, msg: 'open ' + dir + '/README.md' }) + '\n');
    }
    // one session running now, one only remembered for a restore
    const a = machine(A, [{ name: 'App', path: srcRepo, aiTool: 'claude', aiSessionId: id1 }]);
    const knownA = { sessions: { Other: { dir: lonely, run: 'claude', resume: id2 }, Shell: { dir: A, run: 'shell' } } };
    assert.deepEqual(T.localChats(a, knownA).map((c) => c.name).sort(), ['App', 'Other']);
    const preview = await T.collect(a, knownA, true); assert.equal(preview.chats.length, 2); assert.ok(preview.bytes > 0); assert.equal(preview.chats[0].b64, undefined);
    const full = await T.collect(a, knownA, false);
    const file = Vault.pack('old-pass', { kind: T.KIND, data: { servers: [{ id: 's1' }] }, chats: full.chats });
    assert.ok(!file.includes('README')); assert.equal(Vault.read(file, 'wrong'), null);
    const opened = Vault.read(file, 'old-pass'); assert.equal(opened.kind, T.KIND); assert.equal(opened.chats.length, 2);
    fs.rmSync(path.join(A, 'Documents'), { recursive: true, force: true });   // the old computer is not reachable from the new one
    // the new computer has "app" (another path, https origin) but not "other"
    const b = machine(B, []);
    const known = { sessions: {}, lost: [] };
    const { placed, waiting } = await T.place(b, opened.chats, known, shq);
    assert.deepEqual(placed.map((p) => [p.name, p.dir]), [['App', dstRepo]]);
    assert.deepEqual(waiting.map((w) => w.name), ['Other']);
    const landed = fs.readFileSync(path.join(B, '.claude', 'projects', dstRepo.replace(/[^A-Za-z0-9]/g, '-'), id1 + '.jsonl'), 'utf8');
    assert.ok(landed.includes(dstRepo + '/README.md')); assert.ok(!landed.includes(srcRepo));
    // after cloning "other" anywhere below home, a retry places it
    const cloned = path.join(B, 'src', 'other'); fs.mkdirSync(cloned, { recursive: true }); repo(cloned, 'git@github.com:me/other');
    const again = await T.place(b, waiting, known, shq);
    assert.deepEqual(again.placed.map((p) => p.dir), [cloned]); assert.equal(again.waiting.length, 0);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tn-xfer-contract-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const A = path.join(base, 'a'), B = path.join(base, 'b');
  for (const home of [A, B]) fs.mkdirSync(path.join(home, 'work'), { recursive: true });
  return { A, B, src: path.join(A, 'work'), dst: path.join(B, 'work') };
}
function put(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; }
function auth(home, email) { return put(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email }, token: 'DO-NOT-COPY-AUTH' })); }
const ID = '4cbf2a9d-d71e-4998-868f-d2953df55c37';
const chatPath = (home, profile, dir, id = ID) => path.join(home, profile, 'projects', dir.replace(/[^A-Za-z0-9]/g, '-'), id + '.jsonl');

test('legacy encrypted archives restore offline to HOME defaults despite a custom shell profile', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t), custom = path.join(f.B, '.claude-agent03');
  put(path.join(custom, '.claude.json'), '{"oauthAccount":{"emailAddress":"custom@fixture.invalid"}}');
  const legacy = { name: 'Legacy', tool: 'claude', id: ID, dir: f.dst, rel: '', b64: Buffer.from('{"legacy":true}\n').toString('base64') };
  const opened = Vault.read(Vault.pack('fixture', { kind: T.KIND, chats: [legacy] }), 'fixture');
  const result = await T.place(machine(f.B, [], { CLAUDE_CONFIG_DIR: custom }), opened.chats, { sessions: {} }, shq);
  assert.equal(result.placed.length, 1); assert.equal(result.waiting.length, 0);
  assert.equal(fs.readFileSync(chatPath(f.B, '.claude', f.dst), 'utf8'), '{"legacy":true}\n');
  assert.equal(fs.existsSync(path.join(custom, 'projects')), false);
  assert.equal(fs.existsSync(path.join(f.B, '.claude.json')), false, 'offline restore never manufactures credentials');
});

test('new default archives bind the selected account and reject target conflicts without touching credentials', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t); auth(f.A, 'same@fixture.invalid');
  put(chatPath(f.A, '.claude', f.src), JSON.stringify({ cwd: f.src, message: 'saved' }) + '\n');
  const source = machine(f.A, [{ name: 'Default', aiTool: 'claude', aiSessionId: ID, path: f.src }]);
  const full = await T.collect(source, {}, false); assert.equal(full.skipped.length, 0); assert.equal(full.chats.length, 1);
  const c = full.chats[0]; assert.equal(c.profile, path.join(f.A, '.claude')); assert.equal(c.defaultProfile, true);
  assert.deepEqual(c.account, { email: 'same@fixture.invalid', profile: c.profile, mode: 'default' });
  assert.equal(JSON.stringify(full).includes('DO-NOT-COPY-AUTH'), false);
  // Use the existing folder without relying on a matching repository.
  c.dir = f.dst; c.root = ''; c.origin = '';
  const b = machine(f.B, []), known = { sessions: {} }, file = chatPath(f.B, '.claude', f.dst);
  auth(f.B, 'other@fixture.invalid');
  assert.equal((await T.place(b, [c], known, shq)).waiting.length, 1); assert.equal(fs.existsSync(file), false);
  auth(f.B, 'same@fixture.invalid');
  assert.equal((await T.place(b, [{ ...c, account: { ...c.account, email: '' } }], known, shq)).waiting.length, 1, 'new archives without a source identity cannot claim a signed-in target account');
  assert.equal(fs.existsSync(file), false);
  put(path.join(f.B, '.claude', '.claude.json'), '{"oauthAccount":{"emailAddress":"conflict@fixture.invalid"}}');
  assert.equal((await T.place(b, [c], known, shq)).waiting.length, 1); assert.equal(fs.existsSync(file), false);
  fs.unlinkSync(path.join(f.B, '.claude', '.claude.json'));
  assert.equal((await T.place(b, [c], known, shq)).placed.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.B, '.claude.json'))).oauthAccount.emailAddress, 'same@fixture.invalid');
});

test('archive collection discovers custom profiles and archived Codex chats, retaining safe provenance', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t), codexId = '5cbf2a9d-d71e-4998-868f-d2953df55c38';
  auth(f.A, 'wrong@fixture.invalid');
  put(path.join(f.A, '.claude-agent03', '.claude.json'), '{"oauthAccount":{"emailAddress":"selected@fixture.invalid"}}');
  put(chatPath(f.A, '.claude-agent03', f.src), '{"agent03":true}\n');
  const rel = '2026/11/rollout-' + codexId + '.jsonl';
  put(path.join(f.A, '.codex', 'archived_sessions', rel), '{"codex":true}\n');
  const sessions = [{ name: 'Custom', aiTool: 'claude', aiSessionId: ID, path: f.src }, { name: 'Codex', aiTool: 'codex', aiSessionId: codexId, path: f.src }];
  const a = machine(f.A, sessions), full = await T.collect(a, {}, false);
  assert.equal(full.chats.length, 2); assert.deepEqual(full.skipped, []);
  const custom = full.chats.find(c => c.tool === 'claude'), codex = full.chats.find(c => c.tool === 'codex');
  assert.equal(custom.profile, path.join(f.A, '.claude-agent03')); assert.equal(custom.defaultProfile, false);
  assert.equal(custom.account.email, 'selected@fixture.invalid'); assert.equal(custom.account.mode, 'config');
  assert.equal(codex.rel, rel); assert.equal(Buffer.from(codex.b64, 'base64').toString(), '{"codex":true}\n');
  // A duplicate requires the trusted process profile, never a latest-file guess.
  put(chatPath(f.A, '.claude', f.src), '{"wrong":true}\n');
  assert.equal((await T.collect(a, {}, false)).skipped[0].why, 'ambiguous');
  sessions[0].aiStatus = { cfg: path.join(f.A, '.claude-agent03') };
  assert.equal((await T.collect(a, {}, false)).chats[0].account.email, 'selected@fixture.invalid');
  const server = { ...a, cfg: { id: 'fixture-server' } };
  assert.equal((await T.collectServers([server], {}, false)).chats[0].profile, custom.profile);
  const b = machine(f.B, []), known = { sessions: {} };
  custom.dir = f.dst; custom.root = ''; custom.origin = '';
  assert.equal((await T.place(b, [custom], known, shq)).waiting.length, 1, 'custom chats cannot be offered as default-profile resumes');
  codex.dir = f.dst; codex.root = ''; codex.origin = '';
  assert.equal((await T.place(b, [codex], known, shq)).placed.length, 1);
  assert.equal(fs.readFileSync(path.join(f.B, '.codex', 'sessions', rel), 'utf8'), '{"codex":true}\n');
});

test('offline archive writer retains collision, traversal, symlink and 40 MB limits', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t), b = machine(f.B, []), known = { sessions: {} };
  const c = { name: 'Legacy', tool: 'claude', id: ID, dir: f.dst, rel: '', b64: Buffer.from('original\n').toString('base64') };
  const file = chatPath(f.B, '.claude', f.dst); put(file, 'different existing chat\n');
  assert.equal((await T.place(b, [c], known, shq)).waiting.length, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), 'different existing chat\n');
  fs.unlinkSync(file); fs.symlinkSync(path.join(f.B, 'outside'), file);
  assert.equal((await T.place(b, [c], known, shq)).waiting.length, 1); assert.equal(fs.existsSync(path.join(f.B, 'outside')), false);
  assert.equal((await T.place(b, [{ ...c, tool: 'codex', rel: '../rollout-' + ID + '.jsonl' }], known, shq)).waiting.length, 1);
  const huge = put(chatPath(f.A, '.claude', f.src), ''); fs.truncateSync(huge, 40 * 1024 * 1024 + 1);
  const source = machine(f.A, [{ name: 'Huge', path: f.src, aiTool: 'claude', aiSessionId: ID }]);
  for (const sizesOnly of [true, false]) {
    const result = await T.collect(source, {}, sizesOnly);
    assert.equal(result.chats.length, 0); assert.equal(result.bytes, 0); assert.equal(result.skipped[0].why, 'toolarge');
  }
});

test('the file goes to the Desktop when there is one, named by date', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-home-'));
  try {
    assert.equal(T.exportDir(home), home); fs.mkdirSync(path.join(home, 'Downloads')); assert.equal(T.exportDir(home), path.join(home, 'Downloads'));
    fs.mkdirSync(path.join(home, 'Desktop')); assert.equal(T.exportDir(home), path.join(home, 'Desktop'));
    assert.equal(T.exportName(new Date(2026, 10, 6, 9, 5)), 'TERMNEST-chuyen-may-2026-11-06-0905.termnest');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('server chats travel as a spare copy and go back only to a server that lost them', { skip: process.platform === 'win32' }, async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tn-srvchat-'))), H = path.join(base, 'srv');
  try {
    const id = '3cbf2a9d-d71e-4998-868f-d2953df55c36', dir = path.join(H, 'ws', 'app');
    fs.mkdirSync(dir, { recursive: true }); repo(dir, 'git@gitlab.example.com:me/app.git');
    const proj = path.join(H, '.claude', 'projects', dir.replace(/[^A-Za-z0-9]/g, '-')); fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, id + '.jsonl'), '{"m":"hello"}\n');
    const srv = { ...machine(H, [{ name: 'SV1', path: dir, aiTool: 'claude', aiSessionId: id }]), cfg: { id: 's1' }, publicView: () => ({ name: 'dev-ubuntu-02' }) };
    const localOnly = { ...machine(base, []), cfg: { id: 'local', local: true } };
    const sizes = await T.collectServers([localOnly, srv], {}, true);
    assert.equal(sizes.chats.length, 1); assert.equal(sizes.chats[0].serverName, 'dev-ubuntu-02'); assert.equal(sizes.chats[0].b64, undefined);
    const full = await T.collectServers([localOnly, srv], {}, false);
    assert.equal(full.chats[0].server, 's1');
    assert.equal(await T.restoreOnServer(srv, full.chats[0], shq), 'present');   // the server still has it: untouched
    fs.writeFileSync(path.join(proj, id + '.jsonl'), '{"m":"hello"}\n{"m":"went on"}\n');
    assert.equal(await T.restoreOnServer(srv, full.chats[0], shq), 'present');
    assert.ok(fs.readFileSync(path.join(proj, id + '.jsonl'), 'utf8').includes('went on'));
    fs.rmSync(path.join(H, '.claude'), { recursive: true, force: true });   // the server was reinstalled
    assert.equal(await T.restoreOnServer(srv, full.chats[0], shq), 'written');
    assert.equal(fs.readFileSync(path.join(proj, id + '.jsonl'), 'utf8'), '{"m":"hello"}\n');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
