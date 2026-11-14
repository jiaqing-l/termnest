'use strict';
// UX3 (implementation/51 §3A): connection chip + speed diagnostics, stale-while-revalidate for a few read-only GETs,
// cheap hover prefetch, and the Cmd/Ctrl-K command palette. Loaded as a plain script BEFORE app.js (like ux2.js), also required by node tests.
// Everything is additive and switchable: localStorage 'tw-ux3' = 'off' (Cài đặt → Khác) makes every hook a no-op and the app runs
// exactly as before. Every DOM part is guarded and never throws: a failure here must leave the old screens working.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(root); return; }
  // The feature host also loads every public/features/*.js after login: a second run must not create a second instance (two palettes, two chips).
  if (root.TWUX3) return;
  root.TWUX3 = factory(root); if (root.document) root.TWUX3.boot();
})(typeof window === 'object' ? window : globalThis, function (root) {
  var t = function (k, p) { try { return typeof root.i18n === 'function' ? root.i18n(k, p) : k; } catch (e) { return k; } };
  function store(k, v) { try { if (v === undefined) return root.localStorage.getItem(k); root.localStorage.setItem(k, v); } catch (e) { /* optional */ } return null; }
  function isOn() { return store('tw-ux3') !== 'off'; }

  // ================= pure helpers (unit-tested) =================
  // Lower-case, no diacritics (đ -> d): "phien" finds "Phiên".
  function fold(s) { return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase(); }
  // Fuzzy score of query q in text: -1 = no match; higher is better. Substring beats subsequence; word starts and runs score extra.
  function fuzzy(q, text) {
    q = fold(q).replace(/\s+/g, ' ').trim(); var s = fold(text);
    if (!q) return 0;
    var at = s.indexOf(q);
    if (at >= 0) return 1000 - at * 2 - (s.length - q.length) * 0.1 + (at === 0 || /[\s\-_./]/.test(s[at - 1]) ? 50 : 0);
    var qi = 0, score = 0, run = 0, i;
    for (i = 0; i < s.length && qi < q.length; i++) {
      if (s[i] === q[qi]) { run++; score += 1 + run * 2 + (i === 0 || /[\s\-_./]/.test(s[i - 1]) ? 5 : 0); qi++; } else run = 0;
    }
    return qi === q.length ? score : -1;
  }
  // items: [{label, hint?, ...}] -> best first, at most limit; empty query keeps the given order.
  function rank(items, q, limit) {
    var out = [];
    (items || []).forEach(function (it, i) {
      var a = fuzzy(q, it.label), b = it.hint ? fuzzy(q, it.hint) : -1, sc = a >= 0 ? a : b >= 0 ? b * 0.5 : -1;   // a hint-only match ranks below a label match
      if (sc >= 0) out.push({ it: it, sc: sc, i: i });
    });
    if (String(q || '').trim()) out.sort(function (x, y) { return y.sc - x.sc || x.i - y.i; });
    return out.slice(0, limit || 50).map(function (o) { return o.it; });
  }

  // Keep the last good payload of an allowlisted GET in memory and localStorage (versioned key, size-capped, no credentials).
  var SECRET = /^(password|passwd|secret|apikey|api_key|authorization|cookie|accesstoken|refreshtoken|privatekey|sshkey)$/i;
  function scrub(o, depth) {
    if (!o || typeof o !== 'object' || depth > 8) return o;
    if (Array.isArray(o)) return o.map(function (x) { return scrub(x, depth + 1); });
    var out = {}; Object.keys(o).forEach(function (k) { if (!SECRET.test(k)) out[k] = scrub(o[k], depth + 1); }); return out;
  }
  function createCache(storage, opts) {
    opts = opts || {};
    var prefix = opts.prefix || 'tw-ux3c1:', maxBytes = opts.maxBytes || 200000, maxAge = opts.maxAge || 7 * 864e5, allow = opts.allow || [], mem = {};
    function allowed(path) { path = String(path || ''); return allow.some(function (re) { return re.test(path); }); }
    function key(path) { return String(path).split('?')[0]; }
    function get(k) {
      var e = mem[k];
      if (!e) { try { var raw = storage && storage.getItem(prefix + k); e = raw ? JSON.parse(raw) : null; } catch (x) { e = null; } if (e) mem[k] = e; }
      if (!e || typeof e.at !== 'number' || Date.now() - e.at > maxAge) return null;
      return { at: e.at, data: JSON.parse(JSON.stringify(e.data)) };   // a copy: the caller may mutate it
    }
    function set(k, data) {
      if (data == null || typeof data !== 'object') return false;
      var clean = scrub(data, 0), json;
      try { json = JSON.stringify({ at: Date.now(), data: clean }); } catch (e) { return false; }
      if (json.length > maxBytes) return false;   // too big to be worth keeping
      mem[k] = JSON.parse(json);
      try { if (storage) storage.setItem(prefix + k, json); } catch (e) { /* quota/private mode: memory copy still works */ }
      return true;
    }
    function clear() { mem = {}; try { if (storage) Object.keys(storage).filter(function (x) { return x.indexOf(prefix) === 0; }).forEach(function (x) { storage.removeItem(x); }); } catch (e) { /* optional */ } }
    return { allowed: allowed, key: key, get: get, set: set, clear: clear };
  }

  // The GET wrapper. raw(method, path, body) is the app's own fetch. Behaviour is unchanged for anything not allowlisted, non-GET, or when off.
  // First call of an allowlisted route in this page load: the real request always runs; if a cached payload exists AND the route can be
  // refreshed later (hooks.canRefetch), the caller gets the cached copy at once, and when the fresh data lands hooks.refetch(key) lets the
  // owning screen redraw from the live request. Otherwise the caller waits for the real response exactly as before (hooks.pending shows a skeleton).
  function createSwr(cache, raw, hooks) {
    hooks = hooks || {}; var seen = {}, noop = function () {};
    return function (method, path, body) {
      var on = hooks.enabled ? hooks.enabled() : true;
      if (!on || method !== 'GET' || body || !cache.allowed(path)) return raw(method, path, body);
      var k = cache.key(path), first = !seen[k]; seen[k] = true;
      var hit = first && hooks.canRefetch && hooks.canRefetch(k) ? cache.get(k) : null;
      var live = raw(method, path, body);
      var tapped = live.then(function (r) { cache.set(k, r); return r; });
      if (!hit) {
        if (first && hooks.pending) { try { hooks.pending(k); } catch (e) { /* cosmetic */ } tapped.then(function () { (hooks.settled || noop)(k); }, function () { (hooks.settled || noop)(k); }); }
        return tapped;
      }
      try { if (hooks.stale) hooks.stale(k, hit.at); } catch (e) { /* cosmetic */ }
      tapped.then(function (fresh) {
        var same = false; try { same = JSON.stringify(scrub(fresh, 0)) === JSON.stringify(scrub(hit.data, 0)); } catch (e) { /* treat as changed */ }
        try { if (!same && hooks.refetch) hooks.refetch(k); } catch (e) { /* the next poll refreshes anyway */ }
        try { if (hooks.fresh) hooks.fresh(k); } catch (e) { /* cosmetic */ }
      }, noop);
      return Promise.resolve(hit.data);
    };
  }

  // Last N pane opens, in memory only: { at, key, session, server, open, first, srv }.
  function createTimings(max) {
    var list = []; max = max || 20;
    return {
      add: function (rec) { list.push(rec); while (list.length > max) list.shift(); return rec; },
      list: function () { return list.slice().reverse(); },   // newest first
      clear: function () { list.length = 0; },
      summary: function () {
        var v = list.map(function (r) { return r.first; }).filter(function (n) { return typeof n === 'number'; }).sort(function (a, b) { return a - b; });
        return v.length ? { n: v.length, median: v[Math.floor(v.length / 2)], max: v[v.length - 1] } : null;
      }
    };
  }

  // ================= page wiring =================
  var ALLOW = [/^\/api\/tokens(\?|$)/, /^\/api\/features\/opshub\/state(\?|$)/];   // read-only routes. Notes (editable) and /api/state (drives alerts) are deliberately not here.
  var cache = null, swr = null, timings = createTimings(20), marks = {};
  var panes = typeof WeakMap === 'function' ? new WeakMap() : null;
  var states = {};   // session key -> { st:'connecting'|'ok'|'lost'|'ended', ms, until }
  var doc = root.document, app = function () { try { return root.TW && root.TW.app && root.TW.app(); } catch (e) { return null; } };
  var chip = null, hint = null, diag = null, tick = null;
  function now() { return root.performance && root.performance.now ? root.performance.now() : Date.now(); }
  function serverName(id) { try { var s = (app().servers() || []).filter(function (v) { return v.id === id; })[0]; return s ? s.name : id; } catch (e) { return id; } }
  function hhmm(ts) { var d = new Date(ts); return (d.getHours() < 10 ? '0' : '') + d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes(); }

  // -- connection events from app.js connectPane --
  function ev(name, p, a) {
    if (!isOn()) return;
    var key = panes && p ? panes.get(p) : null;
    if (name === 'connecting') { if (panes && p) panes.set(p, a); key = a; marks[key] = { t0: now() }; states[key] = { st: 'connecting' }; }
    else if (!key) return;
    var m = marks[key] || (marks[key] = { t0: now() });
    if (name === 'open') m.open = now() - m.t0;
    else if (name === 'control') { try { var c = JSON.parse(a); if (c && c.t === 'timing' && typeof c.open === 'number') m.srv = c.open; } catch (e) { /* ignore */ } }
    else if (name === 'data') {
      if (m.first == null) {
        m.first = Math.round(now() - m.t0); states[key] = { st: 'ok', ms: m.first };
        var i = key.indexOf('/');
        timings.add({ at: Date.now(), key: key, session: key.slice(i + 1), server: key.slice(0, i), open: m.open == null ? null : Math.round(m.open), first: m.first, srv: m.srv == null ? null : m.srv });
        renderDiag();
      }
    }
    else if (name === 'retry') states[key] = { st: 'lost', until: Date.now() + a };
    else if (name === 'close') { if (a === 4001) states[key] = { st: 'ended' }; else if (!states[key] || states[key].st !== 'lost') states[key] = { st: 'lost', until: Date.now() + 300 }; }
    paintChip();
  }
  function curKey() { try { var c = app().current(); return c && c.v && c.s ? c.v.id + '/' + c.s.name : null; } catch (e) { return null; } }
  function paintChip() {
    if (!chip) return;
    var k = curKey(), s = k && states[k];
    if (!isOn() || !s || s.st === 'ended') { chip.hidden = true; return; }
    chip.hidden = false; chip.className = 'ux3-chip ' + s.st;
    chip.textContent = s.st === 'connecting' ? t('ux3.chip_connecting') : s.st === 'ok' ? t('ux3.chip_ok', [s.ms]) : t('ux3.chip_lost', [Math.max(0, Math.ceil((s.until - Date.now()) / 1000))]);
  }

  // -- diagnostics list in Cài đặt → Khác --
  function renderDiag() {
    if (!diag) return;
    var ol = diag.querySelector('ol'), sum = diag.querySelector('.ux3-sum'), rows = timings.list();
    ol.textContent = '';
    if (!rows.length) { var li = doc.createElement('li'); li.className = 'hint'; li.textContent = t('ux3.diag_empty'); ol.append(li); }
    rows.forEach(function (r) {
      var li = doc.createElement('li');
      li.textContent = hhmm(r.at) + ' · ' + r.session + ' · ' + serverName(r.server) + ' · ' + t('ux3.diag_row', [r.open == null ? '–' : r.open, r.first]) + (r.srv != null ? ' · ' + t('ux3.diag_srv', [r.srv]) : '');
      ol.append(li);
    });
    var s = timings.summary(); sum.textContent = s ? t('ux3.diag_sum', [s.n, s.median, s.max]) : '';
  }
  function buildDiag() {
    var pane = doc.querySelector('.set-pane[data-pane="more"]'); if (!pane || doc.getElementById('ux3-diag')) return;
    diag = doc.createElement('section'); diag.className = 'st'; diag.id = 'ux3-diag';
    var h = doc.createElement('h3'); h.textContent = t('ux3.diag_title');
    var p = doc.createElement('p'); p.className = 'hint'; p.textContent = t('ux3.diag_hint');
    var lab = doc.createElement('label'); lab.className = 'sw'; var sp = doc.createElement('span'); sp.textContent = t('ux3.enable');
    var cb = doc.createElement('input'); cb.type = 'checkbox'; cb.checked = isOn();
    cb.onchange = function () { store('tw-ux3', cb.checked ? 'on' : 'off'); sm.textContent = t('ux3.reload_note'); if (cache && !cb.checked) cache.clear(); };
    lab.append(sp, cb);
    var sm = doc.createElement('p'); sm.className = 'hint'; sm.setAttribute('role', 'status');
    var sum = doc.createElement('p'); sum.className = 'ux3-sum hint'; var ol = doc.createElement('ol'); ol.className = 'ux3-diag-list';
    diag.append(h, p, lab, sm, sum, ol); pane.append(diag); renderDiag();
  }

  // -- stale marker + skeleton while an allowlisted view loads --
  var VIEW_OF = { '/api/tokens': 'v-token', '/api/features/opshub/state': 'v-ops' };
  function slot(k) { var s = doc && VIEW_OF[k] && doc.getElementById(VIEW_OF[k]); return s || null; }
  function dropMark(k) { var s = slot(k); if (s) Array.prototype.slice.call(s.querySelectorAll(':scope > .ux3-stamp, :scope > .ux3-skel')).forEach(function (n) { n.remove(); }); }
  var hooks = {
    enabled: isOn,
    // Only a route whose owner can be asked to redraw may be served stale (see refetch): tokens (token-ui poll) and the Ops hub (its own refresh button).
    canRefetch: function (k) { return !!(app() && app().ux3Refetch); },
    refetch: function () {
      try { app().ux3Refetch(); } catch (e) { /* ignore */ }
      var b = doc.querySelector('#v-ops .hub-refresh button'); if (b) b.click();
    },
    stale: function (k, at) {
      var s = slot(k); if (!s) return; dropMark(k);
      var n = doc.createElement('div'); n.className = 'ux3-stamp'; n.textContent = t('ux3.stale', [hhmm(at)]); s.insertBefore(n, s.firstChild);
    },
    fresh: function (k) { setTimeout(function () { dropMark(k); }, 400); },
    pending: function (k) {
      var s = slot(k); if (!s || s.children.length > 1) return; dropMark(k);
      var n = doc.createElement('div'); n.className = 'ux3-skel'; n.setAttribute('aria-hidden', 'true');
      n.innerHTML = '<i></i><i></i><i></i><i></i>'; s.insertBefore(n, s.firstChild);
    },
    settled: function (k) { dropMark(k); }
  };
  function wrapGet(raw, method, path, body) {
    if (!isOn()) return raw(method, path, body);
    if (!cache) { cache = createCache(root.localStorage, { allow: ALLOW }); swr = createSwr(cache, raw, hooks); }
    return swr(method, path, body);
  }

  // -- prefetch: hover >= 200 ms on a session row/card warms only the preview text (one tiny tmux capture through the normal /screens queue) --
  var hov = { timer: 0, key: '' }, warmAt = {}, warming = false;
  function warm(key) {
    var a = app(); if (!a || !a.ux3Has || warming || doc.hidden || !isOn()) return;
    if (a.ux3Has(key) || Date.now() - (warmAt[key] || 0) < 60000) return;
    var i = key.indexOf('/'), id = key.slice(0, i), name = key.slice(i + 1), v = (a.servers() || []).filter(function (x) { return x.id === id; })[0];
    if (!v || !v.on || v.mode === 'powershell' || v.rebooting) return;   // offline / plain sessions: nothing cheap to warm
    warmAt[key] = Date.now(); warming = true;
    a.api('POST', '/api/servers/' + id + '/screens', { names: [name], lines: 30 }).then(function (r) {
      var txt = r && r.screens && r.screens[name]; if (typeof txt === 'string' && txt.trim()) a.ux3Warm(key, txt.split('\n'));
    }).catch(function () { /* best effort */ }).then(function () { warming = false; });
  }
  function bindHover() {
    doc.addEventListener('pointerover', function (e) {
      if (!isOn() || e.pointerType === 'touch') return;
      var n = e.target && e.target.closest && e.target.closest('[data-k]'); if (!n || !n.dataset.k || n.dataset.k.indexOf('/') < 0) return;
      if (hov.key === n.dataset.k) return;
      clearTimeout(hov.timer); hov.key = n.dataset.k; var k = hov.key;
      hov.timer = setTimeout(function () { warm(k); }, 200);
    }, true);
    doc.addEventListener('pointerout', function (e) {
      var n = e.target && e.target.closest && e.target.closest('[data-k]'); if (!n || (e.relatedTarget && n.contains(e.relatedTarget))) return;
      clearTimeout(hov.timer); hov.key = '';
    }, true);
  }

  // -- command palette --
  var pal = null, palSel = 0, palRows = [], palPrev = null;
  function isPaletteKey(e) { return !!e && e.type === 'keydown' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && String(e.key).toLowerCase() === 'k' && isOn(); }
  function click(id) { var n = doc.getElementById(id); if (n) n.click(); }
  function buildItems() {
    var a = app(), out = [], seen = {};
    function tab(id) { var b = doc.getElementById('tab-' + id); return b && b.textContent.trim() ? b : null; }
    ['over', 'focus', 'token', 'notes', 'ops'].forEach(function (id) { var b = tab(id); if (b) out.push({ g: 'views', label: b.textContent.trim(), run: function () { b.click(); } }); });
    [['btn-new', 'ux3.a_new'], ['set', 'ux3.a_settings'], ['theme', 'ux3.a_theme'], ['open-file', 'ux3.a_openfile'], ['drop-pick', 'ux3.a_sendfile']].forEach(function (x) {
      if (doc.getElementById(x[0])) out.push({ g: 'actions', label: t(x[1]), run: function () { click(x[0]); } });
    });
    try {
      (a.servers() || []).forEach(function (v) {
        out.push({ g: 'servers', label: v.name, hint: v.user ? v.user + '@' + v.host : '', run: function () { var sel = doc.getElementById('srv-sel'); if (sel) { sel.value = v.id; sel.dispatchEvent(new Event('change')); } } });
        (v.sessions || []).forEach(function (s) { var k = v.id + '/' + s.name; if (seen[k]) return; seen[k] = 1; out.push({ g: 'sessions', label: s.name, hint: v.name, run: function () { a.openSession(v.id, s.name); } }); });
      });
    } catch (e) { /* no servers yet */ }
    var order = { sessions: 0, servers: 1, views: 2, actions: 3 };
    return out.sort(function (x, y) { return order[x.g] - order[y.g]; });
  }
  function paintPal(q) {
    var list = pal.querySelector('[role=listbox]'), items = buildItems();
    palRows = rank(items, q, 40); palSel = Math.min(palSel, Math.max(0, palRows.length - 1)); list.textContent = '';
    if (!palRows.length) { var e = doc.createElement('div'); e.className = 'ux3-none'; e.textContent = t('ux3.pal_none'); list.append(e); }
    var last = '';
    palRows.forEach(function (r, i) {
      if (r.g !== last) { last = r.g; var h = doc.createElement('div'); h.className = 'ux3-grp'; h.setAttribute('role', 'presentation'); h.textContent = t('ux3.g_' + r.g); list.append(h); }
      var o = doc.createElement('div'); o.className = 'ux3-opt'; o.id = 'ux3-o' + i; o.setAttribute('role', 'option'); o.setAttribute('aria-selected', String(i === palSel));
      var l = doc.createElement('span'); l.textContent = r.label; o.append(l);
      if (r.hint) { var s = doc.createElement('small'); s.textContent = r.hint; o.append(s); }
      o.onmousemove = function () { if (palSel !== i) { palSel = i; mark(); } }; o.onclick = function () { runPal(i); };
      list.append(o);
    });
    mark();
  }
  function mark() {
    var input = pal.querySelector('input');
    Array.prototype.forEach.call(pal.querySelectorAll('.ux3-opt'), function (o, i) { var on = i === palSel; o.setAttribute('aria-selected', String(on)); if (on) { input.setAttribute('aria-activedescendant', o.id); o.scrollIntoView({ block: 'nearest' }); } });
  }
  function runPal(i) { var r = palRows[i]; if (!r) return; closePal(true); setTimeout(function () { try { r.run(); } catch (e) { /* the action reports its own errors */ } }, 0); }
  // keep = an action ran: do not pull focus back from whatever the action focused (the close handler restores focus otherwise)
  function closePal(keep) { if (pal) { pal._kept = !!keep; if (pal.open) pal.close(); } }
  function openPal() {
    if (!isOn() || !doc.body) return;
    if (!pal) {
      pal = doc.createElement('dialog'); pal.id = 'ux3-pal'; pal.className = 'ux3-pal'; pal.setAttribute('role', 'dialog'); pal.setAttribute('aria-label', t('ux3.pal_title'));
      pal.innerHTML = '<input type="text" role="combobox" aria-expanded="true" aria-controls="ux3-list" autocomplete="off" spellcheck="false"><div id="ux3-list" role="listbox"></div>';
      var input = pal.querySelector('input'); input.placeholder = t('ux3.pal_ph'); input.setAttribute('aria-label', t('ux3.pal_ph'));
      input.addEventListener('input', function () { palSel = 0; paintPal(input.value); });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown') { e.preventDefault(); palSel = palRows.length ? (palSel + 1) % palRows.length : 0; mark(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); palSel = palRows.length ? (palSel + palRows.length - 1) % palRows.length : 0; mark(); }
        else if (e.key === 'Enter') { e.preventDefault(); runPal(palSel); }
      });
      pal.addEventListener('click', function (e) { if (e.target === pal) closePal(); });   // click on the backdrop
      pal.addEventListener('close', function () { if (palPrev && palPrev.isConnected && !pal._kept) try { palPrev.focus(); } catch (e) { /* gone */ } pal._kept = false; });
      doc.body.append(pal);
    }
    if (pal.open) { closePal(); return; }   // Cmd-K again toggles it
    palPrev = doc.activeElement; pal._kept = false; palSel = 0;
    var inp = pal.querySelector('input'); inp.value = ''; paintPal(''); pal.showModal(); inp.focus();
  }

  function boot() {
    try {
      doc.addEventListener('DOMContentLoaded', function () { try { init(); } catch (e) { /* never break the page */ } });
      if (doc.readyState !== 'loading') init();
    } catch (e) { /* never break the page */ }
  }
  var inited = false;
  function init() {
    if (inited || !doc.body) return; inited = true;
    if (!isOn()) { buildDiag(); return; }   // off: only the switch stays reachable
    var top = doc.querySelector('.main-top');
    if (top) { chip = doc.createElement('span'); chip.id = 'ux3-conn'; chip.hidden = true; chip.setAttribute('role', 'status'); chip.setAttribute('aria-live', 'polite'); top.append(chip); }
    var right = doc.querySelector('.top .right');
    if (right) {
      hint = doc.createElement('button'); hint.type = 'button'; hint.className = 'btn ux3-hint'; hint.id = 'ux3-hint';
      hint.textContent = /Mac|iPhone|iPad/.test(root.navigator.platform || '') ? '⌘ K' : 'Ctrl K'; hint.title = t('ux3.pal_title') + ' (Ctrl/⌘ K)'; hint.setAttribute('aria-label', t('ux3.pal_title'));
      hint.onclick = openPal; right.insertBefore(hint, right.firstChild);
    }
    buildDiag(); bindHover();
    // Capture phase on window: runs before xterm's own handler, so Cmd/Ctrl-K never reaches the terminal as ^K. The Ops hub keeps its own
    // Cmd-K (focus its search box) while its view is showing, so that existing behaviour is untouched.
    root.addEventListener('keydown', function (e) {
      if (!isPaletteKey(e)) return;
      var ops = doc.getElementById('v-ops'); if (ops && ops.classList.contains('on') && !(pal && pal.open)) return;
      e.preventDefault(); e.stopPropagation(); openPal();
    }, true);
    tick = setInterval(function () { if (!doc.hidden) paintChip(); }, 1000);
    doc.addEventListener('click', function () { setTimeout(paintChip, 50); }, true);   // switching tab/session changes which state the chip shows
  }

  return { fuzzy: fuzzy, rank: rank, fold: fold, createCache: createCache, createSwr: createSwr, createTimings: createTimings, scrub: scrub,
    boot: boot, ev: ev, wrapGet: wrapGet, isPaletteKey: isPaletteKey, timingOn: isOn, isOn: isOn, open: function () { openPal(); } };
});
