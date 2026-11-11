'use strict';
// Windows without WSL (plain PowerShell sessions, no tmux): the wheel scrolls the browser terminal's own history and a
// reopened view gets the last ~2 MB back, starting at a line boundary. tmux sessions keep 100000 lines instead of 2000.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), path = require('path');
const { plainReplay, PLAIN_REPLAY } = require('../lib/local');

test('plain replay keeps everything until the limit, then starts at a line boundary', () => {
  assert.equal(plainReplay({ chunks: ['a\n', 'b\n'], trimmed: false }), 'a\nb\n');
  assert.equal(plainReplay({ chunks: ['tail of an old line\n', 'line 2\n'], trimmed: true }), 'line 2\n');
  assert.ok(PLAIN_REPLAY >= 8 * 1048576);
});

test('the page leaves the wheel to xterm on plain sessions and never asks tmux to scroll them', () => {
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  assert.match(app, /function plainPane\(p\)[^\n]*mode === 'powershell'/);
  assert.match(app, /!e\.deltaY \|\| plainPane\(p\)\) return;/);
  assert.match(app, /if \(plainPane\(p\)\) \{ p\.term\.scrollLines\(l\); return; \}/);
  assert.match(app, /scrollback = plainPane\(p\) \? 50000 : 3000/);
});

test('new tmux sessions raise (never lower) the history limit to 100000 lines', () => {
  const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert.match(server, /const HISTORY_LINES = 100000;/);
  assert.match(server, /-ge \$\{HISTORY_LINES\} \] 2>\/dev\/null \|\| H='set-option -g history-limit/);
});

test('clearing the history of a plain session forgets its replay', () => {
  const { Local } = require('../lib/local');
  const fake = { plain: new Map([['s', { chunks: ['x\n'], size: 2, trimmed: true }]]) };
  assert.equal(Local.prototype.clearPlain.call(fake, 's'), true);
  assert.deepEqual(fake.plain.get('s'), { chunks: [], size: 0, trimmed: false });
  assert.equal(Local.prototype.clearPlain.call(fake, 'none'), false);
});

test('Windows keys like Windows Terminal: Ctrl+C copies a selection without interrupting; Ctrl+V pastes, never ^V', () => {
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  assert.match(app, /copySelection\(p\); p\.term\.clearSelection\(\); return false;/);
  assert.match(app, /k === 'v' && !event\.altKey && \(event\.metaKey \|\| event\.ctrlKey && \(event\.shiftKey \|\| !isMac\)\)/);
  assert.match(app, /return false; \/\/ in a browser the default action delivers the clipboard/);
});
