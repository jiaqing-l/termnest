'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const c = require('../public/notes-core');
const at = (h, m, day = 3) => new Date(2026, 10, day, h, m, 0, 0); // 2026-11-03 is Tuesday, 07 is Saturday
const slot = (o) => ({ id: 's', time: '09:00', msg: 'x', days: c.ALLDAYS, on: true, createdAt: at(0, 0, 1).getTime(), lastFired: 0, ...o });
const notes = [{ text: '- [ ] a\n* [ ] b\n- [x] c\n1. [ ] d\ntext [ ] no' }];

test('openTasks counts only unchecked list items', () => {
  assert.equal(c.openTasks(notes[0].text), 3);
  assert.equal(c.openTotal([...notes, { text: '- [ ] z' }]), 4);
});
test('slot fires at its time, not before, and de-dups once marked', () => {
  const s = slot();
  assert.equal(c.dueSlots([s], at(8, 59), { notes }).length, 0);
  const d = c.dueSlots([s], at(9, 0), { notes });
  assert.equal(d.length, 1); assert.equal(d[0].late, false); assert.equal(d[0].open, 3);
  s.lastFired = d[0].at.getTime();
  assert.equal(c.dueSlots([s], at(9, 0), { notes }).length, 0);
  assert.equal(c.dueSlots([s], at(14, 0), { notes }).length, 0);
});
test('weekday filter and late flag', () => {
  const s = slot({ days: c.WORKDAYS });
  assert.equal(c.dueSlots([s], at(9, 1, 7), { notes }).length, 0); // Saturday
  assert.equal(c.dueSlots([s], at(9, 1, 3), { notes }).length, 1); // Tuesday
  assert.equal(c.dueSlots([s], at(9, 5, 3), { notes })[0].late, true);
});
test('off / created later / bad time are ignored', () => {
  assert.equal(c.dueSlots([slot({ on: false })], at(10, 0), { notes }).length, 0);
  assert.equal(c.dueSlots([slot({ createdAt: at(9, 30).getTime() })], at(10, 0), { notes }).length, 0);
  assert.equal(c.dueSlots([slot({ time: '25:00' })], at(10, 0), { notes }).length, 0);
});
test('only-open skips when no task remains, quiet hours silence', () => {
  const none = [{ text: '- [x] done' }];
  assert.equal(c.dueSlots([slot()], at(9, 0), { notes: none, onlyOpen: true })[0].skip, true);
  assert.equal(c.dueSlots([slot()], at(9, 0), { notes: none, onlyOpen: false })[0].skip, false);
  const q = { on: true, from: '08:00', to: '10:00' };
  assert.equal(c.dueSlots([slot()], at(9, 0), { notes, quiet: q })[0].silent, true);
  assert.equal(c.dueSlots([slot()], at(9, 0), { notes, quiet: { ...q, on: false } })[0].silent, false);
});
test('toggleDay / daysText', () => {
  assert.deepEqual(c.toggleDay([1, 2], 2), [1]); assert.deepEqual(c.toggleDay([1], 6), [1, 6]);
  assert.equal(c.daysText(c.WORKDAYS), 'work'); assert.equal(c.daysText(c.ALLDAYS), 'all'); assert.equal(c.daysText([1]), 'custom');
});
