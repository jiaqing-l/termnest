'use strict';
// macOS-style editing keys for the browser terminal. xterm.js sends a plain backspace for Cmd+Backspace and a bare
// Enter for Shift+Enter, so deleting a line was slow and a chat composer could not take a newline. The sequences
// below are the ones Terminal.app/iTerm send; Claude Code and Codex both accept them (checked in a real pane).
(function (root, factory) { if (typeof module === 'object') module.exports = factory(); else root.TerminalKeys = factory(); })(typeof window === 'object' ? window : this, function () {
  var NEWLINE = '\n';          // Ctrl+J: a new line in the composer, never a send
  var LINE_START = '\x01', LINE_END = '\x05';   // Ctrl+A / Ctrl+E
  var KILL_TO_START = '\x15';  // Ctrl+U: delete back to the start of the line
  var WORD_BACK = '\x1b\x7f', WORD_LEFT = '\x1bb', WORD_RIGHT = '\x1bf';
  // Returns the bytes to send for a key event, or null to leave it to xterm.
  function sequence(e, isMac) {
    if (!e || e.type !== 'keydown' || e.isComposing || e.keyCode === 229) return null;
    var key = e.key, meta = e.metaKey, alt = e.altKey, ctrl = e.ctrlKey, shift = e.shiftKey;
    if (key === 'Enter') return shift && !meta && !alt && !ctrl ? NEWLINE : null;
    if (key === 'Backspace') {
      if (meta && !alt && !ctrl) return KILL_TO_START;
      if (alt && !meta && !ctrl) return WORD_BACK;
      if (ctrl && !isMac && !meta && !alt) return WORD_BACK;
      return null;
    }
    if (shift) return null;
    if (key === 'ArrowLeft') return meta && !alt && !ctrl ? LINE_START : alt && !meta && !ctrl ? WORD_LEFT : null;
    if (key === 'ArrowRight') return meta && !alt && !ctrl ? LINE_END : alt && !meta && !ctrl ? WORD_RIGHT : null;
    return null;
  }
  return { sequence: sequence, NEWLINE: NEWLINE };
});
