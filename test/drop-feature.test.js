'use strict';
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const drop = require('../lib/features/drop');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

test('accepts any file except programs; checks that pictures, pdf, text and Office files are what they claim', () => {
  assert.equal(drop.check('a.PNG', PNG), 'png');
  assert.equal(drop.check('n.md', Buffer.from('# hi')), 'md');
  assert.equal(drop.check('x.pdf', Buffer.from('%PDF-1.7 ...')), 'pdf');
  assert.equal(drop.check('trang.html', Buffer.from('<h1>x</h1>')), 'html');
  assert.equal(drop.check('bao-cao.docx', Buffer.from([0x50, 0x4b, 3, 4, 0, 0])), 'docx');
  assert.equal(drop.check('data.parquet', Buffer.from([1, 2, 3, 0])), 'parquet');   // unknown types pass through, binary or not
  assert.equal(drop.check('noext', Buffer.from('x')), 'dat');
  assert.throws(() => drop.check('fake.png', Buffer.from('not an image at all')), /không đúng/);
  assert.throws(() => drop.check('fake.xlsx', Buffer.from('plain text')), /không đúng/);
  assert.throws(() => drop.check('a.txt', Buffer.from([65, 0, 66])), /nhị phân/);
  for (const bad of ['a.exe', 'x.DLL', 'setup.msi', 'run.bat', 'tool.cmd']) assert.throws(() => drop.check(bad, Buffer.from('MZ')), /chương trình/);
  assert.throws(() => drop.check('a.png', Buffer.alloc(0)), /rỗng/);
  assert.throws(() => drop.check('a.txt', Buffer.alloc(drop.MAX_BYTES + 1, 65)), /quá lớn/);
});

test('the stored script writes stdin to a private temp folder and prints the path', { skip: process.platform === 'win32' }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-drop-'));
  const r = cp.spawnSync('sh', ['-c', drop.storeScript('20261103-abc.png')], { input: PNG, env: { ...process.env, TMPDIR: tmp }, encoding: 'buffer' });
  assert.equal(r.status, 0);
  const out = r.stdout.toString().trim(); assert.ok(out.startsWith(tmp));
  assert.deepEqual(fs.readFileSync(out), PNG);
  assert.equal(fs.statSync(out).mode & 0o077, 0); assert.equal(fs.statSync(path.dirname(out)).mode & 0o077, 0);
});

test('the client reads the server and session from the app current() shape {v, s}', () => {
  const vm = require('node:vm');
  const TW = { el: () => ({}), app: () => ({}) };
  const ctx = { TW, setInterval: () => 0, clearInterval() {}, document: {}, i18n: (k) => k };
  ctx.window = ctx;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/features/drop.js'), 'utf8'), ctx);
  const plain = (v) => JSON.parse(JSON.stringify(v));   // objects made inside the vm have another prototype
  assert.deepEqual(plain(TW.dropTarget({ v: { id: 'srv-1' }, s: { name: 'build' } })), { id: 'srv-1', name: 'build' });
  assert.deepEqual(plain(TW.dropTarget({ id: 'srv-2', name: 'old' })), { id: 'srv-2', name: 'old' });   // the older shape still works
  assert.equal(TW.dropTarget(null), null);
  assert.equal(typeof TW.upload, 'function');
});

test('taking a file from another machine: contained to the session folder, any file type, stored on the target', async () => {
  const { transferReadRuntime } = require('../lib/file-viewer');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-xfer-')), outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-xout-'));
  try {
    fs.mkdirSync(path.join(root, 'docs')); fs.writeFileSync(path.join(root, 'docs', 'bao-cao.docx'), Buffer.from([0x50, 0x4b, 3, 4, 9, 9])); fs.writeFileSync(path.join(root, 'trang.html'), '<h1>Xin chào</h1>');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 's');
    const read = transferReadRuntime(), run = (p, max = 1000) => read({ cwd: root, path: p, max });
    const ok = await run('docs/bao-cao.docx'); assert.equal(ok.name, 'bao-cao.docx'); assert.deepEqual([...Buffer.from(ok.b64, 'base64')], [0x50, 0x4b, 3, 4, 9, 9]);
    assert.equal(Buffer.from((await run(path.join(root, 'trang.html'))).b64, 'base64').toString(), '<h1>Xin chào</h1>');   // an absolute path inside the folder works
    assert.equal((await run('docs')).code, 'notfile'); assert.equal((await run('nothing.txt')).code, 'notfound'); assert.equal((await run('../x')).code, 'notfound');
    assert.equal((await run(path.join(outside, 'secret.txt'))).code, 'outside');
    assert.equal((await run('docs/bao-cao.docx', 3)).code, 'toolarge');
    for (const bad of ['', 'a\nb', 'x'.repeat(5000)]) assert.equal((await run(bad)).code, 'invalid');
    if (process.platform !== 'win32') { fs.symlinkSync(outside, path.join(root, 'link')); assert.equal((await run('link/secret.txt')).code, 'outside'); }
    // the route: source read, then the target stores it with its own checks
    let handler; const fails = [], sent = []; const stored = [];
    const backend = (id, extra = {}) => ({ ready: true, mode: 'native', cfg: { local: true }, snapshot: { sessions: [{ name: 's', path: root }] },
      exec: async (cmd, t, m, input) => { if (/display-message/.test(cmd)) return { code: 0, out: root + '\n' }; if (input) { stored.push([id, input.length]); return { code: 0, out: '/tmp/termnest-drop-1/stored.docx\n' }; } return { code: 0, out: '' }; }, ...extra });
    const backends = { src: backend('src'), dst: backend('dst'), win: backend('win', { mode: 'powershell' }) };
    drop.register({ route: (m, p, h) => { if (p === '/transfer') handler = h; }, backendOf: (id) => backends[id] || null, shq: (x) => "'" + x + "'",
      fail: (res, code, msg) => fails.push(msg), send: (res, code, body) => sent.push(body), readJson: async (req) => req.body, readBody: async () => Buffer.alloc(0) });
    const call = (body) => handler({ req: { body }, res: {}, url: new URL('http://x/transfer') });
    await call({ from: { server: 'src', session: 's', path: 'docs/bao-cao.docx' }, to: { server: 'dst', session: 's' } });
    assert.deepEqual(stored, [['dst', 6]]); assert.equal(sent[0].path, '/tmp/termnest-drop-1/stored.docx'); assert.equal(sent[0].name, 'bao-cao.docx'); assert.equal(sent[0].kind, 'archive');
    await call({ from: { server: 'src', session: 's', path: path.join(outside, 'secret.txt') }, to: { server: 'dst', session: 's' } }); assert.match(fails.at(-1), /thư mục của phiên/);
    await call({ from: { server: 'gone', session: 's', path: 'a' }, to: { server: 'dst', session: 's' } }); assert.match(fails.at(-1), /chưa kết nối/);
    await call({ from: { server: 'src', session: 's', path: 'a' }, to: { server: 'win', session: 's' } }); assert.match(fails.at(-1), /chưa hỗ trợ/);
    await call({ from: { server: 'src' }, to: {} }); assert.match(fails.at(-1), /chọn máy nguồn/i);
    assert.equal(stored.length, 1);   // nothing else was written
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});
