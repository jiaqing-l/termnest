'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { UsageService, usageScript, normalize, parseReport, validRange, labelOf } = require('../lib/usage');

const claude = { daily: [{ date: '2026-11-02', totalCost: 80.0167, modelBreakdowns: [
  { modelName: 'claude-opus-5-5', inputTokens: 1478, outputTokens: 590616, cacheCreationTokens: 2602041, cacheReadTokens: 182553265, cost: 69.145 },
  { modelName: 'claude-sonnet-5-5', inputTokens: 254, outputTokens: 85347, cacheCreationTokens: 871554, cacheReadTokens: 65313037, cost: 10.871 }] }] };
const codex = { daily: [{ date: '2026-11-02', costUSD: 63.87, models: {
  'gpt-6.1-sol': { inputTokens: 2848880, outputTokens: 466504, cacheCreationTokens: 0, cacheReadTokens: 61342336, totalTokens: 64657720 } } }] };

test('usage scripts run ccusage per tool with the account directory and a pinned version', () => {
  const s = usageScript({ tool: 'claude', directory: '~/.claude-tech2' }, '2026-11-01', '2026-11-30', 'Asia/Ho_Chi_Minh');
  assert.match(s, /command -v npx/);
  assert.match(s, /CLAUDE_CONFIG_DIR="\$HOME"\/'\.claude-tech2' npx -y ccusage@\d+\.\d+\.\d+ claude daily --json --breakdown --since 20261101 --until 20261130 --timezone 'Asia\/Ho_Chi_Minh'/);
  assert.match(usageScript({ tool: 'codex', directory: '/srv/codex home' }, '2026-11-01', '2026-11-02', 'UTC'), /CODEX_HOME='\/srv\/codex home' npx .* codex daily/);
  assert.throws(() => usageScript({ tool: 'gemini', directory: '/x' }, '2026-11-01', '2026-11-02', 'UTC'));
  assert.throws(() => usageScript({ tool: 'claude', directory: '/x' }, '2026-11-01; rm -rf /', '2026-11-02', 'UTC'));
});

test('ranges must be real, ordered and bounded', () => {
  assert.deepEqual(validRange('2026-11-01', '2026-11-30'), { from: '2026-11-01', to: '2026-11-30' });
  for (const [a, b] of [['2026-11-30', '2026-11-01'], ['2026-13-01', '2026-13-02'], ['x', 'y'], ['2025-01-01', '2026-11-30']]) assert.throws(() => validRange(a, b));
});

test('Claude reports cost per model, Codex only per day', () => {
  const [c] = normalize('claude', claude);
  assert.equal(c.cost, 80.0167);
  assert.deepEqual(c.models.map((m) => m.model), ['opus-5-5', 'sonnet-5-5']);
  assert.equal(c.models[0].total, 1478 + 590616 + 2602041 + 182553265);
  const [x] = normalize('codex', codex);
  assert.equal(x.cost, 63.87);
  assert.equal(x.models[0].cost, null);
  assert.equal(x.models[0].total, 64657720);
  assert.deepEqual(normalize('claude', { daily: [{ date: 'bad' }, null] }), []);
  assert.deepEqual(normalize('codex', null), []);
});

test('ccusage output is parsed defensively', () => {
  assert.deepEqual(parseReport('npm warn x\n{"daily":[]}').json, { daily: [] });
  assert.match(parseReport('NO_NPX\n').error, /npx/);
  assert.match(parseReport('').error, /ccusage/);
  assert.match(parseReport('{oops').error, /Không đọc/);
});

test('account labels prefer nickname, then email, then directory', () => {
  assert.equal(labelOf({ id: 'a', nickname: 'Work', directory: '~/.claude' }, new Map([['a', 'x@y']])), 'Work');
  assert.equal(labelOf({ id: 'a', nickname: '', directory: '~/.claude' }, new Map([['a', 'x@y.vn']])), 'x@y.vn');
  assert.equal(labelOf({ id: 'a', nickname: '', directory: '~/.claude-tech2/' }, new Map()), 'claude-tech2');
});

function backend(outputs, log = []) {
  return { cfg: { name: 'dev-box' }, exec: async (cmd) => { log.push(cmd); const next = outputs.shift(); if (next instanceof Error) throw next; return { code: 0, out: next }; } };
}
const cfg = { id: 'a1', hostId: 'h1', tool: 'claude', directory: '~/.claude', nickname: '' };
const range = { from: '2026-11-01', to: '2026-11-30', zone: 'UTC' };

test('results are cached for the ttl and refresh bypasses the cache', async () => {
  let t = 1000; const log = [];
  const svc = new UsageService({ now: () => t, ttl: 60000 });
  const b = backend([JSON.stringify(claude), JSON.stringify(claude), JSON.stringify(claude)], log);
  const get = (refresh) => svc.get(() => b, [cfg], { ...range, refresh });
  const first = await get(false);
  assert.equal(first.accounts[0].days[0].models.length, 2);
  assert.equal(first.accounts[0].hostName, 'dev-box');
  await get(false); assert.equal(log.length, 1);
  await get(true); assert.equal(log.length, 2);
  t += 61000; await get(false); assert.equal(log.length, 3);
});

test('concurrent identical requests share one ccusage run', async () => {
  const log = []; const svc = new UsageService();
  const b = backend([JSON.stringify(claude)], log);
  await Promise.all([1, 2, 3].map(() => svc.get(() => b, [cfg], range)));
  assert.equal(log.length, 1);
});

test('a failed refresh keeps the last good numbers but reports the error', async () => {
  const svc = new UsageService({ ttl: 0 });
  const b = backend([JSON.stringify(claude), new Error('timed out'), 'NO_NPX']);
  await svc.get(() => b, [cfg], range);
  const bad = (await svc.get(() => b, [cfg], range)).accounts[0];
  assert.equal(bad.days.length, 1); assert.equal(bad.stale, true); assert.match(bad.error, /quá lâu/);
  const noNpx = (await svc.get(() => b, [cfg], range)).accounts[0];
  assert.equal(noNpx.stale, true); assert.match(noNpx.error, /npx/);
});

test('an unreachable host or first-run failure shows an error without data', async () => {
  const svc = new UsageService();
  assert.match((await svc.get(() => null, [cfg], range)).accounts[0].error, /chưa kết nối/);
  const none = (await svc.get(() => backend(['NO_NPX']), [{ ...cfg, id: 'a2', directory: '/other' }], range)).accounts[0];
  assert.deepEqual(none.days, []); assert.match(none.error, /npx/);
});
