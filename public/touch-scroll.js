(function (root) {
  'use strict';
  // Finger swipes become scroll lines, so a phone can read tmux history like a mouse wheel does. A swipe is told apart
  // from a tap by a small slop; once it starts the browser's own panning and the click that would open the keyboard are cancelled.
  // A quick flick keeps gliding after the finger lifts and slows down on its own (momentum), like native scrolling.
  function attach(host, opts) {
    var slop = opts.slop || 8, startY = null, lastY = 0, lastX = 0, acc = 0, moving = false, samples = [], glide = null;
    var now = opts.now || function () { return Date.now(); };
    var hasRaf = typeof root.requestAnimationFrame === 'function';
    var raf = opts.raf || function (fn) { return hasRaf ? root.requestAnimationFrame(fn) : setTimeout(fn, 16); };
    var caf = opts.caf || function (id) { return hasRaf ? root.cancelAnimationFrame(id) : clearTimeout(id); };
    var friction = opts.friction || 0.0035; // fraction of the speed lost per millisecond
    function emit(px, x, y) {
      acc += px;
      var cell = opts.cell() || 16, lines = Math.trunc(acc / cell);
      if (lines) { acc -= lines * cell; opts.onLines(lines, x, y); } // finger up = toward newest output
    }
    function stopGlide() { if (glide !== null) { caf(glide); glide = null; } }
    function startGlide(speed, x, y) { // speed in px per ms, positive = toward newest output
      var prev = now();
      function step() {
        var t = now(), dt = Math.max(1, t - prev); prev = t;
        emit(speed * dt, x, y);
        speed *= Math.max(0, 1 - friction * dt);
        if (Math.abs(speed) < 0.03) { glide = null; return; }
        glide = raf(step);
      }
      glide = raf(step);
    }
    host.addEventListener('touchstart', function (e) {
      stopGlide();
      if (e.touches.length !== 1) { startY = null; return; }
      startY = lastY = e.touches[0].clientY; acc = 0; moving = false; samples = [];
    }, { passive: true, capture: true });
    host.addEventListener('touchmove', function (e) {
      if (startY === null || e.touches.length !== 1) return;
      var t = e.touches[0];
      if (!moving) {
        if (Math.abs(t.clientY - startY) < slop) return;
        moving = true; // the distance already travelled counts, so the first swipe does not feel dead
      }
      e.preventDefault(); e.stopPropagation();
      var dy = lastY - t.clientY; lastY = t.clientY; lastX = t.clientX;
      var at = now(); samples.push({ at: at, dy: dy }); while (samples.length > 1 && at - samples[0].at > 100) samples.shift();
      emit(dy, t.clientX, t.clientY);
    }, { passive: false, capture: true });
    function end(e) {
      if (moving && e.cancelable) e.preventDefault();
      var was = moving, at = now(), recent = samples.filter(function (s) { return at - s.at <= 100; });
      startY = null; moving = false;
      if (!was || e.type === 'touchcancel' || !recent.length) return;
      var dist = recent.reduce(function (a, s) { return a + s.dy; }, 0), span = Math.max(16, at - recent[0].at);
      var speed = dist / span;
      if (Math.abs(speed) >= 0.2) startGlide(Math.max(-5, Math.min(5, speed)), lastX, lastY); // ignore slow drags that simply stop
    }
    host.addEventListener('touchend', end, { passive: false, capture: true });
    host.addEventListener('touchcancel', end, { passive: false, capture: true });
    return { stop: stopGlide };
  }
  var api = { attach: attach };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.TouchScroll = api;
})(typeof window !== 'undefined' ? window : globalThis);
