'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), cp = require('node:child_process');
const T = require('../lib/transfer');
const { Vault } = require('../lib/vault');

const shq = (x) => "'" + String(x).replace(/'/g, "'\\''") + "'";
function machine(home, sessions) {
  return { ready: true, mode: 'native', cfg: { id: 'local' }, snapshot: { sessions },
    exec: async (cmd, t, m, input) => { const r = cp.spawnSync('sh', ['-c', cmd], { env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: '', CODEX_HOME: '' }, input, maxBuffer: 256 * 1024 * 1024 }); return { code: r.status, out: String(r.stdout), err: String(r.stderr) }; } };
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
