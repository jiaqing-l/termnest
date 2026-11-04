'use strict';
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const h = require('../lib/features/handoff');

const NOW = 1_800_000_000_000, H = 3600000;
const crew = (stateAt, extra = {}) => ({ root: '/ws', stateFiles: [{ path: 'docs/Implementation/SV/16-IMPLEMENTATION-TRACKING.md', at: stateAt, mentions: 3 }, { path: 'docs/Implementation/SV/00-INDEX.md', at: stateAt - H, mentions: 1 }], tasks: [{ task: 't1', mentioned: true, tracks: [{ id: 'W0', state: 'merged' }, { id: 'W1', state: 'done' }] }], ...extra });
const repo = (dirty, commitsAfter = 0) => ({ repos: [{ root: 'docs', branch: 'develop', dirty, dirtyTotal: dirty.length, commitsAfter }] });
const level = (r, id) => (r.checks.find((c) => c.id === id) || {}).level;

test('a fresh snapshot with nothing newer lets a new session open and hands over the snapshot, index and crew manifest', () => {
  const r = h.evaluate({ crew: crew(NOW - 600000), facts: { git: repo([]), screen: { shells: 0, last: '' } }, now: NOW });
  assert.equal(r.canOpen, true); assert.equal(r.needsSnapshot, false); assert.equal(level(r, 'snapshot'), 'ok');
  assert.deepEqual(r.files, ['docs/Implementation/SV/16-IMPLEMENTATION-TRACKING.md', 'docs/Implementation/SV/00-INDEX.md', '_crew/tasks/t1/MANIFEST.md']);
});

test('no snapshot at all, or one older than later edits or commits, blocks opening and asks for a snapshot first', () => {
  const none = h.evaluate({ crew: { root: '/ws', stateFiles: [], tasks: [] }, facts: { git: { repos: [] }, screen: {} }, now: NOW });
  assert.equal(none.canOpen, false); assert.equal(level(none, 'snapshot'), 'bad');
  const edited = h.evaluate({ crew: crew(NOW - 3 * H), facts: { git: repo([{ path: 'x.cs', at: NOW - H, state_file: false }]), screen: {} }, now: NOW });
  assert.equal(edited.needsSnapshot, true); assert.match(edited.checks[0].detail, /1 file sửa thêm/);
  const committed = h.evaluate({ crew: crew(NOW - 3 * H), facts: { git: repo([], 2), screen: {} }, now: NOW });
  assert.equal(committed.needsSnapshot, true); assert.match(committed.checks[0].detail, /2 commit mới/);
  const own = h.evaluate({ crew: crew(NOW - 3 * H), facts: { git: repo([{ path: 'docs/Implementation/SV/16-IMPLEMENTATION-TRACKING.md', at: NOW - H, state_file: true }]), screen: {} }, now: NOW });
  assert.equal(own.canOpen, true, 'editing the snapshot itself is not a newer change');
});

test('running crew tracks, background shells, unrelated dirty files and a pending question are warnings, not blockers', () => {
  const c = crew(NOW - 600000, { tasks: [{ task: 't1', mentioned: true, tracks: [{ id: 'W1', state: 'dispatched' }, { id: 'W2', state: 'merged' }] }] });
  const r = h.evaluate({ crew: c, facts: { git: repo([{ path: 'a.md', at: NOW - 2 * H, state_file: false }]), screen: { shells: 2, last: 'Bạn muốn làm phần nào?' } }, now: NOW });
  assert.equal(r.canOpen, true);
  assert.deepEqual(['crew', 'git', 'shells', 'question'].map((id) => level(r, id)), ['warn', 'warn', 'warn', 'warn']);
});

test('the prompt is one line under the limit, keeps the instructions and cuts the last message first', () => {
  const git = repo([{ path: 'docs/a.md' }, { path: 'docs/b.md' }]); git.repos[0].dirtyTotal = 2;
  const p = h.buildPrompt({ files: ['docs/x/16-TRACKING.md', '_crew/tasks/t1/MANIFEST.md'], git, last: 'Bạn muốn làm phần nào?\nHay "B"?\u0007' });
  assert.ok(!/[\x00-\x1f\x7f]/.test(p)); assert.ok(p.length <= h.MAX_PROMPT);
  assert.match(p, /^Đọc theo thứ tự, không dựng lại từ trí nhớ: docs\/x\/16-TRACKING\.md; _crew\/tasks\/t1\/MANIFEST\.md\./);
  assert.match(p, /Đối chiếu git status.*docs: nhánh develop, 2 file chưa commit \(docs\/a\.md, docs\/b\.md\)/); assert.match(p, /Tin nhắn cuối của phiên cũ: "Bạn muốn làm phần nào\? Hay "B"\?"/);
  const long = h.buildPrompt({ files: ['f.md'], git, last: 'x'.repeat(5000) });
  assert.ok(long.length <= h.MAX_PROMPT); assert.match(long, /Đối chiếu git status/); assert.match(long, /…x+"$/);
  assert.doesNotMatch(h.buildPrompt({ files: [], git: { repos: [] }, last: '' }), /Tin nhắn cuối/);
  assert.ok(h.SNAPSHOT_PROMPT.length <= h.MAX_PROMPT && !/[\x00-\x1f]/.test(h.SNAPSHOT_PROMPT));
});

test('tool is guessed from the running command or the screen, defaulting to Claude', () => {
  assert.equal(h.guessTool({ cmd: 'claude', lines: [] }), 'claude'); assert.equal(h.guessTool({ cmd: 'node', lines: ['GPT-6.1-Sol · Ask Codex to do anything'] }), 'codex'); assert.equal(h.guessTool(null), 'claude');
});

const hasGit = cp.spawnSync('git', ['--version']).status === 0;
test('facts read the repos of the state files, ignore the snapshot itself and count only commits that changed other files', { skip: !hasGit }, async () => {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tw-handoff-'))), docs = path.join(ws, 'docs'); fs.mkdirSync(docs);
  const git = (date, ...a) => cp.execFileSync('git', ['-C', docs, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  const OLD = '2020-01-01T00:00:00Z', NEW = new Date().toISOString();
  git(OLD, 'init', '-q', '-b', 'develop'); fs.writeFileSync(path.join(docs, 'snap.md'), '1'); fs.writeFileSync(path.join(docs, 'code.md'), '1'); git(OLD, 'add', '.'); git(OLD, 'commit', '-qm', 'init');
  const since = Date.now() - 3600000;
  fs.writeFileSync(path.join(docs, 'snap.md'), '2'); git(NEW, 'commit', '-qam', 'snapshot only'); fs.writeFileSync(path.join(docs, 'code.md'), '2'); git(NEW, 'commit', '-qam', 'real change'); fs.writeFileSync(path.join(docs, 'new.md'), 'x'); fs.writeFileSync(path.join(docs, 'snap.md'), '3');
  const out = await h.factsRuntime()({ cwd: ws, session: '', sinceMs: since, ignore: [path.join(docs, 'snap.md')], dirs: [docs], home: ws });
  assert.equal(out.git.ok, true); assert.equal(out.git.repos.length, 1);
  const g = out.git.repos[0]; assert.equal(g.root, 'docs'); assert.equal(g.branch, 'develop'); assert.equal(g.commitsAfter, 1);
  assert.deepEqual(g.dirty.map((d) => [d.path, d.state_file]).sort(), [['docs/new.md', false], ['docs/snap.md', true]]);
  assert.equal(g.commits.length, 3); assert.equal(h.gitSummary(out.git).dirtyTotal, 2);
});

test('without a repo the git block is empty and nothing throws', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-nogit-'));
  const out = await h.factsRuntime()({ cwd: dir, session: '', home: dir });
  assert.equal(out.git.ok, false); assert.deepEqual(out.screen, { shells: 0, last: '' }); assert.equal(out.baseline, null);
});

test('the last message ignores Codex and Claude footer lines (needs tmux to read a screen)', { skip: process.platform === 'win32' || cp.spawnSync('tmux', ['-V']).status !== 0 }, async () => {
  const sock = 'twho' + process.pid, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-ho-screen-'));
  try {
    cp.execFileSync('tmux', ['-L', sock, 'new-session', '-d', '-s', 's1', '-x', '160', '-y', '30', `printf '%s\\n' 'Đã sửa xong hai file và chạy test thành công.' 'Bạn muốn làm phần nào tiếp theo?' '› Ask Codex to do anything' 'GPT-6.1-Sol medium · ~/work/proj' '2 shells still running'; sleep 30`]);
    await new Promise((r) => setTimeout(r, 500));
    const out = await h.factsRuntime()({ cwd: dir, session: 's1', socket: sock, home: dir });
    assert.equal(out.screen.last, 'Đã sửa xong hai file và chạy test thành công. Bạn muốn làm phần nào tiếp theo?'); assert.equal(out.screen.shells, 2);
  } finally { cp.spawnSync('tmux', ['-L', sock, 'kill-server']); }
});
