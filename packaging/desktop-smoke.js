'use strict';
// Exercise the installed native shell and its IPC bridge, then the installed
// launcher/runtime's authenticated setup, login, PTY and quit paths.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { smoke, freePort, start } = require('./smoke');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function redact(text) {
  return text.replace(/https?:\/\/[^\s"'<>]+/gi, '[URL redacted]')
    .replace(/[a-f0-9]{48}/gi, '[token redacted]')
    .replace(/(setupToken["'\s: =]+)[^\s,}]+/gi, '$1[redacted]');
}
async function waitReady(child, marker, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(marker)) {
    if (child.exitCode !== null || child.signalCode) throw new Error(`Native shell exited before rendering: ${child.exitCode}/${child.signalCode}`);
    if (Date.now() >= deadline) throw new Error(`Native webview readiness timed out after ${timeoutMs} ms`);
    await delay(100);
  }
  assert.equal(fs.readFileSync(marker, 'utf8'), 'webview-ready');
}
function diagnostics(temp) {
  return ['shell.log', 'server.log', 'process.log'].map(name => {
    const file = path.join(temp, name);
    return `${name}:\n${fs.existsSync(file) ? redact(fs.readFileSync(file, 'utf8')).slice(-16000) : '(not created)'}`;
  }).join('\n');
}
async function desktopSmoke(executable, resources, node) {
  // Resolve Windows 8.3 aliases once; Rust and Node receive the same full path.
  const temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-native-')));
  const marker = path.join(temp, 'ready');
  const port = process.env.TW_DESKTOP_SMOKE_ISOLATED === '1' ? await freePort() : 7681;
  const url = `http://127.0.0.1:${port}`;
  let child;
  const processLog = fs.openSync(path.join(temp, 'process.log'), 'a');
  const launch = port => spawn(path.resolve(executable), [], {
    stdio: ['ignore', processLog, processLog],
    env: {...process.env, TW_DATA: temp, TW_DESKTOP_SMOKE_FILE: marker,
      TW_DESKTOP_SMOKE_PORT: String(port), TW_DESKTOP_LOG: path.join(temp, 'shell.log'),
      TW_DESKTOP_SERVER_LOG: path.join(temp, 'server.log')}
  });
  try {
    // Fail instead of interacting with a developer's existing instance.
    let occupied = false;
    try { await fetch(url + '/__app', {signal: AbortSignal.timeout(500)}); occupied = true; } catch {}
    assert.equal(occupied, false, 'Port 7681 must be free for installed smoke');
    child = launch(port);
    const exit = new Promise((resolve, reject) => {child.once('error', reject); child.once('exit', (code, signal) => resolve({code, signal}));});
    // Allow the shell's 60-second server deadline plus first WebView2 creation.
    await Promise.race([waitReady(child, marker), exit.then(result => {
      if (!fs.existsSync(marker)) throw new Error(`Native shell exited before readiness: ${JSON.stringify(result)}`);
    })]);
    // Native smoke closes through the normal window-close/drain handler.
    const result = await Promise.race([exit, delay(15000).then(() => {throw new Error('Native close timed out');})]);
    assert.equal(result.code, 0);
    await assert.rejects(fetch(url + '/__app', {signal: AbortSignal.timeout(500)}));
    console.log('Installed native shell passed: rendered WebView, local fonts, IPC, close and child cleanup');
    await smoke(resources, node);
    // Reuse an independently started source server without assuming ownership.
    const source = await start({root: resources, node, launcher: false});
    try {
      fs.rmSync(marker, {force: true});
      child = launch(source.port);
      const reusedExit = new Promise((resolve, reject) => {child.once('error', reject); child.once('exit', code => resolve(code));});
      await Promise.race([waitReady(child, marker), reusedExit.then(code => {
        if (!fs.existsSync(marker)) throw new Error(`Source reuse exited before readiness: ${code}`);
      })]);
      assert.equal(await Promise.race([reusedExit, delay(15000).then(() => {throw new Error('Source reuse timed out');})]), 0);
      assert.equal(fs.readFileSync(marker, 'utf8'), 'webview-ready');
      assert.equal((await source.request('/__app')).status, 200);
      console.log('Installed native shell passed: source-server reuse without stopping its owner');
    } finally { await source.close(); }
  } catch (error) {
    console.error('Installed native smoke diagnostics:\n' + diagnostics(temp));
    throw error;
  } finally {
    fs.closeSync(processLog);
    if (child && child.exitCode === null && !child.signalCode) {
      const closed = new Promise(resolve => child.once('close', resolve));
      child.kill();
      await Promise.race([closed, delay(5000)]);
    }
    fs.rmSync(temp, {recursive: true, force: true, maxRetries: 20, retryDelay: 100});
  }
}
if (require.main === module) desktopSmoke(...process.argv.slice(2)).catch(error => {console.error(error); process.exitCode = 1;});
module.exports = {desktopSmoke, waitReady, diagnostics, redact};
