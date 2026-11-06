'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const { screensScript, parseScreens, MAX_SESSIONS } = require('../lib/screens');

test('the script asks tmux for each session and keeps the last lines', () => {
  const script = screensScript(['a', 'b-c'], 10);
  assert.match(script, /@@S 0/); assert.match(script, /@@S 1/);
  assert.match(script, /capture-pane -p -t '=a:'/); assert.match(script, /'=b-c:'/);
  assert.match(script, /L=10/);
});

test('names and counts are validated', () => {
  assert.throws(() => screensScript([]), /Invalid/);
  assert.throws(() => screensScript('a'), /Invalid/);
  assert.throws(() => screensScript(['x; rm -rf /\n']), /Invalid/);
  assert.throws(() => screensScript(Array.from({ length: MAX_SESSIONS + 1 }, (_, i) => 's' + i)), /Invalid/);
  assert.match(screensScript(['a'], 9999), /L=60/);
  assert.match(screensScript(['a'], 1), /L=4/);
});

test('the reply is split per session, in order', () => {
  const out = '@@S 0\nline 1\nline 2\n@@S 1\n@@S 2\nonly\n';
  assert.deepEqual(parseScreens(out, ['a', 'b', 'c']), { a: 'line 1\nline 2', b: '', c: 'only' });
  assert.deepEqual(parseScreens('garbage', ['a']), {});
});

test('the awk filter drops trailing blank lines and keeps only the last N', () => {
  const awk = screensScript(['x'], 4).match(/\| (awk .*)$/)[1];
  const run = (input) => execFileSync('sh', ['-c', awk], { input }).toString();
  assert.equal(run('a\nb\nc\nd\ne\nf\n\n   \n\n'), 'c\nd\ne\nf\n');
  assert.equal(run('\n\n'), '');
  assert.equal(run('only\n'), 'only\n');
});

test('the wall is wired in: script tag, static route, API route and locale keys', () => {
  const fs = require('node:fs'), path = require('node:path');
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8'), server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(html, /src="\/wall\.js"/); assert.match(html, /id="wall"/);
  assert.match(server, /'\/wall\.js': \[path\.join\(PUB, 'wall\.js'\)/); assert.match(server, /tail === '\/screens' && m === 'POST'/);
  for (const lang of ['vi', 'en']) {
    const t = JSON.parse(fs.readFileSync(path.join(root, 'public/locales', lang + '.json'), 'utf8'));
    for (const k of ['wall.all', 'wall.f.all', 'wall.f.wait', 'wall.f.run', 'wall.f.idle', 'wall.empty']) assert.ok(t[k], lang + ' ' + k);
  }
});

test('a file buried in a wide workspace is still offered by name (find, not a capped walk)', { skip: process.platform === 'win32' && 'uses find, which Windows does not have' }, async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { fileRuntime } = require('../lib/file-viewer');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-wide-'));
  try {
    for (let r = 0; r < 40; r++) { const d = path.join(root, 'repo' + r, 'src', 'deep'); fs.mkdirSync(d, { recursive: true }); for (let f = 0; f < 260; f++) fs.writeFileSync(path.join(d, 'f' + f + '.txt'), ''); }   // ~10k files first in the walk order
    const target = path.join(root, 'zdocs', 'Implementation', 'Smart', 'phase', 'x', 'bien-the'); fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(path.join(root, 'zdocs', 'node_modules', 'bien-the'), { recursive: true }); fs.writeFileSync(path.join(root, 'zdocs', 'node_modules', 'bien-the', 'manifest.csv'), 'skip');
    fs.writeFileSync(path.join(target, 'manifest.csv'), 'a,b\n1,2\n');
    const result = await fileRuntime()({ cwd: root, path: 'bien-the/manifest.csv' });
    assert.deepEqual(result.candidates, ['zdocs/Implementation/Smart/phase/x/bien-the/manifest.csv']);
    const none = await fileRuntime()({ cwd: root, path: 'bien-the/nothing.csv' });
    assert.match(none.error, /Không tìm thấy tệp/);
    assert.equal(none.candidates, undefined);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the file index and filter find files by part of the name or path, newest first, skipping heavy folders', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { indexRuntime, filterIndex } = require('../lib/features/browse');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-search-'));
  try {
    const put = (rel, body, age) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); const t = new Date(Date.now() - age * 1000); fs.utimesSync(f, t, t); };
    put('docs/a/b/c/Manifest-Bien-The.csv', 'x', 100); put('docs/new/manifest-v2.csv', 'x', 5); put('node_modules/pkg/manifest.csv', 'x', 1); put('src/notes.md', 'x', 1); put('src/manifest.bin', 'x', 1); put('.mobile/plan/manifest-mobile.md', 'x', 50);
    const index = await indexRuntime()({ cwd: root });
    assert.ok(index.rows.length >= 4 && !index.error);
    const names = (q) => filterIndex(index.rows, q).files.map((f) => f.rel);
    assert.deepEqual(names('MANIFEST'), ['docs/new/manifest-v2.csv', '.mobile/plan/manifest-mobile.md', 'docs/a/b/c/Manifest-Bien-The.csv']);   // newest first; no node_modules, no .bin; dot folders are searched
    assert.deepEqual(names('bien-the'), ['docs/a/b/c/Manifest-Bien-The.csv']);
    assert.deepEqual(names('c/manifest-bien'), ['docs/a/b/c/Manifest-Bien-The.csv']);   // a path typed as folder/name
    assert.deepEqual(names('./new/manifest'), ['docs/new/manifest-v2.csv']);
    assert.deepEqual(names('zzz-nothing'), []); assert.deepEqual(names('*'), []); assert.deepEqual(names('['), []);
    assert.equal(filterIndex(index.rows, '').bad, true); assert.equal(filterIndex(index.rows, 'a\nb').bad, true);
    const many = Array.from({ length: 80 }, (_, i) => ({ rel: 'x/file' + i + '.md', at: i }));
    const page = filterIndex(many, 'file'); assert.equal(page.files.length, 50); assert.equal(page.more, true); assert.equal(page.files[0].rel, 'x/file79.md');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the file browser lists folders that start with a dot, but not .git or dot-files', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { browseRuntime } = require('../lib/features/browse');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-browse-'));
  try {
    for (const d of ['.mobile', '.github', '.git', 'docs', 'node_modules']) fs.mkdirSync(path.join(root, d));
    fs.writeFileSync(path.join(root, 'README.md'), 'x'); fs.writeFileSync(path.join(root, '.env'), 'x'); fs.writeFileSync(path.join(root, 'a.md'), 'xx');
    const out = await browseRuntime()({ cwd: root, dir: '' });
    assert.deepEqual(out.dirs, ['.github', '.mobile', 'docs']);
    assert.deepEqual(out.files.map((f) => f.name), ['a.md', 'README.md']);
    assert.equal(out.files.find((f) => f.name === 'a.md').size, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('creating a folder or file stays inside the session folder, never overwrites, and checks every parent', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { createRuntime } = require('../lib/features/browse');
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tn-create-'))), outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-outside-'));
  try {
    const run = createRuntime(); const make = (o) => run({ cwd: root, dir: '', ...o });
    let r = await make({ name: 'docs', kind: 'folder' }); assert.equal(r.path, fs.realpathSync(root) + path.sep + 'docs'); assert.ok(fs.statSync(r.path).isDirectory());
    r = await make({ name: 'docs/ghi-chu.md', kind: 'file', content: '# Xin chào\n' }); assert.equal(fs.readFileSync(r.path, 'utf8'), '# Xin chào\n');
    r = await make({ name: 'a/b/c/moi.txt', kind: 'file' }); assert.equal(fs.readFileSync(r.path, 'utf8'), '');   // missing parents are created
    r = await run({ cwd: root, dir: path.join(root, 'docs'), name: 'phu.md', kind: 'file' }); assert.ok(r.path.endsWith(path.join('docs', 'phu.md')));   // created in the folder being shown
    assert.deepEqual(await make({ name: 'docs/ghi-chu.md', kind: 'file', content: 'ghi đè?' }), { code: 'exists' });
    assert.equal(fs.readFileSync(path.join(root, 'docs', 'ghi-chu.md'), 'utf8'), '# Xin chào\n');   // the first content is intact
    assert.deepEqual(await make({ name: 'docs', kind: 'folder' }), { code: 'exists' });
    for (const bad of ['..', '../x', 'a/../../x', '/etc/x', 'a\\b', 'x:y', 'bad|name', '', ' ', 'a/./b', 'x'.repeat(256), 'n\x00ul']) assert.equal((await make({ name: bad, kind: 'file' })).code, 'invalid', JSON.stringify(bad));
    assert.equal((await make({ name: 'x', kind: 'socket' })).code, 'invalid'); assert.equal((await make({ name: 'x', kind: 'file', content: 'a\0b' })).code, 'invalid');
    assert.equal((await run({ cwd: root, dir: outside, name: 'x', kind: 'file' })).code, 'outside');   // a folder outside the session
    if (process.platform !== 'win32') {
      fs.symlinkSync(outside, path.join(root, 'link'));
      assert.equal((await make({ name: 'link/escape.txt', kind: 'file' })).code, 'invalid');   // a symlinked parent must not lead out
      assert.deepEqual(fs.readdirSync(outside), []);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('rename and trash stay inside the session folder, never overwrite, and the trash can restore', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { fsopRuntime, browseRuntime } = require('../lib/features/browse');
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tn-fsop-'))), outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-fsout-'));
  const real = fs.realpathSync(root);
  try {
    fs.mkdirSync(path.join(root, 'docs', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'a.md'), 'A'); fs.writeFileSync(path.join(root, 'docs', 'b.md'), 'B'); fs.writeFileSync(path.join(root, 'docs', 'sub', 'c.md'), 'C');
    const run = fsopRuntime(), op = (o) => run({ cwd: root, ...o });
    // rename
    let r = await op({ op: 'rename', path: path.join(root, 'docs', 'a.md'), name: 'moi.md' });
    assert.equal(r.path, path.join(real, 'docs', 'moi.md')); assert.equal(fs.readFileSync(r.path, 'utf8'), 'A'); assert.ok(!fs.existsSync(path.join(root, 'docs', 'a.md')));
    assert.deepEqual(await op({ op: 'rename', path: path.join(root, 'docs', 'moi.md'), name: 'b.md' }), { code: 'exists' });   // never overwrites
    assert.equal(fs.readFileSync(path.join(root, 'docs', 'b.md'), 'utf8'), 'B');
    for (const bad of ['', ' ', '.', '..', 'x/y', '../x', 'a\\b', 'n\x00ul', 'x'.repeat(256)]) assert.equal((await op({ op: 'rename', path: path.join(root, 'docs', 'moi.md'), name: bad })).code, 'invalid', JSON.stringify(bad));
    assert.equal((await op({ op: 'rename', path: path.join(root, 'docs', 'nothing.md'), name: 'x' })).code, 'notfound');
    assert.equal((await op({ op: 'rename', path: root, name: 'x' })).code, 'root');
    assert.equal((await op({ op: 'rename', path: path.join(outside, 'f'), name: 'x' })).code, 'outside');
    assert.equal((await op({ op: 'rename', path: '../x', name: 'y' })).code, 'outside');
    r = await op({ op: 'rename', path: path.join(root, 'docs', 'moi.md'), name: 'MOI.md' }); assert.ok(r.path.endsWith('MOI.md'));   // letter case only
    r = await op({ op: 'rename', path: path.join(root, 'docs', 'sub'), name: 'thu-muc-con' }); assert.ok(fs.statSync(r.path).isDirectory());   // folders too
    // trash
    const gone = await op({ op: 'trash', path: path.join(root, 'docs', 'thu-muc-con') });
    assert.ok(gone.id && gone.name === 'thu-muc-con'); assert.ok(!fs.existsSync(path.join(root, 'docs', 'thu-muc-con')));
    assert.equal(fs.readFileSync(path.join(root, '.termnest-trash', '.gitignore'), 'utf8'), '*\n');
    assert.equal(fs.readFileSync(path.join(root, '.termnest-trash', gone.id, 'data', 'thu-muc-con', 'c.md'), 'utf8'), 'C');   // the whole folder is kept
    await new Promise((r) => setTimeout(r, 5));   // the list is ordered by the millisecond the item went in
    const second = await op({ op: 'trash', path: path.join(root, 'docs', 'b.md') });
    assert.deepEqual((await op({ op: 'list' })).items.map((i) => [i.name, i.rel, i.kind]), [['b.md', 'docs/b.md', 'file'], ['thu-muc-con', 'docs/thu-muc-con', 'folder']]);   // newest first
    assert.equal((await op({ op: 'trash', path: root })).code, 'root');
    assert.equal((await op({ op: 'trash', path: path.join(root, '.termnest-trash') })).code, 'invalid');   // the trash itself cannot be trashed or renamed
    assert.equal((await op({ op: 'rename', path: path.join(root, '.termnest-trash'), name: 'x' })).code, 'invalid');
    // the browser hides the trash
    assert.ok(!(await browseRuntime()({ cwd: root, dir: '' })).dirs.includes('.termnest-trash'));
    // restore
    r = await op({ op: 'restore', id: second.id }); assert.equal(fs.readFileSync(r.path, 'utf8'), 'B');
    fs.writeFileSync(path.join(root, 'docs', 'thu-muc-con'), 'a file with the old name');
    assert.deepEqual(await op({ op: 'restore', id: gone.id }), { code: 'exists' });   // the old place is taken: nothing is overwritten
    fs.rmSync(path.join(root, 'docs', 'thu-muc-con'));
    fs.rmSync(path.join(root, 'docs'), { recursive: true });   // even if the parent folder is gone, the restore recreates it
    r = await op({ op: 'restore', id: gone.id }); assert.equal(fs.readFileSync(path.join(r.path, 'c.md'), 'utf8'), 'C');
    assert.deepEqual((await op({ op: 'list' })).items, []);
    assert.equal((await op({ op: 'restore', id: 'zzzzzzzz' })).code, 'notfound'); assert.equal((await op({ op: 'restore', id: '../../x' })).code, 'invalid');
    // a tampered record cannot point outside
    const bad = path.join(root, '.termnest-trash', 'abcdef12'); fs.mkdirSync(path.join(bad, 'data'), { recursive: true }); fs.writeFileSync(path.join(bad, 'data', 'x'), 'x');
    fs.writeFileSync(path.join(bad, 'info.json'), JSON.stringify({ name: 'x', rel: '../escape', at: 1, kind: 'file' }));
    assert.equal((await op({ op: 'restore', id: 'abcdef12' })).code, 'outside'); assert.deepEqual(fs.readdirSync(outside), []);
    if (process.platform !== 'win32') {   // a symlinked parent must not lead out
      fs.symlinkSync(outside, path.join(root, 'link')); fs.writeFileSync(path.join(outside, 'secret.txt'), 's');
      assert.equal((await op({ op: 'trash', path: path.join(root, 'link', 'secret.txt') })).code, 'outside');
      assert.ok(fs.existsSync(path.join(outside, 'secret.txt')));
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('a host without Node.js is reported with a code and its system, and file errors follow the chosen language', async () => {
  const { runOnHost, hostErrorExtra, localizeFileError, fileRuntime } = require('../lib/file-viewer');
  const { setLang } = require('../lib/i18n-server');
  const remote = (result) => ({ cfg: { local: false }, snapshot: { sys: { os: 'Ubuntu 22.04.5 LTS' } }, exec: async () => result });
  setLang('en');
  try {
    let caught = null; try { await runOnHost(remote({ code: 127, out: '', err: 'sh: 1: node: not found\n' }), fileRuntime, { cwd: '/', path: 'a' }); } catch (e) { caught = e; }
    assert.equal(caught.code, 'no-node'); assert.match(caught.message, /no Node\.js/);
    assert.deepEqual(hostErrorExtra(caught, remote({})), { code: 'no-node', os: 'Ubuntu 22.04.5 LTS' });
    caught = null; try { await runOnHost(remote({ code: 1, out: '', err: 'permission denied' }), fileRuntime, { cwd: '/', path: 'a' }); } catch (e) { caught = e; }
    assert.equal(caught.code, 'host'); assert.equal(hostErrorExtra(caught, remote({})), undefined);   // an ordinary failure has no install hint
    caught = null; try { await runOnHost(remote({ code: 0, out: 'not json', err: '' }), fileRuntime, { cwd: '/', path: 'a' }); } catch (e) { caught = e; }
    assert.equal(caught.code, 'host');
    assert.equal(localizeFileError('Không được mở tệp ngoài thư mục của phiên.'), 'Files outside the session folder cannot be opened.');
    assert.equal(localizeFileError('Không thấy tệp ở thư mục của phiên, nhưng có 3 tệp trùng tên.'), 'The file is not in the session folder, but 3 files with that name were found.');
    assert.equal(localizeFileError('something else'), 'something else');
    setLang('vi');
    assert.equal(localizeFileError('Tệp quá lớn (tối đa 5 MB).'), 'Tệp quá lớn (tối đa 5 MB).');
  } finally { setLang('vi'); }
});

test('the Node.js guide lists a Windows command and picks it for a Windows host', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/file-viewer.js'), 'utf8');
  assert.match(src, /\['win',[^\]]*winget install OpenJS\.NodeJS\.LTS'\]/);
  const { runOnHost } = require('../lib/file-viewer');
  const win = { cfg: { local: false }, exec: async () => ({ code: 1, out: '', err: "'node' is not recognized as an internal or external command" }) };
  return runOnHost(win, () => async () => ({}), {}).then(() => assert.fail('should throw'), (e) => assert.equal(e.code, 'no-node'));
});

test('the trash can delete one item or everything for good, and expires old items; only its own slots are touched', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { fsopRuntime } = require('../lib/features/browse');
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tn-purge-')));
  try {
    const op = fsopRuntime(), run = (o) => op({ cwd: root, ...o });
    for (const n of ['a.txt', 'b.txt', 'c.txt']) fs.writeFileSync(path.join(root, n), 'x'.repeat(10));
    const a = await run({ op: 'trash', path: 'a.txt' }); await run({ op: 'trash', path: 'b.txt' }); await run({ op: 'trash', path: 'c.txt' });
    fs.mkdirSync(path.join(root, '.termnest-trash', 'notours1'));   // a folder without info.json is never removed
    let list = await run({ op: 'list' });
    assert.equal(list.count, 3); assert.equal(list.bytes, 30); assert.equal(list.items[0].bytes, 10);
    assert.equal((await run({ op: 'purge', id: a.id })).ok, true);
    assert.equal((await run({ op: 'purge', id: a.id })).code, 'notfound');
    for (const bad of ['../x', '', 'a/b', '..']) assert.equal((await run({ op: 'purge', id: bad })).code, 'notfound');
    // expire: make one item look 10 days old
    list = await run({ op: 'list' });
    const old = path.join(root, '.termnest-trash', list.items[1].id, 'info.json'), info = JSON.parse(fs.readFileSync(old, 'utf8'));
    fs.writeFileSync(old, JSON.stringify({ ...info, at: Date.now() - 10 * 86400000 }));
    assert.equal((await run({ op: 'expire', days: 0 })).code, 'invalid');
    assert.equal((await run({ op: 'expire', days: 7 })).removed, 1);
    assert.equal((await run({ op: 'list' })).count, 1);
    assert.equal((await run({ op: 'empty' })).removed, 1);
    assert.equal((await run({ op: 'list' })).count, 0);
    assert.ok(fs.existsSync(path.join(root, '.termnest-trash', 'notours1')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('temp files of Send file: listed, deleted by name or all, expired by age; nothing outside that folder', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { tempRuntime } = require('../lib/features/browse');
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tn-temp-'))), saved = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  try {
    const dir = path.join(tmp, 'termnest-drop-' + (process.getuid ? process.getuid() : 0)); fs.mkdirSync(dir);
    for (const n of ['1.png', '2.pdf', '3.txt']) fs.writeFileSync(path.join(dir, n), 'abcd');
    fs.writeFileSync(path.join(tmp, 'outside.txt'), 'keep');
    const t = tempRuntime();
    const list = await t({ op: 'list' }); assert.equal(list.count, 3); assert.equal(list.bytes, 12); assert.equal(list.dir, dir);
    for (const bad of [['../outside.txt'], [], ['a/b'], 'x']) assert.equal((await t({ op: 'delete', names: bad })).code, 'invalid');
    assert.equal((await t({ op: 'delete', names: ['1.png', 'missing.txt'] })).removed, 1);
    const past = (Date.now() - 5 * 86400000) / 1000; fs.utimesSync(path.join(dir, '2.pdf'), past, past);
    assert.equal((await t({ op: 'expire', days: 3 })).removed, 1);
    assert.equal((await t({ op: 'all' })).removed, 1);
    assert.equal((await t({ op: 'list' })).count, 0);
    assert.ok(fs.existsSync(path.join(tmp, 'outside.txt')));
  } finally { if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved; fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('clean-up settings accept only the offered choices, and Send file uses the temp choice', async () => {
  const browse = require('../lib/features/browse'), { storeScript } = require('../lib/features/drop');
  assert.deepEqual(browse.cleanupOf({}), { tempDays: 1, trashDays: 0 });
  assert.deepEqual(browse.cleanupOf({ tempDays: 7, trashDays: 30 }), { tempDays: 7, trashDays: 30 });
  assert.deepEqual(browse.cleanupOf({ tempDays: 2, trashDays: -1 }), { tempDays: 1, trashDays: 0 });
  assert.match(storeScript('a.txt', 1), /-mtime \+0 /); assert.match(storeScript('a.txt', 7), /-mtime \+6 /); assert.doesNotMatch(storeScript('a.txt', 0), /find/);
  const routes = {}, sent = [], fails = [];
  let stored = null;
  browse.register({ route: (m, p, h) => { routes[m + p] = h; }, remotes: () => [], backendOf: () => null, send: (res, c, b) => sent.push(b), fail: (res, c, m) => fails.push(m),
    readJson: async (req) => req.body, shq: (x) => x, settings: { get: () => stored || { tempDays: 3 }, set: (v) => { stored = v; } } });
  await routes['GET/cleanup']({ res: {} }); assert.deepEqual(sent.at(-1), { tempDays: 3, trashDays: 0 });
  await routes['POST/cleanup']({ req: { body: { trashDays: 30 } }, res: {} }); assert.deepEqual(stored, { tempDays: 3, trashDays: 30 });
  await routes['POST/cleanup']({ req: { body: { trashDays: 5 } }, res: {} }); assert.equal(fails.length, 1); assert.deepEqual(stored, { tempDays: 3, trashDays: 30 });
  assert.equal(browse.cleanupSettings().tempDays, 3);
});

test('the file feature loads while TERMNEST is still locked (its settings are read only when needed)', () => {
  const browse = require('../lib/features/browse');
  assert.doesNotThrow(() => browse.register({ route() {}, remotes: () => [], backendOf: () => null, send() {}, fail() {}, readJson: async () => ({}), shq: (x) => x,
    settings: { get: () => { throw new TypeError("Cannot read properties of null (reading 'features')"); }, set() {} } }));
  assert.deepEqual(browse.cleanupSettings(), { tempDays: 1, trashDays: 0 });
});
