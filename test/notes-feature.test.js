'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const notes = require('../lib/features/notes');

test('clean keeps valid data and drops oversized, malformed or orphaned entries', () => {
  const doc = notes.clean({
    notes: [{ id: 'n1', title: 'T'.repeat(500), text: 'x', pet: 'dog' }, { id: 'bad id', title: 'x' }, { id: 'n2', pet: '../x' }],
    reminders: [{ id: 'r1', noteId: 'n1', time: '15:00', title: 'a', daily: 1, link: 'evil' }, { id: 'r2', noteId: 'ghost', time: '15:00' }, { id: 'r3', noteId: 'n1', time: '25:00' }, { id: 'r4', noteId: 'n1', time: '09:30', on: false, snoozeUntil: 5 }],
    settings: { bell: false, sound: true, snooze: 'whenever', current: 'ghost' } });
  assert.equal(doc.notes.length, 2); assert.equal(doc.notes[0].title.length, 120); assert.equal(doc.notes[0].pet, 'dog'); assert.equal(doc.notes[1].pet, '');
  assert.deepEqual(doc.reminders.map((r) => r.id), ['r1', 'r4']);
  assert.equal(doc.reminders[0].daily, true); assert.equal(doc.reminders[0].link, 'note'); assert.equal(doc.reminders[1].on, false); assert.equal(doc.reminders[1].snoozeUntil, 5);
  assert.deepEqual(doc.settings, { bell: false, os: true, sound: true, quiet: true, snooze: '10 phút', current: '' });
  assert.deepEqual(notes.clean(null), { notes: [], reminders: [], settings: { bell: true, os: true, sound: false, quiet: true, snooze: '10 phút', current: '' } });
});

test('append adds to an existing .md/.txt inside the session directory and nothing else', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-notes-')); fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'TRACK.md'), '# Tracking'); fs.writeFileSync(path.join(dir, 'code.js'), 'x');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-out-')); fs.writeFileSync(path.join(outside, 'o.md'), 'o');
  const run = notes.appendRuntime();
  const ok = await run({ cwd: dir, path: 'sub/TRACK.md', text: '- nhắc việc\n' });
  assert.equal(ok.ok, true); assert.equal(fs.readFileSync(path.join(dir, 'sub', 'TRACK.md'), 'utf8'), '# Tracking\n- nhắc việc\n');
  await run({ cwd: dir, path: 'sub/TRACK.md', text: 'dòng 2' });
  assert.equal(fs.readFileSync(path.join(dir, 'sub', 'TRACK.md'), 'utf8'), '# Tracking\n- nhắc việc\ndòng 2\n');
  for (const [p, re] of [['new.md', /chưa tồn tại/], ['code.js', /\.md hoặc \.txt/], [path.join(outside, 'o.md'), /ngoài thư mục/], ['../' + path.basename(outside) + '/o.md', /ngoài thư mục/], ['', /không hợp lệ/]])
    assert.match((await run({ cwd: dir, path: p, text: 'x' })).error, re);
  assert.match((await run({ cwd: dir, path: 'sub/TRACK.md', text: 'x'.repeat(61000) })).error, /quá dài/);
  assert.match((await run({ cwd: dir, path: 'sub/TRACK.md', text: '' })).error, /quá dài/);
  assert.equal(fs.existsSync(path.join(dir, 'new.md')), false); assert.equal(fs.readFileSync(path.join(outside, 'o.md'), 'utf8'), 'o');
});
