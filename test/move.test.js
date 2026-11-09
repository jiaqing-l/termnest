'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), cp = require('node:child_process');
const move = require('../lib/features/move');

const shq = (x) => "'" + String(x).replace(/'/g, "'\\''") + "'";
// A "machine": its own HOME; commands run through a real shell, stdin carries uploaded bytes.
function machine(home, sessions, extra = {}) {
  return { ready: true, mode: 'native', cfg: { id: path.basename(home) }, snapshot: { sessions }, launches: [],
    exec: async function (cmd, t, m, input) { if (cmd.includes('function verifyRuntime()')) return { code: 0, out: JSON.stringify({ verified: true }) }; if (cmd.startsWith('tmux send-keys ')) { this.launches.push(cmd); return { code: 0, out: '' }; } const r = cp.spawnSync('sh', ['-c', cmd], { env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: '', CODEX_HOME: '' }, input, maxBuffer: 256 * 1024 * 1024 }); return { code: r.status, out: String(r.stdout), err: String(r.stderr) }; }, ...extra };
}
function signIn(home, email) { fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email } })); }
function repo(dir, origin) { fs.mkdirSync(path.join(dir, '.git'), { recursive: true }); fs.writeFileSync(path.join(dir, '.git', 'config'), `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${origin}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`); }

test('a Claude chat moves to a machine where the same repository lives at another path, and resumes there', { skip: process.platform === 'win32' }, async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tn-move-'))), A = path.join(base, 'a'), B = path.join(base, 'b');
  try {
    // machine A: /…/a/work/xspire (repo, ssh url), session in its sub-folder "docs"; machine B: /…/b/src/projects/xspire (https url)
    const srcRepo = path.join(A, 'work', 'xspire'), dstRepo = path.join(B, 'src', 'projects', 'xspire');
    fs.mkdirSync(path.join(srcRepo, 'docs'), { recursive: true }); fs.mkdirSync(path.join(dstRepo, 'docs'), { recursive: true });
    repo(srcRepo, 'git@gitlab.example.com:team/xspire.git'); repo(dstRepo, 'https://dev@gitlab.example.com/team/xspire');
    signIn(A, 'Me@Example.com'); signIn(B, 'me@example.com');
    const id = '1cbf2a9d-d71e-4998-868f-d2953df55c34', cwd = path.join(srcRepo, 'docs');
    const proj = path.join(A, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-')); fs.mkdirSync(proj, { recursive: true });
    const chat = [{ cwd, message: 'edit ' + path.join(srcRepo, 'README.md') }, { cwd, message: 'done' }].map((x) => JSON.stringify(x)).join('\n') + '\n';
    fs.writeFileSync(path.join(proj, id + '.jsonl'), chat);
    const a = machine(A, [{ name: 'SV1', path: cwd, cmd: 'claude', aiTool: 'claude', aiSessionId: id }]);
    const b = machine(B, [{ name: 'SV1', path: dstRepo, cmd: 'bash' }]);
    // the local fast path of runOnHost is not used: both machines answer through `node -e` in their own HOME
    const routes = {}, sent = [], fails = [], started = [], stopped = [];
    move.register({ route: (m, p, h) => { routes[m + p] = h; }, backendOf: (x) => ({ a, b }[x] || null), shq, readJson: async (req) => req.body,
      send: (res, c, body) => sent.push(body), fail: (res, c, msg) => fails.push(msg),
      sessions: { start: async (r, o) => started.push([r.cfg.id, o]), stop: async (r, n) => { stopped.push([r.cfg.id, n]); return true; } } });
    await routes['GET/check']({ res: {}, url: new URL('http://x/check?server=a&session=SV1&to=b') });
    assert.deepEqual(fails, []);
    const c = sent.pop();
    assert.equal(c.same, true); assert.equal(c.from, 'me@example.com'); assert.equal(c.size, Buffer.byteLength(chat));
    assert.equal(c.places[0].path, path.join(dstRepo, 'docs')); assert.equal(c.places[0].why, 'repo');
    assert.equal(c.name, 'SV1-2');   // SV1 is taken on the target
    await routes['POST/run']({ req: { body: { server: 'a', session: 'SV1', to: 'b', dir: c.places[0].path, name: c.name, stop: true } }, res: {} });
    assert.deepEqual(fails, []);
    const r = sent.pop();
    assert.equal(r.ok, true); assert.equal(r.rewritten, 3); assert.equal(r.stopped, true);
    const landed = path.join(B, '.claude', 'projects', path.join(dstRepo, 'docs').replace(/[^A-Za-z0-9]/g, '-'), id + '.jsonl');
    const text = fs.readFileSync(landed, 'utf8');
    assert.ok(!text.includes(srcRepo)); assert.ok(text.includes(path.join(dstRepo, 'README.md')));
    if (process.platform !== 'win32') assert.equal(fs.statSync(landed).mode & 0o077, 0);
    assert.deepEqual(started, [['b', { name: 'SV1-2', dir: path.join(dstRepo, 'docs'), run: 'shell', restoring: true }]]);
    assert.deepEqual(stopped, [['a', 'SV1']]);
    assert.ok(b.launches[0].includes('--resume')); assert.ok(b.launches[0].includes(id)); assert.ok(b.launches[0].includes('env -u CLAUDE_CONFIG_DIR'));
    // a second move never shortens a longer copy that the target went on with
    fs.appendFileSync(landed, JSON.stringify({ message: 'continued on b' }) + '\n');
    b.snapshot.sessions.push({ name: 'SV1-2', path: dstRepo, cmd: 'claude' });
    await routes['POST/run']({ req: { body: { server: 'a', session: 'SV1', to: 'b', dir: path.join(dstRepo, 'docs'), name: 'SV1-3' } }, res: {} });
    assert.equal(sent.pop().kept, true); assert.ok(fs.readFileSync(landed, 'utf8').includes('continued on b'));
    // another account on the target: refused, nothing written
    signIn(B, 'someone@else.com');
    await routes['POST/run']({ req: { body: { server: 'a', session: 'SV1', to: 'b', dir: path.join(dstRepo, 'docs'), name: 'SV1-4' } }, res: {} });
    assert.match(fails.pop(), /someone@else\.com/); assert.equal(started.length, 2);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('a Codex chat keeps its dated place under the target\'s own sessions folder', { skip: process.platform === 'win32' }, async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tn-movex-'))), A = path.join(base, 'a'), B = path.join(base, 'b');
  try {
    const id = '019a1b2c-3d4e-7f60-8a9b-0c1d2e3f4a5b', rel = `2026/11/06/rollout-2026-11-06T09-00-00-${id}.jsonl`;
    const tok = (email) => JSON.stringify({ tokens: { id_token: 'h.' + Buffer.from(JSON.stringify({ email })).toString('base64url') + '.s' } });
    for (const h of [A, B]) { fs.mkdirSync(path.join(h, '.codex'), { recursive: true }); fs.writeFileSync(path.join(h, '.codex', 'auth.json'), tok('me@example.com')); fs.mkdirSync(path.join(h, 'w'), { recursive: true }); }
    fs.mkdirSync(path.dirname(path.join(A, '.codex', 'sessions', rel)), { recursive: true }); fs.writeFileSync(path.join(A, '.codex', 'sessions', rel), '{"a":1}\n');
    const a = machine(A, [{ name: 'cx', path: path.join(A, 'w'), cmd: 'node', aiTool: 'codex', aiSessionId: id }]), b = machine(B, []);
    const routes = {}, sent = [], fails = [], started = [];
    move.register({ route: (m, p, h) => { routes[m + p] = h; }, backendOf: (x) => ({ a, b }[x] || null), shq, readJson: async (req) => req.body,
      send: (res, c, body) => sent.push(body), fail: (res, c, msg) => fails.push(msg), sessions: { start: async (r, o) => started.push(o), stop: async () => true } });
    await routes['POST/run']({ req: { body: { server: 'a', session: 'cx', to: 'b', dir: path.join(B, 'w'), name: 'cx' } }, res: {} });
    assert.deepEqual(fails, []);
    assert.equal(fs.readFileSync(path.join(B, '.codex', 'sessions', rel), 'utf8'), '{"a":1}\n');
    assert.equal(started[0].run, 'shell'); assert.ok(b.launches[0].includes('CODEX_HOME=')); assert.ok(b.launches[0].includes('codex resume')); assert.ok(b.launches[0].includes(id));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('path rewriting and free names', () => {
  assert.deepEqual(move.rewritePaths('"/a/x" and "/a/x/y"', '/a/x', '/b/z'), { text: '"/b/z" and "/b/z/y"', count: 2 });
  assert.equal(move.rewritePaths('x', 'a"b', '/c').count, 0);
  assert.equal(move.freeName('s', new Set(['s', 's-2'])), 's-3');
});

test('without a known conversation id the user picks it from the folder\'s recent chats, then it moves', { skip: process.platform === 'win32' }, async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tn-pick-'))), A = path.join(base, 'a'), B = path.join(base, 'b');
  try {
    const dir = path.join(A, 'ws'); fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(path.join(B, 'ws2'), { recursive: true });
    signIn(A, 'me@x.com'); signIn(B, 'me@x.com');
    const proj = path.join(A, '.claude', 'projects', dir.replace(/[^A-Za-z0-9]/g, '-')); fs.mkdirSync(proj, { recursive: true });
    const old = '11111111-2222-4333-8444-555555555555', cur = '66666666-7777-4888-9999-000000000000';
    fs.writeFileSync(path.join(proj, old + '.jsonl'), JSON.stringify({ type: 'user', message: { role: 'user', content: 'sửa lỗi cũ' } }) + '\n');
    const past = (Date.now() - 3600e3) / 1000; fs.utimesSync(path.join(proj, old + '.jsonl'), past, past);
    fs.writeFileSync(path.join(proj, cur + '.jsonl'), JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Thêm test cho ảnh lớn' }] } }) + '\n');
    const a = machine(A, [{ name: 'SV1', path: dir, cmd: 'claude' }]), b = machine(B, []);   // no aiSessionId: an older Claude
    const routes = {}, sent = [], fails = [], started = [];
    move.register({ route: (m, p, h) => { routes[m + p] = h; }, backendOf: (x) => ({ a, b }[x] || null), shq, readJson: async (req) => req.body,
      send: (res, c, body) => sent.push(body), fail: (res, c, msg) => fails.push(msg), sessions: { start: async (r, o) => started.push(o), stop: async () => true } });
    await routes['GET/check']({ res: {}, url: new URL('http://x/check?server=a&session=SV1&to=b') });
    const pick = sent.pop();
    assert.deepEqual(pick.pick.map((c) => c.id), [cur, old]); assert.equal(pick.pick[0].ask, 'Thêm test cho ảnh lớn'); assert.equal(pick.pick[1].ask, 'sửa lỗi cũ');
    await routes['GET/check']({ res: {}, url: new URL('http://x/check?server=a&session=SV1&to=b&id=' + cur) });
    assert.equal(sent.pop().same, true);
    await routes['POST/run']({ req: { body: { server: 'a', session: 'SV1', to: 'b', dir: path.join(B, 'ws2'), name: 'SV1', id: cur } }, res: {} });
    assert.deepEqual(fails, []); assert.equal(started[0].run, 'shell'); assert.ok(b.launches[0].includes(cur));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// "Không đọc được:" used to end with nothing: the dialog now names the machine and the reason.
test('a survey failure names the machine and the reason instead of an empty message', { skip: process.platform === 'win32' }, async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tn-move-err-'))), A = path.join(base, 'a'), B = path.join(base, 'b');
  try {
    const cwd = path.join(A, 'work'); fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(B, { recursive: true });
    signIn(A, 'me@example.com'); signIn(B, 'me@example.com');
    const id = '1cbf2a9d-d71e-4998-868f-d2953df55c34', proj = path.join(A, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
    fs.mkdirSync(proj, { recursive: true }); fs.writeFileSync(path.join(proj, id + '.jsonl'), JSON.stringify({ cwd, message: 'hi' }) + '\n');
    const a = machine(A, [{ name: 'SV1', path: cwd, cmd: 'claude', aiTool: 'claude', aiSessionId: id }]);
    const b = machine(B, []); const real = b.exec;
    b.exec = function (cmd, ...rest) { if (cmd.includes('function placeRuntime')) return Promise.reject(new Error('Máy chủ phản hồi quá lâu.')); return real.call(this, cmd, ...rest); };
    const routes = {}, fails = [];
    move.register({ route: (m, p, h) => { routes[m + p] = h; }, backendOf: (x) => ({ a, b }[x] || null), shq, readJson: async (req) => req.body,
      send: () => {}, fail: (res, c, msg) => fails.push(msg), sessions: { start: async () => {}, stop: async () => true } });
    await routes['GET/check']({ res: {}, url: new URL('http://x/check?server=a&session=SV1&to=b') });
    assert.equal(fails.length, 1); assert.match(fails[0], /b — Máy chủ phản hồi quá lâu\./, fails[0]);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
