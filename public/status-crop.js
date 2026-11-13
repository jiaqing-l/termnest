'use strict';
// Hides tmux's own status bar rows inside an xterm pane without touching the tmux session: the pane asks tmux for that many
// extra rows and the host element (overflow:hidden) clips them. detect() only answers when it is sure; otherwise 0 (do nothing).
(function (root) {
  var MAX_ROWS = 3;
  // A status row = every cell of the row has the same, non-default background colour (green by default in tmux), none is
  // inverse video, and at least one row of the group has text. The whole screen being one colour is not a status bar.
  function rowInfo(line, cols, cell) {
    if (!line || line.length < cols || cols < 8) return null;
    var first = line.getCell(0, cell); if (!first || first.isBgDefault() || first.isInverse()) return null;
    var mode = first.getBgColorMode(), color = first.getBgColor(), text = false;
    for (var x = 0; x < cols; x++) {
      var c = line.getCell(x, cell); if (!c) return null;
      if (c.isBgDefault() || c.isInverse() || c.getBgColorMode() !== mode || c.getBgColor() !== color) return null;
      if (!text) { var ch = c.getChars(); if (ch && ch !== ' ') text = true; }
    }
    return { text: text };
  }
  function detect(term, max) {
    try {
      var buf = term && term.buffer && term.buffer.active; if (!buf) return 0;
      var rows = term.rows, cols = term.cols, cell = buf.getNullCell && buf.getNullCell(), n = 0, text = false;
      if (!cell || rows < 6) return 0;
      for (var r = rows - 1; r >= 0 && n < (max || MAX_ROWS); r--) {
        var info = rowInfo(buf.getLine(buf.baseY + r), cols, cell); if (!info) break;
        n++; text = text || info.text;
      }
      // A fourth coloured row above the group means a coloured screen, not a status bar: uncertain.
      if (n === (max || MAX_ROWS) && rows - 1 - n >= 0 && rowInfo(buf.getLine(buf.baseY + rows - 1 - n), cols, cell)) return 0;
      return text && n < rows - 2 ? n : 0;
    } catch (e) { return 0; }
  }
  var api = { detect: detect, MAX_ROWS: MAX_ROWS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.StatusCrop = api;
})(typeof window !== 'undefined' ? window : globalThis);
