'use strict';
// The "newest" button must show only while the pane is scrolled back in tmux copy-mode.
// Panes on the alternate screen (Claude, Codex) used to keep a stale button that did nothing.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), path = require('path');
const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const start = app.indexOf('function drawScrollbar(p)'), end = app.indexOf('function scrollbar(p)');
const draw = new Function(app.slice(start, end) + '; return drawScrollbar;')();

function pane(scroll) {
  const cls = new Set();
  return { scroll, thumb: { style: {} }, toBottom: { hidden: true },
    bar: { hidden: true, clientHeight: 200, classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), remove: (c) => cls.delete(c), has: (c) => cls.has(c) } } };
}
const st = (o) => ({ inMode: false, position: 0, history: 500, alternate: false, height: 40, mouse: false, ...o });

test('shown only when scrolled back in copy-mode', () => {
  const p = pane(st({ inMode: true, position: 12 }));
  draw(p); assert.equal(p.toBottom.hidden, false); assert.equal(p.bar.hidden, false);
});

test('hidden at the bottom, in or out of copy-mode', () => {
  for (const s of [st({}), st({ inMode: true, position: 0 })]) { const p = pane(s); p.toBottom.hidden = false; draw(p); assert.equal(p.toBottom.hidden, true); }
});

test('a stale button is removed when the pane is on the alternate screen or has no history', () => {
  for (const s of [st({ alternate: true, inMode: true, position: 9 }), st({ history: 0 }), null]) {
    const p = pane(s); p.toBottom.hidden = false; p.bar.hidden = false; draw(p);
    assert.equal(p.toBottom.hidden, true); assert.equal(p.bar.hidden, true);
  }
});
