'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

function tree() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tn-index-')));
  const put = (rel, text = 'x') => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  put('docs/Implementation/A/05-PLAN.md', '# plan');
  put('docs/Implementation/B/00-INDEX.md'); put('docs/Implementation/C/00-INDEX.md');
  put('node_modules/pkg/README-ONLY.md'); put('_wt-task-w1/docs/WT-ONLY.md');
  return { root, put };
}
function local(root, id) {
  return { cfg: { id, local: true }, ready: true, mode: 'native', snapshot: { sessions: [{ name: 's', path: root }] }, exec: async () => ({ code: 0, out: root + '\n' }) };
}
// Same host code path as SSH: the runtime is serialised and run by `node -e` through a shell.
function remote(root, id) {
  return { cfg: { id, local: false }, ready: true, mode: 'native', snapshot: { sessions: [{ name: 's', path: root }] },
    exec: (cmd) => cmd.startsWith('tmux ') ? Promise.resolve({ code: 0, out: root + '\n' }) :
      new Promise(resolve => execFile('/bin/sh', ['-c', cmd], { maxBuffer: 64 << 20 }, (err, out, errOut) => resolve({ code: err ? err.code || 1 : 0, out, err: errOut }))) };
}
const fresh = () => { delete require.cache[require.resolve('../lib/file-viewer')]; return require('../lib/file-viewer'); };

test('a bare document name opens directly from the index, ignoring heavy folders and worktrees', async () => {
  const fv = fresh(), { root } = tree(), b = local(root, 'a');
  const v = await fv.readSessionFile(b, 's', '05-PLAN.md');
  assert.equal(v.text, '# plan'); assert.equal(v.path, path.join(root, 'docs/Implementation/A/05-PLAN.md'));
  const many = await fv.readSessionFile(b, 's', '00-INDEX.md');
  assert.deepEqual([...many.candidates].sort(), ['docs/Implementation/B/00-INDEX.md', 'docs/Implementation/C/00-INDEX.md']);
  assert.ok((await fv.indexRuntime()({ base: root })).files.every(f => !f.startsWith('node_modules/') && !f.startsWith('_wt-')));
});

test('a missing name answers at once from a complete index; a file created later is found after a rebuild', async (t) => {
  const fv = fresh(), { root, put } = tree(), b = local(root, 'b');
  await fv.readSessionFile(b, 's', '05-PLAN.md');
  const started = Date.now(); const miss = await fv.readSessionFile(b, 's', 'NOPE.md');
  assert.ok(miss.error && !miss.candidates); assert.ok(Date.now() - started < 1000);
  put('docs/new/LATER.md', 'later');
  const realNow = Date.now; t.after(() => { Date.now = realNow; });
  Date.now = () => realNow() + 20000; // the index is now older than the 10-second rebuild threshold
  const v = await fv.readSessionFile(b, 's', 'LATER.md');
  assert.equal(v.text, 'later');
});

test('the index and lookups also work through the serialised host runtime (SSH path)', { skip: process.platform === 'win32' && 'uses /bin/sh like an SSH host' }, async () => {
  const fv = fresh(), { root } = tree(), b = remote(root, 'c');
  const v = await fv.readSessionFile(b, 's', '05-PLAN.md');
  assert.equal(v.text, '# plan');
  const many = await fv.readSessionFile(b, 's', '00-INDEX.md');
  assert.equal(many.candidates.length, 2);
});

test('relative paths and non-document names keep the previous behaviour', async () => {
  const fv = fresh(), { root, put } = tree(), b = local(root, 'd');
  assert.equal((await fv.readSessionFile(b, 's', 'docs/Implementation/A/05-PLAN.md')).text, '# plan');
  put('src/deep/tool.js', 'js');
  const js = await fv.readSessionFile(b, 's', 'tool.js');
  assert.equal(js.text, 'js'); // live search, then opened in the same request
});

test('a bare image name opens from the index too (screenshots printed by an AI)', async () => {
  const fv = fresh(), { root, put } = tree(), b = local(root, 'img');
  put('docs/mockups/shots/ban-cham-1.png', Buffer.from('89504e470d0a1a0a', 'hex'));
  assert.ok((await fv.indexRuntime()({ base: root })).files.includes('docs/mockups/shots/ban-cham-1.png'));
  const v = await fv.readSessionFile(b, 's', 'ban-cham-1.png');
  assert.equal(v.path, path.join(root, 'docs/mockups/shots/ban-cham-1.png'));
});
