'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const health = require('../lib/features/health');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-health-'));
  const task = (id, tracks) => { const d = path.join(root, '_crew', 'tasks', id); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'MANIFEST.md'), `---\ntracks: ${tracks}\n---\n`); };
  task('t-merged', '[{ id: W0, state: merged }, { id: W1, state: merged }]');
  task('t-running', '[{ id: W0, state: merged }, { id: W1, state: dispatched }]');
  task('t-nowt', '[{ id: W0, state: merged }]');
  for (const n of ['_wt-t-merged-W0', '_wt-t-merged-W1', '_wt-t-running-W1']) { fs.mkdirSync(path.join(root, n)); fs.writeFileSync(path.join(root, n, 'f'), 'x'.repeat(2048)); }
  return root;
}

test('offers only tasks whose tracks are all merged and that still have worktrees', async () => {
  const root = fixture(), out = await health.healthRuntime()({ cwd: root });
  assert.deepEqual(out.candidates.map((c) => [c.task, c.worktrees]), [['t-merged', 2]]);
  assert.ok(out.diskFreeGb > 0 && out.memFreePct >= 0 && out.cpus > 0);
});

test('a directory without _crew still reports machine health and no candidates', async () => {
  const out = await health.healthRuntime()({ cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'tw-nh-')) });
  assert.equal(out.root, ''); assert.deepEqual(out.candidates, []);
});

test('level flags low disk, low memory and overload', () => {
  assert.equal(health.level({ diskFreeGb: 50, memFreePct: 50, load: 1, cpus: 8 }).level, 'ok');
  assert.equal(health.level({ diskFreeGb: 8, memFreePct: 50, load: 1, cpus: 8 }).level, 'warn');
  assert.equal(health.level({ diskFreeGb: 3, memFreePct: 50, load: 1, cpus: 8 }).level, 'bad');
  assert.equal(health.level({ diskFreeGb: 50, memFreePct: 5, load: 20, cpus: 8 }).reasons.length, 2);
});

test('task ids are validated before reaching the shell', () => {
  assert.ok(health.TASK.test('20261102-sv-perf'));
  for (const bad of ['', '../x', 'a b', 'a;rm -rf', '$(x)', '-x']) assert.ok(!health.TASK.test(bad));
});
