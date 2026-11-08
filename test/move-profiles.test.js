'use strict';
const test = process.platform === 'win32' ? require('node:test').skip : require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), cp = require('node:child_process');
const move = require('../lib/features/move');
const id = '11111111-2222-4333-8444-555555555555', other = '66666666-7777-4888-9999-000000000000';
const shq = x => "'" + String(x).replace(/'/g, "'\\''") + "'";
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tn-profiles-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const A = path.join(root, 'a'), B = path.join(root, 'b');
  for (const h of [A, B]) fs.mkdirSync(path.join(h, 'empty-work'), { recursive: true });
  return { root, A, B, cwd: path.join(A, 'empty-work'), dst: path.join(B, 'empty-work') };
}
function put(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); return file; }
function auth(home, profile, email) { return put(profile === '.claude' ? path.join(home, '.claude.json') : path.join(home, profile, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email }, secret: 'NEVER-RETURN-AUTH' })); }
function chat(home, profile, cwd, session = id, text = 'selected chat') { return put(path.join(home, profile, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), session + '.jsonl'), JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: text } }) + '\n'); }
function env(home, extra = {}) { return { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', ...extra }; }
function runtime(home, fn, a, extra = {}, forbidAuth = false) {
  const guard = forbidAuth ? `const F=require('fs').promises,old=F.open;F.open=function(p,...a){if(/(?:auth|\\.claude)\\.json$/.test(p))throw Error('credential read during discovery');return old.call(this,p,...a)};` : '';
  const r = cp.spawnSync(process.execPath, ['-e', guard + '(' + fn.toString() + ')()(' + JSON.stringify(a) + ').then(v=>process.stdout.write(JSON.stringify(v)))'], { env: env(home, extra), encoding: 'utf8', maxBuffer: move.MAX_BYTES * 2 });
  assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
}
function harness(f, session, options = {}) {
  const calls = [], sent = [], failed = [], starts = [], stops = [], routes = {};
  function machine(home, sessions) {
    return { cfg: { id: path.basename(home) }, mode: 'native', snapshot: { sessions }, exec: async (command, timeout, maxBuffer, input) => {
      calls.push({ home, command, input: !!input });
      if (command.includes('function verifyRuntime()')) { options.beforeProof?.(); return { code: 0, out: JSON.stringify({ verified: options.verified === true }) }; }
      if (command.startsWith('tmux send-keys ')) return { code: options.launchFail ? 1 : 0, out: '' };
      const r = cp.spawnSync('sh', ['-c', command], { env: env(home), input, maxBuffer: move.MAX_BYTES * 2 });
      if (input && r.status === 0) options.afterWrite?.();
      return { code: r.status, out: String(r.stdout), err: String(r.stderr) };
    } };
  }
  const a = machine(f.A, [session]), b = machine(f.B, []);
  move.register({ route: (method, route, fn) => { routes[method + route] = fn; }, backendOf: id => ({ a, b }[id]), shq,
    readJson: async req => req.body, send: (res, status, body) => sent.push(body), fail: (res, status, message, extra) => failed.push({ message, ...extra }),
    sessions: { start: async (backend, args) => starts.push(args), stop: async (backend, name) => { stops.push(name); return true; } } });
  const check = async (extra = {}) => { const n = sent.length; await routes['GET/check']({ res: {}, url: new URL('http://fixture/check?' + new URLSearchParams({ server: 'a', session: session.name, to: 'b', ...extra })) }); return sent.length > n ? sent.at(-1) : null; };
  const run = async extra => { const n = sent.length; await routes['POST/run']({ res: {}, req: { body: { server: 'a', session: session.name, to: 'b', dir: f.dst, name: 'moved', ...extra } } }); return sent.length > n ? sent.at(-1) : null; };
  return { calls, sent, failed, starts, stops, a, b, check, run };
}

test('exact UUID discovery finds agent03, carries provenance and reads only its account', t => {
  const f = fixture(t); auth(f.A, '.claude', 'wrong@fixture.invalid'); auth(f.A, '.claude-agent03', 'right@fixture.invalid');
  chat(f.A, '.claude', f.cwd, other, 'WRONG PROFILE CHAT'); const source = chat(f.A, '.claude-agent03', f.cwd);
  chat(f.A, '.claude-technology', f.cwd, other, 'unrelated');
  const found = runtime(f.A, move.sourceRuntime, { tool: 'claude', id, dir: f.cwd, max: move.MAX_BYTES }, {}, true);
  assert.equal(found.profile, path.join(f.A, '.claude-agent03')); assert.equal(Buffer.from(found.b64, 'base64').toString(), fs.readFileSync(source, 'utf8'));
  assert.ok(!JSON.stringify(found).includes('WRONG PROFILE'));
  const account = runtime(f.A, move.accountRuntime, { tool: 'claude', profile: found.profile });
  assert.equal(account.email, 'right@fixture.invalid'); assert.equal(account.mode, 'config'); assert.ok(!JSON.stringify(account).includes('NEVER-RETURN-AUTH'));
  fs.unlinkSync(path.join(f.A, '.claude-agent03', '.claude.json'));
  assert.equal(runtime(f.A, move.accountRuntime, { tool: 'claude', profile: found.profile }).email, '', 'never falls back to the wrong default identity');
});

test('duplicates reject safely; snapshot profile resolves duplicate UUID and account together', async t => {
  const f = fixture(t); for (const p of ['.claude', '.claude-agent03']) { auth(f.A, p, p === '.claude' ? 'wrong@fixture.invalid' : 'right@fixture.invalid'); chat(f.A, p, f.cwd); }
  auth(f.B, '.claude', 'right@fixture.invalid');
  assert.equal(runtime(f.A, move.sourceRuntime, { tool: 'claude', id, dir: f.cwd, max: 0 }).code, 'ambiguous');
  const h = harness(f, { name: 'smart', path: f.cwd, aiTool: 'claude', aiSessionId: id, aiStatus: { cfg: '.claude-agent03', startedAt: 123 } });
  const c = await h.check(); assert.equal(c.profile, path.join(f.A, '.claude-agent03')); assert.equal(c.from, 'right@fixture.invalid'); assert.equal(c.same, true);
  assert.equal(await h.check({ profile: path.join(f.A, '.claude') }), null); assert.equal(h.starts.length, 0);
});

test('recent choices include each profile and never inspect credentials', t => {
  const f = fixture(t); chat(f.A, '.claude', f.cwd, id, 'first profile'); chat(f.A, '.claude-agent03', f.cwd, id, 'second profile');
  auth(f.A, '.claude-agent03', 'right@fixture.invalid');
  const r = runtime(f.A, move.recentRuntime, { tool: 'claude', dir: f.cwd, limit: 12 }, {}, true);
  assert.equal(r.items.length, 2); assert.deepEqual(new Set(r.items.map(c => c.profile)), new Set([path.join(f.A, '.claude'), path.join(f.A, '.claude-agent03')]));
  assert.deepEqual(new Set(r.items.map(c => c.ask)), new Set(['first profile', 'second profile']));
});

test('UUID, profile traversal, symlinked profiles/projects/files and arbitrary source paths are refused', t => {
  const f = fixture(t); const outside = put(path.join(f.root, 'outside', id + '.jsonl'), 'DO NOT READ');
  fs.symlinkSync(path.dirname(outside), path.join(f.A, '.claude-agent03'));
  assert.equal(runtime(f.A, move.sourceRuntime, { tool: 'claude', id, dir: f.cwd, profile: '.claude-agent03', max: 99 }).code, 'profile');
  for (const p of ['../a/.claude', '/etc', '.claude/../.claude', '.claude\n']) assert.equal(runtime(f.A, move.sourceRuntime, { tool: 'claude', id, dir: f.cwd, profile: p, max: 99 }).code, 'profile');
  assert.equal(runtime(f.A, move.sourceRuntime, { tool: 'claude', id: '../'.repeat(12), dir: f.cwd }).code, 'invalid');
  const file = chat(f.A, '.claude', f.cwd); fs.unlinkSync(file); fs.symlinkSync(outside, file);
  assert.equal(runtime(f.A, move.sourceRuntime, { tool: 'claude', id, dir: f.cwd, max: 99, sourcePath: outside }).code, 'notfound');
  fs.rmSync(path.join(f.A, '.claude', 'projects'), { recursive: true }); fs.symlinkSync(path.dirname(outside), path.join(f.A, '.claude', 'projects'));
  assert.equal(runtime(f.A, move.sourceRuntime, { tool: 'claude', id, dir: f.cwd, max: 99 }).code, 'notfound');
});

test('custom CODEX_HOME and archived sessions preserve the dated relative placement', t => {
  const f = fixture(t), profile = path.join(f.A, 'custom-codex'), rel = '2026/11/08/rollout-fixture-' + id + '.jsonl';
  put(path.join(profile, 'archived_sessions', rel), JSON.stringify({ type: 'session_meta', payload: { cwd: f.cwd } }) + '\n');
  const token = 'header.' + Buffer.from(JSON.stringify({ email: 'codex@fixture.invalid' })).toString('base64url') + '.signature';
  put(path.join(profile, 'auth.json'), JSON.stringify({ tokens: { id_token: token } }));
  const args = { tool: 'codex', id, dir: f.cwd, max: move.MAX_BYTES };
  const got = runtime(f.A, move.sourceRuntime, args, { CODEX_HOME: profile }, true);
  assert.equal(got.profile, profile); assert.equal(got.rel, rel);
  assert.equal(runtime(f.A, move.accountRuntime, { tool: 'codex', profile }, { CODEX_HOME: profile }).email, 'codex@fixture.invalid');
  assert.equal(runtime(f.A, move.recentRuntime, { tool: 'codex', dir: f.cwd }, { CODEX_HOME: profile }, true).items[0].profile, profile);
});

test('agent03 survey, explicit target profile, empty non-git folder, rewrite and bound resume work together', async t => {
  const f = fixture(t); auth(f.A, '.claude', 'wrong@fixture.invalid'); auth(f.A, '.claude-agent03', 'same@fixture.invalid');
  auth(f.B, '.claude', 'wrong@fixture.invalid'); auth(f.B, '.claude-agent07', 'same@fixture.invalid');
  const original = chat(f.A, '.claude-agent03', f.cwd), before = fs.readFileSync(original);
  const h = harness(f, { name: 'smart', path: f.cwd, aiTool: 'claude', aiSessionId: id });
  const first = await h.check(); assert.equal(first.same, false); assert.ok(first.targetProfiles.includes(path.join(f.B, '.claude-agent07')));
  const c = await h.check({ targetProfile: path.join(f.B, '.claude-agent07') }); assert.equal(c.same, true); assert.ok(c.places.every(p => p.why !== 'repo'));
  assert.equal(c.sourceMode, 'config'); assert.equal(c.targetMode, 'config');
  const moved = await h.run({ profile: c.profile, targetProfile: c.targetProfile, receipt: c.receipt, stop: false });
  assert.equal(moved.ok, true); assert.equal(moved.stopped, false); assert.equal(h.stops.length, 0);
  const landed = path.join(f.B, '.claude-agent07', 'projects', f.dst.replace(/[^A-Za-z0-9]/g, '-'), id + '.jsonl');
  assert.equal(fs.readFileSync(landed, 'utf8'), before.toString().split(f.cwd).join(f.dst)); assert.deepEqual(fs.readFileSync(original), before);
  assert.equal(fs.existsSync(path.join(f.B, '.claude', 'projects')), false);
  const launch = h.calls.find(c => c.command.startsWith('tmux send-keys ')).command;
  assert.equal(launch, `tmux send-keys -t ${shq('=moved:')} ${shq(`env CLAUDE_CONFIG_DIR=${shq(c.targetProfile)} claude --resume ${shq(id)}`)} Enter`);
  assert.equal(h.starts[0].run, 'shell');
});

test('normal default Claude accounts and resume use HOME/.claude.json with the config env unset', async t => {
  const f = fixture(t);
  for (const home of [f.A, f.B]) {
    auth(home, '.claude', 'default@fixture.invalid');
    const who = runtime(home, move.accountRuntime, { tool: 'claude', profile: path.join(home, '.claude') });
    assert.deepEqual(who, { email: 'default@fixture.invalid', profile: path.join(home, '.claude'), mode: 'default' });
    assert.equal(fs.existsSync(path.join(home, '.claude', '.claude.json')), false);
  }
  const source = chat(f.A, '.claude', f.cwd), original = fs.readFileSync(source);
  const h = harness(f, { name: 'smart', path: f.cwd, aiTool: 'claude', aiSessionId: id, aiStatus: { cfg: '.claude' } }, { verified: true });
  const c = await h.check(); assert.equal(c.same, true); assert.equal(c.sourceMode, 'default'); assert.equal(c.targetMode, 'default');
  const r = await h.run({ profile: c.profile, targetProfile: c.targetProfile, receipt: c.receipt, stop: true });
  assert.equal(r.ok, true); assert.equal(r.stopped, true); assert.deepEqual(h.stops, ['smart']);
  const launch = h.calls.find(c => c.command.startsWith('tmux send-keys ')).command;
  assert.equal(launch, `tmux send-keys -t ${shq('=moved:')} ${shq(`env -u CLAUDE_CONFIG_DIR claude --resume ${shq(id)}`)} Enter`);
  assert.ok(h.calls.find(c => c.command.includes('function verifyRuntime()')).command.includes('"mode":"default"'));
  assert.deepEqual(fs.readFileSync(source), original);
  assert.equal(fs.existsSync(path.join(f.B, '.claude', '.claude.json')), false, 'never creates or copies credentials to match launch mode');
});

test('conflicting top-level and nested default Claude identities reject on either host', async t => {
  for (const side of ['A', 'B']) {
    const f = fixture(t);
    auth(f.A, '.claude', 'checked@fixture.invalid'); auth(f.B, '.claude', 'checked@fixture.invalid');
    const nested = put(path.join(f[side], '.claude', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'launched@fixture.invalid' }, secret: 'NEVER-RETURN-AUTH' }));
    const before = fs.readFileSync(nested); chat(f.A, '.claude', f.cwd);
    assert.equal(runtime(f[side], move.accountRuntime, { tool: 'claude', profile: path.join(f[side], '.claude') }).code, 'account');
    const h = harness(f, { name: 'smart', path: f.cwd, aiTool: 'claude', aiSessionId: id });
    const c = await h.check(); assert.equal(c.same, false); assert.equal(side === 'A' ? c.from : c.to, '');
    assert.equal(await h.run({ stop: true }), null); assert.equal(h.calls.filter(c => c.input).length, 0);
    assert.equal(h.starts.length, 0); assert.equal(h.stops.length, 0); assert.deepEqual(fs.readFileSync(nested), before);
    assert.ok(!JSON.stringify(h.sent).includes('launched@fixture.invalid')); assert.ok(!JSON.stringify(h.sent).includes('NEVER-RETURN-AUTH'));
  }
});

test('nested default metadata never substitutes for missing normal default identity', t => {
  const f = fixture(t);
  for (const home of [f.A, f.B]) {
    put(path.join(home, '.claude', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'nested@fixture.invalid' } }));
    const who = runtime(home, move.accountRuntime, { tool: 'claude', profile: path.join(home, '.claude') });
    assert.equal(who.email, ''); assert.equal(who.mode, 'default');
  }
});

test('source append during upload or just before stop keeps the old session and reports an incomplete move', async t => {
  for (const [when, stop] of [['afterWrite', false], ['afterWrite', true], ['beforeProof', true]]) {
    const f = fixture(t); auth(f.A, '.claude', 'same@fixture.invalid'); auth(f.B, '.claude', 'same@fixture.invalid');
    const source = chat(f.A, '.claude', f.cwd), original = fs.readFileSync(source), tail = JSON.stringify({ type: 'user', message: { content: 'new source message' } }) + '\n';
    const h = harness(f, { name: 'smart', path: f.cwd, aiTool: 'claude', aiSessionId: id }, { verified: true, [when]: () => fs.appendFileSync(source, tail) });
    const c = await h.check();
    assert.equal(await h.run({ receipt: c.receipt, stop }), null);
    assert.equal(h.failed.at(-1).code, 'stale'); assert.equal(h.failed.at(-1).incomplete, true); assert.equal(h.failed.at(-1).stopped, false);
    assert.equal(h.stops.length, 0); assert.equal(h.starts.length, when === 'afterWrite' ? 0 : 1);
    assert.equal(h.calls.filter(c => c.command.startsWith('tmux send-keys ')).length, when === 'afterWrite' ? 0 : 1);
    assert.equal(fs.readFileSync(source, 'utf8'), original.toString() + tail);
    const landed = path.join(f.B, '.claude', 'projects', f.dst.replace(/[^A-Za-z0-9]/g, '-'), id + '.jsonl');
    assert.equal(fs.readFileSync(landed, 'utf8'), original.toString().split(f.cwd).join(f.dst));
    assert.ok(!fs.readFileSync(landed, 'utf8').includes('new source message'), 'fixture proves the target is an older prefix');
    if (when === 'afterWrite') {
      assert.equal(await h.run({ stop: true }), null, 'a retry cannot overwrite a different existing target');
      assert.equal(h.stops.length, 0); assert.equal(h.starts.length, 0);
    }
  }
});

test('source account, profile path and snapshot identity are rechecked after upload', async t => {
  for (const change of ['account', 'profile', 'snapshot']) {
    const f = fixture(t); auth(f.A, '.claude-agent03', 'same@fixture.invalid'); auth(f.B, '.claude', 'same@fixture.invalid');
    chat(f.A, '.claude-agent03', f.cwd);
    const options = { verified: true }, session = { name: 'smart', path: f.cwd, aiTool: 'claude', aiSessionId: id, aiStatus: { cfg: '.claude-agent03' } };
    const h = harness(f, session, options);
    options.afterWrite = () => {
      if (change === 'account') auth(f.A, '.claude-agent03', 'changed@fixture.invalid');
      if (change === 'snapshot') session.aiSessionId = other;
      if (change === 'profile') {
        fs.renameSync(path.join(f.A, '.claude-agent03'), path.join(f.A, '.claude-original'));
        fs.symlinkSync(path.join(f.A, '.claude-original'), path.join(f.A, '.claude-agent03'));
      }
    };
    assert.equal(await h.run({ stop: true }), null); assert.equal(h.failed.at(-1).code, 'stale');
    assert.equal(h.starts.length, 0); assert.equal(h.stops.length, 0);
  }
});

test('target collision and symlink reject without overwrite, resume, or stopping source', async t => {
  for (const kind of ['collision', 'symlink']) {
    const f = fixture(t); auth(f.A, '.claude', 'same@fixture.invalid'); auth(f.B, '.claude', 'same@fixture.invalid'); chat(f.A, '.claude', f.cwd);
    const target = chat(f.B, '.claude', f.dst, id, 'unrelated destination bytes'), original = fs.readFileSync(target);
    if (kind === 'symlink') { const external = put(path.join(f.root, 'victim'), original); fs.unlinkSync(target); fs.symlinkSync(external, target); }
    const h = harness(f, { name: 'smart', path: f.cwd, aiTool: 'claude', aiSessionId: id });
    assert.equal(await h.run({ stop: true }), null); assert.deepEqual(fs.readFileSync(target), original); assert.equal(h.starts.length, 0); assert.equal(h.stops.length, 0);
  }
});

test('stale file/account/profile receipts, arbitrary UUID and unknown folder choices cannot cause side effects', async t => {
  const f = fixture(t); auth(f.A, '.claude', 'same@fixture.invalid'); const targetAuth = auth(f.B, '.claude', 'same@fixture.invalid'); const source = chat(f.A, '.claude', f.cwd);
  chat(f.A, '.claude', path.join(f.A, 'different-folder'), other, 'not this session');
  const h = harness(f, { name: 'smart', path: f.cwd, aiTool: 'claude', aiSessionId: id });
  const c = await h.check(); fs.appendFileSync(source, '{}\n');
  assert.equal(await h.run({ receipt: c.receipt }), null); assert.equal(h.failed.at(-1).code, 'stale');
  const c2 = await h.check(); fs.writeFileSync(targetAuth, JSON.stringify({ oauthAccount: { emailAddress: 'changed@fixture.invalid' } }));
  assert.equal(await h.run({ receipt: c2.receipt }), null); assert.equal(h.failed.at(-1).code, 'stale');
  assert.equal(await h.run({ id: other }), null);
  const unknown = harness(f, { name: 'old', path: f.cwd, aiTool: 'claude' }); assert.equal(await unknown.check({ id: other }), null);
  assert.equal(h.calls.filter(c => c.input).length, 0); assert.equal(h.starts.length, 0); assert.equal(h.stops.length, 0);
});

test('the 40MB cap remains accurate and never reads an oversized chat into the response', async t => {
  const f = fixture(t); auth(f.A, '.claude-agent03', 'same@fixture.invalid'); auth(f.B, '.claude', 'same@fixture.invalid');
  const source = chat(f.A, '.claude-agent03', f.cwd); fs.truncateSync(source, move.MAX_BYTES + 1);
  const h = harness(f, { name: 'smart', path: f.cwd, aiTool: 'claude', aiSessionId: id });
  const c = await h.check(); assert.equal(c.size, move.MAX_BYTES + 1); assert.equal(c.tooLarge, true);
  assert.equal(await h.run({ stop: true }), null); assert.equal(h.calls.filter(c => c.input).length, 0); assert.equal(h.stops.length, 0);
  const got = runtime(f.A, move.sourceRuntime, { tool: 'claude', id, dir: f.cwd, max: Number.MAX_SAFE_INTEGER }); assert.equal(got.code, 'toolarge'); assert.equal(got.b64, undefined);
});

test('failed resume dispatch never stops the source', async t => {
  const f = fixture(t); auth(f.A, '.claude', 'same@fixture.invalid'); auth(f.B, '.claude', 'same@fixture.invalid'); chat(f.A, '.claude', f.cwd);
  const h = harness(f, { name: 'smart', path: f.cwd, aiTool: 'claude', aiSessionId: id }, { launchFail: true });
  assert.equal(await h.run({ stop: true }), null); assert.equal(h.stops.length, 0);
});

test('rewrite expansion is refused before allocating a result above the cap', () => {
  const rewritten = move.rewritePaths('/a'.repeat(50000), '/a', '/' + 'x'.repeat(1000));
  assert.equal(rewritten.tooLarge, true); assert.equal(rewritten.text, null);
});

test('stop proof requires a live descendant with exact UUID, working folder and config', { skip: process.platform !== 'linux' }, async t => {
  const f = fixture(t), profile = path.join(f.B, '.claude-agent07'), bin = path.join(f.root, 'bin');
  const executable = put(path.join(f.root, 'claude'), 'process.stdout.write("ready\\n");setInterval(()=>{},1000);');
  const fakeTmux = put(path.join(bin, 'tmux'), '#!/bin/sh\nprintf "%s\\n" ' + process.pid + '\n'); fs.chmodSync(fakeTmux, 0o700);
  const child = cp.spawn(process.execPath, [executable, '--resume', id], { cwd: f.dst, env: env(f.B, { CLAUDE_CONFIG_DIR: profile }), stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill()); await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
  const args = { tool: 'claude', id, dir: f.dst, profile, name: 'moved' }, extra = { PATH: bin + ':' + process.env.PATH };
  assert.equal(runtime(f.B, move.verifyRuntime, args, extra).verified, true);
  assert.equal(runtime(f.B, move.verifyRuntime, { ...args, profile: path.join(f.B, '.claude') }, extra).verified, false);
  assert.equal(runtime(f.B, move.verifyRuntime, { ...args, id: other }, extra).verified, false);
  assert.equal(runtime(f.B, move.verifyRuntime, { ...args, dir: f.cwd }, extra).verified, false);
  assert.equal(runtime(f.B, move.verifyRuntime, { ...args, mode: 'default' }, extra).verified, false);
});

test('default Claude stop proof requires unset config, the exact HOME, UUID and default mode', { skip: process.platform !== 'linux' }, async t => {
  const f = fixture(t), profile = path.join(f.B, '.claude'), bin = path.join(f.root, 'bin');
  const executable = put(path.join(f.root, 'claude'), 'process.stdout.write("ready\\n");setInterval(()=>{},1000);');
  const fakeTmux = put(path.join(bin, 'tmux'), '#!/bin/sh\nprintf "%s\\n" ' + process.pid + '\n'); fs.chmodSync(fakeTmux, 0o700);
  const args = { tool: 'claude', id, dir: f.dst, profile, mode: 'default', name: 'moved' }, extra = { PATH: bin + ':' + process.env.PATH };
  for (const kind of ['normal', 'explicitNested', 'otherHome']) {
    const childEnv = env(kind === 'otherHome' ? f.A : f.B); delete childEnv.CLAUDE_CONFIG_DIR;
    if (kind === 'explicitNested') childEnv.CLAUDE_CONFIG_DIR = profile;
    const child = cp.spawn(process.execPath, [executable, '--resume', id], { cwd: f.dst, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => child.kill()); await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
    assert.equal(runtime(f.B, move.verifyRuntime, args, extra).verified, kind === 'normal', kind);
    if (kind === 'normal') {
      assert.equal(runtime(f.B, move.verifyRuntime, { ...args, mode: 'config' }, extra).verified, false);
      assert.equal(runtime(f.B, move.verifyRuntime, { ...args, id: other }, extra).verified, false);
    }
    child.kill(); await new Promise(resolve => child.once('exit', resolve));
  }
});

test('UUID already stored in another destination project rejects instead of ambiguous resume', async t => {
  const f = fixture(t); auth(f.A, '.claude', 'same@fixture.invalid'); auth(f.B, '.claude', 'same@fixture.invalid'); chat(f.A, '.claude', f.cwd);
  const existing = chat(f.B, '.claude', path.join(f.B, 'different-work'), id, 'destination history'), before = fs.readFileSync(existing);
  const h = harness(f, { name: 'smart', path: f.cwd, aiTool: 'claude', aiSessionId: id });
  assert.equal(await h.run({ stop: true }), null); assert.deepEqual(fs.readFileSync(existing), before); assert.equal(h.starts.length, 0); assert.equal(h.stops.length, 0);
});

test('an unproved target leaves the source running even after the user requests stop', async t => {
  const f = fixture(t); auth(f.A, '.claude', 'same@fixture.invalid'); auth(f.B, '.claude', 'same@fixture.invalid'); chat(f.A, '.claude', f.cwd);
  const h = harness(f, { name: 'smart', path: f.cwd, aiTool: 'claude', aiSessionId: id });
  const r = await h.run({ stop: true }); assert.equal(r.ok, true); assert.equal(r.stopped, false); assert.equal(h.stops.length, 0);
});

test('wrong default target account cannot receive a selected source profile', async t => {
  const f = fixture(t); auth(f.A, '.claude-agent03', 'right@fixture.invalid'); auth(f.B, '.claude', 'wrong@fixture.invalid'); chat(f.A, '.claude-agent03', f.cwd);
  const h = harness(f, { name: 'smart', path: f.cwd, aiTool: 'claude', aiSessionId: id });
  assert.equal(await h.run({ stop: true }), null); assert.equal(h.calls.filter(c => c.input).length, 0); assert.equal(h.starts.length, 0); assert.equal(h.stops.length, 0);
});
