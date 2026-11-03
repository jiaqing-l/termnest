'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { fileRuntime } = require('../lib/file-viewer');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-nf-'));
const put = (rel, text = '# x') => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
put('Implementation/SV/Phan/12-MASTER-PLAN-MVP.md');
put('Implementation/Other/12-MASTER-PLAN-MVP.md');
put('Implementation/SV/Phan/other.md');
put('node_modules/pkg/12-MASTER-PLAN-MVP.md');
put('top.md', '# top');
const read = fileRuntime();

test('a bare file name that is not in the folder returns the files with that name below it', async () => {
  const out = await read({ cwd: dir, path: '12-MASTER-PLAN-MVP.md' });
  assert.match(out.error, /2 tệp trùng tên/);
  assert.deepEqual([...out.candidates].sort(), ['Implementation/Other/12-MASTER-PLAN-MVP.md', 'Implementation/SV/Phan/12-MASTER-PLAN-MVP.md']);
});

test('a partial path keeps only candidates ending with it', async () => {
  const out = await read({ cwd: dir, path: 'Phan/12-MASTER-PLAN-MVP.md' });
  assert.deepEqual([...out.candidates], ['Implementation/SV/Phan/12-MASTER-PLAN-MVP.md']);
});

test('a name that exists nowhere keeps the plain message, and an existing file still opens', async () => {
  const out = await read({ cwd: dir, path: 'nope.md' });
  assert.equal(out.candidates, undefined); assert.match(out.error, /Không tìm thấy tệp/);
  assert.equal((await read({ cwd: dir, path: 'top.md' })).text, '# top');
});

test('absolute paths and paths outside the folder never trigger a search', async () => {
  const absolute = await read({ cwd: dir, path: path.join(dir, 'missing', '12-MASTER-PLAN-MVP.md') });
  assert.equal(absolute.candidates, undefined);
  const outside = await read({ cwd: dir, path: '../12-MASTER-PLAN-MVP.md' });
  assert.equal(outside.candidates, undefined);
});

test('candidates are listed newest first', async () => {
  const old = new Date(Date.now() - 86400000); fs.utimesSync(path.join(dir, 'Implementation/Other/12-MASTER-PLAN-MVP.md'), old, old);
  const out = await read({ cwd: dir, path: '12-MASTER-PLAN-MVP.md' });
  assert.equal(out.candidates[0], 'Implementation/SV/Phan/12-MASTER-PLAN-MVP.md'); assert.equal(out.candidates[1], 'Implementation/Other/12-MASTER-PLAN-MVP.md');
});
