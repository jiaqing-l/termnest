'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const P = require('../public/pet-state');
const { trackDir, logScript, retainWorkers, RETAIN_MS } = require('../lib/crew');
const { parsePoll } = require('../lib/parse');

test('lookup uses command boundaries and never treats terminal prose as a command', () => {
  for (const [cmd, expected] of [['git push origin main', 'box'], ['/usr/bin/git push', 'box'],
    ['npm test', 'test'], ['npm run test -- --run', 'test'], ['node --test', 'test'], ['pytest', 'test'],
    ['dotnet test x.csproj', 'test'], ['docker build .', 'hat'], ['docker buildx build .', 'hat'],
    ['claude --resume abc', 'laptop'], ['2.1.3', 'laptop'], ['echo git push', 'normal'],
    ['npm testbad', 'normal'], ['docker builder', 'normal'], ['git status', 'normal'], ['node app.js', 'normal']]) {
    assert.equal(P.activity(cmd), expected, cmd);
  }
});
test('badges use actual age and reject missing, invalid or future creation times', () => {
  const now = 1000000;
  assert.equal(P.badge(now - P.LIMITS.day + 1, now), '');
  assert.equal(P.badge(now - P.LIMITS.day, now), '🎖️');
  assert.equal(P.badge(now - P.LIMITS.week, now), '👑');
  for (const bad of [0, -1, NaN, undefined, now + 1]) assert.equal(P.badge(bad, now), '');
});
test('off, hidden and reduced-motion each stop motion independently', () => {
  assert.equal(P.motion(true, false, false), true);
  assert.equal(P.motion(false, false, false), false);
  assert.equal(P.motion(true, true, false), false);
  assert.equal(P.motion(true, false, true), false);
  const css = fs.readFileSync(path.join(__dirname, '../public/app.css'), 'utf8');
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.match(css, /\.pets-off \.pet-art/);
});
test('waiting phases and finish require explicit evidence, never guessed output', () => {
  assert.equal(P.phase('wait', 0, 119999), 'jump');
  assert.equal(P.phase('wait', 0, 120000), 'knock');
  assert.equal(P.phase('wait', 0, 128000), 'chin');
  assert.equal(P.outcome({ state: 'idle', lines: ['FAIL'] }), '');
  assert.equal(P.outcome({ dead: true, exitStatus: null }), '');
  assert.equal(P.outcome({ dead: true, exitStatus: 0 }), 'finish');
  assert.equal(P.outcome({ dead: true, exitStatus: 2 }), 'failure');
});
test('poll maps foreground arguments only and reads tmux explicit exit status', () => {
  const snap = parsePoll('@@PS\n11 10 4 git push origin main\n12 10 4 docker build .\n@@PSOK\n1\n@@FOREGROUND\n11 11 11\n12 12 11\n@@SESS\n$0|~|one|~|0|~|10|~|20|~|git|~|/work\n@@DETAIL\n$0|~|10|~|1|~|2\n@@END', 21);
  assert.equal(snap.sessions[0].petActivity, 'box');
  assert.equal(snap.sessions[0].exitStatus, 2);
  assert.equal(snap.workersReliable, true);
  assert.equal(JSON.stringify(snap).includes('origin main'), false);
});
test('retained workers preserve tail and duration for exactly one hour; restart clears result', () => {
  const w = { task: 'task-1', track: 'W1', cwd: '/work', elapsed: 20, lines: ['last'] };
  const active = retainWorkers([], [w], 1000);
  const ended = retainWorkers(active, [], 3000);
  assert.equal(ended[0].elapsed, 22);
  assert.equal(ended[0].result, 'unknown');
  assert.deepEqual(ended[0].lines, ['last']);
  assert.equal(retainWorkers(ended, [], 3000 + RETAIN_MS - 1).length, 1);
  assert.equal(retainWorkers(ended, [], 3000 + RETAIN_MS).length, 0);
  assert.equal(retainWorkers(ended, [w], 4000)[0].finishedAt, undefined);
});
test('path validation rejects traversal, metacharacters and partial names', () => {
  for (const task of ['../x', '.', '..', 'x/y', 'x;id', 'x\n', '', 'x'.repeat(129)])
    assert.throws(() => trackDir({ cwd: '/work', task, track: 'W1' }));
  for (const track of ['../x', 'W1/a', 'W1\n', '$HOME'])
    assert.throws(() => trackDir({ cwd: '/work', task: 't', track }));
  assert.throws(() => trackDir({ cwd: '/work/../escape', task: 't', track: 'W1' }));
});
test('SSH worker paths stay POSIX when the client runs on Windows', () => {
  const worker = { cwd: '/fixture/work space', task: 'task-1', track: 'W1' };
  assert.equal(trackDir(worker), '/fixture/work space/_crew/tasks/task-1/tracks/W1');
  assert.ok(logScript(worker).includes("'/fixture/work space/_crew/tasks/task-1/tracks/W1'"));
  // A Windows client must not reinterpret a remote POSIX path as a local drive path.
  for (const cwd of [String.raw`C:\work`, 'C:/work', '../work'])
    assert.throws(() => trackDir({ ...worker, cwd }), /Invalid worker path/);
});
test('remote log script reads only bounded regular logs and rejects symlink escapes', {skip:process.platform==='win32' ? 'SSH log reader requires POSIX paths, /bin/sh, readlink and Unix symlinks' : false}, (t) => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-log-')));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const w = { cwd: tmp, task: 'task-1', track: 'W1' }, track = trackDir(w), logs = path.join(track, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const run = () => spawnSync('/bin/sh', ['-c', logScript(w)], { encoding: 'utf8', timeout: 3000 });
  fs.writeFileSync(path.join(logs, 'a log.txt'), 'hello <script>\n' + 'x'.repeat(70000));
  fs.writeFileSync(path.join(track, 'DONE'), '0\n');
  let result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.startsWith('DONE\n'));
  assert.equal(result.stdout.length, 65541);
  fs.writeFileSync(path.join(tmp, 'secret'), 'MUST NOT LEAK');
  fs.symlinkSync(path.join(tmp, 'secret'), path.join(logs, 'z.log'));
  assert.equal(run().stdout.includes('MUST NOT LEAK'), false);
  fs.renameSync(logs, logs + '-real'); fs.symlinkSync(tmp, logs);
  assert.equal(run().status, 3);
});

function sceneHarness({ stored = null, reduced = false, storageThrows = false, hour=12, random=.1 } = {}) {
  const vm = require('node:vm');
  class Node {
    constructor() { this.children = []; this.dataset = {}; this.className = ''; this.textContent = ''; this.classes = new Set(); this.style = {}; this.clientWidth = 600;
      this.classList = { toggle: (c, on) => on ? this.classes.add(c) : this.classes.delete(c) }; }
    querySelectorAll(selector) { const classes = selector.split('.').filter(Boolean); return this.children.filter(n => classes.every(c => n.className.split(' ').includes(c))); }
    append(...nodes) { for (const n of nodes) { n.parent = this; this.children.push(n); } }
    get firstChild() { return this.children[0]; }
    set innerHTML(s) { this.html = s; this.children = []; }
    remove() { this.parent.children = this.parent.children.filter((n) => n !== this); }
  }
  const nodes = Object.fromEntries(['pets-enabled', 'pet-yard', 'pet-weather', '.scene', '.house', '.playground > b'].map((k) => [k, new Node()]));
  const doc = { hidden: false, documentElement: new Node(), createElement: () => new Node(),
    getElementById: (id) => nodes[id], querySelector: (sel) => nodes[sel], addEventListener() {} };
  let now = new Date(2026,10,1,hour).getTime(), timer, frame;
  const media = { matches: reduced, addEventListener() {} };
  const context = { window: { PetState: P, PetArt: { ORDER: ['cat'], pet: () => '<svg></svg>' }, matchMedia: () => media },
    document: doc, localStorage: { getItem() { if (storageThrows) throw Error('blocked'); return stored; },
      setItem() { if (storageThrows) throw Error('blocked'); } },
    Date: class extends Date { static now() { return now; } }, Math: Object.assign(Object.create(Math), { random: () => random }),
    requestAnimationFrame: (fn) => { frame = fn; },
    setInterval: (fn) => { timer = fn; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/pet-scene.js'), 'utf8'), context);
  return { nodes, doc, media, api: context.window.PetScene, frame(ms) { frame(ms); }, tick(ms) { now += ms; timer(); },
    sync(sessions, on = true) { context.window.PetScene.sync([{ id: 'server', on, sessions, houseSessions: sessions }], on, true, () => {}, { cpu: 95, ram: 90, disk: 90 }); } };
}
test('scene honors persisted off, storage exceptions, reduced motion and observed wait timing', () => {
  const off = sceneHarness({ stored: 'off' });
  off.sync([{ name: 'a', created: 1, state: 'wait' }]);
  assert.equal(off.nodes['pet-yard'].querySelectorAll('.yard-pet').length, 0);
  assert.ok(off.doc.documentElement.classes.has('pets-off'));
  const h = sceneHarness({ storageThrows: true, reduced: true });
  h.sync([{ name: 'a', created: 1, state: 'wait' }]);
  assert.ok(h.doc.documentElement.classes.has('pets-still'));
  assert.match(h.nodes['pet-yard'].querySelectorAll('.yard-pet')[0].className, /act-jump/);
  h.tick(120000);
  assert.match(h.nodes['pet-yard'].querySelectorAll('.yard-pet')[0].className, /act-knock/);
  h.tick(8000);
  assert.match(h.nodes['pet-yard'].querySelectorAll('.yard-pet')[0].className, /act-chin/);
  h.nodes['pets-enabled'].checked = false;
  assert.doesNotThrow(() => h.nodes['pets-enabled'].onchange());
  assert.ok(h.doc.documentElement.classes.has('pets-off'));
});
test('scene only leaves after confirmed absence; disconnect keeps pets; house pets join idle sessions', () => {
  const h = sceneHarness();
  const session = { name: 'a', created: 1, state: 'idle' };
  h.sync([session]); h.api.event('server', 'a', 'stop');
  h.sync([session]);
  assert.doesNotMatch(h.nodes['pet-yard'].querySelectorAll('.yard-pet')[0].className, /act-leave/);
  h.sync([session], false);
  assert.match(h.nodes['pet-yard'].querySelectorAll('.yard-pet')[0].className, /house-wave/);
  h.sync([]);
  assert.match(h.nodes['pet-yard'].querySelectorAll('.yard-pet')[0].className, /act-leave/);
  h.tick(8000); h.sync([]);
  assert.equal(h.nodes['pet-yard'].querySelectorAll('.yard-pet').length, 3);
  h.sync([session]); h.tick(24000);
  assert.equal(h.nodes['pet-yard'].querySelectorAll('.yard-pet.act-soccer').length,2);
  h.sync([session, { ...session, name: 'b' }]); h.tick(24000);
  assert.equal(h.nodes['pet-yard'].children.filter((n) => /act-soccer/.test(n.className)).length, 2);
  h.doc.hidden = true; const before = h.nodes['pet-yard'].querySelectorAll('.yard-pet')[0].className; h.tick(24000);
  assert.equal(h.nodes['pet-yard'].querySelectorAll('.yard-pet')[0].className, before);
});

test('soccer moves both pets, arcs the shared ball, scores and freezes when hidden', () => {
  const h = sceneHarness();
  h.sync(['a', 'b', 'c'].map(name => ({ name, created: 1, state: 'idle' })));
  h.tick(24000);
  const yard = h.nodes['pet-yard'], pets = yard.querySelectorAll('.yard-pet.act-soccer');
  assert.equal(pets.length, 2);
  assert.equal(yard.querySelectorAll('.yard-pet.act-fish').length, 1);
  const field = yard.querySelectorAll('.soccer-field')[0], ball = field.children[2];
  h.frame(1); const before = pets.map(p => p.style.left);
  for (let t = 51; t <= 2001; t += 50) h.frame(t);
  assert.notDeepEqual(pets.map(p => p.style.left), before);
  assert.ok(parseFloat(ball.style.bottom) > 14);
  for (let t = 2051; t <= 6051; t += 50) h.frame(t);
  const score = h.nodes['.playground > b'].firstChild;
  assert.match(score.textContent, /1 – 0/);
  h.doc.hidden = true;
  const position = ball.style.left, text = score.textContent;
  for (let t = 6101; t <= 13001; t += 50) h.frame(t);
  assert.equal(field.hidden, true);
  assert.equal(ball.style.left, position);
  assert.equal(score.textContent, text);
});

test('Crew ownership walks dispatcher ancestors to every pane, never directories', () => {
  const { findWorkers } = require('../lib/parse');
  const ps = [{ pid: 10, ppid: 1, args: 'bash', elapsed: 100 },
    { pid: 20, ppid: 10, args: 'claude', elapsed: 90 },
    { pid: 30, ppid: 20, args: 'bash crew-dispatch.sh --task task-1 --track W1', elapsed: 80 },
    { pid: 40, ppid: 30, args: 'codex exec work', elapsed: 70 }];
  const pane = { panePid: 10, name: 'a', created: 123 };
  const live = findWorkers(ps, new Map([[30, '/same']]), [pane]);
  assert.deepEqual(live[0].owner, { name: 'a', created: 123 });
  ps[2].ppid = 1;
  assert.equal(findWorkers(ps, new Map([[30, '/same']]), [pane])[0].owner, null);
  const retained = retainWorkers(retainWorkers([], live, 1000), [], 2000);
  assert.deepEqual(retained[0].owner, live[0].owner);
  assert.equal(retainWorkers(live, [{ ...live[0], owner: null, dispatcherPid: 999 }], 3000)[0].owner, null);
  const snap = parsePoll('@@PS\n30 20 2 bash crew-dispatch.sh --task t --track W1\n@@SESS\n$0|~|a|~|0|~|123|~|20|~|bash|~|/same\n@@DETAIL\n$0|~|10|~|0|~|\n@@OWNERS\n$0|~|10\n$0|~|20\n@@END', 30);
  assert.equal(snap.workers[0].owner.name, 'a');
  assert.equal(snap.sessions[0].pane_pid, 10);
});
test('daily totals persist observed intervals, deduplicate failures, rotate local day', () => {
  const { advance, dayKey, MAX_GAP_MS, leaders } = require('../lib/daily');
  const start = new Date(2026, 10, 1, 10).getTime();
  let s = { name: 'a', created: 10, state: 'run' };
  let data = advance(null, 'server', [s], start);
  data = advance(JSON.parse(JSON.stringify(data)), 'server', [s], start + 3000);
  assert.equal(leaders(data).run[0].value, 3000);
  data = advance(data, 'server', [s], start + 3000 + MAX_GAP_MS + 1);
  assert.equal(leaders(data).run[0].value, 3000);
  s = { ...s, state: 'wait', dead: true, exitStatus: 2 };
  data = advance(data, 'server', [s], start + 100000);
  data = advance(data, 'server', [s], start + 103000);
  assert.equal(leaders(data).wait[0].value, 3000);
  assert.equal(leaders(data).failures[0].value, 1);
  data = advance(data, 'server', [s], new Date(2026, 10, 2, 0).getTime());
  assert.equal(data.summary.day, dayKey(start));
  assert.equal(data.summary.leaders.run[0].value, 3000);
  assert.deepEqual(leaders(data).run, []);
  assert.deepEqual(leaders(data).failures, []);
  data = advance(data, '', [], new Date(2026, 10, 3, 0).getTime());
  data = advance(data, 'server', [s], new Date(2026, 10, 3, 0, 0, 3).getTime());
  assert.deepEqual(leaders(data).failures, []);
});
test('pet preferences validate names, choices, keys and sound without overwriting other settings', () => {
  const { cleanPrefs } = require('../lib/parse');
  const key = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/one';
  const value = { name: '<Cat>', kind: 'cat', hat: 'winter' };
  assert.deepEqual(cleanPrefs({ pets: { [key]: value }, sound: true }).pets[key], value);
  assert.equal(cleanPrefs({ sound: false }, { pets: { [key]: value } }).pets[key].name, '<Cat>');
  for (const patch of [{ sound: 'yes' }, { pets: [] }, { pets: { '../x': value } }, { pets: { [key]: { ...value, kind: 'script' } } }, { pets: { [key]: { ...value, hat: '<img>' } } }]) assert.throws(() => cleanPrefs(patch));
});

test('weather and house load use preference thresholds and actual server warnings', () => {
  const h = sceneHarness();
  const server = { id: 's', on: true, sessions: [], cpu: 60, ram: 60, disk: 60, sys: { failed: [] } };
  const sync = (limits) => h.api.sync([server], true, true, () => {}, limits);
  sync({ cpu: 95, ram: 90, disk: 90 });
  assert.match(h.nodes['pet-weather'].textContent, /Nhẹ nhàng/);
  sync({ cpu: 50, ram: 90, disk: 90 });
  assert.match(h.nodes['pet-weather'].textContent, /Tải cao/);
  assert.ok(h.nodes['.house'].classes.has('high-cpu'));
  sync({ cpu: 50, ram: 50, disk: 50 });
  assert.match(h.nodes['pet-weather'].textContent, /Nhiều cảnh báo/);
  assert.ok(h.nodes['.house'].classes.has('high-ram'));
  assert.ok(h.nodes['.house'].classes.has('high-disk'));
});

test('diary persists observed transitions, records explicit replies and reliable outcomes only', () => {
  const D = require('../lib/diary');
  let s = { name: 'one', created: 1, state: 'run', lines: ['success!'] };
  let data = D.observe(null, 'srv', [s], 100);
  assert.deepEqual(D.entries(data, 'srv', s).map(e => e.type), ['observed']);
  s = { ...s, state: 'wait' };
  data = D.observe(JSON.parse(JSON.stringify(data)), 'srv', [s], 200);
  data = D.observe(data, 'srv', [s], 300);
  D.answered(data, 'srv', s, 350);
  s = { ...s, state: 'run' };
  data = D.observe(data, 'srv', [s], 400);
  s = { ...s, dead: true, exitStatus: 0 };
  data = D.observe(data, 'srv', [s], 500);
  data = D.observe(data, 'srv', [s], 600);
  assert.deepEqual(D.entries(data, 'srv', s).map(e => e.type), ['observed', 'waiting', 'answered', 'resumed', 'finish']);
  assert.equal(D.entries(data, 'other', s).length, 0);
  assert.equal(D.entries(data, 'srv', { ...s, created: 2 }).length, 0);
  for (let i = 0; i < 100; i++) data = D.observe(data, 'srv', [{ ...s, dead: false, state: i % 2 ? 'wait' : 'run' }], 1000 + i);
  assert.equal(D.entries(data, 'srv', s).length, D.LIMITS.entries);
  data = D.observe(data, 'srv', Array.from({ length: 600 }, (_, i) => ({ name: 's' + i, created: 1, state: 'run' })), 2000);
  assert.equal(Object.keys(data).length, D.LIMITS.sessions);
});

test('house pets populate an empty yard, sleep 23–06, and share random activities',()=>{
 for(const hour of [23,0,5]){const h=sceneHarness({hour});h.sync([]);h.tick(24000);assert.equal(h.nodes['pet-yard'].querySelectorAll('.yard-pet.act-sleep').length,3);}
 for(const [random,action] of [[.1,'soccer'],[.5,'fish'],[.9,'walk']]){const h=sceneHarness({random});h.sync([]);h.tick(24000);assert.ok(h.nodes['pet-yard'].querySelectorAll('.yard-pet.act-'+action).length>=2);}
});
