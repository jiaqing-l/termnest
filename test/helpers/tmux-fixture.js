'use strict';

// tmux owns the pane process. Exit cleanly when our private server closes the
// terminal (or respawn-pane replaces it), so a subreaper sees a successful child.
// Install handlers BEFORE printing: visible content also proves shutdown is ready.
// exec avoids leaving an intermediate shell; quote both argv values for POSIX sh
// so apostrophes, backslashes, Unicode and terminal escapes survive unchanged.
const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
function paneCommand(lines, { alternate = false } = {}) {
  const output = lines.join('\n') + '\n' + (alternate ? '\x1b[?1049h' : '');
  const script = `process.on('SIGHUP', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
process.stdout.write(${JSON.stringify(output)});`;
  return `exec ${quote(process.execPath)} -e ${quote(script)}`;
}

module.exports = { paneCommand };
