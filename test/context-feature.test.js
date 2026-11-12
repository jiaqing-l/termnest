'use strict';
const { paneCommand } = require('./helpers/tmux-fixture');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ctx = require('../lib/features/context');

const line = (o) => JSON.stringify(o) + '\n';
// Claude Code's own model catalog: config.models[].runtime.max_input_tokens, per config folder.
function catalog(dir, windows) {
  const d = path.join(dir, 'cache', 'model-catalog'); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'abc-cc.json'), JSON.stringify({ version: 2, catalog: { config: { models: Object.entries(windows).map(([id, w]) => ({ id, name: id, runtime: { max_input_tokens: w } })) } } }));
}
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-ctx-'));
  const work = path.join(home, 'work', 'proj'); fs.mkdirSync(work, { recursive: true });
  // Claude: project dir name replaces every non-alphanumeric character with '-'
  const cdir = path.join(home, '.claude', 'projects', work.replace(/[^A-Za-z0-9]/g, '-')); fs.mkdirSync(cdir, { recursive: true });
  fs.writeFileSync(path.join(cdir, 's1.jsonl'),
    line({ type: 'user', message: { role: 'user' } }) +
    line({ type: 'assistant', message: { model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 149000, output_tokens: 50 } } }) +
    line({ type: 'assistant', message: { model: '<synthetic>', usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }) + '{not json\n');
  catalog(path.join(home, '.claude'), { 'claude-opus-5-5': 1000000, 'claude-haiku-4-5-20251001': 200000 });
  // Codex: first line is session_meta with cwd; later token_count events
  const d = new Date(), cdx = path.join(home, '.codex', 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  fs.mkdirSync(cdx, { recursive: true });
  const other = path.join(home, 'elsewhere'); fs.mkdirSync(other);
  fs.writeFileSync(path.join(cdx, 'rollout-a.jsonl'), line({ type: 'session_meta', payload: { cwd: other } }) + line({ payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 999 }, model_context_window: 1000 } } }));
  fs.writeFileSync(path.join(cdx, 'rollout-b.jsonl'), line({ type: 'session_meta', payload: { cwd: other + '2' } }) +
    line({ payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 100 }, model_context_window: 475000 } } }) +
    line({ payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 377723 }, model_context_window: 475000 } } }));
  return { home, work, other2: other + '2' };
}

test('Claude context is the last real assistant message (input + cache), ignoring synthetic and broken lines', async () => {
  const f = fixture(); const out = await ctx.contextRuntime()({ home: f.home, sessions: [{ name: 'a', path: f.work }] });
  assert.deepEqual({ ...out.a, at: 0 }, { tool: 'claude', ctx: 150010, window: 1000000, by: 'catalog', model: 'opus-5-5', at: 0 });
});

test('Codex context uses the newest token_count and the model window, matched by session directory', async () => {
  const f = fixture(); fs.mkdirSync(f.other2);
  const out = await ctx.contextRuntime()({ home: f.home, sessions: [{ name: 'c', path: f.other2 }, { name: 'none', path: path.join(f.home, 'nowhere') }] });
  assert.equal(out.c.tool, 'codex'); assert.equal(out.c.ctx, 377723); assert.equal(out.c.window, 475000);
  assert.equal(out.none, undefined);
});

test('stale or malformed sessions are skipped and the window comes from the catalog, not from the amount used', async () => {
  const f = fixture(); const file = path.join(f.home, '.claude', 'projects', f.work.replace(/[^A-Za-z0-9]/g, '-'), 's1.jsonl');
  fs.appendFileSync(file, line({ type: 'assistant', message: { model: 'claude-opus-5-5', usage: { input_tokens: 5, cache_read_input_tokens: 400000 } } }));
  const out = await ctx.contextRuntime()({ home: f.home, sessions: [{ name: 'a', path: f.work }, { name: 5, path: 1 }, null] });
  assert.equal(out.a.window, 1000000); assert.equal(out.a.ctx, 400005);
  const old = new Date(Date.now() - 20 * 3600 * 1000); fs.utimesSync(file, old, old);
  assert.deepEqual(await ctx.contextRuntime()({ home: f.home, sessions: [{ name: 'a', path: f.work }] }), {});
});

test('the window is the catalog value of the session model; a model missing from the catalog has no window at all', async () => {
  const f = fixture(), dir = path.join(f.home, '.claude'), proj = path.join(dir, 'projects', f.work.replace(/[^A-Za-z0-9]/g, '-'));
  const run = () => ctx.contextRuntime()({ home: f.home, sessions: [{ name: 'a', path: f.work }] });
  const write = (model, cache) => fs.writeFileSync(path.join(proj, 's1.jsonl'), line({ type: 'assistant', message: { model, usage: { input_tokens: 1, cache_read_input_tokens: cache } } }));
  write('claude-haiku-4-5-20251001', 90000);
  assert.deepEqual([(await run()).a.window, (await run()).a.by], [200000, 'catalog']);
  write('claude-opus-5-5-20261201', 90000); // a dated id resolves to its catalog family
  assert.deepEqual([(await run()).a.window, (await run()).a.by], [1000000, 'catalog']);
  write('claude-brand-new-9', 90000);
  const unknown = (await run()).a;
  assert.equal(unknown.window, null); assert.equal(unknown.by, 'unknown'); assert.equal(unknown.ctx, 90001);
  fs.rmSync(path.join(dir, 'cache'), { recursive: true });
  write('claude-opus-5-5', 90000);
  assert.equal((await run()).a.window, null, 'no catalog on the host means unknown, never a default');
});

const cpc = require('node:child_process');
const hasTmuxCtx = process.platform !== 'win32' && cpc.spawnSync('tmux', ['-V']).status === 0;
test('sessions sharing one folder each get the log that matches their screen; an unmatched one gets nothing', { skip: !hasTmuxCtx }, async () => {
  const f = fixture(); fs.rmSync(path.join(f.home, '.claude'), { recursive: true });
  const proj = path.join(f.home, '.claude', 'projects', f.work.replace(/[^A-Za-z0-9]/g, '-')); fs.mkdirSync(proj, { recursive: true });
  const A = ['Alpha session discusses the pipeline migration gate', 'Alpha also reviewed the host mapping rules again'], B = ['Beta session builds the notes reminder feature', 'Beta wrote the tests for the reminder scheduler'];
  const log = (lines, cache) => lines.map((t) => line({ type: 'assistant', message: { model: 'claude-opus-5-5', content: t, usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: cache } } })).join('');
  fs.writeFileSync(path.join(proj, 'a.jsonl'), log(A, 111000)); fs.writeFileSync(path.join(proj, 'b.jsonl'), log(B, 55000));
  const sock = 'twctx' + process.pid, say = (name, lines) => cpc.execFileSync('tmux', ['-L', sock, 'new-session', '-d', '-s', name, '-x', '200', '-y', '40', paneCommand(lines)]);
  try {
    say('sa', A); say('sb', B); say('sc', ['Nothing that any log contains, just some filler text here', 'Another unrelated line that matches no transcript at all']);
    await new Promise((r) => setTimeout(r, 500));
    const out = await ctx.contextRuntime()({ home: f.home, socket: sock, sessions: ['sa', 'sb', 'sc'].map((name) => ({ name, path: f.work })) });
    assert.equal(out.sa.ctx, 111001); assert.equal(out.sb.ctx, 55001); assert.equal(out.sc, undefined);
  } finally { cpc.spawnSync('tmux', ['-L', sock, 'kill-server']); }
});

test('context reader looks past the ten newest logs when many sessions share one folder', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../lib/features/context.js'), 'utf8');
  assert.match(src, /for \(const c of cands\.slice\(0, 30\)\)/);
  assert.match(src, /const tails = new Map\(\)/);
  assert.match(src, /capture-pane', '-p', '-J'\], extra/);
});
