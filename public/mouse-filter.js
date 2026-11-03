'use strict';
// Claude Code asks the terminal to report mouse events (DECSET 1000/1002/1003/1006…). xterm.js then forwards every
// drag to the app, so text cannot be highlighted or copied without holding Option/Shift. This filter removes only the
// mouse-reporting modes from the output stream, so plain drag selects text; everything else passes through unchanged.
(function (root, factory) { if (typeof module === 'object') module.exports = factory(); else root.MouseFilter = factory(); })(typeof window === 'object' ? window : this, function () {
  var MOUSE = { 9: 1, 1000: 1, 1001: 1, 1002: 1, 1003: 1, 1004: 0, 1005: 1, 1006: 1, 1015: 1, 1016: 1 };
  var MAX_PENDING = 48;
  var RESET = '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l';
  function concat(a, b) { var o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; }
  function create() {
    var pending = new Uint8Array(0);
    // Input and output are Uint8Array; sequences split across chunks are held until complete.
    function push(chunk) {
      var data = pending.length ? concat(pending, chunk) : chunk, n = data.length, i = 0, start = 0, parts = [], hold = -1;
      pending = new Uint8Array(0);
      while (i < n) {
        if (data[i] !== 0x1b) { i++; continue; }
        if (i + 1 >= n) { hold = i; break; }
        if (data[i + 1] !== 0x5b) { i++; continue; }
        if (i + 2 >= n) { hold = i; break; }
        if (data[i + 2] !== 0x3f) { i += 2; continue; }
        var j = i + 3;
        while (j < n && ((data[j] >= 0x30 && data[j] <= 0x39) || data[j] === 0x3b)) j++;
        if (j >= n) { if (n - i <= MAX_PENDING) { hold = i; break; } i = j; continue; }
        var final = data[j];
        if (final !== 0x68 && final !== 0x6c) { i = j + 1; continue; }
        var modes = String.fromCharCode.apply(null, data.subarray(i + 3, j)).split(';').filter(Boolean);
        var keep = modes.filter(function (m) { return !MOUSE[Number(m)]; });
        if (keep.length === modes.length) { i = j + 1; continue; }
        parts.push(data.subarray(start, i));
        if (keep.length) parts.push(new TextEncoder().encode('\x1b[?' + keep.join(';') + String.fromCharCode(final)));
        start = i = j + 1;
      }
      if (hold >= 0) { parts.push(data.subarray(start, hold)); pending = data.slice(hold); }
      else parts.push(data.subarray(start, n));
      var size = parts.reduce(function (s, p) { return s + p.length; }, 0), out = new Uint8Array(size), at = 0;
      parts.forEach(function (p) { out.set(p, at); at += p.length; });
      return out;
    }
    return { push: push, reset: function () { pending = new Uint8Array(0); } };
  }
  return { create: create, RESET: RESET };
});
