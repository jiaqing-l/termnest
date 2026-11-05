'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { keysScript, BAD } = require('../lib/keys');

test('a single line is typed literally and submitted with Enter', () => {
  assert.equal(keysScript('=s:', 'hello', true), "tmux send-keys -l -t '=s:' -- 'hello' && tmux send-keys -t '=s:' Enter");
  assert.equal(keysScript('=s:', 'hello', false), "tmux send-keys -l -t '=s:' -- 'hello'");
});

test('a newline becomes Ctrl+J between the lines, never an Enter', () => {
  const script = keysScript('=s:', 'one\ntwo\n\nthree', true);
  assert.equal(script.split('C-j').length - 1, 3);
  assert.equal(script.match(/ Enter$/).length, 1);
  assert.match(script, /'one' && tmux send-keys -t '=s:' C-j && tmux send-keys -l -t '=s:' -- 'two'/);
});

test('quotes and shell characters stay inside the quoted text', () => {
  const script = keysScript('=s:', "it's $(x); `y`", false);
  assert.match(script, /-- 'it'\\''s \$\(x\); `y`'$/);
});

test('only newlines are allowed among the control characters', () => {
  assert.equal(BAD.test('a\nb'), false);
  assert.equal(BAD.test('a\tb'), true); assert.equal(BAD.test('a\rb'), true); assert.equal(BAD.test('a\x1bb'), true);
});
