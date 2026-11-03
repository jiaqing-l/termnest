'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { sequence } = require('../public/terminal-keys');
const ev = (key, mods = {}) => ({ type: 'keydown', key, metaKey: false, altKey: false, ctrlKey: false, shiftKey: false, isComposing: false, keyCode: 0, ...mods });

test('Cmd+Backspace deletes back to the start of the line, Option+Backspace one word', () => {
  assert.equal(sequence(ev('Backspace', { metaKey: true }), true), '\x15');
  assert.equal(sequence(ev('Backspace', { altKey: true }), true), '\x1b\x7f');
  assert.equal(sequence(ev('Backspace'), true), null);
});

test('Shift+Enter inserts a newline instead of sending; plain Enter is untouched', () => {
  assert.equal(sequence(ev('Enter', { shiftKey: true }), true), '\n');
  assert.equal(sequence(ev('Enter'), true), null);
  assert.equal(sequence(ev('Enter', { shiftKey: true, ctrlKey: true }), true), null);
});

test('Cmd and Option arrows move to line ends and across words', () => {
  assert.equal(sequence(ev('ArrowLeft', { metaKey: true }), true), '\x01');
  assert.equal(sequence(ev('ArrowRight', { metaKey: true }), true), '\x05');
  assert.equal(sequence(ev('ArrowLeft', { altKey: true }), true), '\x1bb');
  assert.equal(sequence(ev('ArrowRight', { altKey: true }), true), '\x1bf');
  assert.equal(sequence(ev('ArrowLeft', { metaKey: true, shiftKey: true }), true), null);
  assert.equal(sequence(ev('ArrowUp', { metaKey: true }), true), null);
});

test('Ctrl+Backspace deletes a word off macOS only', () => {
  assert.equal(sequence(ev('Backspace', { ctrlKey: true }), false), '\x1b\x7f');
  assert.equal(sequence(ev('Backspace', { ctrlKey: true }), true), null);
});

test('IME composition and non-keydown events are never rewritten', () => {
  assert.equal(sequence(ev('Backspace', { metaKey: true, isComposing: true }), true), null);
  assert.equal(sequence(ev('Enter', { shiftKey: true, keyCode: 229 }), true), null);
  assert.equal(sequence({ ...ev('Backspace', { metaKey: true }), type: 'keyup' }, true), null);
  assert.equal(sequence(null, true), null);
});
