'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { detect } = require('../public/status-crop');

// Fake xterm buffer: a row is a string; 'g' = green background cell, '.' = default cell, 'i' = green inverse, 'b' = other bg.
function term(rows, cols = 20, text = 'abc') {
  const cell = (ch, i, ts) => ({ isBgDefault: () => ch === '.', isInverse: () => ch === 'i', getBgColorMode: () => 1, getBgColor: () => (ch === 'b' ? 5 : 2), getChars: () => (ts ? text[i] || ' ' : ' ') });
  const lines = rows.map((r, y) => ({ length: cols, getCell: (x) => cell(r[x] || '.', x, y === rows.length - 1 || /t/.test(r)) }));
  return { rows: rows.length, cols, buffer: { active: { baseY: 0, getNullCell: () => ({}), getLine: (y) => lines[y] } } };
}
const plain = '.'.repeat(20), green = 'g'.repeat(20);

test('one or two uniform coloured rows at the bottom are status rows', () => {
  assert.equal(detect(term([plain, plain, plain, plain, plain, plain, green])), 1);
  assert.equal(detect(term([plain, plain, plain, plain, plain, green, green])), 2);
});
test('uncertain screens are left alone', () => {
  assert.equal(detect(term(Array(8).fill(plain))), 0, 'no status');
  assert.equal(detect(term([plain, plain, plain, plain, plain, plain, 'g'.repeat(19) + '.'])), 0, 'one cell off');
  assert.equal(detect(term([plain, plain, plain, plain, plain, plain, 'g'.repeat(10) + 'b'.repeat(10)])), 0, 'two colours');
  assert.equal(detect(term([plain, plain, plain, plain, plain, plain, 'i'.repeat(20)])), 0, 'inverse video');
  assert.equal(detect(term(Array(8).fill(green))), 0, 'whole screen one colour');
  assert.equal(detect(term([plain, plain, green])), 0, 'tiny terminal');
  assert.equal(detect({}), 0); assert.equal(detect(null), 0);
});
test('never counts more than 3 rows', () => {
  assert.equal(detect(term([plain, plain, plain, plain, plain, green, green, green])), 3);
  assert.equal(detect(term([plain, plain, plain, green, green, green, green, green])), 0, 'four+ rows: uncertain');
});
