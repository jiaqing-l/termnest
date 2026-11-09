'use strict';
const { shq } = require('./parse');

// Types a message into a tmux session. A newline inside the message becomes Ctrl+J, which Claude Code and Codex read as
// "new line" (a plain Enter would send the half-written message); the final Enter, when asked for, submits it.
function keysScript(target, text, enter) {
  const t = shq(target), parts = [];
  String(text).split('\n').forEach((line, i) => {
    if (i > 0) parts.push(`tmux send-keys -t ${t} C-j`);
    if (line) parts.push(`tmux send-keys -l -t ${t} -- ${shq(line)}`);
  });
  // Claude Code treats fast multi-line or long input as a paste; an Enter typed inside that paste only adds a newline and the
  // prompt stays unsent. Let the paste settle first.
  if (enter && (String(text).includes('\n') || String(text).length > 200)) parts.push('sleep 0.6');
  if (enter) parts.push(`tmux send-keys -t ${t} Enter`);
  return parts.join(' && ');
}

// Newlines are allowed, every other control character is not.
const BAD = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/;

module.exports = { keysScript, BAD };
