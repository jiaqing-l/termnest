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
  case "\${f##*/}" in prompt-*|devdb.log) continue ;; esac
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
// A Codex worker log is "<time> <line>" with marker lines (exec / codex / apply patch / thinking / tokens used). Turn its tail
// into what the worker is doing right now, one short line each: a command and how it ended, a file it edits, what it says.
// (Same format as the activity feed in features/crewpack.js, which runs on the remote host and so cannot share this code.)
function workerFeed(text, max = 40) {
  const MARK = /^(exec|codex|apply patch|user|thinking|tokens used)$/;
  const lines = String(text || '').split('\n').map((l) => { const m = /^(\d{4}-\d\d-\d\dT[\d:]+[+-]\d{4}) ?(.*)$/.exec(l); return m ? m[2] : null; }).filter((l) => l !== null);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i];
    if (!MARK.test(t)) continue;
    const block = []; let j = i + 1;
    for (; j < lines.length && !MARK.test(lines[j]) && block.length < 60; j++) block.push(lines[j]);
    if (t === 'exec') {
      const cmd = (block[0] || '').replace(/ in \/\S+$/, '').replace(/^\/bin\/(?:z|ba)?sh -lc /, '').replace(/^"(.*)"$/, '$1').slice(0, 200);
      const res = block.map((b) => /^ ?(succeeded|exited (-?\d+)|failed) in (\d+)ms:/.exec(b)).find(Boolean);
      out.push('$ ' + cmd + (res ? (res[1] === 'succeeded' ? '  ✔ ' : '  ✖ ' + (res[2] ? 'exit ' + res[2] + ' ' : '')) + (Number(res[3]) / 1000).toFixed(1) + 's' : '  …'));
    } else if (t === 'codex') {
      const say = block.filter((b) => b.trim()).join(' ').trim();
      if (say) out.push('› ' + say.slice(0, 300));
    } else if (t === 'thinking') {
      const say = block.filter((b) => b.trim()).join(' ').trim();
      if (say) out.push('· ' + say.slice(0, 160));
    } else if (t === 'apply patch') {
      const files = [...new Set(block.filter((b) => /^\/\S+$/.test(b.trim())).map((b) => b.trim().split('/').slice(-2).join('/')))];
      out.push('✎ ' + (files.slice(0, 8).join(', ') || 'apply patch') + (block.some((b) => /^patch: (?:failed|rejected)/.test(b)) ? '  ✖' : ''));
    }
    i = j - 1;
  }
  return out.slice(-max).join('\n');
}
// One script for many tracks of one task root: one SSH channel instead of one per track. Same safety rules as logScript (no
// client-supplied filenames, readlink -f containment, symlink rejection, 64 KB tail). Each record starts with a line
// "<nonce> <index> <result>" (the nonce is random per call so log text can never forge one) and runs to the next record.
const NONCE = /^[a-f0-9]{16,64}$/;
function batchLogScript({ cwd, items, nonce }) {
  if (!NONCE.test(nonce || '') || !Array.isArray(items) || !items.length || items.length > 60) throw new Error('Invalid batch');
  for (const w of items) trackDir({ cwd, task: w.task, track: w.track });
  const list = items.map((w, i) => `one ${i} ${w.task} ${w.track}`).join('\n');
  return `base=$(readlink -f -- ${shq(cwd)}) || exit 3
one() {
  i=$1; task=$2; trk=$3
  track="$base/_crew/tasks/$task/tracks/$trk"
  printf '\\n${nonce} %s ' "$i"
  [ "$(readlink -f -- "$track")" = "$track" ] || { echo denied; return; }
  logs="$track/logs"
  [ "$(readlink -f -- "$logs")" = "$logs" ] || { echo denied; return; }
  latest=''
  for f in "$logs"/*; do
    [ -f "$f" ] && [ ! -L "$f" ] || continue
    case "\${f##*/}" in prompt-*|devdb.log) continue ;; esac
    [ -z "$latest" ] || [ "$f" -nt "$latest" ] || continue
    latest="$f"
  done
  if [ -n "$latest" ]; then real=$(readlink -f -- "$latest") || latest=''; case "$real" in "$logs"/*) ;; *) latest='' ;; esac; fi
  result=unknown
  [ -f "$track/DONE" ] && [ ! -L "$track/DONE" ] && result=DONE
  [ -f "$track/FAILED" ] && [ ! -L "$track/FAILED" ] && result=FAILED
  printf '%s\\n' "$result"
  [ -z "$latest" ] || tail -c 65536 -- "$latest"
}
${list}
exit 0`;
}
// -> array aligned with items: { result, text, feed } or { error } for a track the host refused.
function parseBatch(out, nonce, items) {
  const res = items.map(() => ({ error: 'missing' }));
  const parts = String(out || '').split('\n' + nonce + ' ');
  for (const part of parts.slice(1)) {
    const nl = part.indexOf('\n'), head = (nl < 0 ? part : part.slice(0, nl)).split(' '), i = Number(head[0]), what = head[1];
    if (!Number.isInteger(i) || i < 0 || i >= items.length) continue;
    if (what === 'denied') { res[i] = { error: 'denied' }; continue; }
    let text = nl < 0 ? '' : part.slice(nl + 1);
    const lines = text.split('\n'); if (lines.length > 200) text = lines.slice(-200).join('\n');
    res[i] = { result: ['DONE', 'FAILED'].includes(what) ? what : 'unknown', text, feed: workerFeed(nl < 0 ? '' : part.slice(nl + 1)) };
  }
  return res;
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
module.exports = { trackDir, logScript, batchLogScript, parseBatch, workerFeed, retainWorkers, RETAIN_MS };
