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
