'use strict';
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const test = require('node:test');
const wd = require('../lib/features/watchdog');

const MARK = '__tw_watchdog__';
const posix = { skip: process.platform === 'win32' };
// `sleep` rejects extra arguments on macOS, so idle node processes carry the marker words instead.
const idle = (...tags) => cp.spawn(process.execPath, ['-e', 'setTimeout(function(){},30000)', ...tags], { stdio: 'ignore' });

test('cleanRules keeps well-formed rules, drops the rest and falls back to defaults', () => {
  assert.equal(wd.cleanRules(undefined), wd.DEFAULT_RULES);
  const out = wd.cleanRules([{ id: 'ok', severity: 'warn', title: 't', argsRegex: 'x' }, { id: 'bad id', severity: 'warn', title: 't' }, { id: 'sev', severity: 'nope', title: 't' }, null, { id: 'long', severity: 'info', title: 't', argsRegex: 'a'.repeat(300) }]);
  assert.deepEqual(out.map((r) => r.id), ['ok', 'long']); assert.equal(out[1].argsRegex, undefined);
});

test('flags a process whose command line matches a rule and ignores the scanner itself', posix, async () => {
  const child = idle('twdogneedle');
  try {
    const rules = wd.cleanRules([{ id: 'needle', severity: 'urgent', title: 'needle', argsRegex: 'twdogneedle' }]);
    const out = await wd.scanRuntime()({ rules, mark: MARK });
    assert.deepEqual(out.found.map((f) => [f.rule, f.pid]), [['needle', child.pid]]);
  } finally { child.kill(); }
});

test('unlessRegex excuses a process and count rules fire only above the limit', posix, async () => {
  const kids = [1, 2, 3].map((i) => idle('twcnt' + i));
  try {
    const excused = await wd.scanRuntime()({ rules: wd.cleanRules([{ id: 'u', severity: 'warn', title: 't', argsRegex: 'twcnt1', unlessRegex: 'setTimeout' }]), mark: MARK });
    assert.deepEqual(excused.found, []);
    const below = await wd.scanRuntime()({ rules: wd.cleanRules([{ id: 'c', severity: 'warn', title: 't', countRegex: 'twcnt', maxCount: 3 }]), mark: MARK });
    assert.deepEqual(below.found, []);
    const above = await wd.scanRuntime()({ rules: wd.cleanRules([{ id: 'c', severity: 'warn', title: 't', countRegex: 'twcnt', maxCount: 2 }]), mark: MARK });
    assert.equal(above.found.length, 3);
  } finally { kids.forEach((k) => k.kill()); }
});

test('a signal is sent only when pid and command line still match, and freeze/resume work', posix, async () => {
  const child = idle('twsig'), args = [process.execPath, '-e', 'setTimeout(function(){},30000)', 'twsig'].join(' ');
  try {
    const stale = await wd.scanRuntime()({ rules: [], mark: MARK, signal: { pid: child.pid, args: 'something else', name: 'STOP' } });
    assert.equal(stale.sent, false);
    const ok = await wd.scanRuntime()({ rules: [], mark: MARK, signal: { pid: child.pid, args, name: 'STOP' } });
    assert.equal(ok.sent, true);
    const state = cp.execFileSync('ps', ['-o', 'stat=', '-p', String(child.pid)], { encoding: 'utf8' }).trim();
    assert.match(state, /^T/);
    assert.equal((await wd.scanRuntime()({ rules: [], mark: MARK, signal: { pid: child.pid, args, name: 'CONT' } })).sent, true);
  } finally { child.kill('SIGKILL'); }
});
