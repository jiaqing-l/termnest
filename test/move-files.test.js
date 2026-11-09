'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const mf = require('../lib/move-files');
const { shq } = require('../lib/parse');

test('related files travel with a moved chat: written, named and HTML assets; a different target file is kept as a backup', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-move-files-')), src = path.join(tmp, 'src'), dst = path.join(tmp, 'dst'), profile = path.join(tmp, 'profile');
  const put = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  put(src, 'docs/mock/page.html', '<img src="shots/a.png"><link href="style.css"><a href="https://x.dev/y.png">');
  put(src, 'docs/mock/shots/a.png', 'PNG'); put(src, 'docs/mock/style.css', 'body{}');
  put(src, 'docs/05-report.md', 'report v2'); put(src, 'src/app.js', 'code');
  put(src, '.git/config', 'secret'); put(src, 'docs/unrelated.md', 'not named');
  fs.symlinkSync('/etc/hosts', path.join(src, 'docs/link.md'));
  put(dst, 'docs/05-report.md', 'report v1');
  const rel = 'projects/x/abc.jsonl';
  put(profile, rel, [JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: path.join(src, 'docs/mock/page.html') } }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Xem docs/05-report.md và `src/app.js`; bỏ qua mockups/shots/x-*.png, docs/link.md, ../outside.md, /etc/passwd, .git/config' }] } })].join('\n'));
  const run = async (backend, runtime, a) => runtime()(a);
  const plan = await mf.plan({ run, src: {}, dst: {}, profile, rel, fromRoot: src, toRoot: dst });
  assert.deepEqual(plan.files.map((f) => f.rel).sort(), ['docs/05-report.md', 'docs/mock/page.html', 'docs/mock/shots/a.png', 'docs/mock/style.css', 'src/app.js']);
  assert.equal(plan.copy.length, 5); assert.equal(plan.differs, 1);
  const exec = async (cmd, timeout, max, input) => { const r = spawnSync('sh', ['-c', cmd], { input, encoding: 'utf8' }); return { code: r.status, out: r.stdout }; };
  const res = await mf.copy({ run, src: {}, dst: { exec }, fromRoot: src, toRoot: dst, files: plan.copy, node: shq(process.execPath), shq });
  assert.equal(res.code, undefined, JSON.stringify(res)); assert.equal(res.done, 5); assert.deepEqual(res.kept, ['docs/05-report.md']);
  assert.equal(fs.readFileSync(path.join(dst, 'docs/05-report.md'), 'utf8'), 'report v2');
  const backup = fs.readdirSync(path.join(dst, 'docs')).find((n) => n.startsWith('05-report.md.truoc-chuyen-'));
  assert.equal(fs.readFileSync(path.join(dst, 'docs', backup), 'utf8'), 'report v1');
  assert.equal(fs.readFileSync(path.join(dst, 'docs/mock/shots/a.png'), 'utf8'), 'PNG');
  assert.ok(!fs.existsSync(path.join(dst, '.git')) && !fs.existsSync(path.join(dst, 'docs/link.md')));
  // A second move finds everything identical and copies nothing.
  const again = await mf.plan({ run, src: {}, dst: {}, profile, rel, fromRoot: src, toRoot: dst });
  assert.equal(again.copy.length, 0);
  fs.rmSync(tmp, { recursive: true, force: true });
});
