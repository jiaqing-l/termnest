'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { inlineAssets, isLocal, resolve } = require('../lib/html-assets');

const PNG = { kind: 'image', mime: 'image/png', base64: 'AAAA' };
function reader(files, seen = []) {
  return async (abs) => { seen.push(abs); return files[abs] || { error: 'missing' }; };
}

test('only relative references count as local', () => {
  assert.equal(isLocal('img/a.png'), true);
  assert.equal(isLocal('../a.png'), true);
  assert.equal(isLocal('/abs/a.png'), true);
  for (const x of ['http://x/a.png', 'https://x/a.png', '//cdn/a.png', 'data:image/png;base64,AA', '#id', '', 'file:///a.png']) assert.equal(isLocal(x), false, x);
});

test('references resolve against the html folder, for POSIX and Windows paths', () => {
  assert.equal(resolve('/w/Implementation/R/report.html', 'img/a.png?v=2#x'), '/w/Implementation/R/img/a.png');
  assert.equal(resolve('/w/Implementation/R/report.html', '../shared/a%20b.png'), '/w/Implementation/shared/a b.png');
  assert.equal(resolve('C:\\w\\R\\report.html', 'img/a.png'), 'C:\\w\\R\\img\\a.png');
});

test('images next to the report become data: URLs, including css url() and single-quoted src', async () => {
  const files = { '/w/R/img/a.png': PNG, '/w/R/b.png': PNG };
  const html = '<img src="img/a.png"><img class=x src=\'b.png\'><div style="background:url(img/a.png)"></div>';
  const out = await inlineAssets(html, '/w/R/r.html', reader(files));
  assert.equal((out.match(/data:image\/png;base64,AAAA/g) || []).length, 3);
  assert.ok(!/src="img\/a\.png"/.test(out));
});

test('remote and data images are left alone and never read', async () => {
  const seen = [];
  const html = '<img src="https://x/a.png"><img src="data:image/png;base64,QQ"><img src="//cdn/a.png">';
  const out = await inlineAssets(html, '/w/R/r.html', reader({}, seen));
  assert.equal(out, html); assert.deepEqual(seen, []);
});

test('a picture that cannot be read keeps its original tag, the page still renders', async () => {
  const out = await inlineAssets('<img src="gone.png"><p>ok</p>', '/w/R/r.html', reader({}));
  assert.equal(out, '<img src="gone.png"><p>ok</p>');
});

test('a stylesheet next to the page is inlined and the pictures it names are resolved from the stylesheet folder', async () => {
  const files = { '/w/R/css/site.css': { text: '.a{background:url(../img/bg.png)}' }, '/w/R/img/bg.png': PNG };
  const out = await inlineAssets('<link rel="stylesheet" href="css/site.css"><link rel="icon" href="x.ico">', '/w/R/r.html', reader(files));
  assert.match(out, /<style>\.a\{background:url\("data:image\/png;base64,AAAA"\)\}<\/style>/);
  assert.match(out, /<link rel="icon" href="x\.ico">/);
});

test('svg files are inlined as images and the number of files is capped', async () => {
  const files = { '/w/R/l.svg': { text: '<svg xmlns="http://www.w3.org/2000/svg"/>' } };
  assert.match(await inlineAssets('<img src="l.svg">', '/w/R/r.html', reader(files)), /data:image\/svg\+xml;base64,/);
  const many = Array.from({ length: 80 }, (_, i) => '<img src="i' + i + '.png">').join('');
  const seen = []; await inlineAssets(many, '/w/R/r.html', reader({}, seen));
  assert.ok(seen.length <= 60);
});

test('the reader decides what is allowed: a refused path is simply not inlined', async () => {
  const out = await inlineAssets('<img src="../../etc/passwd.png">', '/w/R/r.html', async () => ({ error: 'Không được mở tệp ngoài thư mục của phiên.' }));
  assert.equal(out, '<img src="../../etc/passwd.png">');
});

test('with the real session reader: pictures inside the session folder load, files outside it do not', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { fileRuntime } = require('../lib/file-viewer');
  const PNG_HEX = '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6054b0000000049454e44ae426082';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-assets-')), outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-outside-'));
  fs.mkdirSync(path.join(root, 'doc', 'img'), { recursive: true });
  fs.writeFileSync(path.join(root, 'doc', 'img', 'shelf.png'), Buffer.from(PNG_HEX, 'hex'));
  fs.writeFileSync(path.join(outside, 'secret.png'), Buffer.from(PNG_HEX, 'hex'));
  const readFile = fileRuntime(), real = fs.realpathSync(path.join(root, 'doc', 'r.html'.replace('r.html', '')));
  const htmlPath = path.join(real, 'r.html');
  const html = '<img src="img/shelf.png"><img src="' + path.relative(path.join(real), path.join(fs.realpathSync(outside), 'secret.png')) + '">';
  const out = await inlineAssets(html, htmlPath, (abs) => readFile({ cwd: root, path: abs }));
  assert.equal((out.match(/data:image\/png;base64,/g) || []).length, 1, 'only the picture inside the session folder is inlined');
  assert.match(out, /secret\.png/);
});

// A mockup that loads its sample data from a sibling .js file rendered empty: scripts are now inlined like stylesheets.
test('local scripts next to the page become inline scripts in order; remote and unreadable ones stay as they were', async () => {
  const files = { '/w/M/data.js': { text: 'window.DATA = [1, "</script>"];' }, '/w/M/lib/app.js': { text: 'render(window.DATA);' } };
  const html = '<head><script src="data.js"></script><script defer type="module" src=\'lib/app.js\'></script>' +
    '<script src="https://cdn.example/x.js"></script><script src="missing.js"></script></head>';
  const out = await inlineAssets(html, '/w/M/page.html', reader(files));
  assert.ok(out.indexOf('window.DATA') < out.indexOf('render(window.DATA)'), 'order kept');
  assert.ok(out.includes('<script>window.DATA = [1, "<\\/script>"];</script>'), out);
  assert.ok(out.includes('<script type="module">render(window.DATA);</script>'), out);
  assert.ok(out.includes('<script src="https://cdn.example/x.js"></script>') && out.includes('<script src="missing.js"></script>'));
});

test('all pictures of a report are fetched in ONE call when a batch reader is given (slow links: one round trip)', async () => {
  const { inlineAssets } = require('../lib/html-assets');
  const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  const calls = [], single = [];
  const html = '<img src="shots/a.png"><img src="shots/b.png"><img src="shots/a.png"><img src="https://x/y.png">';
  const out = await inlineAssets(html, '/w/r/report.html', async (p) => { single.push(p); return { error: 'x' }; },
    async (paths) => { calls.push(paths); return paths.map(() => ({ kind: 'image', mime: 'image/png', base64: png })); });
  assert.equal(calls.length, 1); assert.deepEqual(calls[0], ['/w/r/shots/a.png', '/w/r/shots/b.png']); assert.deepEqual(single, []);
  assert.equal((out.match(/data:image\/png;base64,/g) || []).length, 3); assert.match(out, /https:\/\/x\/y\.png/);
});

test('the batch reader runs the same contained file reader for each path, with a total size cap', async () => {
  const fs = require('fs'), os = require('os'), path = require('path'), { manyRuntime } = require('../lib/file-viewer');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-many-'));
  try {
    fs.mkdirSync(path.join(dir, 'shots')); fs.writeFileSync(path.join(dir, 'shots', 'a.png'), Buffer.from('89504e470d0a1a0a0000', 'hex'));
    const got = await manyRuntime()({ cwd: dir, paths: [path.join(dir, 'shots', 'a.png'), '/etc/passwd', path.join(dir, 'missing.png')], max: 1024 });
    assert.equal(got.length, 3); assert.equal(got[0].kind, 'image'); assert.ok(got[1].error); assert.ok(got[2].error);
    assert.match(String(manyRuntime), /^function manyRuntime\(\)\{const one=\(function fileRuntime/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
