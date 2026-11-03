'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const c = require('../public/notes-core');
const at = (h, m, day = 3) => new Date(2026, 10, day, h, m, 0, 0);
const rem = (o) => ({ id: 'r', noteId: 'n', time: '15:00', title: 't', daily: false, on: true, createdAt: at(9, 0).getTime(), lastFired: 0, ...o });

test('exports: txt drops markdown marks, md is verbatim, names carry the date and a clean slug', () => {
  const md = '# Tiêu đề\n\n**đậm** `code` [web](http://x)\n- [x] xong\n- [ ] chưa\n- ý\n';
  assert.equal(c.toTxt(md), 'Tiêu đề\n\nđậm code web (http://x)\n[x] xong\n[ ] chưa\n• ý\n');
  assert.equal(c.exportBody({ text: md }, 'md'), md);
  assert.equal(c.fileName({ title: 'Đo lại lần gọi hai!' }, 'txt', at(9, 0)), 'ghi-chu-2026-11-03-do-lai-lan-goi-hai.txt');
  assert.equal(c.fileName({ title: '???' }, 'md', at(9, 0)), 'ghi-chu-2026-11-03-ghi-chu.md');
  assert.equal(c.fileName({ title: 'x' }, 'exe', at(9, 0)).endsWith('.md'), true);
});

test('a one-time reminder rings once at its time today and then finishes', () => {
  const r = rem({});
  assert.deepEqual(c.due([r], at(14, 59)), []);
  const d = c.due([r], at(15, 0)); assert.equal(d.length, 1); assert.equal(d[0].late, false);
  c.markFired(r, d[0].at, at(15, 0));
  assert.equal(r.on, false); assert.deepEqual(c.due([r], at(15, 5)), []);
});

test('a time already past when it was created rings tomorrow, not immediately', () => {
  const r = rem({ time: '15:00', createdAt: at(15, 58).getTime() });
  assert.deepEqual(c.due([r], at(15, 59)), []);
  assert.deepEqual(c.due([r], at(23, 0)), []);
  assert.equal(c.due([r], at(15, 0, 4)).length, 1);
  assert.equal(c.whenText(r, at(15, 59)), 'Ngày mai');
  assert.equal(c.whenText(rem({ time: '17:30' }), at(9, 0)), 'Hôm nay');
});

test('a daily reminder rings every day and is flagged late when the app was closed', () => {
  const r = rem({ daily: true, time: '09:00', createdAt: at(8, 0).getTime() });
  const first = c.due([r], at(9, 0)); assert.equal(first.length, 1);
  c.markFired(r, first[0].at, at(9, 0)); assert.equal(r.on, true);
  assert.deepEqual(c.due([r], at(12, 0)), []);
  const lateOpen = c.due([r], at(9, 40, 4)); assert.equal(lateOpen.length, 1); assert.equal(lateOpen[0].late, true);
  assert.equal(c.whenText(r, at(9, 0)), 'Mỗi ngày');
});

test('snooze waits for its time and rings again; off or malformed reminders never ring', () => {
  const r = rem({});
  const d = c.due([r], at(15, 0)); c.markFired(r, d[0].at, at(15, 0));
  const until = c.snooze(r, '10 phút', at(15, 1)); assert.equal(until, at(15, 11).getTime()); assert.equal(r.on, true);
  assert.deepEqual(c.due([r], at(15, 10)), []);
  assert.equal(c.due([r], at(15, 11)).length, 1);
  assert.equal(c.snooze(rem({}), '1 giờ', at(10, 0)), at(11, 0).getTime());
  assert.equal(c.snooze(rem({}), 'Sáng mai 08:00', at(20, 0)), at(8, 0, 4).getTime());
  assert.deepEqual(c.due([rem({ on: false }), rem({ time: '25:61' }), rem({ time: 'abc' })], at(16, 0)), []);
});

test('quiet hours handle a window that wraps midnight', () => {
  assert.equal(c.quiet(at(23, 0), '22:00', '07:00'), true);
  assert.equal(c.quiet(at(6, 59), '22:00', '07:00'), true);
  assert.equal(c.quiet(at(7, 0), '22:00', '07:00'), false);
  assert.equal(c.quiet(at(12, 0), '22:00', '07:00'), false);
  assert.equal(c.quiet(at(13, 0), '12:00', '14:00'), true);
});
