'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rebootServer } = require('../lib/reboot');
const { Backend } = require('../lib/backend');
function fake(user = 'root') {
  const backend = new Backend({ id: 'fake', name: 'dev', user }, () => {});
  backend.ready = true;
  backend.snapshot = { bootId: 'boot-1', sys: { rebootRequired: true }, sessions: [], workers: [] };
  backend.calls = [];
  backend.exec = async cmd => { backend.calls.push(cmd); return { code: 0 }; };
  return backend;
}
test('root reboot uses a fixed command and records pending state', async () => {
  const b = fake();
  await rebootServer(b, 'dev');
  assert.deepEqual(b.calls, ['(sleep 1; reboot) </dev/null >/dev/null 2>&1 &']);
  assert.equal(b.publicView().rebooting, true);
});
test('sudo denial and transport failure clear pending state and give Vietnamese permission guidance', async () => {
  for (const result of [{ code: 1, err: 'sudo: a password is required' }, { code: undefined }, null]) {
    const b = fake('deploy');
    b.exec = async cmd => { assert.equal(cmd, 'sudo -n -l reboot >/dev/null 2>&1 || exit 1; (sleep 1; sudo -n reboot) </dev/null >/dev/null 2>&1 &'); if (!result) throw Error('connection lost'); return result; };
    await assert.rejects(() => rebootServer(b, 'dev'), /quyền root.*không cần mật khẩu/);
    assert.equal(b.publicView().rebooting, false);
  }
});
test('unready, unnecessary, missing boot ID and wrong-name requests execute nothing', async () => {
  for (const change of [b => { b.ready = false; }, b => { b.snapshot.sys.rebootRequired = false; }, b => { b.snapshot.bootId = ''; }, b => { b.cfg.name = 'other'; }]) {
    const b = fake(); change(b);
    await assert.rejects(() => rebootServer(b, 'dev'));
    assert.deepEqual(b.calls, []);
  }
});
test('pending reboot survives old polls and clears only on a successful new boot poll', async () => {
  const b = fake(); await rebootServer(b, 'dev');
  let boot = 'boot-1';
  b.exec = async () => ({ code: 0, out: '@@BOOT\n' + boot + '\n' });
  await b.poll(); assert.equal(b.publicView().rebooting, true);
  boot = 'boot-2';
  await b.poll(); assert.equal(b.snapshot.bootId, 'boot-2'); assert.equal(b.publicView().rebooting, false);
});

test('accepted detached reboot survives an immediate transport drop until a new boot poll', async () => {
  for (const user of ['root', 'deploy']) {
    const b = fake(user);
    b.exec = async command => {
      assert.equal(command, user === 'root'
        ? '(sleep 1; reboot) </dev/null >/dev/null 2>&1 &'
        : 'sudo -n -l reboot >/dev/null 2>&1 || exit 1; (sleep 1; sudo -n reboot) </dev/null >/dev/null 2>&1 &');
      // The detached shell acknowledges before the host drops SSH.
      const accepted = Promise.resolve({ code: 0 });
      accepted.then(() => { b.ready = false; });
      return accepted;
    };
    assert.deepEqual(await rebootServer(b, 'dev'), { ok: true });
    assert.equal(b.ready, false);
    assert.equal(b.publicView().rebooting, true);
    await b.poll();
    assert.equal(b.publicView().rebooting, true);
    b.ready = true;
    b.exec = async () => ({ code: 0, out: '@@BOOT\nboot-2\n' });
    await b.poll();
    assert.equal(b.publicView().rebooting, false);
  }
});
