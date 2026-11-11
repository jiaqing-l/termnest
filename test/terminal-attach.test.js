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
  assert.match(remote, /if \(this\.sized\.has\(name\)\) \{ go\(\); return; \}\r?\n\s+this\.sized\.add\(name\);\r?\n\s+this\.exec\(`tmux set-option -q -t[^\r\n]*\.then\(go\)/);
});

test('the first resize and keystrokes sent while the channel opens are kept and applied', () => {
  const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const body = server.slice(server.indexOf('function attach(ws, r, name, url)'), server.indexOf('function attach(ws, r, name, url)') + 2400);
  assert.ok(body.indexOf("ws.on('message'") < body.indexOf('r.attach('), 'listens before the channel exists');
  assert.match(body, /stream\.setWindow\(clampSize\(size\.rows/);
  assert.match(body, /for \(const m of early\.splice\(0\)\) stream\.write\(m\)/);
});
