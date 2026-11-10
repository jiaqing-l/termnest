'use strict';
// Node.js installed without sudo (unpacked into ~/.local/node, nvm, volta) is found by a non-login SSH command.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), { execFileSync } = require('child_process');
const { hostNode } = require('../lib/file-viewer');

const run = (home, extraPath) => execFileSync('/bin/sh', ['-c', hostNode({ cfg: {} }) + ' -e 0'],
  { env: { HOME: home, PATH: extraPath ? extraPath + ':/usr/bin:/bin' : '/usr/bin:/bin' }, encoding: 'utf8' });
const fake = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '#!/bin/sh\necho ' + text + ' "$@"\n', { mode: 0o755 }); };

test('host Node: PATH first, then Homebrew, ~/.local/node, nvm; none → exit 127', { skip: process.platform === 'win32' || ['/usr/bin/node', '/bin/node'].some((p) => fs.existsSync(p)) }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-node-'));
  try {
    // A Node in /usr/local/bin or /opt/homebrew/bin (outside the non-login PATH) is found; none at all → exit 127.
    const system = ['/usr/local/bin/node', '/opt/homebrew/bin/node'].filter((p) => fs.existsSync(p));
    if (system.length) assert.doesNotThrow(() => run(home)); else assert.throws(() => run(home), (e) => e.status === 127);
    fake(path.join(home, '.nvm/versions/node/v22.11.0/bin/node'), 'nvm');
    assert.equal(run(home).trim(), 'nvm -e 0');
    fake(path.join(home, '.local/node/bin/node'), 'local');
    assert.match(run(home).trim(), /^(nvm|local) -e 0$/);
    fake(path.join(home, 'bin/node'), 'path');
    assert.equal(run(home, path.join(home, 'bin')).trim(), 'path -e 0');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
