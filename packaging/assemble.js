'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function keep(relative, platform) {
  const parts = relative.replaceAll('\\', '/').split('/');
  const name = parts.at(-1);
  if (/\.(pdb|map)$/i.test(name) || /^README/i.test(name)) return false;
  if (parts.some(p => ['.git', '.github', 'docs', 'doc', 'test', 'tests', 'implementation', 'data', '.bin'].includes(p.toLowerCase()))) return false;
  if (parts.some(p => ['nan', 'node-addon-api', 'cpu-features'].includes(p))) return false;
  const pty = parts.indexOf('node-pty');
  if (pty !== -1) {
    const tail = parts.slice(pty + 1);
    if (['src', 'deps', 'third_party', 'binding.gyp', 'scripts'].includes(tail[0])) return false;
    // Linux has no prebuilt binaries: the addon is compiled during assembly and only build/Release/pty.node is shipped.
    if (tail[0] === 'build') return platform === 'linux' && (tail.length === 1 || (tail[1] === 'Release' && (tail.length === 2 || (tail.length === 3 && tail[2] === 'pty.node'))));
    if (tail[0] === 'prebuilds' && tail[1] && !({ win32: ['win32-x64'], darwin: ['darwin-arm64', 'darwin-x64'], linux: [] }[platform] || []).includes(tail[1])) return false;
  }
  if (parts.includes('@xterm') && parts.includes('src')) return false;
  if (parts.includes('ssh2') && (parts.includes('build') || parts.includes('sshcrypto.node'))) return false;
  return true;
}
function copyTree(source, target, platform) {
  fs.cpSync(source, target, { recursive: true, dereference: false, filter: file => {
    const rel = path.relative(source, file);
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`Unexpected symlink: ${rel}`);
    return keep(rel, platform);
  } });
  function permissions(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) permissions(file);
      else if (entry.name === 'spawn-helper') fs.chmodSync(file, 0o755);
    }
  }
  permissions(target);
}
// Keep runtime support explicit: copying scripts/ or docs/ wholesale can ship developer tools or secrets.
function copyRuntimeSupport(root, out) {
  const files = [
    ['scripts/install-supervisor.sh', 'scripts/install-supervisor.sh'],
    ['scripts/install-supervisor-macos.sh', 'scripts/install-supervisor-macos.sh'],
    ['scripts/install-supervisor.ps1', 'scripts/install-supervisor.ps1'],
    ['scripts/supervisor-check.js', 'scripts/supervisor-check.js'],
    // Sets the password from a terminal when the setup screen is gone (see the login page's desktop hint).
    ['scripts/set-password.js', 'scripts/set-password.js'],
    ['docs/supervisor.md', 'SUPERVISOR.md'],
  ];
  for (const [source, destination] of files) {
    const from = path.join(root, source), to = path.join(out, destination);
    // Absent platform installers are allowed while their track is being integrated.
    // Reject links, including a linked parent directory, rather than following them into private files.
    let stat;
    try {
      const parent = fs.lstatSync(path.dirname(from));
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Unsafe runtime support directory');
      stat = fs.lstatSync(from);
    } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isFile() || stat.nlink !== 1) throw new Error(`Unsafe runtime support file: ${source}`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    fs.chmodSync(to, stat.mode & 0o777);
  }
}
function assemble(destination, platform = process.platform) {
  if (!['win32', 'darwin', 'linux'].includes(platform)) throw new Error('Target must be win32, darwin or linux');
  const root = path.resolve(__dirname, '..');
  const out = path.resolve(destination);
  if (out === root || root.startsWith(out + path.sep)) throw new Error('Unsafe staging path');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'termnest-deps-'));
  try {
    for (const file of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(root, file), path.join(temp, file));
    // Use npm's JS entry point so Windows needs no cmd.exe quoting.
    const npm = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    if (!fs.existsSync(npm)) throw new Error('Run assembly with npm run prepare:desktop');
    execFileSync(process.execPath, [npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: temp, stdio: 'inherit', encoding: 'utf8' });
    // node-pty ships no Linux prebuilds, so compile it here with the same Node that the bundle runs.
    if (platform === 'linux') {
      if (process.platform !== 'linux') throw new Error('The Linux payload must be assembled on Linux');
      execFileSync(process.execPath, [npm, 'rebuild', 'node-pty', '--foreground-scripts', '--no-audit', '--no-fund'], { cwd: temp, stdio: 'inherit', encoding: 'utf8' });
      if (!fs.existsSync(path.join(temp, 'node_modules/node-pty/build/Release/pty.node'))) throw new Error('node-pty did not build');
    }
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    for (const name of ['server.js', 'package.json', 'LICENSE', 'THIRD-PARTY-NOTICES.md']) fs.copyFileSync(path.join(root, name), path.join(out, name));
    const notices = path.join(out, 'THIRD-PARTY-NOTICES.md');
    fs.writeFileSync(notices, fs.readFileSync(notices, 'utf8').replaceAll('(docs/licenses/', '(licenses/'));
    // Legal texts must travel with the binaries, even though developer docs do not.
    fs.cpSync(path.join(root, 'docs/licenses'), path.join(out, 'licenses'), { recursive: true });
    for (const name of ['lib', 'public']) copyTree(path.join(root, name), path.join(out, name), platform);
    fs.copyFileSync(path.join(__dirname, 'launcher.js'), path.join(out, 'launcher.js'));
    copyRuntimeSupport(root, out);
    copyTree(path.join(temp, 'node_modules'), path.join(out, 'node_modules'), platform);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
if (require.main === module) assemble(process.argv[2] || 'packaging/out/stage', process.argv[3]);
module.exports = { keep, copyTree, copyRuntimeSupport, assemble };
