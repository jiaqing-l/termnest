'use strict';
// Folder browser on a Windows+WSL machine: other drives are listed, and a Windows path from the system dialog opens.
const test = require('node:test'), assert = require('node:assert/strict');
const { wslDrives, wslPath } = require('../lib/wsl-dirs');

test('WSL drives: /mnt/<letter> only, labelled C:, D:', async () => {
  const r = { exec: async () => ({ code: 0, out: '/mnt/c\n/mnt/d\n/mnt/wsl\n' }) };
  assert.deepEqual(await wslDrives(r), [{ label: 'C:', path: '/mnt/c' }, { label: 'D:', path: '/mnt/d' }]);
  assert.deepEqual(await wslDrives({ exec: async () => { throw Error('down'); } }), []);
});

test('Windows path → WSL path: wslpath when it answers, the /mnt rule otherwise', async () => {
  let cmd = '';
  assert.equal(await wslPath({ exec: async (c) => { cmd = c; return { code: 0, out: '/mnt/d/Work Space\n' }; } }, 'D:\\Work Space'), '/mnt/d/Work Space');
  assert.equal(cmd, "wslpath -u 'D:\\Work Space'");
  const none = { exec: async () => ({ code: 127, out: '' }) };
  assert.equal(await wslPath(none, 'E:\\src\\app\\'), '/mnt/e/src/app');
  assert.equal(await wslPath(none, 'D:\\'), '/mnt/d');
});
