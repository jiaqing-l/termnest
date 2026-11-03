'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { create, RESET } = require('../public/mouse-filter');
const enc = (s) => new TextEncoder().encode(s), dec = (b) => new TextDecoder().decode(b);
const run = (...chunks) => { const f = create(); return chunks.map((c) => dec(f.push(enc(c)))).join(''); };

test('mouse reporting modes are removed so plain drag can select text', () => {
  assert.equal(run('a\x1b[?1000hb'), 'ab');
  assert.equal(run('\x1b[?1002h\x1b[?1006hX\x1b[?1006l\x1b[?1002l'), 'X');
  assert.equal(run('\x1b[?1003;1015;1006h'), '');
});

test('other private modes and ordinary escapes pass through untouched', () => {
  for (const s of ['\x1b[?1049h', '\x1b[?25l', '\x1b[?2004h', '\x1b[?1004h', '\x1b[31mred\x1b[0m', 'plain text', '\x1b[2J\x1b[H', '\x1b]0;title\x07'])
    assert.equal(run(s), s);
});

test('a mixed list keeps the non-mouse modes', () => {
  assert.equal(run('\x1b[?1049;1000;2004h'), '\x1b[?1049;2004h');
  assert.equal(run('\x1b[?1000;1006l'), '');
});

test('sequences split across chunks are still caught and nothing is lost', () => {
  assert.equal(run('hi\x1b', '[?10', '00h', 'ok'), 'hiok');
  assert.equal(run('\x1b[?1049', 'h'), '\x1b[?1049h');
  assert.equal(run('end\x1b'), 'end');            // a trailing lone ESC is held for the next chunk
  const f = create(); f.push(enc('x\x1b')); assert.equal(dec(f.push(enc('[0mY'))), '\x1b[0mY');
});

test('long digit runs and stray escapes cannot stall the stream', () => {
  const long = '\x1b[?' + '1'.repeat(80) + 'h';
  assert.equal(run(long), long);
  assert.equal(run('\x1b\x1b[?1000h!'), '\x1b!');
  assert.match(RESET, /1000l.*1006l/);
});

test('multi-byte text is preserved byte for byte', () => {
  assert.equal(run('Tiếng Việt ✓ 🐼\x1b[?1000h done'), 'Tiếng Việt ✓ 🐼 done');
});
