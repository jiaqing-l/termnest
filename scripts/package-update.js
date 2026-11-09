#!/usr/bin/env node
'use strict';
// Build a source-only update. The archive extracts into the application directory (no enclosing folder).
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const roots = ['lib', 'public', 'server.js', 'scripts', 'docs/supervisor.md', 'docs/server-backups.md', 'package.json', 'package-lock.json'];
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
function safeEntry(name) {
  const parts = name.split('/');
  return !path.posix.isAbsolute(name) && !/[\x00-\x1f\\]/.test(name) && !parts.some(p =>
    !p || p === '..' || p === '.' || p.startsWith('.') || /^(node_modules|data|vault|credentials?|secrets?|implementation)$/i.test(p)) &&
    !/\.(?:tar|tgz|gz|zip|7z|exe|dll|dylib|so|node|pem|key|p12|pfx|env)$/i.test(name) &&
    // This audited implementation module is required by server.js; vault DATA stays excluded.
    (name === 'lib/vault.js' || !/(?:^|\/)(?:vault|credentials?|secrets?|password|id_rsa|id_ed25519)(?:[._-]|$)/i.test(name));
}
function build({ source = path.resolve(__dirname, '..'), output = path.join(source, 'implementation', 'termnest-update-test.tar.gz'), tar = 'tar' } = {}) {
  source = path.resolve(source); output = path.resolve(output);
  // Stage exact file bytes and modes. Never follow symlinks or archive a directory recursively.
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'termnest-update-'));
  let temp;
  try {
    const entries = [];
    function collect(name) {
      if (!safeEntry(name)) return;
      const from = path.join(source, name), st = fs.lstatSync(from);
      if (st.isSymbolicLink()) throw Error('Bundle refuses symlink: ' + name);
      if (st.isDirectory()) {
        for (const child of fs.readdirSync(from).sort()) collect(name + '/' + child);
      } else {
        if (!st.isFile() || st.nlink !== 1) throw Error('Bundle requires regular single-link file: ' + name);
        const bytes = fs.readFileSync(from);
        // Native binaries can have no extension; reject their executable magic too.
        const magic = bytes.subarray(0, 4).toString('hex');
        if (magic === '7f454c46' || ['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe'].includes(magic) || bytes.subarray(0, 2).toString() === 'MZ') throw Error('Bundle refuses native binary: ' + name);
        const to = path.join(stage, name); fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.writeFileSync(to, bytes, { mode: st.mode & 0o777 }); fs.chmodSync(to, st.mode & 0o777);
        entries.push({ path: name, sha256: hash(bytes), mode: st.mode & 0o777 });
      }
    }
    for (const root of roots) collect(root);
    entries.sort((a, b) => a.path.localeCompare(b.path));
    const manifest = 'SHA256SUMS';
    fs.writeFileSync(path.join(stage, manifest), entries.map(e => e.sha256 + '  ' + e.path).join('\n') + '\n');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    temp = path.join(path.dirname(output), '.' + path.basename(output) + '.' + crypto.randomBytes(8).toString('hex') + '.tmp');
    const names = entries.map(e => e.path).concat(manifest);
    // The archive is named relative to its own folder: GNU tar on Windows reads "D:\\…" as a remote host "D".
    execFileSync(tar, ['-czf', path.basename(temp), '-C', stage, '--', ...names], { cwd: path.dirname(temp), stdio: 'pipe', env: { ...process.env, COPYFILE_DISABLE: '1', TAR_OPTIONS: '' } });
    const actual = execFileSync(tar, ['-tzf', path.basename(temp)], { cwd: path.dirname(temp), encoding: 'utf8', env: { ...process.env, TAR_OPTIONS: '' } }).trim().split('\n');
    if (JSON.stringify(actual) !== JSON.stringify(names)) throw Error('Bundle entry verification failed');
    // Verify decompression and content before the atomic rename, including the generated manifest.
    const check = path.join(stage, 'verify'); fs.mkdirSync(check);
    execFileSync(tar, ['-xzpf', path.basename(temp), '-C', check], { cwd: path.dirname(temp), stdio: 'pipe', env: { ...process.env, TAR_OPTIONS: '' } });
    for (const e of entries) {
      const file = path.join(check, e.path), st = fs.lstatSync(file);
      if (!st.isFile() || hash(fs.readFileSync(file)) !== e.sha256 || (process.platform !== 'win32' && (st.mode & 0o777) !== e.mode)) throw Error('Bundle content verification failed: ' + e.path);
    }
    if (!fs.readFileSync(path.join(check, manifest)).equals(fs.readFileSync(path.join(stage, manifest)))) throw Error('Bundle manifest verification failed');
    const digest = hash(fs.readFileSync(temp));
    fs.renameSync(temp, output); temp = null;
    return { output, sha256: digest, entries: names };
  } finally {
    if (temp) fs.rmSync(temp, { force: true });
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--output')) { console.error('Usage: node scripts/package-update.js [--output FILE]'); process.exitCode = 2; }
  else { try { const result = build(args.length ? { output: args[1] } : {}); console.log(result.sha256 + '  ' + result.output); } catch (e) { console.error(e.message); process.exitCode = 1; } }
}
module.exports = { build, safeEntry };
