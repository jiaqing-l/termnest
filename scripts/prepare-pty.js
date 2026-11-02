'use strict';
// node-pty 1.1.0 ships the Unix prebuilt spawn helper without execute permission.
// Repair only that packaged helper, so a fresh npm install can open terminals.
if (process.platform !== 'win32') {
  const fs = require('fs');
  const path = require('path');
  const root = path.dirname(require.resolve('node-pty/package.json'));
  const helper = path.join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
  if (fs.existsSync(helper)) fs.chmodSync(helper, fs.statSync(helper).mode | 0o100);
}
