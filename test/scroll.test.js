'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { scrollScript, parseScrollState, MAX_LINES } = require('../lib/scroll');

test('scroll scripts drive tmux copy-mode and always report state', () => {
  const up = scrollScript('Vifon-SV', 'up', 3);
  assert.match(up, /copy-mode -e -t '=Vifon-SV:'/);
  assert.match(up, /send-keys -t '=Vifon-SV:' -X -N 3 scroll-up/);
  assert.match(up, /history_size/);
  assert.match(up, /display-message -p -t '=Vifon-SV:' '#\{pane_in_mode\}\|/);
  assert.match(scrollScript('a', 'down', 2), /-N 2 scroll-down/);
  assert.match(scrollScript('a', 'bottom'), /-X cancel/);
  assert.match(scrollScript('a', 'top'), /history-top/);
  assert.doesNotMatch(scrollScript('a', 'state'), /copy-mode/);
});

test('scroll scripts clamp counts and reject unsafe names and ops', () => {
  assert.match(scrollScript('a', 'up', 99999), new RegExp(`-N ${MAX_LINES} scroll-up`));
  assert.match(scrollScript('a', 'up', -4), /-N 1 scroll-up/);
  assert.match(scrollScript('a', 'up', 'x; rm -rf /'), /-N 1 scroll-up/);
  assert.throws(() => scrollScript("a'; rm -rf /; '", 'up', 1));
  assert.throws(() => scrollScript('a', 'kill-server', 1));
});

test('scroll state parses tmux output and rejects garbage', () => {
  assert.deepEqual(parseScrollState('1|12|340|0|45\n'), { inMode: true, position: 12, history: 340, alternate: false, height: 45, mouse: false });
  assert.deepEqual(parseScrollState('noise\n0|0|3|1|30'), { inMode: false, position: 0, history: 3, alternate: true, height: 30, mouse: false });
  assert.deepEqual(parseScrollState('0||281|0|20'), { inMode: false, position: 0, history: 281, alternate: false, height: 20, mouse: false });
  assert.throws(() => parseScrollState('oops'));
  assert.throws(() => parseScrollState('1|2|3'));
});

test('state parses the mouse flag and still accepts the older five-field reply', () => {
  assert.deepEqual(parseScrollState('0||120|1|40|1\n'), { inMode: false, position: 0, history: 120, alternate: true, height: 40, mouse: true });
  assert.equal(parseScrollState('1|5|120|0|40\n').mouse, false);
  assert.throws(() => parseScrollState('0||x|1|40|1'));
});

test('copy-mode is only entered when the pane is not on the alternate screen', () => {
  for (const op of ['up', 'top']) assert.match(scrollScript('a', op, 2), /alternate_on}'\)" = 0 \]/);
});

const cp = require('node:child_process');
const hasTmux = process.platform !== 'win32' && cp.spawnSync('tmux', ['-V']).status === 0;
test('a pane on the alternate screen never enters copy-mode, a normal one does', { skip: !hasTmux }, async () => {
  const sock = 'twscroll' + process.pid, run = (...a) => cp.execFileSync('tmux', ['-L', sock, ...a], { encoding: 'utf8' });
  // tmux() in the scripts is the plain binary, so point it at the private server through a wrapper on PATH.
  const dir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tw-scroll-'));
  require('node:fs').writeFileSync(require('node:path').join(dir, 'tmux'), `#!/bin/sh\nexec ${cp.execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim()} -L ${sock} "$@"\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: dir + ':' + process.env.PATH };
  const sh = (script) => cp.execFileSync('sh', ['-c', script], { env, encoding: 'utf8' });
  try {
    run('new-session', '-d', '-s', 's1', '-x', '80', '-y', '10', "seq 1 200; sleep 30");
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(parseScrollState(sh(scrollScript('s1', 'up', 3))).inMode, true);
    sh(scrollScript('s1', 'bottom'));
    run('send-keys', '-t', '=s1:', '-l', ''); run('respawn-pane', '-k', '-t', '=s1:', "seq 1 200; printf '\\033[?1049h'; sleep 30");
    await new Promise((r) => setTimeout(r, 600));
    const st = parseScrollState(sh(scrollScript('s1', 'up', 3)));
    assert.equal(st.alternate, true); assert.equal(st.inMode, false);
  } finally { cp.spawnSync('tmux', ['-L', sock, 'kill-server']); }
});
