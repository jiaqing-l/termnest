'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBackend, localConfig } = require('../lib/backends');
const { Local, selectMode, bootId, psQuote } = require('../lib/local');
const { Remote } = require('../lib/remote');
const { syncKnown, mergePrefs, cleanPrefs, shq } = require('../lib/parse');
test('local backend is explicit and SSH accounts still use Remote', () => {
  assert.ok(createBackend(localConfig()) instanceof Local);
  assert.ok(createBackend({ id: 'ssh', auth: 'key' }) instanceof Remote);
  assert.equal(localConfig().host, require('os').hostname());
});
test('Windows selects runnable WSL or PowerShell; Unix stays native', async () => {
  const calls = [];
  const probe = async (file, args) => { calls.push([file, args]); return { code: 0 }; };
  assert.equal(await selectMode('win32', probe), 'wsl');
  assert.deepEqual(calls[0], ['wsl.exe', ['--exec', 'sh', '-c', 'true']]);
  assert.equal(await selectMode('win32', async () => ({ code: 1 })), 'powershell');
  assert.equal(await selectMode('darwin', () => { throw Error('unexpected probe'); }), 'native');
});
test('boot identity uses stable OS boot data and refuses an invented fallback', async () => {
  assert.equal(await bootId('darwin', async () => ({ code: 0, out: 'AB34EF13-F8D2-4483-B8A3-520D1E5353EF\n' })), 'darwin:AB34EF13-F8D2-4483-B8A3-520D1E5353EF');
  assert.equal(await bootId('linux', async () => ({ code: 0, out: 'abc-def\n' })), 'linux:abc-def');
  assert.equal(await bootId('win32', async () => ({ code: 0, out: '2026-11-01T00:00:00Z\r\n' })), 'win32:2026-11-01T00:00:00Z');
  assert.equal(await bootId('darwin', async () => ({ code: 1, out: '' })), '');
});
test('restore survives reboot, repeated polls, serialization and keeps Codex intent', () => {
  const old = { bootId: 'one', sessions: { agent: { dir: '/tmp', run: 'codex' } } };
  const next = syncKnown(old, 'two', []).record;
  assert.deepEqual(next.lost, ['agent']);
  assert.deepEqual(syncKnown(JSON.parse(JSON.stringify(next)), 'two', []).record, next);
  assert.deepEqual(syncKnown(next, 'two', [{ name: 'agent', path: '/tmp', cmd: 'codex' }]).record.lost, []);
  assert.equal(syncKnown(null, 'two', [{ name: 'agent', path: '/tmp', cmd: 'codex' }]).record.sessions.agent.run, 'codex');
});
test('auto restore defaults off and only accepts boolean; templates accept Codex', () => {
  assert.equal(mergePrefs().autoRestoreLocal, false);
  assert.equal(cleanPrefs({ autoRestoreLocal: true }).autoRestoreLocal, true);
  assert.throws(() => cleanPrefs({ autoRestoreLocal: 'yes' }));
  assert.equal(cleanPrefs({ templates: [{ name: 'agent', dir: '', run: 'codex' }] }).templates[0].run, 'codex');
});
test('local command uses argument array and existing shell quoting preserves hostile path', {skip:process.platform==='win32' ? 'Native Unix backend requires /bin/sh; Windows WSL and PowerShell have separate coverage' : false}, async () => {
  const r = new Local(localConfig()); r.ready = true; r.mode = 'native';
  const value = "Tiếng Việt ' ; $(echo unsafe) `echo unsafe`";
  const result = await r.exec(`printf %s ${shq(value)}`);
  assert.equal(result.out, value); assert.equal(result.code, 0);
  r.close();
});
test('local uses WSL arguments and keeps private socket out of user command text', async () => {
  const calls = [];
  const r = new Local(localConfig(), null, null, { command: async (...args) => { calls.push(args); return { code: 0, out: '' }; } });
  r.ready = true; r.mode = 'wsl'; r.socket = "private'quoted";
  await r.exec('printf %s safe');
  assert.equal(calls[0][0], 'wsl.exe');
  assert.deepEqual(calls[0][1].slice(0, 3), ['--exec', 'sh', '-c']);
  assert.ok(calls[0][1][3].includes(shq(r.socket)));
});
test('SSH attach command and PTY shape are preserved', () => {
  const r = new Remote({}, () => {});
  r.client = { exec: (...args) => {
    assert.equal(args[0], `${require('../lib/backend').windowSizeCmd('safe')}; tmux -u attach-session -t '=safe'`);   // single command: option (when unset) + attach
    assert.deepEqual(args[1], { pty: { term: 'xterm-256color', cols: 80, rows: 24 } });
    args[2](null, 'ssh-channel');
  } };
  r.attach('safe', 80, 24, (err, stream) => { assert.equal(err, null); assert.equal(stream, 'ssh-channel'); });
});
test('Codex recovery only uses verified resume picker, never unrelated --last session', async () => {
  const r = new Local(localConfig());
  r.exec = async () => ({ code: 0, out: 'Usage: codex resume [OPTIONS] [SESSION_ID]' });
  assert.equal(await r.codexLaunch(false), 'codex');
  assert.equal(await r.codexLaunch(true), 'codex resume');
  r.exec = async () => ({ code: 1, out: 'unrecognized command' });
  assert.equal(await r.codexLaunch(true), 'codex');
});
test('terminal adapter preserves split UTF-8 input and UTF-8 output; detaching plain session does not kill it', () => {
  const { terminalStream } = require('../lib/local');
  let onData, input = '', killed = false, size;
  const terminal = { onData: fn => { onData = fn; return { dispose() {} }; }, onExit: () => ({ dispose() {} }),
    write: text => { input += text; }, resize: (cols, rows) => { size = [cols, rows]; }, kill: () => { killed = true; } };
  const s = terminalStream(terminal, false);
  const bytes = Buffer.from('Tiếng Việt');
  for (const byte of bytes) s.write(Buffer.from([byte]));
  assert.equal(input, 'Tiếng Việt');
  s.on('data', b => assert.equal(b.toString('utf8'), 'Tiếng Việt'));
  onData('Tiếng Việt'); s.setWindow(30, 100); assert.deepEqual(size, [100, 30]);
  s.close(); assert.equal(killed, false);
  terminalStream(terminal).close(); assert.equal(killed, true);
});
test('PowerShell fallback owns sessions until tool close, validates cwd without shell interpolation', async () => {
  let spawnArgs, killed = 0;
  const r = new Local(localConfig(), null, () => {}, { platform: 'win32', pty: () => ({ spawn: (...args) => {
    spawnArgs = args; return { onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), kill: () => { killed++; } };
  } }) });
  r.mode = 'powershell'; r.ready = true; r.boot = 'windows:boot';
  const cwd = await r.startPlain({ name: 'plain', dir: require('os').tmpdir(), run: 'shell' });
  assert.equal(spawnArgs[0], 'powershell.exe');
  assert.equal(spawnArgs[2].cwd, cwd);
  assert.ok(Buffer.from(spawnArgs[1].at(-1), 'base64').toString('utf16le').includes('UTF8Encoding'));
  await r.poll(); assert.equal(r.snapshot.sessions[0].name, 'plain');
  assert.equal(r.publicView().persistent, false);
  assert.match(r.publicView().guidance, /wsl --install/);
  r.close(); assert.equal(killed, 1); assert.equal(r.plain.size, 0);
});
test('missing tmux remains visible with installation guidance on each platform', async () => {
  for (const [platform, mode, guidance] of [['darwin', 'native', /brew install tmux/], ['linux', 'native', /apt install tmux/], ['win32', 'wsl', /WSL/]]) {
    const r = new Local(localConfig(), null, () => {}, { platform });
    r.mode = mode; r.ready = true;
    r.exec = async () => ({ code: 0, out: '@@NOTMUX\n@@END\n' });
    await r.poll();
    assert.equal(r.publicView().hasTmux, false);
    assert.equal(r.publicView().on, true);
    assert.match(r.publicView().guidance, guidance);
  }
});
test('failed poll cannot replace the last good session list', async () => {
  const r = new Local(localConfig()); r.ready = true;
  r.snapshot = { sessions: [{ name: 'keep' }] };
  let persisted = false; r.onPoll = () => { persisted = true; };
  r.exec = async () => ({ code: 1, out: '' });
  await r.poll();
  assert.equal(r.snapshot.sessions[0].name, 'keep'); assert.equal(persisted, false);
});
test('concurrent PowerShell creation cannot leak a second process with the same name', async () => {
  let spawned = 0;
  const r = new Local(localConfig(), null, () => {}, { pty: () => ({ spawn: () => {
    spawned++; return { onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), kill() {} };
  } }) });
  const options = { name: 'same', dir: require('os').tmpdir(), run: 'shell' };
  const results = await Promise.allSettled([r.startPlain(options), r.startPlain(options)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(spawned, 1); r.close();
});

test('PowerShell quoting preserves literal quotes and metacharacters on every host', () => {
  assert.equal(psQuote("a'b;$x"), "'a''b;$x'");
});
