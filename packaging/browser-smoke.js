'use strict';
// Optional real-browser coverage, using the same ws dependency as the app.
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { start, freePort } = require('./smoke');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function browserSmoke(chromePath) {
  const app = await start({ env: { TW_SETUP_TOKEN: 'browser-test-token' } });
  let chrome, closed, ws;
  try {
    const port = await freePort();
    chrome = spawn(chromePath, ['--headless=new', '--no-sandbox', '--no-first-run',
      '--no-default-browser-check', `--remote-debugging-port=${port}`,
      `--user-data-dir=${path.join(app.data, 'chrome')}`, 'about:blank'], { stdio: 'ignore' });
    closed = new Promise(resolve => { chrome.once('exit', resolve); chrome.once('error', resolve); });
    let target;
    for (let i = 0; i < 100; i++) {
      try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page'); } catch { /* startup */ }
      if (target) break;
      await delay(100);
    }
    assert.ok(target, 'Chrome started');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    let sequence = 0;
    const pending = new Map();
    ws.on('message', buffer => {
      const message = JSON.parse(buffer);
      if (!message.id) return;
      const request = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => reject(new Error(`Chrome timed out: ${method}`)), 10000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const wait = async expression => {
      for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await delay(100); }
      throw new Error(`Browser condition failed: ${expression}`);
    };
    await send('Network.enable');
    await send('Network.setBlockedURLs', { urls: ['https://fonts.googleapis.com/*', 'https://fonts.gstatic.com/*'] });
    await send('Page.navigate', { url: app.url });
    await wait("!!document.querySelector('#login-setup') && !document.querySelector('#login-setup').hidden");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#form-setup')).display"), 'none');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#form-login')).display"), 'none');
    // A new document models the launcher's first browser open, not a hash-only navigation.
    await send('Page.navigate', { url: app.url + '/?first-run#setup=browser-test-token' });
    await wait("!!document.querySelector('#form-setup') && !document.querySelector('#form-setup').hidden");
    assert.equal(await evaluate('location.hash'), '');
    assert.equal(await evaluate("document.querySelector('#setup-hint').hidden"), true);
    await evaluate("document.querySelector('#setup-pass').value='browser-password-123'; document.querySelector('#setup-confirm').value='browser-password-123'; document.querySelector('#form-setup').requestSubmit()");
    await wait("!document.querySelector('#form-login').hidden && document.querySelector('#login-setup').hidden");
  } finally {
    if (ws) ws.close();
    if (chrome) { chrome.kill(); await closed; }
    await app.close();
  }
}
module.exports = { browserSmoke };
