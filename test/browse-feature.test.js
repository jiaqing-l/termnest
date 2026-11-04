'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const browse = require('../lib/features/browse');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tw-browse-')));
const put = (rel, text = 'x') => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
put('docs/Implementation/SV/40-DE-XUAT.md', '# doc'); put('docs/readme.md'); put('docs/binary.exe'); put('docs/.hidden.md'); put('node_modules/x/index.js');
put('top.txt'); put('README'); put('data.bin');
const run = browse.browseRuntime();

test('lists folders and viewable files of the session folder, hiding dotfiles, node_modules and unviewable files', async () => {
  const top = await run({ cwd: root });
  assert.equal(top.parent, null); assert.equal(top.rel, '');
  assert.deepEqual(top.dirs, ['docs']); assert.deepEqual(top.files.map((f) => f.name), ['README', 'top.txt']);
  const docs = await run({ cwd: root, dir: 'docs' });
  assert.equal(docs.rel, 'docs'); assert.equal(docs.parent, root);
  assert.deepEqual(docs.dirs, ['Implementation']); assert.deepEqual(docs.files.map((f) => f.name), ['readme.md']);
});

test('absolute folders inside the session folder work; anything outside is refused', async () => {
  const deep = await run({ cwd: root, dir: path.join(root, 'docs', 'Implementation', 'SV') });
  assert.equal(deep.rel, 'docs/Implementation/SV'); assert.deepEqual(deep.files.map((f) => f.name), ['40-DE-XUAT.md']);
  for (const dir of ['..', '../..', path.dirname(root), '/etc']) assert.match((await run({ cwd: root, dir })).error, /thư mục của phiên/);
  assert.match((await run({ cwd: root, dir: 'missing' })).error, /Không mở được/);
});

test('symlinks are not followed or listed, and bad input is rejected', { skip: process.platform === 'win32' }, async () => {
  fs.symlinkSync(os.tmpdir(), path.join(root, 'linkdir')); fs.symlinkSync(path.join(root, 'top.txt'), path.join(root, 'link.txt'));
  const top = await run({ cwd: root });
  assert.ok(!top.dirs.includes('linkdir')); assert.ok(!top.files.some((f) => f.name === 'link.txt'));
  assert.match((await run({ cwd: root, dir: 'linkdir' })).error, /thư mục của phiên/);
  assert.match((await run({ cwd: 5 })).error, /chưa đúng/); assert.match((await run({ cwd: root, dir: 'a\u0000b' })).error, /chưa đúng/);
});
