'use strict';
const path = require('path').posix;
const { shq } = require('./parse');
const RETAIN_MS = 3600000;
const COMPONENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
function trackDir(w) {
  if (!COMPONENT.test(w.task || '') || !COMPONENT.test(w.track || '') ||
      typeof w.cwd !== 'string' || !w.cwd.startsWith('/') || /[\x00-\x1f\x7f]/.test(w.cwd) ||
      w.cwd.split('/').includes('..')) throw new Error('Invalid worker path');
  return path.join(w.cwd, '_crew/tasks', w.task, 'tracks', w.track);
}
// Never accept a client-supplied filename. Resolve every directory/file on the SSH host,
// rejecting symlink escapes (including an entire logs directory pointing elsewhere).
function logScript(w) {
  const dir = trackDir(w);
  return `base=$(readlink -f -- ${shq(w.cwd)}) || exit 3
track="$base/_crew/tasks/${w.task}/tracks/${w.track}"
[ "$(readlink -f -- ${shq(dir)})" = "$track" ] || exit 3
logs="$track/logs"
[ "$(readlink -f -- "$logs")" = "$logs" ] || exit 3
latest=''
for f in "$logs"/*; do
  [ -f "$f" ] && [ ! -L "$f" ] || continue
  real=$(readlink -f -- "$f") || continue
  case "$real" in "$logs"/*) ;; *) continue ;; esac
  [ -z "$latest" ] || [ "$f" -nt "$latest" ] || continue
  latest="$f"
done
result=unknown
[ -f "$track/DONE" ] && [ ! -L "$track/DONE" ] && result=DONE
[ -f "$track/FAILED" ] && [ ! -L "$track/FAILED" ] && result=FAILED
printf '%s\\n' "$result"
[ -z "$latest" ] || tail -c 65536 -- "$latest"
exit 0`;
}
function retainWorkers(previous, live, now) {
  const key = (w) => w.task && w.track ? `${w.task}/${w.track}` : `${w.kind}/${w.cwd}`;
  const seen = new Set(live.map(key));
  const old = new Map(previous.map((w) => [key(w), w]));
  return live.map((w) => ({ ...w, owner: w.owner || (w.dispatcherPid && w.dispatcherPid === old.get(key(w))?.dispatcherPid && w.elapsed >= old.get(key(w))?.elapsed && !old.get(key(w))?.finishedAt ? old.get(key(w))?.owner : null), observedAt: now, result: 'running', lines: w.lines || old.get(key(w))?.lines || [] }))
    .concat(previous.filter((w) => !seen.has(key(w))).map((w) => w.finishedAt ? w :
      { ...w, finishedAt: now, elapsed: w.elapsed + Math.max(0, now - w.observedAt) / 1000, result: 'unknown' })
      .filter((w) => now - w.finishedAt < RETAIN_MS));
}
module.exports = { trackDir, logScript, retainWorkers, RETAIN_MS };
