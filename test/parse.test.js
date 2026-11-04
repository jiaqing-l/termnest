'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { claudeSessionId, classify, isAsking, isWorking, contentSignature, screenQuiet, findWorkers, parseDirs, parsePoll, shq, validDir, validHost, validName } = require('../lib/parse');
const { Vault } = require('../lib/vault');
const { friendlyError } = require('../lib/remote');

test('public assets use the TERMNEST display name', () => {
  const publicDir = path.join(__dirname, '..', 'public');
  const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    return entry.isDirectory() ? files(fullPath) : [fullPath];
  });
  for (const file of files(publicDir)) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /Tmux Web/, path.relative(publicDir, file));
  }
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  assert.match(html, /<title>TERMNEST<\/title>/);
  assert.match(html, /<img class="login-lockup" src="\/termnest-logo-oncolor\.svg" alt="TERMNEST · by JIAQING">/);
  assert.match(html, /<div class="brand" id="brand" aria-label="TERMNEST · by JIAQING"><img class="brand-lockup brand-light" src="\/termnest-logo\.svg" alt=""><img class="brand-lockup brand-dark" src="\/termnest-logo-dark\.svg" alt=""><img class="brand-mark" src="\/termnest-mark\.svg" alt=""><\/div>/);
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /'\/termnest-logo-dark\.svg': \[path\.join\(PUB, 'termnest-logo-dark\.svg'\), 'image\/svg\+xml'\]/);
  assert.match(html, /data-i18n="html\.tagline"/);
  assert.equal(require('../public/locales/en.json')['html.tagline'], 'It stays awake for you, so you can sleep soundly.');
  assert.equal(JSON.parse(fs.readFileSync(path.join(publicDir, 'manifest.webmanifest'))).name, 'TERMNEST');
});

test('shq keeps injected text inside one shell word', () => {
  assert.equal(shq("a'; rm -rf /; '"), `'a'\\''; rm -rf /; '\\'''`);
});

test('claudeSessionId is a stable UUID specific to the physical folder and session name', () => {
  const id = claudeSessionId('/work', 'build-api');
  assert.equal(id, claudeSessionId('/work', 'build-api'));
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(id, claudeSessionId('/other', 'build-api'));
  assert.notEqual(id, claudeSessionId('/work', 'other'));
  assert.notEqual(claudeSessionId('/a', 'bc'), claudeSessionId('/ab', 'c'));
});

test('parseDirs preserves spaces and newlines and sorts names ignoring case', () => {
  const r = parseDirs('/work space\n\0zebra\0Beta\0alpha folder\0two\nlines\0');
  assert.deepEqual(r, {
    path: '/work space', parent: '/',
    dirs: ['alpha folder', 'Beta', 'two\nlines', 'zebra'], truncated: false,
  });
});

test('parseDirs handles an empty folder and the root parent', () => {
  assert.deepEqual(parseDirs('/\n\0'), { path: '/', parent: null, dirs: [], truncated: false });
  assert.deepEqual(parseDirs('/a/b\n\0'), { path: '/a/b', parent: '/a', dirs: [], truncated: false });
  assert.equal(parseDirs('/a\n\n\0').path, '/a\n');
});

test('parseDirs sorts before capping the list at 500 folders', () => {
  const names = Array.from({ length: 501 }, (_, i) => 'dir-' + String(i).padStart(3, '0')).reverse();
  const r = parseDirs('/work\n\0' + names.join('\0') + '\0');
  assert.equal(r.dirs.length, 500);
  assert.equal(r.dirs[0], 'dir-000');
  assert.equal(r.dirs[499], 'dir-499');
  assert.equal(r.truncated, true);
  assert.equal(parseDirs('/work\n\0' + names.slice(1).join('\0') + '\0').truncated, false);
});

test('input rules reject what cannot be a name, path or host', () => {
  assert.ok(validName('build-api_1'));
  for (const bad of ['', 'a b', 'a;b', 'tên', 'a'.repeat(33), null]) assert.equal(validName(bad), false);
  assert.ok(validDir('/root/a b'));
  assert.ok(validDir(''));
  assert.equal(validDir('/a\nb'), false);
  assert.ok(validHost('192.0.2.10'));
  assert.equal(validHost('a b'), false);
  assert.equal(validHost('$(id)'), false);
});

test('classify tells waiting, idle and running apart', () => {
  assert.equal(classify({ cmd: 'bash', lines: ['root@x:~#'], activityAge: 500 }), 'idle');
  assert.equal(classify({ cmd: 'tail', lines: ['GET /health 200'], activityAge: 500 }), 'run');
  assert.equal(classify({ cmd: 'bash', lines: ['Tiếp tục? [y/N]'], activityAge: 1 }), 'wait');
  assert.equal(classify({ cmd: 'claude', lines: ['Đang build'], activityAge: 2 }), 'run');
  assert.equal(classify({ cmd: 'claude', lines: ['>'], activityAge: 60 }), 'wait');
  assert.equal(classify({ cmd: '2.1.3', lines: ['>'], activityAge: 60 }), 'wait');
});

test('classify waits when a shell question is the last non-empty line', () => {
  assert.equal(classify({ cmd: 'bash', lines: ['root@x:~# read answer', 'Proceed? (y/n)', '', '  '], activityAge: 1 }), 'wait');
});

test('classify ignores an answered shell question above a fresh prompt', () => {
  assert.equal(classify({ cmd: 'bash', lines: ['Proceed? (y/n) y', 'root@x:~#', ''], activityAge: 1 }), 'idle');
});

test('classify keeps a Claude question three lines up waiting', () => {
  assert.equal(classify({ cmd: 'claude', lines: ['Proceed? (y/n)', 'Choose an option', '>', ''], activityAge: 1 }), 'wait');
});

test('parsePoll reads every section and attaches pane lines', () => {
  const out = [
    '@@HOST', 'dev-1', '@@CPU', 'cpu  10 0 10 80 0 0 0 0 0 0',
    '@@MEM', 'MemTotal:       1000 kB', 'MemAvailable:    250 kB',
    '@@DISK', '/dev/vda1 100 50 50 58% /', '@@SESS',
    '$1|~|claude|~|1|~|100|~|190|~|bash|~|/root/a',
    '@@PANE $1', 'root@x:~#', '@@END',
  ].join('\n');
  const r = parsePoll(out, 200);
  assert.equal(r.hostname, 'dev-1');
  assert.equal(r.ram, 75);
  assert.equal(r.disk, 58);
  assert.deepEqual(r.cpuTicks, { idle: 80, total: 100 });
  assert.equal(r.sessions.length, 1);
  assert.equal(r.sessions[0].path, '/root/a');
  assert.equal(r.sessions[0].activityAge, 10);
  assert.deepEqual(r.sessions[0].lines, ['root@x:~#']);
  assert.equal(r.sessions[0].state, 'idle');
});

test('parsePoll reports a server without tmux', () => {
  const r = parsePoll('@@HOST\nx\n@@NOTMUX\n', 1);
  assert.equal(r.hasTmux, false);
  assert.deepEqual(r.sessions, []);
});

test('vault encrypts secrets and refuses a wrong password', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-'));
  const file = path.join(dir, 'vault.json');
  const v = new Vault(file);
  v.create('correct horse', { servers: [{ key: 'SECRET-KEY-TEXT' }] });
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('SECRET-KEY-TEXT'));
  // Windows stat mode bits do not represent NTFS ACLs.
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const w = new Vault(file);
  assert.equal(w.unlock('wrong'), false);
  assert.equal(w.unlocked, false);
  assert.equal(w.unlock('correct horse'), true);
  assert.equal(w.data.servers[0].key, 'SECRET-KEY-TEXT');
  fs.rmSync(dir, { recursive: true });
});

test('friendlyError gives plain messages', () => {
  assert.match(friendlyError(new Error('All configured authentication methods failed')), /Sai tài khoản/);
  assert.match(friendlyError(new Error('connect ECONNREFUSED 1.2.3.4:22')), /VPN/);
  assert.match(friendlyError(new Error('x'), true), /đổi khóa/);
});

test('findWorkers ties a detached worker to its dispatch and hides raw arguments', () => {
  const procs = [
    { pid: 10, ppid: 1, elapsed: 600, args: 'python3 gate.py bash scripts/crew/crew-dispatch.sh --task t1 --track W1 --detach' },
    { pid: 11, ppid: 10, elapsed: 590, args: 'bash scripts/crew/crew-dispatch.sh --task t1 --track W1' },
    { pid: 12, ppid: 11, elapsed: 580, args: 'timeout 3600 sh -c run' },
    { pid: 13, ppid: 12, elapsed: 570, args: 'node /usr/lib/bin/codex exec --token=SECRET do work' },
    { pid: 20, ppid: 1, elapsed: 30, args: 'claude --print hello' },
    { pid: 30, ppid: 1, elapsed: 900, args: 'claude --continue' },
    { pid: 31, ppid: 1, elapsed: 5, args: 'sh -c echo codex exec claude --print crew-dispatch.sh' },
  ];
  const w = findWorkers(procs, new Map([[10, '/w']]));
  assert.equal(w.length, 2);
  assert.deepEqual(w[0], { kind: 'codex', task: 't1', track: 'W1', elapsed: 600, cwd: '/w', dispatcherPid: 10, owner: null });
  assert.deepEqual(w[1], { kind: 'claude', task: '', track: '', elapsed: 30, cwd: '' });
  assert.ok(!JSON.stringify(w).includes('SECRET'));
});

const { POLL_SCRIPT, SLOW_SCRIPT, parseSlow, networkSpeed, cleanPrefs, mergePrefs, syncKnown } = require('../lib/parse');
const { Remote } = require('../lib/remote');
const vm = require('vm');

test('fast system sections parse memory, swap, load, uptime, network, boot and top', () => {
  const out = ['@@MEM', 'MemTotal: 8388608 kB', 'MemAvailable: 2097152 kB',
    'SwapTotal: 4194304 kB', 'SwapFree: 3145728 kB', '@@LOAD', '1.25 0.5 0.2 1/1 42',
    '@@CORES', '8', '@@UPTIME', '12345.67 10000', '@@BOOT', 'boot-one', '@@NET',
    'Inter-| Receive | Transmit', ' lo: 99 0 0 0 0 0 0 0 99 0 0 0 0 0 0 0',
    ' eth0: 1048576 0 0 0 0 0 0 0 2097152 0 0 0 0 0 0 0', '@@TOP',
    ' 180.2 20.0 3145728 dotnet', ' 1.2 0.1 1048576 node'].join('\n');
  const r = parsePoll(out, 1);
  assert.equal(r.ram, 75);
  assert.equal(r.bootId, 'boot-one');
  assert.deepEqual(r.netBytes, { eth0: { rx: 1048576, tx: 2097152 } });
  assert.equal(r.sys.ramTotalGb, 8);
  assert.equal(r.sys.ramUsedGb, 6);
  assert.equal(r.sys.swapTotalGb, 4);
  assert.equal(r.sys.swapUsedGb, 1);
  assert.equal(r.sys.load1, 1.25);
  assert.equal(r.sys.cores, 8);
  assert.equal(r.sys.uptimeSec, 12345.67);
  assert.deepEqual(r.sys.top, [{ cmd: 'dotnet', cpu: 180.2, memGb: 3 }, { cmd: 'node', cpu: 1.2, memGb: 1 }]);
  const missing = parsePoll('@@HOST\nminimal\n@@MEM\nMemTotal: 1000\n@@NOTMUX', 1);
  assert.equal(missing.sys.swapUsedGb, null);
  assert.equal(missing.sys.ramUsedGb, null);
  assert.deepEqual(missing.sys.top, []);
  assert.equal(missing.sys.cores, null);
});

test('slow system sections parse disks, failed units and update-notifier text', () => {
  const r = parseSlow(['@@OS', 'Ubuntu 24.04 LTS', '@@DISKS',
    'Filesystem 1024-blocks Used Available Capacity Mounted on',
    '/dev/vda1 10485760 2097152 8388608 20% /', '/dev/vdb 20971520 10485760 10485760 50% /data space',
    '@@FAILED', 'nginx.service loaded failed failed A web server',
    '● backup.timer loaded failed failed Backup', '@@REBOOT', '1', '@@UPDATES',
    '12 updates can be applied immediately.', '3 of these updates are standard security updates.', '@@END'].join('\n'));
  assert.equal(r.os, 'Ubuntu 24.04 LTS');
  assert.deepEqual(r.disks, [{ mount: '/', usedGb: 2, totalGb: 10, pct: 20 },
    { mount: '/data space', usedGb: 10, totalGb: 20, pct: 50 }]);
  assert.deepEqual(r.failed, ['nginx.service', 'backup.timer']);
  assert.equal(r.rebootRequired, true);
  assert.equal(r.updates, 12);
  assert.deepEqual(parseSlow('@@OS\nAlpine\n@@END'), { os: 'Alpine', disks: [], failed: [], rebootRequired: false, updates: 0 });
  assert.equal(parseSlow('@@REBOOT\n0\n@@UPDATES\n').updates, 0);
});

test('poll scripts are valid POSIX sh and tolerate missing Linux tools', {skip:process.platform==='win32' ? 'SSH/WSL poll scripts require /bin/sh on their POSIX host' : false}, () => {
  const { spawnSync } = require('child_process');
  for (const script of [POLL_SCRIPT, SLOW_SCRIPT]) {
    const syntax = spawnSync('/bin/sh', ['-n'], { input: script, timeout: 3000 });
    assert.equal(syntax.status, 0, syntax.stderr.toString());
    const empty = spawnSync('/bin/sh', ['-c', script], { env: { PATH: '/nonexistent' }, timeout: 3000 });
    assert.equal(empty.status, 0);
  }
  for (const type of ['tmpfs', 'devtmpfs', 'squashfs', 'overlay']) assert.ok(SLOW_SCRIPT.includes(`-x ${type}`));
});

test('network speed uses actual elapsed time and ignores loopback, resets and new interfaces', () => {
  const mb = 1024 * 1024;
  const prev = { eth0: { rx: mb, tx: mb }, eth1: { rx: 0, tx: 0 }, lo: { rx: 0, tx: 0 } };
  const next = { eth0: { rx: 5 * mb, tx: 3 * mb }, eth1: { rx: 2 * mb, tx: 4 * mb },
    lo: { rx: 100 * mb, tx: 100 * mb }, new0: { rx: 100 * mb, tx: 100 * mb } };
  assert.deepEqual(networkSpeed(prev, next, 2000), { downMBs: 3, upMBs: 3 });
  assert.deepEqual(networkSpeed(next, prev, 2000), { downMBs: 0, upMBs: 0 });
  assert.deepEqual(networkSpeed(null, next, 2000), { downMBs: 0, upMBs: 0 });
  assert.deepEqual(networkSpeed(prev, next, 0), { downMBs: 0, upMBs: 0 });
});

test('preferences merge defaults, validate all changes atomically and protect recentDirs', () => {
  assert.deepEqual(mergePrefs({ limits: { cpu: 80 } }).limits, { cpu: 80, ram: 90, disk: 90 });
  const saved = mergePrefs({ recentDirs: ['/work'] });
  const edited = cleanPrefs({ limits: { cpu: 50, ram: 100 }, templates: [{ name: 'build', dir: '/work', run: 'claude' }],
    commands: ['git status'], recentDirs: ['/injected'] }, saved);
  assert.deepEqual(edited.limits, { cpu: 50, ram: 100, disk: 90 });
  assert.deepEqual(edited.recentDirs, ['/work']);
  for (const bad of [null, [], { limits: [] }, { limits: null }, { limits: { cpu: 49 } },
    { limits: { ram: 101 } }, { limits: { disk: 90.5 } }, { limits: { cpu: '95' } },
    { templates: Array(21).fill({ name: 'x', dir: '', run: 'shell' }) },
    { templates: [null] }, { templates: [{ name: 'bad name', dir: '', run: 'shell' }] },
    { templates: [{ name: 'x', dir: '/a\nb', run: 'shell' }] },
    { templates: [{ name: 'x', dir: '', run: 'node' }] }, { commands: Array(21).fill('x') },
    { commands: [''] }, { commands: ['x'.repeat(201)] }, { commands: ['a\nb'] },
    { commands: ['a\x1bb'] }, { commands: [42] }]) {
    assert.throws(() => cleanPrefs(bad, saved));
  }
  assert.deepEqual(saved, mergePrefs({ recentDirs: ['/work'] }));
});

test('known sessions are learned, intentionally stopped, lost on reboot, restored and dismissed', () => {
  const live = { name: 'build', path: '/work', cmd: 'claude' };
  const learned = syncKnown(undefined, 'boot1', [live]);
  assert.equal(learned.changed, true);
  assert.deepEqual(learned.record.sessions.build, { dir: '/work', run: 'claude' });
  assert.equal(syncKnown(learned.record, 'boot1', [live]).changed, false);
  assert.deepEqual(syncKnown(learned.record, 'boot1', []).record.sessions, {});
  const reboot = syncKnown(learned.record, 'boot2', []);
  assert.deepEqual(reboot.record.lost, ['build']);
  assert.deepEqual(learned.record.lost, []); // pure: does not mutate its input
  assert.equal(syncKnown(reboot.record, 'boot2', []).changed, false);
  assert.equal(syncKnown(JSON.parse(JSON.stringify(reboot.record)), 'boot2', []).changed, false);
  const restored = syncKnown(reboot.record, 'boot2', [live]);
  assert.deepEqual(restored.record.lost, []);
  assert.ok(restored.record.sessions.build);
  const dismissed = { ...reboot.record, sessions: {}, lost: [] };
  assert.equal(syncKnown(dismissed, 'boot2', []).changed, false);
  assert.ok(syncKnown(learned.record, '', []).record.sessions.build); // no boot ID means no inferred reboot/stop
  assert.equal(syncKnown(undefined, 'boot1', [{ ...live, cmd: 'bash' }]).record.sessions.build.run, 'shell');
  assert.equal(syncKnown(undefined, 'boot1', [{ ...live, cmd: '2.1.3' }]).record.sessions.build.run, 'claude');
});

test('Remote throttles slow polls, guards overlap, calculates speed and caps both histories', async () => {
  const r = new Remote({ id: 'test' }, () => {});
  assert.equal(r.publicView().sys, null);
  r.ready = true;
  const originalNow = Date.now;
  let now = 200000000;
  Date.now = () => now;
  let fast = 0, slow = 0;
  r.exec = async (script) => {
    if (script.includes('@@OS')) { slow += 1; return { out: '@@OS\nUbuntu\n@@END', code: 0 }; }
    fast += 1;
    return { out: `@@CPU\ncpu ${fast * 10} 0 0 ${fast * 90}\n@@NET\neth0: ${fast * 1048576} 0 0 0 0 0 0 0 ${fast * 2097152} 0 0 0 0 0 0 0\n@@END`, code: 0 };
  };
  try {
    const first = r.poll();
    await r.poll();
    await first;
    assert.equal(fast, 1);
    assert.equal(slow, 1);
    now += 2000;
    await r.poll();
    assert.equal(r.publicView().sys.downMBs, 0.5);
    assert.equal(r.publicView().sys.upMBs, 1);
    assert.equal(r.longHistory.length, 1);
    assert.equal(slow, 1);
    now += 58000;
    await r.poll();
    assert.equal(slow, 2);
    assert.equal(r.longHistory.length, 2);
    for (let i = 0; i < 30; i += 1) { now += 3000; await r.poll(); }
    assert.equal(r.publicView().sys.net.length, 28);
    assert.equal(r.history.cpu.length, 28);
    now += 86400001;
    await r.poll();
    assert.equal(r.longHistory.length, 1);
    assert.equal(r.publicView().sys.os, 'Ubuntu');
  } finally { Date.now = originalNow; }
});

// Run the real routing/functions with in-memory HTTP/timers and a temporary vault, without listeners.
function backendHarness(t, history) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-backend-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (history !== undefined) fs.writeFileSync(path.join(dir, 'history.json'), history);
  const intervals = [];
  const context = {
    require: (name) => name === 'http' ? { createServer: (handler) => ({ handler, on() {}, listen() {} }) }
      : name === 'ws' ? { WebSocketServer: class {} }
        : name === './lib/backends' ? { ...require('../lib/backends'), createBackend: (cfg, onLearn) => {
          const r = require('../lib/backends').createBackend(cfg, onLearn);
          if (cfg.local) { r.connect = async () => { r.ready = true; }; r.poll = async () => {}; }
          return r;
        } }
        : name.startsWith('./') ? require(path.join('..', name)) : require(name),
    __dirname: path.join(__dirname, '..'),
    process: { env: { TW_DATA: dir }, pid: process.pid, on() {} },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return { unref() {} }; },
    setTimeout, clearTimeout, Buffer, URL, console,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8') +
    '\n globalThis.backend = { api, server, vault, remotes, startRemotes, startSession, onPoll, saveHistory, historyPoints, intervals: null };', context);
  const b = context.backend;
  b.vault.create('test', { servers: [], prefs: mergePrefs(), known: {} });
  // API direct calls use a login cookie generated by the real login handler.
  b.request = async (method, route, body, origin) => {
    const { Readable } = require('stream');
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method;
    req.url = route;
    req.headers = { host: 'localhost', cookie: b.cookie || '', ...(origin ? { origin } : {}) };
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; },
      writeHead(code, headers) { this.code = code; Object.assign(this.headers, headers); this.headersSent = true; },
      end(data) { this.body = data ? JSON.parse(data) : null; } };
    await b.server.handler(req, res);
    if (res.headers['Set-Cookie']) b.cookie = res.headers['Set-Cookie'].split(';')[0];
    return res;
  };
  b.dir = dir;
  b.intervals = intervals;
  return b;
}

test('preferences routes enforce auth/origin, return 400 atomically and merge old vaults', async (t) => {
  const b = backendHarness(t);
  assert.equal((await b.request('GET', '/api/prefs')).code, 401);
  assert.equal((await b.request('POST', '/api/login', { password: 'test' })).code, 200);
  assert.equal((await b.request('GET', '/api/prefs')).body.limits.cpu, 95);
  const before = fs.readFileSync(b.vault.file, 'utf8');
  assert.equal((await b.request('PUT', '/api/prefs', { limits: { cpu: 10 }, commands: ['changed'] })).code, 400);
  assert.equal(fs.readFileSync(b.vault.file, 'utf8'), before);
  assert.equal((await b.request('PUT', '/api/prefs', { commands: ['changed'] }, 'https://evil.example')).code, 403);
  assert.equal((await b.request('PUT', '/api/prefs', { limits: { cpu: 80 } })).body.limits.cpu, 80);
});

test('session keys are sent literally with separate Enter; session DELETE still works', async (t) => {
  const b = backendHarness(t);
  await b.request('POST', '/api/login', { password: 'test' });
  const id = '11111111-1111-1111-1111-111111111111';
  const calls = [];
  b.remotes.set(id, { cfg: { id }, exec: async (cmd) => { calls.push(cmd); return { code: 0 }; }, poll: async () => {} });
  const route = `/api/servers/${id}/sessions/build`;
  assert.equal((await b.request('POST', `${route}/keys`, { text: "$(id)'; echo bad" })).code, 200);
  assert.deepEqual(calls, [`tmux send-keys -l -t ${shq('=build:')} -- ${shq("$(id)'; echo bad")}`, `tmux send-keys -t ${shq('=build:')} Enter`]);
  calls.length = 0;
  await b.request('POST', `${route}/keys`, { text: '', enter: true });
  assert.equal(calls.length, 1);
  calls.length = 0;
  await b.request('POST', `${route}/keys`, { text: 'hello', enter: false });
  assert.equal(calls.length, 1);
  for (const body of [{ text: '\n' }, { text: 'x'.repeat(1001) }, { text: 'ok', enter: 'yes' }, {}]) {
    assert.equal((await b.request('POST', `${route}/keys`, body)).code, 400);
  }
  assert.equal((await b.request('DELETE', route)).code, 200);
  assert.match(calls.at(-1), /kill-session/);
  assert.equal((await b.request('DELETE', `${route}/keys`)).code, 404);
});

test('history loads safely, prunes unknown/expired servers, persists mode 600 and filters hours', async (t) => {
  const now = Date.now();
  const id = '11111111-1111-1111-1111-111111111111';
  const point = (t) => ({ t, cpu: 10, ram: 20, disk: 30 });
  const b = backendHarness(t, JSON.stringify({ [id]: [point(now - 90000000), point(now - 7200000), point(now - 300000)], other: [point(now)] }));
  b.vault.data.servers.push({ id, auth: 'password' });
  b.vault.save();
  await b.request('POST', '/api/login', { password: 'test' });
  assert.equal(b.remotes.get(id).longHistory.length, 2);
  for (const [hours, count] of [['1', 1], ['6', 2], ['24', 2]]) {
    const res = await b.request('GET', `/api/servers/${id}/history?hours=${hours}`);
    assert.equal(res.code, 200);
    assert.equal(res.body.points.length, count);
  }
  for (const hours of ['', '2', '01', 'NaN']) assert.equal((await b.request('GET', `/api/servers/${id}/history?hours=${hours}`)).code, 400);
  b.saveHistory();
  const file = path.join(b.dir, 'history.json');
  // Windows stat mode bits do not represent NTFS ACLs.
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file))), [require('../lib/backends').LOCAL_ID, id]);
  assert.equal(b.historyPoints([point(now - 120000), point(now - 90000), point(now - 60000)]).length, 2);
  assert.equal((await b.request('DELETE', `/api/servers/${id}`)).code, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { [require('../lib/backends').LOCAL_ID]: [] });
  const corrupt = backendHarness(t, '{broken');
  assert.doesNotThrow(() => corrupt.startRemotes());
});

test('restore shares resolved Claude startup, keeps failures lost and dismisses persistent records', async (t) => {
  const b = backendHarness(t);
  await b.request('POST', '/api/login', { password: 'test' });
  const id = '11111111-1111-1111-1111-111111111111';
  const cfg = { id };
  b.vault.data.servers.push(cfg);
  b.vault.data.known[id] = { bootId: 'boot1', sessions: { good: { dir: '/old', run: 'claude' }, bad: { dir: '/gone', run: 'shell' } }, lost: [] };
  const calls = [];
  const r = { cfg, lost: [], snapshot: { bootId: 'boot2' }, exec: async (cmd) => {
    calls.push(cmd);
    if (cmd.includes('/gone')) return { code: 3, out: '' };
    return { code: 0, out: '\0TW_DIR\0/physical\n\0' };
  }, poll: async () => {} };
  b.remotes.set(id, r);
  b.onPoll(r, { bootId: 'boot2', sessions: [] });
  const result = await b.request('POST', `/api/servers/${id}/restore`, {});
  assert.deepEqual(result.body.restored, ['good']);
  assert.equal(result.body.failed[0].name, 'bad');
  assert.equal(r.lost.length, 1);
  assert.equal(r.lost[0].name, 'bad');
  assert.equal(b.vault.data.known[id].sessions.good.dir, '/physical');
  assert.equal(b.vault.data.prefs.recentDirs[0], '/physical');
  assert.ok(calls.some((cmd) => cmd.includes(claudeSessionId('/physical', 'good'))));
  const before = JSON.stringify(b.vault.data.known);
  b.onPoll(r, { bootId: 'boot2', sessions: [{ name: 'good', path: '/physical', cmd: 'bash' }] });
  assert.equal(JSON.stringify(b.vault.data.known), before);
  const persisted = new Vault(b.vault.file); assert.equal(persisted.unlock('test'), true);
  assert.ok(persisted.data.daily.day);
  assert.ok(Object.values(persisted.data.diary).some((record) => record.events.some((e) => e.type === 'observed')));
  assert.equal((await b.request('DELETE', `/api/servers/${id}/lost`)).code, 200);
  assert.equal(r.lost.length, 0);
  assert.equal(Object.hasOwn(b.vault.data.known[id].sessions, 'bad'), false);
});

test('background timer polls without active page and history timer runs every five minutes', (t) => {
  const b = backendHarness(t);
  let polls = 0;
  b.remotes.set('test', { poll() { polls += 1; } });
  const background = b.intervals.find((x) => x.ms === 60000);
  assert.ok(background);
  background.fn();
  assert.equal(polls, 1);
  b.vault.key = null;
  background.fn();
  assert.equal(polls, 1);
  assert.ok(b.intervals.some((x) => x.ms === 300000));
});

test('session changes reject stale poll reconciliation and recent directories stay unique/capped', async (t) => {
  const b = backendHarness(t);
  const cfg = { id: 'test' };
  b.vault.data.servers.push(cfg);
  let pathIndex = 0;
  const r = { cfg, sessionVersion: 0, lost: [], snapshot: { bootId: 'boot1' }, exec: async () => {
    b.onPoll(r, { bootId: 'boot1', sessions: [] }); // poll completes during session creation
    return { code: 0, out: `\0TW_DIR\0/folder${pathIndex}\n\0` };
  } };
  for (pathIndex = 0; pathIndex < 10; pathIndex += 1) {
    await b.startSession(r, { name: `s${pathIndex}`, dir: '', run: 'shell' });
  }
  pathIndex = 5;
  await b.startSession(r, { name: 'again', dir: '', run: 'shell' });
  assert.equal(b.vault.data.prefs.recentDirs.length, 8);
  assert.equal(b.vault.data.prefs.recentDirs[0], '/folder5');
  assert.equal(new Set(b.vault.data.prefs.recentDirs).size, 8);
  assert.equal(Object.keys(b.vault.data.known.test.sessions).length, 11);
  b.onPoll(r, { bootId: 'boot1', sessions: [] }, 0); // poll started before session creation
  assert.equal(Object.keys(b.vault.data.known.test.sessions).length, 11);
});

test('failed Claude launch rolls back the shell and leaves the restore record lost', async (t) => {
  const b = backendHarness(t);
  await b.request('POST', '/api/login', { password: 'test' });
  const id = '11111111-1111-1111-1111-111111111111';
  const cfg = { id };
  b.vault.data.servers.push(cfg);
  b.vault.data.known[id] = { bootId: 'boot2', sessions: { broken: { dir: '/work', run: 'claude' } }, lost: ['broken'] };
  const calls = [];
  const r = { cfg, lost: [{ name: 'broken', dir: '/work', run: 'claude' }], exec: async (cmd) => {
    calls.push(cmd);
    return cmd.includes('TW_DIR') ? { code: 0, out: '\0TW_DIR\0/work\n\0' } : { code: cmd.includes('kill-session') ? 0 : 1 };
  }, poll: async () => {} };
  b.remotes.set(id, r);
  const res = await b.request('POST', `/api/servers/${id}/restore`, { names: ['broken'] });
  assert.equal(res.body.failed.length, 1);
  assert.equal(res.body.restored.length, 0);
  assert.equal(r.lost[0].name, 'broken');
  assert.ok(calls.at(-1).includes('kill-session'));
  assert.deepEqual(b.vault.data.known[id].lost, ['broken']);
});

test('second login keeps remote configuration linked to the current vault for polling', async (t) => {
  const b = backendHarness(t);
  const id = '11111111-1111-1111-1111-111111111111';
  b.vault.data.servers.push({ id, auth: 'password' });
  b.vault.save();
  await b.request('POST', '/api/login', { password: 'test' });
  const r = b.remotes.get(id);
  const originalCfg = r.cfg;
  await b.request('POST', '/api/login', { password: 'test' });
  assert.notEqual(r.cfg, originalCfg);
  assert.equal(r.cfg, b.vault.data.servers[0]);
  b.onPoll(r, { bootId: 'boot', sessions: [{ name: 'new', path: '/work', cmd: 'bash' }] });
  assert.ok(b.vault.data.known[id].sessions.new);
});

test('Remote caps minute history at 1440 and retains slow data when the next slow poll fails', async () => {
  const r = new Remote({}, () => {});
  r.ready = true;
  let now = Date.now();
  const originalNow = Date.now;
  Date.now = () => now;
  let failSlow = false;
  r.exec = async (script) => {
    if (script.includes('@@OS')) {
      if (failSlow) throw new Error('timeout');
      return { code: 0, out: '@@OS\nUbuntu\n@@REBOOT\n1\n' };
    }
    return { code: 0, out: '@@HOST\nhost\n@@END' };
  };
  try {
    await r.poll();
    failSlow = true;
    now += 60000;
    r.longHistory = Array.from({ length: 1440 }, (_, i) => ({ t: now - (1440 - i) * 60000, cpu: 1, ram: 2, disk: 3 }));
    await r.poll();
    assert.equal(r.longHistory.length, 1440);
    assert.equal(r.publicView().sys.os, 'Ubuntu');
    assert.equal(r.publicView().sys.rebootRequired, true);
    assert.equal(r.longHistory.at(-1).t, now);
  } finally { Date.now = originalNow; }
});

test('Remote records connection drop time, clears counters and resets offSince on reconnection', async () => {
  const { EventEmitter } = require('events');
  const clients = [];
  class Client extends EventEmitter {
    constructor() { super(); clients.push(this); }
    connect() { this.emit('ready'); }
    end() { this.emit('close'); }
  }
  const context = { require: (name) => name === 'ssh2' ? { Client }
    : name.startsWith('./') ? require('../lib/' + name.slice(2)) : require(name),
  module: { exports: {} }, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../lib/remote.js'), 'utf8'), context);
  const r = new context.module.exports.Remote({}, () => {});
  await r.connect();
  assert.equal(r.publicView().offSince, null);
  r.prevCpu = { total: 100, idle: 50 };
  r.prevNet = { bytes: {}, t: 1 };
  const before = Date.now();
  clients[0].emit('close');
  assert.equal(r.ready, false);
  assert.ok(r.publicView().offSince >= before);
  assert.equal(r.prevCpu, null);
  assert.equal(r.prevNet, null);
  r.lastSlowPoll = Date.now(); r.slowSys = { rebootRequired: true };
  await r.connect();
  assert.equal(r.publicView().offSince, null);
  assert.equal(r.lastSlowPoll, null);
  assert.equal(r.slowSys, null);
});

test('Crew log route requires login, existing worker and validated task/track; never accepts a path', async (t) => {
  const b = backendHarness(t);
  const id = '11111111-1111-1111-1111-111111111111';
  const route = `/api/servers/${id}/crew-log`;
  assert.equal((await b.request('GET', route + '?task=t&track=W1')).code, 401);
  await b.request('POST', '/api/login', { password: 'test' });
  const worker = { task: 't', track: 'W1', cwd: '/work', elapsed: 12 };
  let calls = 0;
  const r = { ready: true, snapshot: { workers: [worker] }, readWorkerLog: async (w) => {
    assert.equal(w, worker); calls++;
    return { text: '<script>untrusted</script>', result: 'unknown' };
  } };
  b.remotes.set(id, r);
  for (const query of ['task=../t&track=W1', 'task=t&track=..', 'task=t&track=W1%2Fa'])
    assert.equal((await b.request('GET', route + '?' + query)).code, 400);
  assert.equal((await b.request('GET', route + '?task=other&track=W1')).code, 404);
  assert.equal(calls, 0);
  const log = await b.request('GET', route + '?task=t&track=W1&path=/etc/passwd');
  assert.equal(log.code, 200);
  assert.equal(log.body.text, '<script>untrusted</script>');
  r.ready = false;
  assert.equal((await b.request('GET', route + '?task=t&track=W1')).code, 503);
});

test('local is first after login, requires no SSH secret, cannot be removed and saves recovery preferences', async (t) => {
  const b = backendHarness(t);
  const { LOCAL_ID } = require('../lib/backends');
  assert.equal((await b.request('GET', '/api/state')).code, 401);
  await b.request('POST', '/api/login', { password: 'test' });
  const state = (await b.request('GET', '/api/state')).body;
  assert.equal(state.servers[0].id, LOCAL_ID);
  assert.equal(state.servers[0].local, true);
  assert.equal(state.servers[0].host, os.hostname());
  assert.equal(state.servers[0].needsPassword, false);
  assert.equal((await b.request('DELETE', `/api/servers/${LOCAL_ID}`)).code, 400);
  assert.equal((await b.request('PUT', '/api/prefs', { autoRestoreLocal: true })).body.autoRestoreLocal, true);
  assert.equal((await b.request('PUT', '/api/prefs', { autoRestoreLocal: 1 })).code, 400);
  const r = b.remotes.get(LOCAL_ID);
  b.vault.data.prefs.autoRestoreLocal = false;
  b.vault.data.known[LOCAL_ID] = { bootId: 'old', sessions: { saved: { dir: '/tmp', run: 'codex' } } };
  b.onPoll(r, { bootId: 'new', hasTmux: true, sessions: [] });
  assert.deepEqual(r.lost.map(s => s.name), ['saved']);
  const v = new (require('../lib/vault').Vault)(path.join(b.dir, 'vault.json'));
  assert.equal(v.unlock('test'), true);
  assert.deepEqual(v.data.known[LOCAL_ID].lost, ['saved']);
});

test('reboot route enforces authentication, same origin, server identity and local refusal with fake SSH', async t => {
  const b = backendHarness(t);
  const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const calls = [];
  const remote = { cfg: { id, user: 'deploy' }, ready: true,
    snapshot: { bootId: 'old', sys: { rebootRequired: true } },
    publicView: () => ({ name: 'demo-server' }),
    exec: async cmd => { calls.push(cmd); return { code: 0 }; } };
  b.remotes.set(id, remote);
  assert.equal((await b.request('POST', '/api/servers/' + id + '/reboot', { name: 'demo-server' })).code, 401);
  assert.equal((await b.request('POST', '/api/login', { password: 'test' })).code, 200);
  assert.equal((await b.request('POST', '/api/servers/' + id + '/reboot', { name: 'demo-server' }, 'https://evil.example')).code, 403);
  assert.equal((await b.request('POST', '/api/servers/invalid/reboot', { name: 'demo-server' })).code, 404);
  assert.equal((await b.request('POST', '/api/servers/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/reboot', { name: 'demo-server' })).code, 404);
  assert.equal((await b.request('POST', '/api/servers/' + id + '/reboot', { name: 'demo-server ' })).code, 400);
  remote.cfg.local = true;
  const local = await b.request('POST', '/api/servers/' + id + '/reboot', { name: 'demo-server' });
  assert.equal(local.code, 400); assert.match(local.body.error, /Máy này/);
  delete remote.cfg.local;
  assert.deepEqual(calls, []);
  assert.equal((await b.request('POST', '/api/servers/' + id + '/reboot', { name: 'demo-server' })).code, 200);
  assert.deepEqual(calls, ['sudo -n -l reboot >/dev/null 2>&1 || exit 1; (sleep 1; sudo -n reboot) </dev/null >/dev/null 2>&1 &']);
  assert.equal((await b.request('POST', '/api/servers/' + id + '/reboot', { name: 'demo-server' })).code, 400);
});

test('Yes/No belong only to a screen that really asks: a quiet Claude is waiting but not asking', () => {
  assert.equal(isAsking({ cmd: 'node', lines: ['Proceed with the edit? (y/n)'] }), true);
  assert.equal(isAsking({ cmd: 'node', lines: ['Do you want to run this command?', '❯ 1. Yes', '  2. No'] }), true);
  assert.equal(isAsking({ cmd: 'bash', lines: ['Password:'] }), true);
  const quiet = ['Đã xong phần sửa.', '', '▸▸ auto mode on (shift+tab to cycle)'];
  assert.equal(classify({ cmd: 'claude', lines: quiet, activityAge: 90 }), 'wait');
  assert.equal(isAsking({ cmd: 'claude', lines: quiet }), false);
  assert.equal(isAsking({ cmd: 'bash', lines: ['root@x:~#'] }), false);
});

// Poll a session the way the backend does: tmux "activity" keeps refreshing, only the screen text decides.
function pollOnce(rec, lines, activityAge, nowMs) {
  const seen = screenQuiet(rec, lines, activityAge, nowMs);
  return { rec: seen.rec, state: classify({ cmd: '2.1.126', lines, activityAge: seen.quiet }) };
}

test('a finished Claude whose clock and counters keep ticking settles on "waiting" and stays there', () => {
  let rec = null, t = 0; const states = [];
  for (let i = 0; i < 24; i++) {                               // every 5 s for two minutes
    const lines = ['Đã xong phần sửa.', 'Cooked for ' + (50 + i) + 's · done ' + (6 + i % 5) + ':5' + (i % 10) + ' AM', '▸▸ auto mode on (shift+tab to cycle) · ' + i + 's'];
    const r = pollOnce(rec, lines, 2, t); rec = r.rec; states.push(r.state); t += 5000;   // tmux says "active 2 s ago" every time
  }
  assert.ok(states.slice(0, 3).every((x) => x === 'run'), 'the first moments still count as recent activity');
  assert.ok(states.slice(6).every((x) => x === 'wait'), 'after that it never flips back to running: ' + states.join(','));
});

test('real output makes a waiting session run again, and "esc to interrupt" keeps a working one running even in silence', () => {
  let rec = null, t = 0;
  for (let i = 0; i < 10; i++) { rec = pollOnce(rec, ['xong rồi'], 99, t).rec; t += 5000; }
  assert.equal(pollOnce(rec, ['xong rồi'], 99, t).state, 'wait');
  const busy = pollOnce(rec, ['xong rồi', 'Đang đọc file src/app.js để sửa lỗi'], 1, t);
  assert.equal(busy.state, 'run');
  const working = ['✻ Thinking… (95s · ↓ 1.2k tokens · esc to interrupt)'];
  let r = null; for (let i = 0; i < 8; i++) { r = pollOnce(r && r.rec, working, 60, t); t += 5000; }
  assert.equal(r.state, 'run'); assert.equal(isWorking(working), true); assert.equal(isWorking(['all done']), false);
});

test('screen signature ignores digits, spinners and status bars but notices new words', () => {
  const a = ['Thinking 12s ⠋', 'build ok', '▸▸ auto mode on (shift+tab to cycle)'], b = ['Thinking 97s ⠙', 'build ok', '▸▸ auto mode on (shift+tab to cycle) 3'];
  assert.equal(contentSignature(a), contentSignature(b));
  assert.notEqual(contentSignature(a), contentSignature([...a, 'test failed in parse.js']));
});

test('Codex sitting at its prompt is waiting, not running (it runs as plain node)', () => {
  const idle = ['Đã tạo xong bộ plan.', '', '› Ask Codex to do anything', '', 'GPT-6.1-Sol medium · ~/work', '← for agents · ? for shortcuts'];
  assert.equal(classify({ cmd: 'node', lines: idle, activityAge: 90 }), 'wait');
  assert.equal(classify({ cmd: 'codex', lines: idle, activityAge: 90 }), 'wait');
  assert.equal(classify({ cmd: 'node', lines: idle, activityAge: 3 }), 'run', 'just printed something');
  assert.equal(classify({ cmd: 'node', lines: ['server listening on 3000'], activityAge: 900 }), 'run', 'an ordinary node program is not an agent');
  assert.equal(isAsking({ cmd: 'node', lines: idle }), false);
});
