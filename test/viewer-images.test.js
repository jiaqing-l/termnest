'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { fileRuntime } = require('../lib/file-viewer');
const { injectReportLinks } = require('../lib/report-links');
const ui = require('../public/file-viewer');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6054b0000000049454e44ae426082', 'hex');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-img-'));
fs.mkdirSync(path.join(dir, 'a'));
fs.writeFileSync(path.join(dir, 'a', 'shot.png'), PNG);
fs.writeFileSync(path.join(dir, 'fake.png'), 'this is not really a png');
fs.writeFileSync(path.join(dir, 'a', 'x.jpg'), Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]));
fs.writeFileSync(path.join(dir, 'secret.bin'), Buffer.from([0, 1, 2, 3]));
const read = fileRuntime();

test('real images are returned with their detected type, size and base64 data', async () => {
  const f = await read({ cwd: dir, path: 'a/shot.png' });
  assert.equal(f.kind, 'image'); assert.equal(f.mime, 'image/png'); assert.equal(f.size, PNG.length);
  assert.deepEqual(Buffer.from(f.base64, 'base64'), PNG);
  assert.equal((await read({ cwd: dir, path: path.join(dir, 'a', 'x.jpg') })).mime, 'image/jpeg');
});

test('the signature decides, not the extension', async () => {
  // A .png that is really text is shown as text, never as an image.
  const fake = await read({ cwd: dir, path: 'fake.png' });
  assert.equal(fake.kind, 'text'); assert.equal(fake.mime, undefined);
  fs.writeFileSync(path.join(dir, 'binary.png'), Buffer.from([0, 1, 2, 3, 4]));
  assert.ok((await read({ cwd: dir, path: 'binary.png' })).error);
  assert.ok((await read({ cwd: dir, path: 'secret.bin' })).error);
});

test('images outside the session directory are still refused', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-out-')); fs.writeFileSync(path.join(outside, 'o.png'), PNG);
  assert.match((await read({ cwd: dir, path: path.join(outside, 'o.png') })).error, /ngoài thư mục/);
  // Creating a symlink needs extra privilege on Windows; the outside-path check above still runs everywhere.
  let linked = false;
  try { fs.symlinkSync(path.join(outside, 'o.png'), path.join(dir, 'link.png')); linked = true; } catch { /* no symlink permission */ }
  if (linked) assert.match((await read({ cwd: dir, path: 'link.png' })).error, /ngoài thư mục/);
});

test('terminal paths ending in an image extension become links', () => {
  const found = ui.detect('see /root/ws/test-results/trx/In/ab12/TC_EDP_UI_004_Shows.png and ./a/b.JPG:3 done');
  assert.deepEqual(found.map((x) => x.path), ['/root/ws/test-results/trx/In/ab12/TC_EDP_UI_004_Shows.png', './a/b.JPG']);
});

test('report links are injected before </body> or appended, leaving the report untouched', () => {
  const html = '<html><body><p>x /r/a.png</p></body></html>';
  const out = injectReportLinks(html);
  assert.ok(out.indexOf('twimg') > out.indexOf('</p>') && out.indexOf('twimg') < out.lastIndexOf('</body>'));
  assert.ok(out.startsWith('<html><body><p>x /r/a.png</p>'));
  assert.ok(injectReportLinks('<p>no body</p>').endsWith('</script>'));
});
