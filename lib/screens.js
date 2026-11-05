'use strict';
const { shq, validName } = require('./parse');
const MAX_SESSIONS = 40, MIN_LINES = 4, MAX_LINES = 60;

// One tmux call per server returns the last lines of many sessions: the "All" wall polls with this instead of
// opening a terminal per tile. Trailing blank lines are dropped, so a nearly empty screen costs almost nothing.
function screensScript(names, lines = 14) {
  if (!Array.isArray(names) || !names.length || names.length > MAX_SESSIONS || !names.every(validName)) throw new Error('Invalid sessions');
  const n = Math.max(MIN_LINES, Math.min(MAX_LINES, Math.floor(Number(lines)) || 14));
  const awk = `awk -v L=${n} '{a[NR]=$0} END{m=NR; while(m>0 && a[m] ~ /^[ \\t]*$/) m--; for(i=(m>L?m-L+1:1);i<=m;i++) print a[i]}'`;
  return names.map((name, i) => `echo "@@S ${i}"; tmux -u capture-pane -p -t ${shq(`=${name}:`)} 2>/dev/null | ${awk}`).join('\n');
}

function parseScreens(out, names) {
  const res = {};
  let at = -1, buf = [];
  const flush = () => { if (at >= 0 && at < names.length) res[names[at]] = buf.join('\n').replace(/\n+$/, ''); };
  for (const line of String(out).split('\n')) {
    const m = line.match(/^@@S (\d+)$/);
    if (m) { flush(); at = Number(m[1]); buf = []; } else if (at >= 0) buf.push(line);
  }
  flush();
  return res;
}

module.exports = { screensScript, parseScreens, MAX_SESSIONS, MAX_LINES };
