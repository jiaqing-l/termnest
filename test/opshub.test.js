'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const hub = require('../lib/features/opshub');

const NOW = 1_800_000_000_000;
const claude = (name, status, o = {}) => ({ name, created: 111, cmd: 'claude', paneIds: o.pane ? [o.pane] : [], lines: o.lines || ['❯ '], asking: status === 'waiting',
  aiTool: 'claude', aiStatus: { tool: 'claude', status, at: o.at || NOW - 5 * 60000, waitingFor: o.waitingFor || '', ...(o.fresh ? { fresh: true } : {}), cfg: o.cfg || '.claude' } });

function harness(o = {}) {
  let t = o.now || NOW;
  const store = { ...(o.settings || {}) }, routes = {}, calls = [], files = {}, sent = [], started = [], stopped = [];
  const remote = { cfg: { id: 'm1', name: 'dev-ubuntu-02' }, ready: true, lastPoll: t, mode: 'native',
    snapshot: { hostname: 'dev-ubuntu-02', cpu: 30, ram: 40, sessions: o.sessions || [], workers: o.workers || [] },
    exec: async (cmd) => { calls.push(cmd); return { code: 0, out: '' }; }, poll: async () => {} };
  const host = {
    remotes: () => [remote], settings: { get: () => ({ ...store }), set: (v) => { for (const k of Object.keys(store)) delete store[k]; Object.assign(store, v); } },
    service: (k) => k === 'supervision' ? { crew: () => o.crew || [] } : null,
    sessions: { start: async (r, x) => { started.push(x); r.snapshot.sessions.push({ name: x.name, created: 222, cmd: 'zsh', lines: [] }); }, stop: async (r, name) => { stopped.push(name); r.snapshot.sessions = r.snapshot.sessions.filter((s) => s.name !== name); } },
    route: (m, p, fn) => { routes[m + ' ' + p] = fn; }, readJson: async (req) => req.body, log: () => {},
    send: (res, code, body) => { res.code = code; res.body = body; }, fail: (res, code, msg, extra) => { res.code = code; res.body = { error: msg, ...(extra || {}) }; },
  };
  const runOnHost = async (r, runtime, a) => {
    if (a.op === 'put') { files[a.dir + '/fleet.json'] = JSON.parse(require('zlib').gunzipSync(Buffer.from(a.gz, 'base64')).toString()); return { ok: true }; }
    const f = files[a.dir + '/' + (a.kind === 'report' ? 'reports/' + a.id + '.json' : 'answers/' + a.id + '.md')];
    return f === undefined ? { found: false } : { found: true, text: f };
  };
  let n = 0;
  const api = hub.register(host, { now: () => t, runOnHost, setInterval: () => ({}), clearInterval: () => {}, newId: () => 'id' + String(++n).padStart(8, '0'),
    fetch: async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200 }; } });
  const call = async (m, p, body) => { const res = {}; await routes[m + ' ' + p]({ req: { body }, res }); return res; };
  return { api, host, remote, store, routes, calls, files, sent, started, stopped, call, at: (v) => { t = v; remote.lastPoll = v; }, now: () => t };
}

test('session state comes from the agent status; quota and questions read from the screen; secrets masked', () => {
  assert.equal(hub.stateOf(claude('a', 'idle', { fresh: true })), 'fresh');
  assert.equal(hub.stateOf(claude('a', 'idle')), 'idle');
  assert.equal(hub.stateOf(claude('a', 'busy')), 'busy');
  assert.equal(hub.stateOf(claude('a', 'waiting', { waitingFor: 'dialog_open', lines: ["You've hit your weekly limit · resets Nov 11 at 1pm", 'What do you want to do?'] })), 'quota');
  assert.equal(hub.stateOf(claude('a', 'waiting', { waitingFor: 'permission' })), 'asking');
  assert.equal(hub.stateOf({ name: 's', cmd: 'zsh', lines: [] }), 'shell');
  const q = hub.questionOf({ lines: ['│ Run psql with password=Sup3rS3cret?  │', '❯ 1. Yes', '  2. No'] });
  assert.match(q, /Run psql with/); assert.doesNotMatch(q, /Sup3rS3cret/);
});

test('fleet and rule findings: leaders by pane, questions, exit-code tracks, dormant work left out, offline machines', () => {
  const crew = [{ root: '/ws', nudge: [['%6', 'T1']], tasks: [
    { id: 'T1', title: 'SV2 R7', status: 'running', activeAt: NOW - 60000, tracks: [{ id: 'W0', state: 'failed', lastRound: { result: '7' }, rounds: 1 }, { id: 'W2', state: 'queued', lastRound: { result: '8' } }, { id: 'W5', state: 'done' }], heartbeat: { armed: true, alive: true } },
    { id: 'OLD', title: 'old', status: 'running', activeAt: NOW - 5 * 86400000, tracks: [{ id: 'W1', state: 'running' }] }] }];
  const h = harness({ crew, sessions: [claude('Leader', 'busy', { pane: '%6' }), claude('Display', 'waiting', { waitingFor: 'permission', lines: ['Do you want to run npm test?', '❯ 1. Yes'] }), claude('New', 'idle', { fresh: true })] });
  const f = h.api.fleet();
  assert.deepEqual(f.tasks.map((t) => [t.id, t.leader]), [['T1', 'Leader']]);
  assert.deepEqual(f.waiting.map((s) => [s.name, s.question]), [['Display', 'Do you want to run npm test?']]);
  assert.equal(f.sessions.find((s) => s.name === 'New').state, 'fresh');
  const r = h.api.makeReport('manual');
  const codes = r.findings.map((x) => x.code);
  assert.ok(codes.includes('owner_question') && codes.includes('track_queued') && codes.includes('track_unverified'), codes.join());
  assert.equal(r.findings[0].cat, 'BLOCKER');
  assert.equal(r.ai, null, 'no AI while the Ops session is off');
  h.at(NOW + 10 * 60000); h.remote.lastPoll = NOW; // stale poll = offline
  assert.ok(h.api.makeReport('manual').findings.some((x) => x.code === 'machine_offline'));
});

test('old or finished work is not a running team, even when nudge.conf still names it on a reused pane', () => {
  const crew = [{ root: '/ws', nudge: [['%3', 'OLD-DONE'], ['%4', 'OLD-OPEN']], tasks: [
    { id: 'OLD-DONE', title: 'photo perf', status: 'running', activeAt: NOW - 3600000, tracks: [{ id: 'W0', state: 'done' }, { id: 'W1', state: 'done' }] },
    { id: 'OLD-OPEN', title: 'stale', status: 'running', activeAt: NOW - 6 * 86400000, tracks: [{ id: 'W0', state: 'running' }] }] }];
  const h = harness({ crew, sessions: [claude('Smart-Visibility', 'idle', { pane: '%3' }), claude('AAV-Dev', 'idle', { pane: '%4' })] });
  const f = h.api.fleet();
  assert.deepEqual(f.tasks.map((t) => t.id), []);
  assert.deepEqual(f.sessions.map((s) => s.task), ['', '']);
  assert.ok(!h.api.makeReport('manual').findings.some((x) => x.task === 'OLD-DONE' || x.task === 'OLD-OPEN'));
});

test('a session out of quota shows the limit line, not the status bar', () => {
  const s = claude('GPS', 'idle', { lines: ["You've hit your weekly limit · resets Nov 11 at 1pm", 'new task? /clear to save 182.9k tokens', '▸▸ auto mode on (shift+tab to cycle)'] });
  const h = harness({ sessions: [s] });
  const row = h.api.fleet().sessions[0];
  assert.equal(row.state, 'quota'); assert.match(row.question, /^You've hit your weekly limit · resets Nov 11 at 1pm$/);
});

test('while the Ops session is off nothing is typed or opened anywhere; reports still follow the schedule', async () => {
  const h = harness({ sessions: [claude('A', 'idle')] });
  await h.api.tick();
  assert.equal(h.calls.length, 0); assert.equal(h.started.length, 0);
  assert.equal((h.store.reports || []).length, 1);
  await h.api.tick();
  assert.equal(h.store.reports.length, 1, 'one report per interval');
  h.at(NOW + 31 * 60000); await h.api.tick();
  assert.equal(h.store.reports.length, 2);
});

test('the Ops session: opened once with the chosen account, gets fleet.json and the audit prompt, its JSON becomes the AI report', async () => {
  const h = harness({ sessions: [claude('Leader', 'busy')], settings: { cfg: { enabled: true, server: 'm1', root: '/ws', accounts: ['.claude-tech2', '.claude'], model: 'sonnet', perm: 'acceptEdits', interval: 30 } } });
  await h.api.tick();
  assert.deepEqual(h.started, [{ name: 'tn-ops', dir: '/ws', run: 'shell' }]);
  assert.match(h.calls.join('\n'), /CLAUDE_CONFIG_DIR="\$HOME\/\.claude-tech2" claude --model sonnet --permission-mode acceptEdits --name tn-ops/);
  // Claude starts: its status says idle a moment after start (fresh). The queued audit is sent now.
  Object.assign(h.remote.snapshot.sessions.find((s) => s.name === 'tn-ops'), { cmd: 'claude', aiTool: 'claude', aiStatus: { tool: 'claude', status: 'idle', at: NOW, fresh: true } });
  h.calls.length = 0; await h.api.tick();
  const rep = h.store.reports[0];
  assert.equal(rep.ai.status, 'running');
  assert.ok(h.files['/ws/_crew/ops-hub/fleet.json'].sessions.some((s) => s.name === 'Leader'));
  const cmd = h.calls.join('\n');
  assert.match(cmd, /session_created/); assert.match(cmd, /xspire-crew-ops-audit Termnest Ops run id0000000/);
  assert.match(cmd, new RegExp('/ws/_crew/ops-hub/reports/' + rep.id + '\\.json'));
  // Busy, no file yet: nothing else is sent.
  h.remote.snapshot.sessions.find((s) => s.name === 'tn-ops').aiStatus = { tool: 'claude', status: 'busy', at: NOW + 1000 };
  h.calls.length = 0; await h.api.tick(); assert.equal(h.calls.length, 0);
  h.files['/ws/_crew/ops-hub/reports/' + rep.id + '.json'] = JSON.stringify({ id: rep.id, summary: 'W1 kẹt vì test cũ', findings: [{ cat: 'blocker', session: 'Leader', problem: 'CS7036', next: 'fix-2', owner: 'leader', evidence: 'x.cs:561 token=abc123secret' }, { cat: 'WHAT', problem: 'x', owner: 'boss' }] });
  await h.api.tick();
  const ai = h.store.reports[0].ai;
  assert.equal(ai.status, 'done'); assert.equal(ai.summary, 'W1 kẹt vì test cũ');
  assert.deepEqual(ai.findings.map((x) => [x.cat, x.owner]), [['BLOCKER', 'leader'], ['INFO', 'none']]);
  assert.doesNotMatch(ai.findings[0].evidence, /abc123secret/);
  assert.equal(h.api.ops.phase, 'ready');
});

test('questions go to the Ops session first and the Markdown answer comes back; no answer file means a clear failure', async () => {
  const ops = { name: 'tn-ops', created: 9, cmd: 'claude', aiTool: 'claude', lines: [], aiStatus: { tool: 'claude', status: 'idle', at: NOW - 1000 } };
  const h = harness({ sessions: [ops], settings: { lastReportAt: NOW, cfg: { enabled: true, server: 'm1', root: '/ws', accounts: [], model: 'sonnet', perm: 'acceptEdits', interval: 30 } } });
  const res = await h.call('POST', '/ask', { q: 'Vì sao W1 chưa xanh?' });
  assert.equal(res.body.ask.state, 'queued');
  await h.api.tick();
  assert.match(h.calls.join('\n'), /Termnest Ops question id0000000\d: «Vì sao W1 chưa xanh\?»/);
  assert.doesNotMatch(h.calls.join('\n'), /CLAUDE_CONFIG_DIR/);
  const id = h.store.asks[0].id;
  h.files['/ws/_crew/ops-hub/answers/' + id + '.md'] = '**W1** thiếu tham số `policies`.';
  await h.api.tick();
  assert.equal(h.store.asks[0].state, 'done'); assert.match(h.store.asks[0].answer, /policies/);
  // Next question: Claude ends its turn without writing the file.
  await h.call('POST', '/ask', { q: 'Còn W2?' }); await h.api.tick();
  ops.aiStatus = { tool: 'claude', status: 'idle', at: h.now() + 5000 };
  h.at(h.now() + 60000); await h.api.tick();
  assert.equal(h.store.asks[0].state, 'failed'); assert.equal(h.store.asks[0].code, 'ops_no_result');
  assert.equal((await h.call('POST', '/ask', { q: 'x' })).code, 400);
});

test('out of quota: the next account is used; with none left the session pauses and nothing is sent', async () => {
  const quota = { name: 'tn-ops', created: 9, cmd: 'claude', aiTool: 'claude', lines: ["You've hit your weekly limit · resets Nov 11 at 1pm"], asking: true, aiStatus: { tool: 'claude', status: 'waiting', at: NOW, waitingFor: 'dialog_open' } };
  const h = harness({ sessions: [quota], settings: { lastReportAt: NOW, cfg: { enabled: true, server: 'm1', root: '/ws', accounts: ['.claude-a', '.claude-b'], model: 'sonnet', perm: 'acceptEdits', interval: 30 } } });
  await h.api.tick();
  assert.deepEqual(h.stopped, ['tn-ops']); assert.equal(h.api.ops.account, 1);
  await h.api.tick();
  assert.match(h.calls.join('\n'), /CLAUDE_CONFIG_DIR="\$HOME\/\.claude-b"/);
  // The second account is out too: pause, do not cycle forever.
  const s = h.remote.snapshot.sessions.find((x) => x.name === 'tn-ops'); Object.assign(s, quota, { created: 222 });
  h.at(NOW + 6 * 60000); h.calls.length = 0; await h.api.tick();
  assert.equal(h.api.ops.phase, 'paused'); assert.equal(h.calls.length, 0);
});

test('a late poll is not an outage: the Ops session is reported offline only after two minutes', async () => {
  const h = harness({ sessions: [], settings: { lastReportAt: NOW, cfg: { enabled: true, server: 'm1', root: '/ws', accounts: [], model: 'sonnet', perm: 'auto', interval: 30 } } });
  h.remote.lastPoll = NOW - 90000; await h.api.tick();
  assert.notEqual(h.api.ops.phase, 'error'); assert.equal(h.started.length, 0);
  h.at(NOW + 150000); h.remote.lastPoll = NOW - 90000; await h.api.tick();
  assert.equal(h.api.ops.code, 'ops_machine_offline');
});

test('a question inside the Ops session (trust or permission) is never answered: it waits for the owner', async () => {
  const asking = { name: 'tn-ops', created: 9, cmd: 'claude', aiTool: 'claude', lines: ['Do you trust the files in this folder?'], asking: true, aiStatus: { tool: 'claude', status: 'waiting', at: NOW, waitingFor: 'permission' } };
  const h = harness({ sessions: [asking], settings: { cfg: { enabled: true, server: 'm1', root: '/ws', accounts: [], model: 'sonnet', perm: 'acceptEdits', interval: 30 } } });
  await h.api.tick();
  assert.equal(h.api.ops.phase, 'waiting'); assert.equal(h.calls.length, 0);
});

test('messages out: once per waiting question, Telegram token never returned to the page', async () => {
  const h = harness({ sessions: [claude('Display', 'waiting', { waitingFor: 'permission', lines: ['Bạn duyệt hướng IntegrationService?'] })] });
  assert.equal((await h.call('POST', '/notify', { telegram: { token: 'bad', chat: '1' } })).code, 400);
  assert.equal((await h.call('POST', '/notify', { webhook: { url: 'http://x.example/hook' } })).code, 400);
  const ok = await h.call('POST', '/notify', { telegram: { token: '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1', chat: '-1001234567' } });
  assert.equal(ok.code, 200); assert.doesNotMatch(JSON.stringify(ok.body), /AAHdqTcv/);
  await h.api.tick(); await h.api.tick();
  const tg = h.sent.filter((m) => /api\.telegram\.org\/bot123456789:/.test(m.url));
  assert.equal(tg.length, 1); assert.match(tg[0].body.text, /Display .* đang chờ anh: Bạn duyệt hướng IntegrationService\?/);
  const state = await h.call('GET', '/state'); assert.doesNotMatch(JSON.stringify(state.body), /AAHdqTcv/);
  const cfg = await h.call('GET', '/config'); assert.doesNotMatch(JSON.stringify(cfg.body), /AAHdqTcv/);
  // Keeping the token while changing the chat id.
  assert.equal((await h.call('POST', '/notify', { telegram: { chat: '-1009999999' } })).code, 200);
  assert.match(h.store.notify.telegram.token, /^123456789:/);
});

test('pressing "Report now" repeatedly refreshes one report instead of piling up duplicates', async () => {
  const h = harness({ sessions: [claude('A', 'idle')] });
  for (let i = 0; i < 5; i++) { await h.call('POST', '/audit', {}); h.at(h.now() + 10000); }
  assert.equal(h.store.reports.length, 1);
  h.at(h.now() + 180000); await h.call('POST', '/audit', {});
  assert.equal(h.store.reports.length, 2);
});

test('Refresh polls every machine and rescans crew folders before answering', async () => {
  const h = harness({ sessions: [claude('A', 'idle')] });
  let polled = 0, rescanned = 0;
  h.remote.poll = async () => { polled++; };
  h.host.service = (k) => k === 'supervision' ? { crew: () => [], rescan: async () => { rescanned++; } } : null;
  const res = await h.call('POST', '/refresh', {});
  assert.equal(res.code, 200); assert.equal(polled, 1); assert.equal(rescanned, 1);
});

test('settings are validated; the AI report keeps only known fields', () => {
  assert.throws(() => hub.cleanCfg({ enabled: true }, {}), /invalid_scope/);
  assert.throws(() => hub.cleanCfg({ root: '/ws/../etc' }, {}), /invalid_root/);
  assert.throws(() => hub.cleanCfg({ root: "/ws'; rm -rf /" }, {}), /invalid_root/);
  assert.throws(() => hub.cleanCfg({ accounts: ['../x'] }, {}), /invalid_accounts/);
  assert.throws(() => hub.cleanCfg({ model: 'sonnet; rm' }, {}), /invalid_model/);
  // Only modes this Claude Code accepts; "default" is not one of them any more.
  assert.throws(() => hub.cleanCfg({ perm: 'default' }, {}), /invalid_perm/);
  assert.throws(() => hub.cleanCfg({ perm: 'bypassPermissions' }, {}), /invalid_perm/);
  assert.equal(hub.cleanCfg({}, {}).perm, 'auto');
  assert.deepEqual(hub.cleanCfg({ enabled: true, server: 'm1', root: '/ws/', interval: 60 }, {}).root, '/ws');
  assert.equal(hub.cleanAiReport('{"id":"other","findings":[]}', 'mine'), null);
  assert.equal(hub.cleanAiReport('not json', 'mine'), null);
  assert.equal(hub.cleanAiReport('```json\n{"id":"mine","summary":"ok","findings":[]}\n```', 'mine').summary, 'ok');
});
