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
  assert.deepEqual(parseScrollState('1|12|340|0|45\n'), { inMode: true, position: 12, history: 340, alternate: false, height: 45 });
  assert.deepEqual(parseScrollState('noise\n0|0|3|1|30'), { inMode: false, position: 0, history: 3, alternate: true, height: 30 });
  assert.deepEqual(parseScrollState('0||281|0|20'), { inMode: false, position: 0, history: 281, alternate: false, height: 20 });
  assert.throws(() => parseScrollState('oops'));
  assert.throws(() => parseScrollState('1|2|3'));
});
