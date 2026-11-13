'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), os = require('os'), path = require('path');
const { tokenRuntime } = require('../lib/token-source');

function codexFile(dir, lines) {
  const folder = path.join(dir, 'sessions', '2026', '01', '01'); fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, 'rollout-a.jsonl'); fs.writeFileSync(file, lines.join('\n') + '\n'); return file;
}
const meta = { timestamp: '2026-01-01T00:00:00Z', type: 'session_meta', payload: { id: '11111111-1111-1111-1111-111111111111', cwd: '/x/proj' } };
const count = (total, at = '2026-01-01T00:00:01Z') => ({ timestamp: at, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: total } } } });

test('lines without usage markers are skipped but usage and project are still read', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-stream-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  codexFile(dir, [JSON.stringify(meta), JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(3000000) } }), JSON.stringify(count(120)), JSON.stringify(count(200, '2026-01-01T00:00:02Z'))]);
  const row = await tokenRuntime().read({ id: 'c', tool: 'codex', directory: dir }, {}, { zone: 'UTC', quota: false });
  assert.equal(row.buckets.reduce((n, b) => n + b.total, 0), 200);
  assert.equal(row.buckets[0].project, 'proj');
});

test('a file with a line over 16 MB is not re-read while unchanged, and totals do not change', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-stream-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = codexFile(dir, [JSON.stringify(meta), JSON.stringify({ type: 'x', payload: { text: 'y'.repeat(17 * 1048576) } }), JSON.stringify(count(50))]);
  const rt = tokenRuntime(), cache = {};
  const first = await rt.read({ id: 'c', tool: 'codex', directory: dir }, cache, { zone: 'UTC', quota: false });
  const bytes = cache.bytes; assert.ok(bytes > 0); assert.ok(cache.failed[file]);
  const second = await rt.read({ id: 'c', tool: 'codex', directory: dir }, cache, { zone: 'UTC', quota: false });
  assert.equal(cache.bytes, bytes);
  assert.deepEqual(second.buckets, first.buckets); assert.equal(second.reason, first.reason);
  fs.appendFileSync(file, JSON.stringify(count(60)) + '\n');
  await rt.read({ id: 'c', tool: 'codex', directory: dir }, cache, { zone: 'UTC', quota: false });
  assert.ok(cache.bytes > bytes);
});
