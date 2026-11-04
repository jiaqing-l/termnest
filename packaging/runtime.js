'use strict';
// Exact LTS runtime shared by both release jobs. Verify archives before extraction.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const VERSION = '22.14.0';
async function download(name, dir, sums) {
  const response = await fetch(`https://nodejs.org/dist/v${VERSION}/${name}`);
  if (!response.ok) throw new Error(`Download failed: ${name} (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const expected = sums.split('\n').map(line => line.trim().split(/\s+/)).find(row => row[1] === name)?.[0];
  if (!expected || crypto.createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error(`SHA256 mismatch: ${name}`);
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return file;
}
function extractArchive(file, destination, platform = process.platform, env = process.env) {
  // Git Bash can put GNU tar first on PATH; it treats C: as a remote host.
  // Select Windows' ZIP-capable bsdtar explicitly, independent of PATH/Node.
  const tar = platform === 'win32'
    ? path.win32.join(env.SystemRoot || env.WINDIR || 'C:\\Windows', 'System32', 'tar.exe')
    : '/usr/bin/tar';
  const archive = path.resolve(file);
  const target = path.resolve(destination);
  const cwd = path.dirname(archive);
  const relativeTarget = path.relative(cwd, target) || '.';
  const archiveName = path.basename(archive);
  // Windows tar loses Unicode in argv, but Node passes cwd via the wide API.
  const safeArgument = value => !path.isAbsolute(value) && /^[\x20-\x7e]+$/.test(value);
  const extract = (source, output) => execFileSync(tar, ['-xf', source, '-C', output],
    { cwd, stdio: 'inherit', encoding: 'utf8' });
  if (safeArgument(archiveName) && safeArgument(relativeTarget)) {
    extract(archiveName, relativeTarget);
    return;
  }
  // Stage beside the archive so even cross-drive/Unicode destinations never
  // reach tar's argv. Node copies the result across volumes using Unicode APIs.
  const staging = fs.mkdtempSync(path.join(cwd, 'tmux-extract-'));
  try {
    fs.copyFileSync(archive, path.join(staging, 'archive'));
    fs.mkdirSync(path.join(staging, 'out'));
    const relativeStage = path.basename(staging);
    extract(path.join(relativeStage, 'archive'), path.join(relativeStage, 'out'));
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(path.join(staging, 'out'))) {
      fs.cpSync(path.join(staging, 'out', entry), path.join(target, entry), { recursive: true });
    }
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}
async function main() {
  const destination = path.resolve(process.argv[2]);
  const platform = process.argv[3] || process.platform;
  if (!['darwin', 'win32', 'linux'].includes(platform)) throw new Error('Unsupported runtime platform');
  fs.mkdirSync(destination, { recursive: true });
  const temp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'tmux-node-'));
  try {
    const response = await fetch(`https://nodejs.org/dist/v${VERSION}/SHASUMS256.txt`);
    if (!response.ok) throw new Error('Could not download Node checksums');
    const sums = await response.text();
    // Linux ships x64 only: the .deb targets Ubuntu desktop on Intel/AMD.
    for (const arch of platform === 'darwin' ? ['arm64', 'x64'] : ['x64']) {
      const base = `node-v${VERSION}-${platform === 'win32' ? 'win' : platform}-${arch}`;
      const file = await download(base + (platform === 'win32' ? '.zip' : '.tar.gz'), temp, sums);
      extractArchive(file, temp);
      const from = path.join(temp, base, platform === 'win32' ? 'node.exe' : 'bin/node');
      const to = path.join(destination, platform === 'win32' ? 'node.exe' : `node-${arch}`);
      fs.copyFileSync(from, to);
      if (platform !== 'win32') fs.chmodSync(to, 0o755);
      fs.copyFileSync(path.join(temp, base, 'LICENSE'), path.join(destination, `NODE-LICENSE-${arch}`));
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { VERSION, extractArchive };
