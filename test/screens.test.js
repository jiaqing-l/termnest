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

test('a file buried in a wide workspace is still offered by name (find, not a capped walk)', async () => {
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
