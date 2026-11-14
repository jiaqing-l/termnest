'use strict';
// Switching tabs quickly must not leak SSH channels (a late attach is closed at once), and a newly created session opens
// in its own tab even when the first refresh did not see it yet.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), path = require('path');

test('a terminal channel granted after its viewer left is closed immediately', () => {
  const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const body = server.slice(server.indexOf('function attach(ws, r, name, url)'), server.indexOf('function attach(ws, r, name, url)') + 2400);
  assert.match(body, /if \(ws\.readyState !== ws\.OPEN\) \{ try \{ stream\.close\(\); \} catch \{[^}]*\} return; \}/);
  assert.ok(body.indexOf('ws.readyState !== ws.OPEN') < body.indexOf('openTerms.add(ws)'), 'checked before the channel is wired');
});

test('a new session is opened once it shows up, not dropped back to All', () => {
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  assert.match(app, /return refresh\(true\); \}\)\.then\(function \(\) \{ openWhenReady\(id, n\); \}\)/);
  assert.match(app, /function openWhenReady\(id, name, tries\)/);
});

test('switching back shows the last screen at once (tmux sessions) and window-size is set once per session', () => {
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8'), remote = fs.readFileSync(path.join(__dirname, '../lib/remote.js'), 'utf8');
  assert.match(app, /snapshotPane\(p\); closePane\(p\); p\.key = key; p\.term\.reset\(\); fitPane\(p\);/);
  assert.match(app, /if \(screens\[key\] && x\.v\.mode !== 'powershell'\) p\.term\.write\(/);
  assert.match(remote, /this\.sized\.has\(name\) \? attachCmd : `\$\{windowSizeCmd\(name\)\}; \$\{attachCmd\}`/);
});

test('the first resize and keystrokes sent while the channel opens are kept and applied', () => {
  const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const body = server.slice(server.indexOf('function attach(ws, r, name, url)'), server.indexOf('function attach(ws, r, name, url)') + 2400);
  assert.ok(body.indexOf("ws.on('message'") < body.indexOf('r.attach('), 'listens before the channel exists');
  assert.match(body, /stream\.setWindow\(clampSize\(size\.rows/);
  assert.match(body, /for \(const m of early\.splice\(0\)\) stream\.write\(m\)/);
});

test('window-size command uses the tmux 3.x session target and respects user config', () => {
  const { windowSizeCmd } = require('../lib/backend');
  const c = windowSizeCmd('abc');
  assert.match(c, /set-option -t '=abc:' window-size latest/);
  assert.match(c, /show-options -t '=abc:' window-size/);
  assert.match(c, /!= manual/);
  assert.ok(!/-q/.test(c));
  const cp = require('child_process');
  if (cp.spawnSync('tmux', ['-V']).status !== 0) return;
  const sock = ['-L', 'twqa'], t = (...a) => cp.spawnSync('tmux', [...sock, ...a], { encoding: 'utf8' });
  try {
    t('new-session', '-d', '-s', 'abc', '-x', '80', '-y', '24'); t('new-session', '-d', '-s', 'usr'); t('set-option', '-t', '=usr:', 'window-size', 'smallest');
    const run = (n) => cp.spawnSync('sh', ['-c', `tmux() { command tmux -L twqa "$@"; }; ${windowSizeCmd(n)}`]);
    run('abc'); run('usr');
    assert.equal(t('show-options', '-t', '=abc:', '-v', 'window-size').stdout.trim(), 'latest');
    assert.equal(t('show-options', '-t', '=usr:', '-v', 'window-size').stdout.trim(), 'smallest');
  } finally { t('kill-server'); }
});
