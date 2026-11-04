'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawn } = require('node:child_process');

function dataDir(platform = process.platform, env = process.env, home = os.homedir(), io = fs) {
  if (env.TW_DATA) return path.resolve(env.TW_DATA);
  const parent = platform === 'win32' ? env.APPDATA || path.join(home, 'AppData', 'Roaming')
    : platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
    : platform === 'linux' ? env.XDG_DATA_HOME || path.join(home, '.local', 'share') : null;
  if (!parent) return path.join(home, '.tmux-web');
  const target = path.join(parent, 'Termnest');
  const legacy = path.join(parent, 'Tmux Dev');
  if (io.existsSync(target) || !io.existsSync(legacy)) return target;
  try {
    io.renameSync(legacy, target);
  } catch (moveError) {
    // Publish a complete copy atomically. A failed copy must never look like a
    // new installation on the next launch; keep the original as a backup.
    let staging;
    try {
      staging = io.mkdtempSync(path.join(parent, '.termnest-migration-'));
      io.cpSync(legacy, staging, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
      io.renameSync(staging, target);
    } catch (copyError) {
      throw new Error('Could not migrate Tmux Dev data to Termnest. Original data is unchanged; retry after checking permissions and free space.', { cause: copyError });
    } finally {
      if (staging && io.existsSync(staging)) io.rmSync(staging, { recursive: true, force: true });
    }
  }
  return target;
}
function status(port) {
  return new Promise(resolve => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/__app', timeout: 1000 }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; if (body.length > 4096) req.destroy(); });
      res.on('end', () => {
        try { const value = JSON.parse(body); resolve(res.statusCode === 200 && value.app === 'tmux-dev'); }
        catch { resolve(false); }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}
function openBrowser(url) {
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const child = spawn(command, args, { stdio: 'ignore' });
  child.on('error', () => console.error('Could not open the browser. Open the local app URL manually.'));
  child.unref();
}
async function main() {
  const desktop = process.argv.includes('--desktop-pipe');
  const noOpen = desktop || process.argv.includes('--no-open');
  const port = Number(process.env.TW_PORT || 7681);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid TW_PORT');
  const url = `http://127.0.0.1:${port}/`;
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const root = fs.existsSync(path.join(__dirname, 'server.js')) ? __dirname : path.dirname(__dirname);
  const { appWindow } = require(path.join(root, 'lib/app-window'));
  const { instance } = require(path.join(root, 'lib/app-instance'));
  let window, pendingOpen = false, target = url;
  const handoff = await instance(dir, port, () => {
    if (window) window.open(target); else pendingOpen = true;
  }, noOpen);
  if (!handoff) return;
  if (await status(port)) {
    if (!noOpen) openBrowser(url);
    handoff.close(); return;
  }
  try {
    process.env.TW_DATA = dir;
    process.env.TW_PACKAGED = '1';
    if (!fs.existsSync(path.join(dir, 'vault.json'))) {
      // A supplied token is accepted only for headless smoke automation.
      process.env.TW_SETUP_TOKEN = (noOpen && process.env.TW_SETUP_TOKEN) || crypto.randomBytes(24).toString('hex');
      target += '#setup=' + encodeURIComponent(process.env.TW_SETUP_TOKEN);
    } else delete process.env.TW_SETUP_TOKEN;
    const { server, shutdown, activeWork, drain } = require(path.join(root, 'server.js'));
    if (desktop) {
      process.stdin.resume();
      process.stdin.once('end', drain);
      server.once('listening', () => process.stdout.write(JSON.stringify({ setupToken: process.env.TW_SETUP_TOKEN || null }) + '\n'));
      return;
    }
    window = appWindow({ dir, fallback: openBrowser, stop: shutdown, busy: activeWork });
    server.once('listening', () => { if (!noOpen || pendingOpen) window.open(target); });
    server.once('error', () => { console.error('Could not start Termnest on the requested port.'); process.exit(1); });
  } catch (error) { handoff.close(); throw error; }
}
if (require.main === module) main().catch(() => { console.error('Could not start Termnest.'); process.exitCode = 1; });
module.exports = { dataDir, status };
