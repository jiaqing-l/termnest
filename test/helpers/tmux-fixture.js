'use strict';

// tmux owns the pane process. Exit cleanly when our private server closes the
// terminal (or respawn-pane replaces it), so a subreaper sees a successful child.
// Install handlers BEFORE printing: visible content also proves shutdown is ready.
// Use one POSIX shell with a blocking read builtin: no Node runtime, external
// sleep or intermediate shell remains to abort or be orphaned at terminal close.
// Literal printf data preserves apostrophes, backslashes, Unicode and escapes.
const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
function paneCommand(lines, { alternate = false } = {}) {
  const output = lines.join('\n') + '\n' + (alternate ? '\x1b[?1049h' : '');
  const script = `trap 'exit 0' HUP TERM
printf '%s' ${quote(output)} || exit 1
IFS= read -r fixture_input
# EOF or unexpected input is a fixture failure, never a successful idle exit.
exit 1`;
  return `exec /bin/sh -c ${quote(script)}`;
}

module.exports = { paneCommand };
