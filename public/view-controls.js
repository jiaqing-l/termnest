/* Text preferences and focus mode, shared by document and xterm key handlers. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.ViewControls = factory;
})(typeof window === 'object' ? window : globalThis, function (o) {
  'use strict';
  var doc = o.document, win = o.window, app = o.app;
  var mac = /Mac|iPhone|iPad|iPod/i.test(o.navigator.platform || o.navigator.userAgent || '');
  var terminalFont = read('tw-term-font', null, 28), crewFont = read('tw-crew-font', 12, 24);
  var lastCrew = false, pendingFont = false, pendingFullscreen = null, fullscreen = false, busy = false;
  var handled = new WeakSet(), wheelAt = { terminal: -Infinity, crew: -Infinity };
  function clamp(n, max) { return Math.max(9, Math.min(max, Math.round(n))); }
  function read(key, fallback, max) {
    try { var raw = o.storage.getItem(key), n = Number(raw); return raw !== null && raw !== undefined && raw !== '' && Number.isFinite(n) ? clamp(n, max) : fallback; }
    catch (_) { return fallback; }
  }
  function save(key, value) { try { o.storage.setItem(key, String(value)); } catch (_) { /* optional */ } }
  function defaultFont() { return app.classList.contains('compact') ? 12 : 13; }
  function font() { return terminalFont === null ? defaultFont() : terminalFont; }
  function label(button, text, size) { button.title = text + (size ? ' · ' + size + ' px' : ''); button.setAttribute('aria-label', text); }
  function updateLabels() {
    label(o.termMinus, i18n('viewcontrols.giam_co_chu_terminal'), font()); label(o.termPlus, i18n('viewcontrols.tang_co_chu_terminal'), font());
    label(o.termReset, i18n('viewcontrols.co_chu_terminal_mac_dinh'), font());
    label(o.crewMinus, i18n('viewcontrols.giam_co_chu_crew'), crewFont); label(o.crewPlus, i18n('viewcontrols.tang_co_chu_crew'), crewFont);
    label(o.fullscreenButton, fullscreen ? i18n('viewcontrols.thoat_toan_man_hinh') : i18n('viewcontrols.toan_man_hinh'));
    o.fullscreenButton.setAttribute('aria-pressed', String(fullscreen));
  }
  function applyTerminalFont() {
    if (o.composing()) { pendingFont = true; return; }
    pendingFont = false;
    o.panes().forEach(function (p) { if (p.term.options.fontSize !== font()) p.term.options.fontSize = font(); });
    o.fit(); updateLabels();
  }
  function zoom(target, step) {
    if (target === 'crew') {
      crewFont = step === 0 ? 12 : clamp(crewFont + step, 24);
      save('tw-crew-font', crewFont); o.crewOutput.style.setProperty('--crew-font', crewFont + 'px');
    } else {
      terminalFont = step === 0 ? defaultFont() : clamp(font() + step, 28);
      save('tw-term-font', terminalFont); applyTerminalFont();
    }
    updateLabels(); o.say(i18n('viewcontrols.co_chu', [(target === 'crew' ? crewFont : font())]), true, 1600, true);
  }
  function crewTarget(target) { return !o.crewPanel.hidden && (o.crewPanel.contains(target) || lastCrew); }
  function remember(e) { lastCrew = !o.crewPanel.hidden && o.crewPanel.contains(e.target); }
  function syncFullscreen(enabled) {
    fullscreen = !!enabled;
    if (fullscreen) o.showTerminal();
    app.classList.toggle('fs', fullscreen); o.exitChip.hidden = !fullscreen;
    updateLabels(); o.fit();
  }
  async function toggleFullscreen() {
    if (o.composing()) { pendingFullscreen = !fullscreen; return; }
    if (busy) return;
    var enabled = !fullscreen; busy = true; syncFullscreen(enabled);
    try {
      if (win.TW_DESKTOP) await win.TW_DESKTOP.setFullscreen(enabled);
      else if (enabled) await doc.documentElement.requestFullscreen();
      else if (doc.fullscreenElement) await doc.exitFullscreen();
    } catch (_) { o.say(i18n('viewcontrols.che_do_tap_trung', [(enabled ? i18n('viewcontrols.da_bat_khong_mo_duoc') : i18n('viewcontrols.da_tat_khong_doi_duoc'))]), false, 2800, true); }
    finally { busy = false; }
  }
  function action(e) {
    if (e.altKey) return null;
    if (e.key === 'F11' && !e.metaKey && !e.ctrlKey && !e.shiftKey) return 'fullscreen';
    var modifier = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    if (!modifier) return null;
    if (e.shiftKey && String(e.key).toLowerCase() === 'f') return 'fullscreen';
    if (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd') return 1;
    if (e.key === '-' || e.code === 'NumpadSubtract') return -1;
    if (!e.shiftKey && (e.key === '0' || e.code === 'Numpad0')) return 0;
    return null;
  }
  function handleKey(e) {
    var a = action(e); if (a === null) return false;
    e.preventDefault(); e.stopPropagation();
    if (handled.has(e)) return true;
    handled.add(e);
    if (e.type !== 'keydown' || e.isComposing || e.keyCode === 229) return true;
    if (a === 'fullscreen') { if (!e.repeat) toggleFullscreen(); }
    else zoom(crewTarget(e.target) ? 'crew' : 'terminal', a);
    return true;
  }
  function wheel(target) {
    return function (e) {
      if (!e.ctrlKey) return;
      e.preventDefault(); e.stopPropagation();
      var now = Date.now();
      if (!e.deltaY || now - wheelAt[target] < 90) return;
      wheelAt[target] = now; lastCrew = target === 'crew'; zoom(target, e.deltaY < 0 ? 1 : -1);
    };
  }
  [o.termMinus, o.termPlus, o.termReset].forEach(function (b, i) { b.onclick = function () { zoom('terminal', [-1, 1, 0][i]); }; });
  o.crewMinus.onclick = function () { zoom('crew', -1); }; o.crewPlus.onclick = function () { zoom('crew', 1); };
  o.fullscreenButton.onclick = o.exitChip.onclick = toggleFullscreen;
  doc.addEventListener('pointerdown', remember, true); doc.addEventListener('click', remember, true); doc.addEventListener('focusin', remember, true);
  doc.addEventListener('keydown', handleKey, true); doc.addEventListener('keyup', handleKey, true);
  o.terminalHost.addEventListener('wheel', wheel('terminal'), { passive: false, capture: true });
  o.crewOutput.addEventListener('wheel', wheel('crew'), { passive: false });
  doc.addEventListener('fullscreenchange', function () { syncFullscreen(!!doc.fullscreenElement); });
  win.addEventListener('tw-fullscreen', function (e) { syncFullscreen(e.detail); });
  o.crewOutput.style.setProperty('--crew-font', crewFont + 'px'); updateLabels();
  return { font: font, zoom: zoom, handleKey: handleKey, applyTerminalFont: applyTerminalFont,
    flush: function () {
      if (o.composing()) return;
      if (pendingFont) applyTerminalFont();
      if (pendingFullscreen !== null) { var enabled = pendingFullscreen; pendingFullscreen = null; if (enabled !== fullscreen) toggleFullscreen(); }
    } };
});
