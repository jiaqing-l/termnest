'use strict';
// UX2: helpers for the redesigned screens (monogram avatars, sidebar grouping + pins, hero stats, dock menus, interface scale).
// Loaded as a plain script BEFORE app.js (see index.html), so app.js can call window.TWUX2; also required by node tests.
// Everything that touches the page is guarded and never throws: a failure here must leave the old screens working.
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.TWUX2 = api; if (root.document) api.boot(); }
})(typeof window === 'object' ? window : globalThis, function (root) {
  var HUES = [212, 262, 330, 24, 160, 190, 285, 45];
  var MODES = ['prio', 'proj', 'host', 'crew', 'tool', 'stat'];
  var t = function (k, p) { try { return typeof root.i18n === 'function' ? root.i18n(k, p) : k; } catch (e) { return k; } };
  function store(k, v) { try { if (v === undefined) return root.localStorage.getItem(k); root.localStorage.setItem(k, v); } catch (e) { /* optional */ } return null; }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  // ---- monogram: two letters on a hue picked from the name (same hash as app.js, so a session keeps its colour) ----
  function hash(s) { var h = 0; s = String(s); for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
  function hue(name) { return HUES[hash(name) % HUES.length]; }
  function initials(name) {
    var parts = String(name == null ? '' : name).split(/[-_\s.]+/).filter(Boolean);
    return ((parts[0] || '?')[0] + (parts[1] ? parts[1][0] : (parts[0] || '').slice(1, 2))).toUpperCase();
  }
  function monoHtml(name) { return '<span class="mono av-mono" style="--h:' + hue(name) + '">' + esc(initials(name)) + '</span>'; }
  function monoNode(name) {
    var n = root.document.createElement('span'); n.className = 'mono av-mono'; n.style.setProperty('--h', String(hue(name))); n.textContent = initials(name); return n;
  }
  function petsOn() {
    try { return !root.document.documentElement.classList.contains('pets-off') && root.localStorage.getItem('tw-pets') === 'on'; } catch (e) { return false; }
  }

  // ---- sidebar grouping ----
  // item: { key, name, state: 'wait'|'run'|'idle', crew: bool, host, path, tool }  →  [{ id, key|text, items }] (empty groups dropped)
  function projectOf(path) {
    var segs = String(path || '').replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
    var base = segs.length ? segs[segs.length - 1] : '';
    return !base || base === '~' ? '' : base;
  }
  function toolOf(it) {
    var s = (it.tool || '') + ' ' + (it.cmd || '');
    return /codex/i.test(s) ? 'Codex' : /claude|^\d+\.\d+\.\d+$/i.test(s) ? 'Claude' : '';
  }
  function groupSessions(items, mode, pins) {
    var pinned = {}; (pins || []).forEach(function (k) { pinned[k] = true; });
    var need = function (s) { return s.state === 'wait'; }, run = function (s) { return s.state === 'run'; }, idle = function (s) { return s.state === 'idle'; };
    var out = [], list = items || [];
    function add(id, labelKey, arr, text) { if (arr.length) out.push({ id: id, key: text ? undefined : labelKey, text: text, items: arr }); }
    if (MODES.indexOf(mode) < 0) mode = 'prio';
    if (mode === 'proj') {
      var by = {}, order = [];
      list.forEach(function (s) { var p = projectOf(s.path) || ''; if (!by[p]) { by[p] = []; order.push(p); } by[p].push(s); });
      order.filter(Boolean).sort(function (a, b) { return a.toLowerCase() < b.toLowerCase() ? -1 : 1; }).forEach(function (p) { add('p:' + p, '', by[p], p); });
      add('p:', 'ux2.h_other', by[''] || []);
    } else if (mode === 'host') {
      var hs = {}, ho = []; list.forEach(function (s) { var h = s.host || ''; if (!hs[h]) { hs[h] = []; ho.push(h); } hs[h].push(s); });
      ho.forEach(function (h) { add('h:' + h, '', hs[h], h || t('ux2.h_other')); });
    } else if (mode === 'crew') {
      add('crew', 'ux2.h_crew', list.filter(function (s) { return s.crew; })); add('single', 'ux2.h_single', list.filter(function (s) { return !s.crew; }));
    } else if (mode === 'tool') {
      add('t:Claude', '', list.filter(function (s) { return toolOf(s) === 'Claude'; }), 'Claude'); add('t:Codex', '', list.filter(function (s) { return toolOf(s) === 'Codex'; }), 'Codex');
      add('t:other', 'ux2.h_other', list.filter(function (s) { return !toolOf(s); }));
    } else if (mode === 'stat') {
      add('wait', 'ux2.h_wait', list.filter(need)); add('run', 'ux2.h_running', list.filter(run)); add('idle', 'ux2.h_resting', list.filter(idle));
    } else {   // prio: pinned, then waiting for you, then running crews, then the other running sessions, then resting
      var p = function (s) { return !!pinned[s.key]; };
      add('pin', 'ux2.h_pin', list.filter(p));
      add('need', 'ux2.h_need', list.filter(function (s) { return !p(s) && need(s); }));
      add('crewrun', 'ux2.h_crew_run', list.filter(function (s) { return !p(s) && run(s) && s.crew; }));
      add('run', 'ux2.h_run', list.filter(function (s) { return !p(s) && run(s) && !s.crew; }));
      add('idle', 'ux2.h_idle', list.filter(function (s) { return !p(s) && !need(s) && !run(s); }));
    }
    return out;
  }
  function getMode() { var m = store('tw-group'); return MODES.indexOf(m) >= 0 ? m : 'prio'; }
  function setMode(m) { if (MODES.indexOf(m) >= 0) store('tw-group', m); }
  function getPins() { try { var a = JSON.parse(store('tw-pins') || '[]'); return Array.isArray(a) ? a.filter(function (x) { return typeof x === 'string'; }) : []; } catch (e) { return []; } }
  function togglePin(key) {
    var a = getPins(), i = a.indexOf(key); if (i >= 0) a.splice(i, 1); else a.unshift(key);
    store('tw-pins', JSON.stringify(a.slice(0, 200))); return a;
  }

  // ---- small DOM helpers ----
  function el(tag, cls, text) { var n = root.document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function closePops() { root.document.querySelectorAll('.term-tools .pop').forEach(function (m) { m.hidden = true; }); root.document.querySelectorAll('.term-tools .key-more-btn').forEach(function (x) { x.setAttribute('aria-expanded', 'false'); }); }
  // A dock dropdown built like the existing "Phím ▾": the wrapper keeps the document's outside-click handler from closing it early.
  function dockMenu(label, tip, id) {
    var wrap = el('span', 'key-more-wrap'), btn = el('button', 'btn key-more-btn', label), menu = el('span', 'key-more pop menu');
    btn.type = 'button'; btn.id = id + '-btn'; btn.setAttribute('aria-expanded', 'false'); btn.setAttribute('aria-haspopup', 'menu'); if (tip) { btn.setAttribute('aria-label', tip); btn.dataset.tip = tip; }
    menu.id = id; menu.hidden = true;
    btn.onclick = function (e) { e.stopPropagation(); var open = menu.hidden; closePops(); menu.hidden = !open; btn.setAttribute('aria-expanded', String(open));
      // Keep the menu inside the window: the right-hand dock buttons (Aa, ⋯) open towards the left.
      if (open) { menu.style.left = ''; menu.style.right = ''; var rc = menu.getBoundingClientRect(), ww = root.innerWidth || 0; if (rc.right > ww - 8) { menu.style.left = 'auto'; menu.style.right = '0'; } } };
    menu.addEventListener('click', function () { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); });
    wrap.append(btn, menu); return { wrap: wrap, menu: menu, btn: btn };
  }

  // ---- dock: Gửi file · Mở file · Phím ▾ · Lệnh mẫu ▾ | Chia màn ▾ · Aa ▾ · ⋯ (the buttons are MOVED, so every existing handler keeps working) ----
  function buildDock() {
    var d = root.document, bar = d.querySelector('.keybar'), more = d.getElementById('key-more'), tc = d.querySelector('.text-controls');
    if (!bar || !more || !tc || bar.dataset.ux2) return;
    bar.dataset.ux2 = '1';
    var q = function (sel) { return d.querySelector(sel); };
    var ctrlc = q('.keybar [data-k="ctrlc"]'), esc = q('.keybar [data-k="esc"]'), nl = q('.keybar [data-k="nl"]'), kbd = d.getElementById('kbd-toggle');
    // Phím ▾: Ctrl+C (interrupt) and Esc live here now, with the keys a phone keyboard lacks.
    var first = more.firstChild;
    function keyBtn(k, text) { var b = el('button', 'btn', text); b.type = 'button'; b.dataset.k = k; return b; }
    if (ctrlc) { ctrlc.textContent = t('ux2.key_ctrlc'); more.insertBefore(ctrlc, first); }
    if (esc) more.insertBefore(esc, first);
    ['left:←', 'right:→', 'enter:Enter', 'ctrld:Ctrl+D', 'ctrll:Ctrl+L'].forEach(function (s) { var p = s.split(':'); if (!q('.keybar [data-k="' + p[0] + '"]')) more.append(keyBtn(p[0], p[1])); });
    if (kbd) { kbd.textContent = '⌨ ' + t('ux2.kbd_screen'); more.append(kbd); }   // the on-screen keyboard toggle closes the list: last, like the mockup
    // Aa ▾ and ⋯ replace the row of text buttons.
    var aa = dockMenu('Aa ▾', t('ux2.font'), 'aa-pop'), dots = dockMenu('⋯', t('cp.more'), 'dots-pop');
    var mm = q('#mouse-mode'), cp = q('#copy-sel'), mi = q('#term-font-minus'), pl = q('#term-font-plus'), rs = q('#term-font-reset'), hp = q('#term-help-btn'), fs = q('#term-fullscreen');
    function put(menu, node, text) { if (!node) return; if (text) { node.textContent = text; node.dataset.ux2label = text; } menu.append(node); }
    put(aa.menu, mi, t('ux2.font_smaller')); put(aa.menu, pl, t('ux2.font_bigger')); put(aa.menu, rs, t('ux2.font_reset'));
    put(dots.menu, mm); put(dots.menu, cp); if (nl) { nl.textContent = t('html.dong_moi'); dots.menu.append(nl); }
    if (hp) { hp.textContent = '? ' + t('ux2.guide'); dots.menu.append(hp); }
    if (fs) { fs.textContent = '⛶ ' + t('viewcontrols.toan_man_hinh'); dots.menu.append(fs); }
    tc.textContent = ''; tc.append(aa.wrap, dots.wrap);
    // Escape and outside clicks close the menus built here as well (app.js closes the older ones by class).
    d.addEventListener('keydown', function (e) { if (e.key === 'Escape') closePops(); });
    d.addEventListener('click', function (e) { if (!e.target.closest || !e.target.closest('.key-more-wrap')) closePops(); });
  }

  // ---- overview hero: .hero > .hl + .hstats + .scene ----
  function buildHero() {
    var d = root.document, hero = d.querySelector('.hero'); if (!hero || hero.dataset.ux2) return;
    hero.dataset.ux2 = '1';
    var copy = hero.querySelector('.hero-copy'); if (copy) copy.classList.add('hl');
    var wx = d.getElementById('pet-weather'), chips = d.getElementById('chips');
    if (wx && copy) { wx.classList.add('chip', 'wx-chip'); if (chips && chips.parentNode === copy) chips.after(wx); else copy.append(wx); }   // the weather is one of the chips
    var stats = el('div', 'hstats'); stats.id = 'hstats'; stats.setAttribute('role', 'group');
    var scene = hero.querySelector('.scene');
    if (scene) hero.insertBefore(stats, scene); else hero.append(stats);
    if (scene) {
      var lap = scene.querySelector('.laptop'), house = scene.querySelector('.house'), wire = scene.querySelector('.wire');
      if (lap && !lap.querySelector('.box')) { lap.classList.add('sn'); var svg = lap.querySelector('svg'), b1 = el('div', 'box'); if (svg) b1.append(svg); lap.insertBefore(b1, lap.firstChild); }
      if (house && !house.querySelector('.box')) { house.classList.add('sn'); var shelf = house.querySelector('.shelf'), b2 = el('div', 'box'); if (shelf) b2.append(shelf); house.insertBefore(b2, house.firstChild); }
      if (wire) { wire.classList.add('link'); wire.textContent = ''; wire.append(el('i')); }   // one dashed link with a moving dot
    }
  }
  // tiles: sessions, running, need you (click → only the waiting ones), crew workers
  function heroStats(o) {
    var box = root.document.getElementById('hstats'); if (!box) return;
    var rows = [[o.sessions, 'ux2.hs_sessions', ''], [o.run, 'ux2.hs_run', ''], [o.wait, 'ux2.hs_need', 'need'], [o.crew, 'ux2.hs_crew', '']];
    var sig = rows.map(function (r) { return r[0]; }).join(',') + (root.TW_I18N ? root.TW_I18N.lang() : ''); if (box.dataset.sig === sig) return; box.dataset.sig = sig; box.textContent = '';
    rows.forEach(function (r) {
      var tile = el('div', 'hs' + (r[2] ? ' ' + r[2] : '')); tile.append(el('b', '', String(r[0] || 0)), el('span', '', t(r[1])));
      if (r[2] === 'need') {
        tile.tabIndex = 0; tile.setAttribute('role', 'button');
        var go = function () { var f = root.document.querySelector('#f button[data-f="wait"]'); if (f) f.click(); };
        tile.onclick = go; tile.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
      }
      box.append(tile);
    });
  }

  // ---- interface scale (Settings → Giao diện): buttons [data-z] inside #set-zoom call window.TW_setZoom (index.html) ----
  function markZoom() {
    var box = root.document.getElementById('set-zoom'); if (!box) return;
    var z = Number(store('tw-zoom2')); if (!(z > 0)) z = 100;
    box.querySelectorAll('[data-z]').forEach(function (b) { var on = Number(b.dataset.z) === z; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
  }
  function wireZoom() {
    var d = root.document;
    d.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('#set-zoom [data-z]');
      if (b) { var z = Number(b.dataset.z); if (typeof root.TW_setZoom === 'function') root.TW_setZoom(z); else store('tw-zoom2', String(z)); markZoom(); return; }
      if (e.target.closest && e.target.closest('.set-tab')) setTimeout(markZoom, 0);
    });
    markZoom();
  }

  // Playground: slim row of small pets with status dots (persisted in tw-yard-compact).
  function wireYard() {
    var d = root.document, b = d.getElementById('yard-fold'), sec = d.getElementById('playground'); if (!b || !sec) return;
    function apply(on) {
      sec.classList.toggle('compact', on); b.setAttribute('aria-pressed', String(on));
      var k = on ? 'ux2.yard_expand' : 'ux2.yard_compact'; b.setAttribute('data-i18n', k); b.textContent = t(k);
    }
    apply(store('tw-yard-compact') === '1');
    b.addEventListener('click', function () { var on = !sec.classList.contains('compact'); store('tw-yard-compact', on ? '1' : ''); apply(on); });
  }

  // Delete / Backspace outside a text field must do nothing: the desktop WebView treats it as "Back" and returned to the launch screen
  // ("Opening the app…"), dropping the user out of the app.
  function guardBackKey() {
    root.document.addEventListener('keydown', function (e) {
      if (e.key !== 'Backspace' && e.key !== 'Delete') return;
      var t = e.target, tag = t && t.tagName, editable = t && (t.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT');
      if (!editable) e.preventDefault();
    }, true);
  }
  function boot() {
    [guardBackKey, buildDock, buildHero, wireZoom, wireYard].forEach(function (f) { try { f(); } catch (e) { if (root.console) root.console.error('[ux2]', e); } });
  }
  return { HUES: HUES, MODES: MODES, hash: hash, hue: hue, initials: initials, monoHtml: monoHtml, monoNode: monoNode, petsOn: petsOn,
    projectOf: projectOf, toolOf: toolOf, groupSessions: groupSessions, getMode: getMode, setMode: setMode, getPins: getPins, togglePin: togglePin,
    heroStats: heroStats, markZoom: markZoom, closePops: closePops, boot: boot };
});
