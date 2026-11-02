'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { assemble } = require('./assemble');
const { checkPayload } = require('./check-payload');
const stage = path.resolve(__dirname, '../desktop/resources');
assemble(stage);
execFileSync(process.execPath, [path.join(__dirname, 'runtime.js'), stage, process.platform], { stdio: 'inherit', encoding: 'utf8' });
checkPayload(stage);

// A standalone runtime/native addon needs its own ad-hoc signature before the
// outer Tauri bundle seals it. No developer certificate or paid service needed.
if (process.platform === 'darwin') {
  function sign(dir) {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) sign(file);
      else if (execFileSync('/usr/bin/file', ['-b', file], {encoding: 'utf8'}).includes('Mach-O'))
        execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', file], {stdio: 'inherit'});
    }
  }
  sign(stage);
}
