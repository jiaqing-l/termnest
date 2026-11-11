'use strict';
// The agent-status part of the poll (one awk per kind of file) reads Claude session files, Claude background jobs and
// Codex rollouts into exactly the lines parsePoll understands — on whatever awk the host has (mawk, gawk, BSD awk, busybox).
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), { execFileSync } = require('child_process');
const { POLL_SCRIPT, parsePoll } = require('../lib/parse');

const section = (name) => POLL_SCRIPT.split('\n').find((l) => l.startsWith("echo '@@" + name + "'"));
const run = (home, script) => execFileSync('/bin/sh', ['-c', script], { env: { HOME: home, PATH: process.env.PATH }, encoding: 'utf8' });

test('Claude session files: ids, status fields and the profile folder, same format as before', { skip: process.platform === 'win32' }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-poll-'));
  try {
    const dir = path.join(home, '.claude-work', 'sessions'); fs.mkdirSync(dir, { recursive: true });
    const pid = process.pid; // alive, so kill -0 keeps it
    fs.writeFileSync(path.join(dir, pid + '.json'), JSON.stringify({ pid, sessionId: '0f1e2d3c-aaaa-bbbb-cccc-123456789abc', cwd: '/work/shop portal', startedAt: 1700000000000,
      kind: 'interactive', status: 'waiting', statusUpdatedAt: 1700000005000, waitingFor: 'permission: Bash(rm -rf x)', name: 'Billing API' }));
    fs.writeFileSync(path.join(dir, '999999.json'), JSON.stringify({ sessionId: 'dead', status: 'busy' })); // no such process
    const out = run(home, section('AGENTIDS'));
    assert.match(out, new RegExp('^claude ' + pid + ' 0f1e2d3c-aaaa-bbbb-cccc-123456789abc /work/shop portal$', 'm'));
    assert.match(out, new RegExp('^claudestat ' + pid + ' interactive waiting 1700000005000 permission:_Bash_rm_-rf_x_ 0 1700000000000 .claude-work Billing API$', 'm'));
    assert.doesNotMatch(out, /999999/);
    // A profile kept in ~/.config (another machine layout) is reported by its real place below HOME.
    const other = path.join(home, '.config', 'claude-technology', 'sessions'); fs.mkdirSync(other, { recursive: true });
    fs.renameSync(path.join(dir, pid + '.json'), path.join(other, pid + '.json'));
    assert.match(run(home, section('AGENTIDS')), new RegExp('^claudestat ' + pid + ' interactive waiting \\d+ \\S+ 0 \\d+ .config/claude-technology Billing API$', 'm'));
    const st = parsePoll('@@AGENTIDS\n' + run(home, section('AGENTIDS')) + '@@END\n', 1700000010);
    assert.ok(st);
    const snap = parsePoll('@@AGENTIDS\n' + out + '@@END\n', 1700000010);
    assert.ok(snap);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('Claude background jobs: one "@@J id" per job, then its key/value pairs in file order', { skip: process.platform === 'win32' }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-poll-'));
  try {
    const job = path.join(home, '.claude', 'jobs', 'ab12cd34'); fs.mkdirSync(job, { recursive: true });
    fs.writeFileSync(path.join(job, 'state.json'), '{\n  "state": "blocked",\n  "tempo": "blocked",\n  "tasks": 2,\n  "needs": "Anh chọn cách nào?",\n  "name": "Mockup"\n}\n');
    const out = run(home, section('JOBS'));
    assert.equal(out, '@@JOBS\n@@J ab12cd34\n"state": "blocked"\n"tempo": "blocked"\n"tasks": 2\n"needs": "Anh chọn cách nào?"\n"name": "Mockup"\n');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('Codex rollouts: mtime, start time (2nd timestamp), last turn event, file and folder', { skip: process.platform === 'win32' }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-poll-'));
  try {
    const day = path.join(home, '.codex', 'sessions', '2026', '11', '10'); fs.mkdirSync(day, { recursive: true });
    const f = path.join(day, 'rollout-2026-11-10T09-00-00-abc.jsonl');
    fs.writeFileSync(f, JSON.stringify({ timestamp: '2026-11-10T02:00:01Z', type: 'session_meta', payload: { timestamp: '2026-11-10T02:00:00Z', cwd: '/work/app' } }) + '\n' +
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }) + '\n' + JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }) + '\n');
    const t = new Date('2026-11-10T02:05:00Z'); fs.utimesSync(f, t, t);
    // Only the rollout part, as if one Codex process was found.
    const a = section('AGENTIDS'), rolls = 'cx=1;' + a.slice(a.indexOf(' if [ -n "$cx" ]'));
    const out = run(home, rolls).split('\n').filter((l) => l.startsWith('codexroll '));
    assert.deepEqual(out, ['codexroll ' + Math.floor(t / 1000) + ' 2026-11-10T02:00:00Z task_complete rollout-2026-11-10T09-00-00-abc.jsonl /work/app']);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
