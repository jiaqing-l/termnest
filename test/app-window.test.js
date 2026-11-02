'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { findBrowser, appWindow } = require('../lib/app-window');
const { instance } = require('../lib/app-instance');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('macOS lookup prefers Chrome, including user install, over Edge', () => {
  const chrome = path.join('/fixture/test', 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome');
  assert.equal(findBrowser({ platform: 'darwin', home: '/fixture/test', exists: file => file === chrome || file.includes('Microsoft Edge') }), chrome);
  assert.equal(findBrowser({ platform: 'darwin', exists: () => false }), null);
});
test('Windows lookup exhausts Edge locations and App Paths before Chrome', () => {
  const checked = [], registry = [];
  const edge = 'D:\\Edge\\msedge.exe';
  assert.equal(findBrowser({ platform: 'win32', env: {}, home: 'C:\\Users\\test', exists: file => { checked.push(file); return file === edge || file.includes('chrome.exe'); }, registry: (hive, exe) => { registry.push([hive, exe]); return hive === 'HKLM' ? edge : null; } }), edge);
  assert.deepEqual(registry, [['HKCU', 'msedge.exe'], ['HKLM', 'msedge.exe']]);
  assert.equal(checked.some(file => file.includes('chrome.exe')), false);
  assert.equal(checked[0], 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
  assert.equal(findBrowser({ platform: 'win32', env: {}, exists: file => file === 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', registry: () => null }), 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
});
test('Windows lookup uses custom install roots and a UNC home without POSIX separators', () => {
  const env = { 'ProgramFiles(x86)': 'D:\\Apps (x86)', ProgramFiles: 'D:\\Apps', LOCALAPPDATA: 'D:\\Users\\Test User\\AppData\\Local' };
  for (const base of Object.values(env)) {
    const edge = path.win32.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    assert.equal(findBrowser({ platform: 'win32', env, exists: file => file === edge, registry: () => null }), edge);
  }
  const home = '\\\\server\\users\\Test User';
  const chrome = path.win32.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe');
  assert.equal(findBrowser({ platform: 'win32', env: {}, home, exists: file => file === chrome, registry: () => null }), chrome);
});
// Execute unchanged production code with Windows path/process dependencies on any host.
function windowsModule(file, childProcess = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve(file), 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(require.resolve(file)),
    process: { platform: 'win32' }, console,
    require: name => name === 'node:path' ? path.win32 : name === 'node:child_process' ? childProcess : require(name),
    setTimeout, clearTimeout,
  });
  return module.exports;
}
test('Windows registry lookup validates quoted and expanded App Paths and falls back to Chrome', () => {
  const queries = [];
  const chrome = 'D:\\Registered Apps\\Google\\Chrome\\Application\\chrome.exe';
  const { findBrowser: lookup } = windowsModule('../lib/app-window', {
    execFileSync: (exe, args, options) => {
      assert.equal(exe, 'reg.exe'); assert.equal(args[0], 'query'); assert.equal(args[2], '/ve');
      assert.equal(options.windowsHide, true); assert.equal(options.timeout, 2000);
      queries.push(args[1]);
      if (args[1].startsWith('HKCU') && args[1].endsWith('msedge.exe')) throw Error('not installed');
      if (args[1].endsWith('msedge.exe')) return '    (Default)    REG_SZ    "D:\\Removed Edge\\msedge.exe"\r\n';
      return '    (Default)    REG_EXPAND_SZ    "%CUSTOM_APPS%\\Google\\Chrome\\Application\\chrome.exe"\r\n';
    },
  });
  assert.equal(lookup({ platform: 'win32', env: { CUSTOM_APPS: 'D:\\Registered Apps' }, home: 'C:\\Users\\Test', exists: file => file === chrome }), chrome);
  assert.deepEqual(queries, ['HKCU', 'HKLM'].map(hive => `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe`).concat('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe'));
  assert.equal(lookup({ platform: 'win32', env: {}, home: 'C:\\Users\\Test', exists: () => false }), null);
});
test('Windows app spawn preserves spaces in executable and profile paths as single arguments', () => {
  const { appWindow: create } = windowsModule('../lib/app-window');
  const browser = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const child = new EventEmitter();
  const window = create({ dir: 'C:\\Users\\Test User\\AppData\\Roaming\\Termnest', browser,
    launch: (exe, args, options) => {
      assert.equal(exe, browser);
      assert.deepEqual(Array.from(args), ['--app=http://127.0.0.1:7681/#setup=private', '--user-data-dir=C:\\Users\\Test User\\AppData\\Roaming\\Termnest\\app-profile', '--no-first-run', '--no-default-browser-check']);
      assert.equal(options.stdio, 'ignore'); assert.equal(options.shell, undefined);
      return child;
    }, fallback: () => assert.fail('unexpected fallback'), stop: () => assert.fail('unexpected stop'),
  });
  window.open('http://127.0.0.1:7681/#setup=private'); window.cancel();
});
test('Windows default-browser fallback passes the complete URL directly to rundll32', () => {
  const calls = [], child = new EventEmitter(); let unrefs = 0;
  child.unref = () => unrefs++;
  // Expose the private function only inside this test's isolated module context.
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../packaging/launcher'), 'utf8') + '\nmodule.exports.openBrowser = openBrowser;', {
    module, process: { platform: 'win32' }, console,
    require: name => name === 'node:child_process' ? { spawn: (...args) => { calls.push(args); return child; } } : require(name),
  });
  const url = 'http://127.0.0.1:7681/#setup=private&value=1';
  module.exports.openBrowser(url);
  assert.equal(calls[0][0], 'rundll32.exe');
  assert.deepEqual(Array.from(calls[0][1]), ['url.dll,FileProtocolHandler', url]);
  assert.equal(calls[0][2].shell, undefined); assert.equal(calls[0][2].stdio, 'ignore');
  assert.equal(unrefs, 1); assert.equal(child.listenerCount('error'), 1);
});
function fixture(extra = {}) {
  const children = [], calls = [], fallback = [];
  let stops = 0;
  const window = appWindow({ dir: path.resolve(os.tmpdir(), 'private tool'), browser: '/fake/browser', grace: 15, launch: (exe, args, options) => {
    calls.push({ exe, args, options }); const child = new EventEmitter(); children.push(child); return child;
  }, fallback: url => fallback.push(url), stop: () => stops++, ...extra });
  return { window, children, calls, fallback, stops: () => stops };
}
test('app arguments use private persisted profile and stop after window exit grace', async () => {
  const f = fixture(); f.window.open('http://127.0.0.1:7681/#setup=private');
  assert.deepEqual(f.calls[0].args, ['--app=http://127.0.0.1:7681/#setup=private', `--user-data-dir=${path.resolve(os.tmpdir(), 'private tool', 'app-profile')}`, '--no-first-run', '--no-default-browser-check']);
  f.children[0].emit('exit', 0, null); assert.equal(f.stops(), 0);
  await delay(45); assert.equal(f.stops(), 1);
});
test('window close waits for active operation; second open cancels deferred stop', async () => {
  let busy = true;
  const f = fixture({ busy: () => busy }); f.window.open('url'); f.children[0].emit('exit', 0);
  await delay(45); assert.equal(f.stops(), 0);
  f.window.open('url'); busy = false;
  await delay(45); assert.equal(f.stops(), 0);
  f.children[1].emit('exit', 0); await delay(45); assert.equal(f.stops(), 1);
});
test('active work completion allows deferred stop without another open', async () => {
  let busy = true;
  const f = fixture({ busy: () => busy }); f.window.open('url'); f.children[0].emit('exit', 0);
  await delay(45); assert.equal(f.stops(), 0); busy = false;
  await delay(45); assert.equal(f.stops(), 1);
});
test('second launch handoff process exit does not stop original window', async () => {
  const f = fixture(); f.window.open('url'); f.window.open('url');
  f.children[1].emit('exit', 0); await delay(45); assert.equal(f.stops(), 0);
  f.children[0].emit('exit', 0); await delay(45); assert.equal(f.stops(), 1);
});
test('missing browser, synchronous failure, spawn error and nonzero exit fall back without auto-stop', async () => {
  for (const mode of ['missing', 'throw', 'error', 'exit']) {
    const f = fixture(mode === 'missing' ? { browser: null } : mode === 'throw' ? { launch: () => { throw Error('failure'); } } : {});
    f.window.open('private-url');
    if (mode === 'error') f.children[0].emit('error', Error('failure'));
    if (mode === 'exit') f.children[0].emit('exit', 1);
    await delay(30); assert.deepEqual(f.fallback, ['private-url']); assert.equal(f.stops(), 0);
  }
});
test('fake executable receives arguments and controls actual process lifetime', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-window-test-'));
  const script = path.join(dir, 'fake-browser.cjs');
  fs.writeFileSync(script, 'setTimeout(() => process.exit(0), 40);');
  let stopped;
  const done = new Promise(resolve => { stopped = resolve; });
  let args;
  const window = appWindow({ dir, browser: process.execPath, launch: (exe, supplied, options) => {
    args = supplied; return spawn(exe, [script, ...supplied], options);
  }, fallback: () => assert.fail('unexpected fallback'), stop: stopped, grace: 10 });
  try { window.open('http://127.0.0.1:1234/'); await done; assert.equal(args[0], '--app=http://127.0.0.1:1234/'); }
  finally { window.cancel(); fs.rmSync(dir, { recursive: true, force: true }); }
});
test('second process requests a window from owner; simultaneous starts have one owner', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-instance-test-'));
  let opens = 0;
  let owners = [];
  try {
    const results = await Promise.all([instance(dir, 12345, () => opens++), instance(dir, 12345, () => opens++)]);
    owners = results.filter(Boolean); assert.equal(owners.length, 1); assert.equal(opens, 1);
    const modulePath = require.resolve('../lib/app-instance');
    await promisify(execFile)(process.execPath, ['-e', `require(${JSON.stringify(modulePath)}).instance(${JSON.stringify(dir)},12345,()=>{}).then(owner=>{if(owner)process.exit(2)})`], { timeout: 5000 });
    assert.equal(opens, 2);
  } finally {
    await Promise.all(owners.map(owner => new Promise(resolve => owner.close(resolve))));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('launcher handoff opens fake window, waits for an in-flight API request, then stops server', { timeout: 10000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-launch-test-'));
  const fake = path.join(dir, 'browser.cjs'), preload = path.join(dir, 'preload.cjs');
  const count = path.join(dir, 'count');
  fs.writeFileSync(fake, `const fs=require('fs'); const file=${JSON.stringify(count)}; const second=fs.existsSync(file); fs.appendFileSync(file,'open\\n'); setTimeout(()=>process.exit(0),second?10:300);`);
  fs.writeFileSync(preload, `const mod=require(${JSON.stringify(require.resolve('../lib/app-window'))}); const original=mod.appWindow; mod.appWindow=options=>original({...options,browser:process.execPath,grace:30,launch:(exe,args,opts)=>require('child_process').spawn(exe,[${JSON.stringify(fake)},...args],opts)});`);
  const app = await require('../packaging/smoke').start({ env: { NODE_OPTIONS: `--require=${preload}`, TW_SETUP_TOKEN: 'private-test' } });
  let request;
  try {
    // Keep setup awaiting its request body even if its window has gone away.
    request = require('node:http').request(app.url + '/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    request.on('error', () => {}); request.write('{');
    const launch = () => promisify(execFile)(process.execPath, [path.resolve('packaging/launcher.js')], { env: { ...process.env, TW_DATA: app.data, TW_PORT: String(app.port) }, timeout: 5000 });
    await launch();
    for (let i=0; i<100 && !fs.existsSync(count); i++) await delay(10);
    assert.equal(fs.existsSync(count), true);
    await launch();
    await delay(500);
    assert.equal(app.child.exitCode, null);
    assert.equal(fs.readFileSync(count, 'utf8').split('\n').filter(Boolean).length, 2);
    const response = new Promise(resolve => request.once('response', res => { res.resume(); res.once('end', resolve); }));
    request.end('}'); await response;
    assert.equal((await app.exited).code, 0);
  } finally { if(request) request.destroy(); await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
