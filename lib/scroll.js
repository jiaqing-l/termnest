'use strict';
const { shq, validName } = require('./parse');
const MAX_LINES = 500;
const OPS = new Set(['state', 'up', 'down', 'top', 'bottom']);
const FORMAT = '#{pane_in_mode}|#{scroll_position}|#{history_size}|#{alternate_on}|#{pane_height}';

// tmux owns the scrollback: the browser terminal only shows tmux's redraw, so wheel and scrollbar
// drive tmux copy-mode instead of letting xterm turn the wheel into Up/Down keys for the app.
function scrollScript(name, op, n = 1) {
  if (!validName(name)) throw new Error('Invalid session');
  if (!OPS.has(op)) throw new Error('Invalid scroll op');
  const lines = Math.max(1, Math.min(MAX_LINES, Math.floor(Number(n)) || 1));
  const t = shq(`=${name}:`);
  const state = `tmux display-message -p -t ${t} ${shq(FORMAT)}`;
  // History-less panes (an app on the alternate screen) have nothing to scroll: never enter copy-mode there.
  const guard = `[ "$(tmux display-message -p -t ${t} '#{history_size}')" -gt 0 ] 2>/dev/null`;
  const inMode = `[ "$(tmux display-message -p -t ${t} '#{pane_in_mode}')" = 1 ]`;
  const body = {
    state: ':',
    up: `${guard} && { tmux copy-mode -e -t ${t}; tmux send-keys -t ${t} -X -N ${lines} scroll-up; }`,
    down: `${inMode} && tmux send-keys -t ${t} -X -N ${lines} scroll-down`,
    top: `${guard} && { tmux copy-mode -e -t ${t}; tmux send-keys -t ${t} -X history-top; }`,
    bottom: `${inMode} && tmux send-keys -t ${t} -X cancel`,
  }[op];
  return `${body} >/dev/null 2>&1; ${state}`;
}

function parseScrollState(out) {
  const f = String(out).trim().split('\n').pop().split('|');
  // tmux leaves scroll_position empty outside copy-mode.
  if (f.length !== 5 || !f.every((x, i) => /^\d+$/.test(x) || (i === 1 && x === ''))) throw new Error('Invalid scroll state');
  const [inMode, position, history, alternate, height] = f.map((x) => Number(x) || 0);
  return { inMode: inMode === 1, position, history, alternate: alternate === 1, height };
}

module.exports = { scrollScript, parseScrollState, MAX_LINES, OPS };
