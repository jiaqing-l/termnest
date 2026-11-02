'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function start({ root, node = process.execPath, launcher = true, env = {}, beforeStart, extraArgs = [] } = {}) {
  root = path.resolve(root || path.join(__dirname, '..'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'termnest-smoke-'));
  let child;
  let exited;
  try {
    if (beforeStart) beforeStart(data);
    const port = await freePort();
    const entry = launcher ? (fs.existsSync(path.join(root, 'launcher.js')) ? 'launcher.js' : 'packaging/launcher.js') : 'server.js';
    const childEnv = { ...process.env, TW_DATA: data, TW_PORT: String(port), TW_DEFAULT_DIR: data };
    delete childEnv.TW_SETUP_TOKEN; delete childEnv.TW_PACKAGED;
    Object.assign(childEnv, env);
    child = spawn(node, [path.join(root, entry), '--no-open', ...extraArgs], { cwd: root, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    exited = new Promise(resolve => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', error => resolve({ error })); });
    const url = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 200; i++) {
      if (child.exitCode !== null || child.signalCode) throw new Error(`App exited before listening: ${output}`);
      try { const response = await fetch(url + '/api/status', { signal: AbortSignal.timeout(500) }); if (response.ok) { ready = true; break; } } catch { /* startup */ }
      await delay(50);
    }
    if (!ready) throw new Error('App startup timed out');
    return {
      url, port, data, child, exited,
      request: (route, body, cookie) => fetch(url + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000),
      }),
      async close() {
        if (child.exitCode === null && !child.signalCode) child.kill();
        await exited;
        fs.rmSync(data, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (child) { child.kill(); await exited; }
    fs.rmSync(data, { recursive: true, force: true });
    throw error;
  }
}
async function smoke(root, node) {
  const token = crypto.randomBytes(24).toString('hex');
  const app = await start({ root, node, env: { TW_SETUP_TOKEN: token } });
  try {
    const status = await app.request('/api/status');
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { setup: false, authed: false, webSetup: true, packaged: true });
    const home = await app.request('/');
    assert.equal(home.status, 200); assert.match(await home.text(), /Termnest/);
    for (const asset of ['/vendor/xterm.js', '/vendor/xterm.css', '/vendor/addon-fit.js', '/vendor/markdown-it.js']) assert.equal((await app.request(asset)).status, 200, asset);
    const password = crypto.randomBytes(24).toString('hex');
    assert.equal((await app.request('/api/setup', { password, setupToken: token })).status, 200);
    const login = await app.request('/api/login', { password });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const result = await execute(node, ['-e', `
      const pty = require('node-pty');
      const windows = process.platform === 'win32';
      const terminal = pty.spawn(windows ? 'powershell.exe' : '/bin/sh', windows
        ? ['-NoProfile', '-NonInteractive', '-Command', 'Write-Output TMUX_PTY_OK']
        : ['-c', 'printf TMUX_PTY_OK'], { cwd: process.env.TW_DATA, env: process.env });
      let output = '';
      terminal.onData(chunk => { output += chunk; });
      terminal.onExit(({exitCode}) => {
        if (exitCode !== 0 || !output.includes('TMUX_PTY_OK')) process.exit(1);
        console.log('Native PTY shell passed');
        process.exit(0);
      });
      setTimeout(() => { terminal.kill(); process.exit(1); }, 10000).unref();
    `], { cwd: path.resolve(root), env: { ...process.env, TW_DATA: app.data }, timeout: 15000, encoding: 'utf8' });
    assert.match(result.stdout, /Native PTY shell passed/);
    assert.equal((await app.request('/api/quit', {}, cookie)).status, 200);
    const exit = await Promise.race([app.exited, delay(10000).then(() => { throw new Error('Quit timed out'); })]);
    assert.equal(exit.code, 0);
    console.log('Packaged smoke passed: setup, assets, login, native PTY and quit');
  } finally { await app.close(); }
}
if (require.main === module) smoke(path.resolve(process.argv[2]), path.resolve(process.argv[3])).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { start, freePort, smoke };
