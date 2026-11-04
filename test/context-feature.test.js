'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ctx = require('../lib/features/context');

const line = (o) => JSON.stringify(o) + '\n';
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-ctx-'));
  const work = path.join(home, 'work', 'proj'); fs.mkdirSync(work, { recursive: true });
  // Claude: project dir name replaces every non-alphanumeric character with '-'
  const cdir = path.join(home, '.claude', 'projects', work.replace(/[^A-Za-z0-9]/g, '-')); fs.mkdirSync(cdir, { recursive: true });
  fs.writeFileSync(path.join(cdir, 's1.jsonl'),
    line({ type: 'user', message: { role: 'user' } }) +
    line({ type: 'assistant', message: { model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 149000, output_tokens: 50 } } }) +
    line({ type: 'assistant', message: { model: '<synthetic>', usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }) + '{not json\n');
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
  assert.deepEqual({ ...out.a, at: 0 }, { tool: 'claude', ctx: 150010, window: 200000, by: 'default', model: 'opus-5-5', at: 0 });
});

test('Codex context uses the newest token_count and the model window, matched by session directory', async () => {
  const f = fixture(); fs.mkdirSync(f.other2);
  const out = await ctx.contextRuntime()({ home: f.home, sessions: [{ name: 'c', path: f.other2 }, { name: 'none', path: path.join(f.home, 'nowhere') }] });
  assert.equal(out.c.tool, 'codex'); assert.equal(out.c.ctx, 377723); assert.equal(out.c.window, 475000);
  assert.equal(out.none, undefined);
});

test('a window above 200k means the 1M variant, and stale or malformed sessions are skipped', async () => {
  const f = fixture(); const file = path.join(f.home, '.claude', 'projects', f.work.replace(/[^A-Za-z0-9]/g, '-'), 's1.jsonl');
  fs.appendFileSync(file, line({ type: 'assistant', message: { model: 'claude-opus-5-5', usage: { input_tokens: 5, cache_read_input_tokens: 400000 } } }));
  const out = await ctx.contextRuntime()({ home: f.home, sessions: [{ name: 'a', path: f.work }, { name: 5, path: 1 }, null] });
  assert.equal(out.a.window, 1000000); assert.equal(out.a.ctx, 400005);
  const old = new Date(Date.now() - 20 * 3600 * 1000); fs.utimesSync(file, old, old);
  assert.deepEqual(await ctx.contextRuntime()({ home: f.home, sessions: [{ name: 'a', path: f.work }] }), {});
});

function claudeSession(home, work, extra) {
  const cdir = path.join(home, '.claude', 'projects', work.replace(/[^A-Za-z0-9]/g, '-')); fs.mkdirSync(cdir, { recursive: true });
  fs.writeFileSync(path.join(cdir, 's1.jsonl'), extra + line({ type: 'assistant', message: { model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 40000, output_tokens: 5 } } }));
}
test('the window of a Claude session below 200k comes from its last /model switch, else the config folder model setting', async () => {
  const run = (f) => ctx.contextRuntime()({ home: f.home, sessions: [{ name: 'a', path: f.work }] });
  const base = () => { const f = fixture(); fs.rmSync(path.join(f.home, '.claude'), { recursive: true }); return f; };
  let f = base(); claudeSession(f.home, f.work, line({ type: 'user', message: { content: 'Set model to opus[1m]' } }));
  assert.deepEqual([(await run(f)).a.window, (await run(f)).a.by], [1000000, 'switch']);
  f = base(); claudeSession(f.home, f.work, line({ message: 'Set model to opus[1m]' }) + line({ message: 'Set model to sonnet' }));
  assert.deepEqual([(await run(f)).a.window, (await run(f)).a.by], [200000, 'switch']);
  f = base(); claudeSession(f.home, f.work, ''); fs.writeFileSync(path.join(f.home, '.claude', 'settings.json'), JSON.stringify({ model: 'opus[1m]' }));
  assert.deepEqual([(await run(f)).a.window, (await run(f)).a.by], [1000000, 'settings']);
  fs.writeFileSync(path.join(f.home, '.claude', 'settings.json'), JSON.stringify({ model: 'sonnet[1m]' }));
  assert.deepEqual([(await run(f)).a.window, (await run(f)).a.by], [200000, 'default'], 'a setting for another model family must not apply');
});

const cpc = require('node:child_process');
const hasTmuxCtx = process.platform !== 'win32' && cpc.spawnSync('tmux', ['-V']).status === 0;
test('sessions sharing one folder each get the log that matches their screen; an unmatched one gets nothing', { skip: !hasTmuxCtx }, async () => {
  const f = fixture(); fs.rmSync(path.join(f.home, '.claude'), { recursive: true });
  const proj = path.join(f.home, '.claude', 'projects', f.work.replace(/[^A-Za-z0-9]/g, '-')); fs.mkdirSync(proj, { recursive: true });
  const A = ['Alpha session discusses the pipeline migration gate', 'Alpha also reviewed the host mapping rules again'], B = ['Beta session builds the notes reminder feature', 'Beta wrote the tests for the reminder scheduler'];
  const log = (lines, cache) => lines.map((t) => line({ type: 'assistant', message: { model: 'claude-opus-5-5', content: t, usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: cache } } })).join('');
  fs.writeFileSync(path.join(proj, 'a.jsonl'), log(A, 111000)); fs.writeFileSync(path.join(proj, 'b.jsonl'), log(B, 55000));
  const sock = 'twctx' + process.pid, say = (name, lines) => cpc.execFileSync('tmux', ['-L', sock, 'new-session', '-d', '-s', name, '-x', '200', '-y', '40', `printf '%s\\n' ${lines.map((l) => `'${l}'`).join(' ')}; sleep 30`]);
  try {
    say('sa', A); say('sb', B); say('sc', ['Nothing that any log contains, just some filler text here', 'Another unrelated line that matches no transcript at all']);
    await new Promise((r) => setTimeout(r, 500));
    const out = await ctx.contextRuntime()({ home: f.home, socket: sock, sessions: ['sa', 'sb', 'sc'].map((name) => ({ name, path: f.work })) });
    assert.equal(out.sa.ctx, 111001); assert.equal(out.sb.ctx, 55001); assert.equal(out.sc, undefined);
  } finally { cpc.spawnSync('tmux', ['-L', sock, 'kill-server']); }
});
