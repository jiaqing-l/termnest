'use strict';
// "All" wall: every session as a tile showing the last lines of its screen, scrolled like a page.
// Cheap on purpose: a tile is plain text (no terminal, no socket), only tiles near the viewport are refreshed, and one request
// per server fetches all of its visible tiles at once. A click opens the real terminal.
(function (root) {
  var LINES = 14, EVERY = 2500, FILTERS = ['all', 'wait', 'run', 'idle'];
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  var COLOR = { wait: '#e8a62c', run: '#2fa463', idle: '#7b879d' };   // the colour tells the state, nothing else
  var COLS = ['auto', '2', '3', '4'], FONT = { min: 9, max: 17, step: 1, dflt: 11.5 };
  function load(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem(k, String(v)); } catch (e) { /* optional */ } }
  function stateOf(s) { return s.state === 'wait' ? 'wait' : s.state === 'idle' ? 'idle' : 'run'; }

  function create(opts) {
    var host = opts.root, bar = el('div', 'w-bar'), fil = el('div', 'w-filters'), tools = el('div', 'w-tools'), grid = el('div', 'w-grid'), empty = el('p', 'w-empty');
    var tiles = new Map(), visible = new Set(), busy = new Set(), filter = 'all', shown = false, timer = null, io = null;
    bar.append(fil, tools); host.append(bar, grid, empty);
    var cols = COLS.indexOf(load('termnest.wall.cols', 'auto')) >= 0 ? load('termnest.wall.cols', 'auto') : 'auto';
    var font = Math.max(FONT.min, Math.min(FONT.max, Number(load('termnest.wall.font', FONT.dflt)) || FONT.dflt));
    function apply() { host.style.setProperty('--w-font', font + 'px'); host.dataset.cols = cols; host.style.setProperty('--w-cols', cols === 'auto' ? '' : cols); }
    function tool(label, title, onclick) { var b = el('button', 'btn w-t', label); b.type = 'button'; b.title = title; b.setAttribute('aria-label', title); b.onclick = onclick; return b; }
    // Columns, text size and full screen live in the wall's own bar, so the tiles can be tuned without leaving it.
    (function () {
      var colBox = el('div', 'w-cols'); colBox.setAttribute('role', 'group'); colBox.setAttribute('aria-label', opts.text('wall.cols'));
      colBox.append(el('span', 'w-lbl', opts.text('wall.cols')));
      COLS.forEach(function (c) {
        var b = tool(c === 'auto' ? opts.text('wall.cols_auto') : c, opts.text('wall.cols') + ': ' + (c === 'auto' ? opts.text('wall.cols_auto') : c), function () { cols = c; save('termnest.wall.cols', c); apply(); mark(); });
        b.dataset.c = c; colBox.append(b);
      });
      function mark() { colBox.querySelectorAll('[data-c]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.c === cols)); }); }
      var size = function (d) { font = Math.max(FONT.min, Math.min(FONT.max, font + d)); save('termnest.wall.font', font); apply(); };
      tools.append(colBox, tool('A−', opts.text('wall.font_minus'), function () { size(-FONT.step); }), tool('A+', opts.text('wall.font_plus'), function () { size(FONT.step); }), tool('⛶', opts.text('wall.fullscreen'), function () { if (opts.fullscreen) opts.fullscreen(); }));
      mark(); apply();
    })();
    host.addEventListener('dragover', function (e) { e.preventDefault(); });
    host.addEventListener('drop', function (e) { e.preventDefault(); });

    function key(x) { return x.v.id + '/' + x.s.name; }
    function observe() {
      if (io || !root.IntersectionObserver) return;
      io = new IntersectionObserver(function (entries) {
        var fresh = false;
        entries.forEach(function (e) { var k = e.target.dataset.key; if (e.isIntersecting) { if (!visible.has(k)) fresh = true; visible.add(k); } else visible.delete(k); });
        if (fresh) tick();
      }, { root: host, rootMargin: '300px 0px' });
    }
    function make(x) {
      var tile = el('article', 'w-tile'), head = el('header'), dot = el('i', 'w-dot'), name = el('b'), srv = el('span', 'w-srv'), st = el('em'), body = el('pre', 'w-body');
      var openBtn = el('button', 'w-open', '↗'), form = el('form', 'w-reply'), input = el('textarea'), send = el('button', 'btn', opts.text('wall.send'));
      var pic = el('button', 'w-tool', '📎'), fileBtn = el('button', 'w-tool', '📂'), picker = el('input');
      tile.dataset.key = key(x);
      openBtn.type = 'button'; openBtn.title = opts.text('wall.open'); openBtn.setAttribute('aria-label', opts.text('wall.open') + ' ' + x.s.name);
      head.append(dot, name, srv, st, openBtn); head.setAttribute('role', 'button'); head.tabIndex = 0; head.title = opts.text('wall.open');
      // The header opens the real terminal; the screen is plain selectable text and the box underneath answers right here.
      head.onclick = function () { opts.open(x.v.id, x.s.name); };
      head.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); opts.open(x.v.id, x.s.name); } };
      input.rows = 1; input.setAttribute('autocomplete', 'off'); input.placeholder = opts.text('wall.reply'); input.title = opts.text('wall.reply_hint'); input.setAttribute('aria-label', opts.text('wall.reply_hint') + ' ' + x.s.name); send.type = 'submit';
      // Pictures and files: the picker button, drag and drop, or paste. The file is uploaded to the session's machine and its path lands in the box (nothing is sent until Send).
      pic.type = 'button'; pic.title = opts.text('drop.gui_anh_hoac_file_vao'); pic.setAttribute('aria-label', pic.title);
      fileBtn.type = 'button'; fileBtn.title = opts.text('html.mo_file_trong_thu_muc'); fileBtn.setAttribute('aria-label', fileBtn.title);
      picker.type = 'file'; picker.multiple = true; picker.hidden = true; picker.accept = 'image/*,.txt,.md,.log,.json,.csv,.pdf';
      function attach(list) {
        Array.prototype.slice.call(list || [], 0, 5).forEach(function (file) {
          opts.upload(x.v.id, x.s.name, file).then(function (path) { input.value = (input.value ? input.value.replace(/\s*$/, ' ') : '') + path + ' '; input.focus(); input.dispatchEvent(new Event('input')); }).catch(function (err) { opts.fail(err); });
        });
      }
      pic.onclick = function () { picker.click(); };
      picker.onchange = function () { attach(picker.files); picker.value = ''; };
      fileBtn.onclick = function () { opts.browse(x.v.id, x.s.name); };
      var hasFiles = function (dt) { return !!dt && Array.prototype.indexOf.call(dt.types || [], 'Files') >= 0; };
      var PATH_TYPE = 'application/x-termnest-path', hasPath = function (dt) { return !!dt && Array.prototype.indexOf.call(dt.types || [], PATH_TYPE) >= 0; };
      tile.addEventListener('dragover', function (e) { if (hasFiles(e.dataTransfer) || hasPath(e.dataTransfer)) { e.preventDefault(); tile.classList.add('drop'); } });
      tile.addEventListener('drop', function (e) {   // a file dragged out of the viewer: its path goes into this tile's box (same machine only)
        if (!hasPath(e.dataTransfer)) return;
        e.preventDefault(); e.stopPropagation(); tile.classList.remove('drop');
        var data; try { data = JSON.parse(e.dataTransfer.getData(PATH_TYPE)); } catch (err) { return; }
        if (!data || typeof data.path !== 'string') return;
        if (data.host && data.host !== x.v.id) { opts.fail(new Error(opts.text('drop.khac_may'))); return; }
        input.value = (input.value ? input.value.replace(/\s*$/, ' ') : '') + data.path + ' '; input.focus(); input.dispatchEvent(new Event('input'));
      }, true);
      tile.addEventListener('dragleave', function () { tile.classList.remove('drop'); });
      tile.addEventListener('drop', function (e) { tile.classList.remove('drop'); if (!hasFiles(e.dataTransfer)) return; e.preventDefault(); attach(e.dataTransfer.files); });
      input.addEventListener('paste', function (e) { var f = e.clipboardData && e.clipboardData.files; if (f && f.length) { e.preventDefault(); attach(f); } });
      // Enter sends, Shift+Enter (or Ctrl+Enter) starts a new line; the box grows with what is typed.
      function grow() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight + 2, 110) + 'px'; }
      input.addEventListener('input', grow);
      input.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' || e.isComposing) return;
        if (e.shiftKey || e.ctrlKey || e.altKey) { if (!e.shiftKey) { e.preventDefault(); var at = input.selectionStart; input.setRangeText('\n', at, input.selectionEnd, 'end'); grow(); } return; }
        e.preventDefault(); form.requestSubmit();
      });
      form.append(pic, fileBtn, input, send, picker);
      form.onsubmit = function (e) {
        e.preventDefault();
        var text = input.value; if (!text.trim()) return;
        send.disabled = true;
        opts.send(x.v.id, x.s.name, text).then(function () { input.value = ''; grow(); setTimeout(tick, 700); }).catch(function (err) { opts.fail(err); }).then(function () { send.disabled = false; });
      };
      tile.append(head, body, form);
      return { node: tile, name: name, srv: srv, st: st, body: body, dot: dot, text: null };
    }
    function paint(t, x) {
      var state = stateOf(x.s);
      t.node.dataset.state = state; t.node.style.setProperty('--c', COLOR[state]);
      t.name.textContent = x.s.name; t.srv.textContent = x.v.name; t.st.textContent = opts.stateLabel(x.s);
      t.node.setAttribute('aria-label', x.v.name + ' / ' + x.s.name);
      if (t.text == null) t.body.textContent = (x.s.lines || []).join('\n');   // the 8 lines the overview already has, until the first fetch
    }
    function filters(list) {
      fil.textContent = '';
      FILTERS.forEach(function (f) {
        var n = f === 'all' ? list.length : list.filter(function (x) { return stateOf(x.s) === f; }).length;
        var b = el('button', 'btn w-f', ''); b.type = 'button'; b.dataset.f = f; b.setAttribute('aria-pressed', String(filter === f));
        if (COLOR[f]) { b.style.setProperty('--c', COLOR[f]); b.append(el('i', 'w-dot')); }
        b.append(opts.label(f) + ' ' + n);
        b.onclick = function () { filter = f; render(); host.scrollTop = 0; }; fil.append(b);
      });
    }
    function render() {
      if (!shown) return;
      observe();
      var list = opts.items(); filters(list);
      var want = list.filter(function (x) { return filter === 'all' || stateOf(x.s) === filter; }), seen = new Set(), order = [];
      want.forEach(function (x) {
        var k = key(x), t = tiles.get(k); seen.add(k);
        if (!t) { t = make(x); tiles.set(k, t); if (io) io.observe(t.node); }
        paint(t, x); order.push(t.node);
      });
      tiles.forEach(function (t, k) { if (!seen.has(k)) { if (io) io.unobserve(t.node); t.node.remove(); tiles.delete(k); visible.delete(k); } });
      // Keep the DOM order equal to the list order without rebuilding the tiles.
      order.forEach(function (node, i) { if (grid.children[i] !== node) grid.insertBefore(node, grid.children[i] || null); });
      empty.textContent = want.length ? '' : opts.emptyText(); empty.hidden = !!want.length;
    }
    function tick() {
      if (!shown || root.document.hidden) return;
      var byServer = {};
      visible.forEach(function (k) { var i = k.indexOf('/'); (byServer[k.slice(0, i)] = byServer[k.slice(0, i)] || []).push(k.slice(i + 1)); });
      Object.keys(byServer).forEach(function (id) {
        if (busy.has(id)) return;   // never queue behind a slow server
        var names = byServer[id].slice(0, 40); busy.add(id);
        opts.api('POST', '/api/servers/' + id + '/screens', { names: names, lines: LINES }).then(function (r) {
          names.forEach(function (n) {
            var t = tiles.get(id + '/' + n), text = r && r.screens && r.screens[n];
            if (!t || typeof text !== 'string' || text === t.text) return;
            t.text = text; t.body.textContent = text;
          });
        }).catch(function () { /* the next tick tries again */ }).then(function () { busy.delete(id); });
      });
    }
    function show() { if (shown) return; shown = true; host.hidden = false; render(); timer = setInterval(tick, EVERY); setTimeout(tick, 60); }
    function hide() { if (!shown) return; shown = false; host.hidden = true; clearInterval(timer); timer = null; visible.clear(); }
    root.document.addEventListener('visibilitychange', function () { if (!root.document.hidden) tick(); });
    return { show: show, hide: hide, render: render, isShown: function () { return shown; } };
  }
  root.Wall = { create: create };
})(typeof window !== 'undefined' ? window : globalThis);
