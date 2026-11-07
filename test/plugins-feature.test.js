'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const pl = require('../lib/features/plugins');

const T0 = 1_800_000_000_000;
const list = (installed) => JSON.stringify({ installed });
const devkit = (o) => ({ id: 'kit@local', version: '0.6.2', folderVersion: '0.6.8', readFromFolder: '/src/kit', scope: 'project', projectPath: '/w', enabled: true, projectEnabled: true, lastUpdated: '2026-10-19T08:30:06.983Z', ...o });

test('the plugin list is Claude Code\'s own answer per (account, folder); the folder version is the one actually loaded', () => {
  const out = ['@@CFG .claude|', list([devkit({ enabled: false, projectEnabled: false, readFromFolder: undefined, folderVersion: undefined })]),
    '@@CFG .claude|/w', list([devkit()]), '@@CFG .claude-b|', 'not json'].join('\n');
  const r = pl.parseList(out);
  assert.deepEqual(r.accounts.map((a) => [a.cfg, a.cwd, a.plugins.length]), [['.claude', '', 1], ['.claude', '/w', 1], ['.claude-b', '', 0]]);
  const p = r.accounts[1].plugins[0];
  assert.deepEqual([p.version, p.running, p.folder, p.enabled], ['0.6.2', '0.6.8', '/src/kit', true]);
  assert.equal(r.accounts[0].plugins[0].enabled, false);
  assert.equal(pl.parseList('@@NOCLAUDE').noClaude, true);
});

test('a session is stale only when a plugin it uses changed after it started (or after TERMNEST last reloaded it)', () => {
  const state = { accounts: pl.parseList(['@@CFG .claude|/w', list([devkit()])].join('\n')).accounts, mtimes: { '/src/kit': T0 } };
  const sess = (name, startedAt, o = {}) => ({ name, path: '/w', aiCwd: '/w', aiStatus: { tool: 'claude', status: 'idle', at: T0, startedAt, cfg: '.claude', ...o } });
  const snap = { sessions: [sess('old', T0 - 1000), sess('new', T0 + 1000), sess('other', T0 - 1000, { cfg: '.claude-b' }),
    { ...sess('elsewhere', T0 - 1000), aiCwd: '/x', path: '/x' }, sess('parked', T0 - 1000, { parked: true, job: { status: 'idle', at: T0, startedAt: T0 + 5 } })] };
  assert.deepEqual(pl.staleSessions(state, snap, {}).map((x) => x.session), ['old']);
  assert.deepEqual(pl.staleSessions(state, snap, { ['old/' + (T0 - 1000)]: T0 + 1 }).map((x) => x.session), []);
});

test('/reload-plugins is typed only when Claude reports idle at its own prompt', () => {
  const s = (st, o = {}) => ({ name: 'a', aiStatus: { tool: 'claude', status: st, ...o } });
  assert.equal(pl.readyFor(s('idle')), true);
  for (const x of [s('busy'), s('waiting'), s('idle', { parked: true }), { ...s('idle'), asking: true }, { name: 'a' }, s('idle', { tool: 'codex' })]) assert.equal(pl.readyFor(x), false);
});

test('the binary asked is the session\'s own process, and folders are quoted', () => {
  const sc = pl.listScript([{ cfg: '.claude', cwd: "/w/it's here", pid: 42 }]);
  assert.match(sc, /readlink "\/proc\/42\/exe"/);
  assert.match(sc, /lsof -a -p 42 -d txt/);
  assert.ok(sc.includes("'/w/it'\\''s here'"));
});
