'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const crew = require('../lib/features/crew');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-crew-')), sub = path.join(root, 'tools', 'app'); fs.mkdirSync(sub, { recursive: true });
  const task = (id, fm, tracks = {}) => {
    const d = path.join(root, '_crew', 'tasks', id); fs.mkdirSync(path.join(d, 'tracks'), { recursive: true });
    fs.writeFileSync(path.join(d, 'MANIFEST.md'), `---\ntask_id: ${id}\ntitle: ${JSON.stringify(fm.title).replace(/[^\x00-\x7f]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))}\nstatus: ${fm.status}\nupdated: 2026-11-03T10:00:00+07:00\ntracks: ${fm.tracks}\n---\n# body\n`);
    for (const [t, files] of Object.entries(tracks)) { fs.mkdirSync(path.join(d, 'tracks', t), { recursive: true }); for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(d, 'tracks', t, n), c); }
  };
  task('20261102-sv-perf', { title: 'SV perf tải ảnh Đặt', status: 'executing', tracks: '[{ id: W0, state: merged, executor: codex }, { id: W6, state: pending, executor: codex }, { id: W7, state: dispatched, executor: claude }]' },
    { W6: { QUEUED: 'ts=2026-11-03T10:38:12+07:00 reason=resources disk free 5.2 GB, need 6.3 GB\n' } });
  task('20260101-old-finished', { title: 'Old', status: 'done', tracks: '[{ id: W1, state: done, executor: codex }]' });
  task('20261103-empty', { title: 'No tracks', status: 'executing', tracks: '[]' });
  task('20261103-idle-pending', { title: 'Idle', status: 'executing', tracks: '[{ id: W1, state: pending, executor: codex }]' });
  const idle = new Date(Date.now() - 6 * 3600000); fs.utimesSync(path.join(root, '_crew', 'tasks', '20261103-idle-pending', 'MANIFEST.md'), idle, idle);
  const old = new Date(Date.now() - 5 * 86400000); fs.utimesSync(path.join(root, '_crew', 'tasks', '20260101-old-finished', 'MANIFEST.md'), old, old);
  return { root, sub };
}

test('finds the workspace root above the session directory and lists active tasks with sentinel states', async () => {
  const f = fixture(); const out = await crew.crewRuntime()({ cwd: f.sub });
  assert.equal(fs.realpathSync(out.root), fs.realpathSync(f.root));
  assert.deepEqual(out.tasks.map((t) => t.task), ['20261102-sv-perf']);
  const t = out.tasks[0]; assert.equal(t.title, 'SV perf tải ảnh Đặt'); assert.equal(t.status, 'executing');
  assert.deepEqual(t.tracks.map((x) => [x.id, x.state, x.executor]), [['W0', 'merged', 'codex'], ['W6', 'queued', 'codex'], ['W7', 'dispatched', 'claude']]);
  assert.match(t.tracks[1].reason, /^resources disk free/);
});

test('a directory without _crew, a bad path or a missing cwd yields nothing and never throws', async () => {
  const run = crew.crewRuntime(); const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-nocrew-'));
  assert.deepEqual(await run({ cwd: empty }), { root: '', tasks: [] });
  assert.deepEqual(await run({ cwd: 5 }), { root: '', tasks: [] });
  assert.deepEqual(await run({}), { root: '', tasks: [] });
});

test('track and task names are validated before anything reaches a shell', () => {
  for (const ok of ['W6', 'C0', '20261102-sv-perf']) assert.ok(crew.COMPONENT.test(ok));
  for (const bad of ['', '../x', 'a b', 'a;rm', '$(x)', '-x']) assert.ok(!crew.COMPONENT.test(bad));
});

test('a task the session talked about is shown even when idle; others stay hidden', async () => {
  const f = fixture(), home = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-crew-home-')), cwd = fs.realpathSync(f.root);
  const proj = path.join(home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-')); fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'other.jsonl'), JSON.stringify({ text: 'worked on 20261103-idle-pending today' }) + '\n');
  const out = await crew.crewRuntime()({ cwd, home });
  assert.equal(out.linked, 'guess');
  assert.deepEqual(out.tasks.map((t) => [t.task, t.mentioned]).sort(), [['20261102-sv-perf', false], ['20261103-idle-pending', true]]);
});

test('the transcript named after the session id wins over the newest one in the folder', async () => {
  const f = fixture(), home = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-crew-home-')), cwd = fs.realpathSync(f.root);
  const proj = path.join(home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-')); fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'mine-id.jsonl'), 'no tasks mentioned here\n');
  const later = new Date(Date.now() + 5000); fs.writeFileSync(path.join(proj, 'newer.jsonl'), 'talking about 20261103-idle-pending\n'); fs.utimesSync(path.join(proj, 'newer.jsonl'), later, later);
  const out = await crew.crewRuntime()({ cwd, home, claudeId: 'mine-id' });
  assert.equal(out.linked, 'exact');
  assert.ok(out.tasks.every((t) => !t.mentioned));
});

test('without any transcript nothing is claimed as mentioned', async () => {
  const f = fixture(), out = await crew.crewRuntime()({ cwd: f.sub, home: fs.mkdtempSync(path.join(os.tmpdir(), 'tw-nohome-')) });
  assert.equal(out.linked, 'none'); assert.ok(out.tasks.every((t) => !t.mentioned));
});
