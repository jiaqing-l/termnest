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

function project(f, home) { const cwd = fs.realpathSync(f.root), proj = path.join(home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-')); fs.mkdirSync(proj, { recursive: true }); return { cwd, proj }; }
const LINES = ['Pipeline #35884 hong dung mot job host_migration_link', 'Cong nay doi nhan host-migration-follows hoac link toi MR'];

test('two sessions in one folder are told apart by what is on their screen', async () => {
  const f = fixture(), home = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-crew-home-')), { cwd, proj } = project(f, home);
  fs.writeFileSync(path.join(proj, 'a.jsonl'), JSON.stringify({ text: LINES.join(' ') + ' and bash scripts/crew/crew-task.sh status 20261103-idle-pending' }) + '\n');
  fs.writeFileSync(path.join(proj, 'b.jsonl'), JSON.stringify({ text: 'something else entirely, about bash scripts/crew/crew-dispatch.sh 20261102-sv-perf' }) + '\n');
  const mine = await crew.crewRuntime()({ cwd, home, needles: LINES });
  assert.equal(mine.linked, 'match');
  assert.deepEqual(mine.tasks.filter((t) => t.mentioned).map((t) => t.task), ['20261103-idle-pending']);
  const other = await crew.crewRuntime()({ cwd, home, needles: ['unrelated sentence that appears nowhere', 'another unrelated sentence here too'] });
  assert.equal(other.linked, 'none'); assert.ok(other.tasks.every((t) => !t.mentioned));
});

test('a tie between transcripts, or one weak hit, is unknown rather than a guess', async () => {
  const f = fixture(), home = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-crew-home-')), { cwd, proj } = project(f, home);
  for (const n of ['a', 'b']) fs.writeFileSync(path.join(proj, n + '.jsonl'), LINES.join(' ') + ' bash scripts/crew/crew-task.sh status 20261103-idle-pending\n');
  assert.equal((await crew.crewRuntime()({ cwd, home, needles: LINES })).linked, 'none');
  fs.unlinkSync(path.join(proj, 'b.jsonl'));
  assert.equal((await crew.crewRuntime()({ cwd, home, needles: [LINES[0]] })).linked, 'none');
});

test('the transcript named after the session id wins without needing the screen', async () => {
  const f = fixture(), home = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-crew-home-')), { cwd, proj } = project(f, home);
  fs.writeFileSync(path.join(proj, 'mine-id.jsonl'), 'worked on bash scripts/crew/crew-task.sh status 20261103-idle-pending\n');
  fs.writeFileSync(path.join(proj, 'newer.jsonl'), 'talking about bash scripts/crew/crew-task.sh status 20261102-sv-perf\n');
  const out = await crew.crewRuntime()({ cwd, home, claudeId: 'mine-id' });
  assert.equal(out.linked, 'exact'); assert.deepEqual(out.tasks.filter((t) => t.mentioned).map((t) => t.task), ['20261103-idle-pending']);
});

test('without any transcript nothing is claimed as mentioned', async () => {
  const f = fixture(), out = await crew.crewRuntime()({ cwd: f.sub, home: fs.mkdtempSync(path.join(os.tmpdir(), 'tw-nohome-')), needles: LINES });
  assert.equal(out.linked, 'none'); assert.ok(out.tasks.every((t) => !t.mentioned));
});

test('screen lines become needles: real sentences only, never the CLI chrome', () => {
  const backend = { snapshot: { sessions: [{ name: 's', lines: ['  Chế độ tự gộp đã đặt trên MR #170 sẽ chạy ngay khi pipeline xanh.', '✻ Sautéed for 4m 30s · done 7:21 PM · 2 shells still running', '──────────────', '  ⏵⏵ auto mode on (shift+tab to cycle)', 'short', '  ❯ ● until [ -s /tmp/claude-0/x ]   running'] }] } };
  assert.deepEqual(crew.needlesOf(backend, 's'), ['Chế độ tự gộp đã đặt trên MR #170 sẽ chạy ngay khi pipeline xanh.']);
  assert.deepEqual(crew.needlesOf(backend, 'nope'), []);
});

const cpx = require('node:child_process');
const hasTmux = process.platform !== 'win32' && cpx.spawnSync('tmux', ['-V']).status === 0;
test('needles are read from the live tmux scrollback of the named session', { skip: !hasTmux }, async () => {
  const sock = 'twcrew' + process.pid, f = fixture(), home = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-crew-home-')), { cwd, proj } = project(f, home);
  const lines = ['Pipeline thirty five failed exactly one job named host_migration_link', 'The gate asks for host-migration-follows label on the merge request'];
  fs.writeFileSync(path.join(proj, 'a.jsonl'), lines.join(' ') + ' bash scripts/crew/crew-task.sh status 20261103-idle-pending\n');
  fs.writeFileSync(path.join(proj, 'b.jsonl'), 'talking about bash scripts/crew/crew-task.sh status 20261102-sv-perf only\n');
  try {
    cpx.execFileSync('tmux', ['-L', sock, 'new-session', '-d', '-s', 'sess1', '-x', '200', '-y', '40', `printf '%s\\n' ${lines.map((l) => `'${l}'`).join(' ')}; sleep 30`]);
    await new Promise((r) => setTimeout(r, 500));
    const out = await crew.crewRuntime()({ cwd, home, session: 'sess1', socket: sock });
    assert.equal(out.linked, 'match'); assert.deepEqual(out.tasks.filter((t) => t.mentioned).map((t) => t.task), ['20261103-idle-pending']);
  } finally { cpx.spawnSync('tmux', ['-L', sock, 'kill-server']); }
});

test('merely reading about a task is not working on it', async () => {
  const f = fixture(), home = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-crew-home-')), { cwd, proj } = project(f, home);
  fs.writeFileSync(path.join(proj, 'a.jsonl'), 'I read the tracker of 20261103-idle-pending and 20261102-sv-perf but ran nothing\n');
  const out = await crew.crewRuntime()({ cwd, home, claudeId: 'a' });
  assert.equal(out.linked, 'exact'); assert.ok(out.tasks.every((t) => !t.mentioned));
});
