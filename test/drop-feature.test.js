'use strict';
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const drop = require('../lib/features/drop');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

test('accepts real images, text and pdf; rejects mismatches, binaries, empty and oversized', () => {
  assert.equal(drop.check('a.PNG', PNG), 'png');
  assert.equal(drop.check('n.md', Buffer.from('# hi')), 'md');
  assert.equal(drop.check('x.pdf', Buffer.from('%PDF-1.7 ...')), 'pdf');
  assert.throws(() => drop.check('fake.png', Buffer.from('not an image at all')), /không đúng/);
  assert.throws(() => drop.check('a.txt', Buffer.from([65, 0, 66])), /nhị phân/);
  assert.throws(() => drop.check('a.exe', Buffer.from('MZ')), /chưa được hỗ trợ/);
  assert.throws(() => drop.check('a.png', Buffer.alloc(0)), /rỗng/);
  assert.throws(() => drop.check('a.txt', Buffer.alloc(drop.MAX_BYTES + 1, 65)), /quá lớn/);
  assert.throws(() => drop.check('noext', Buffer.from('x')), /chưa được hỗ trợ/);
});

test('the stored script writes stdin to a private temp folder and prints the path', { skip: process.platform === 'win32' }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-drop-'));
  const r = cp.spawnSync('sh', ['-c', drop.storeScript('20261103-abc.png')], { input: PNG, env: { ...process.env, TMPDIR: tmp }, encoding: 'buffer' });
  assert.equal(r.status, 0);
  const out = r.stdout.toString().trim(); assert.ok(out.startsWith(tmp));
  assert.deepEqual(fs.readFileSync(out), PNG);
  assert.equal(fs.statSync(out).mode & 0o077, 0); assert.equal(fs.statSync(path.dirname(out)).mode & 0o077, 0);
});

test('a machine that is not connected is reported as not connected, not as unsupported', async () => {
  let handler; const fails = [];
  drop.register({ route: (m, p, h) => { if (p === '/upload') handler = h; }, backendOf: (id) => (id === 'win' ? { mode: 'powershell' } : null), fail: (res, code, msg) => fails.push(msg) });
  await handler({ req: {}, res: {}, url: new URL('http://x/upload?server=gone&session=s&name=a.png') });
  await handler({ req: {}, res: {}, url: new URL('http://x/upload?server=win&session=s&name=a.png') });
  assert.match(fails[0], /chưa kết nối/);
  assert.match(fails[1], /chưa hỗ trợ/);
});
