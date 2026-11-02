'use strict';
const fs = require('node:fs');
const path = require('node:path');
function checkPayload(stage, artifact) {
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (/^(data|vault\.json|implementation|docs|test|tests|\.git)$/i.test(entry.name) || /\.pdb$/i.test(entry.name)) throw new Error(`Forbidden payload: ${path.relative(stage, file)}`);
      if (entry.isSymbolicLink()) throw new Error(`Unexpected payload symlink: ${file}`);
      if (entry.isDirectory()) walk(file);
    }
  }
  walk(stage);
  if (artifact) {
    const limits = { 'Termnest-Setup.exe': 60, 'Termnest-arm64.dmg': 110, 'Termnest-x64.dmg': 110 };
    const limit = limits[path.basename(artifact)];
    if (!limit) throw new Error('Unknown artifact');
    const bytes = fs.statSync(artifact).size;
    if (!bytes || bytes > limit * 1024 * 1024) throw new Error(`Artifact size ${bytes} exceeds ${limit} MiB or is empty`);
    console.log(`${path.basename(artifact)}: ${(bytes / 1024 / 1024).toFixed(2)} MiB / ${limit} MiB`);
  }
}
if (require.main === module) checkPayload(process.argv[2], process.argv[3]);
module.exports = { checkPayload };
