'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { attach } = require('../public/touch-scroll');

function setup(cell = 10) {
  const handlers = {}, calls = [];
  attach({ addEventListener: (type, fn) => { handlers[type] = fn; } }, { slop: 8, cell: () => cell, onLines: (l) => calls.push(l) });
  const ev = (y, extra = {}) => ({ touches: [{ clientX: 5, clientY: y }], defaultPrevented: false, stopped: false, cancelable: true,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...extra });
  return { handlers, calls, ev };
}

test('a tap never scrolls and is not cancelled', () => {
  const { handlers, calls, ev } = setup();
  handlers.touchstart(ev(100)); const m = ev(103); handlers.touchmove(m); const end = ev(103); handlers.touchend(end);
  assert.deepEqual(calls, []); assert.equal(m.defaultPrevented, false); assert.equal(end.defaultPrevented, false);
});

test('swiping the finger up scrolls toward newer output, down toward older', () => {
  const { handlers, calls, ev } = setup();
  handlers.touchstart(ev(200)); handlers.touchmove(ev(170)); // 30px up, 10px per line
  assert.deepEqual(calls, [3]);
  handlers.touchmove(ev(200)); // back down 30px
  assert.deepEqual(calls, [3, -3]);
});

test('a swipe cancels browser panning and the follow-up click that would open the keyboard', () => {
  const { handlers, ev } = setup();
  handlers.touchstart(ev(100)); const m = ev(60); handlers.touchmove(m); const end = ev(60); handlers.touchend(end);
  assert.equal(m.defaultPrevented, true); assert.equal(m.stopped, true); assert.equal(end.defaultPrevented, true);
});

test('leftover distance below one line carries into the next move', () => {
  const { handlers, calls, ev } = setup();
  handlers.touchstart(ev(100)); handlers.touchmove(ev(86)); // 14px: 1 line, 4px left over
  handlers.touchmove(ev(80)); // 6 more px: 10px total since the leftover, so 1 more line
  assert.deepEqual(calls, [1, 1]);
});

test('multi-touch is ignored so pinch zoom is untouched', () => {
  const { handlers, calls, ev } = setup();
  handlers.touchstart(ev(100)); const m = ev(40, { touches: [{ clientY: 40 }, { clientY: 90 }] }); handlers.touchmove(m);
  assert.deepEqual(calls, []); assert.equal(m.defaultPrevented, false);
});

function glideSetup() {
  const handlers = {}, calls = [], frames = [];
  let clock = 0;
  const api = attach({ addEventListener: (type, fn) => { handlers[type] = fn; } },
    { slop: 8, cell: () => 10, onLines: (l) => calls.push(l), now: () => clock, raf: (fn) => { frames.push(fn); return frames.length; }, caf: (id) => { frames[id - 1] = null; } });
  const ev = (y, extra = {}) => ({ touches: [{ clientX: 5, clientY: y }], cancelable: true, preventDefault() {}, stopPropagation() {}, ...extra });
  const tick = (ms) => { clock += ms; const fn = frames.shift(); if (fn) fn(); };
  return { handlers, calls, ev, tick, frames, at: (ms) => { clock = ms; }, api };
}

test('a quick flick keeps scrolling after the finger lifts and then slows to a stop', () => {
  const g = glideSetup();
  g.at(0); g.handlers.touchstart(g.ev(300));
  g.at(16); g.handlers.touchmove(g.ev(260)); g.at(32); g.handlers.touchmove(g.ev(220)); // fast: 2.5 px per ms
  const during = g.calls.reduce((a, b) => a + b, 0);
  g.handlers.touchend(g.ev(220));
  for (let i = 0; i < 400 && g.frames.length; i += 1) g.tick(16);
  const total = g.calls.reduce((a, b) => a + b, 0);
  assert.ok(total > during, 'momentum added more lines after release');
  assert.equal(g.frames.length, 0, 'glide ends by itself');
});

test('a slow drag that just stops does not glide', () => {
  const g = glideSetup();
  g.at(0); g.handlers.touchstart(g.ev(300));
  g.at(200); g.handlers.touchmove(g.ev(280)); g.at(400); g.handlers.touchmove(g.ev(278));
  g.at(900); g.handlers.touchend(g.ev(278));
  assert.equal(g.frames.length, 0);
});

test('touching the screen again stops a glide in progress', () => {
  const g = glideSetup();
  g.at(0); g.handlers.touchstart(g.ev(300));
  g.at(16); g.handlers.touchmove(g.ev(250)); g.at(32); g.handlers.touchmove(g.ev(200));
  g.handlers.touchend(g.ev(200)); g.tick(16);
  const before = g.calls.length; g.handlers.touchstart(g.ev(100));
  for (let i = 0; i < 20; i += 1) g.tick(16);
  assert.equal(g.calls.length, before);
});
