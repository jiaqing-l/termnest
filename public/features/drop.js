'use strict';
// Drag or paste a file onto the terminal: it is uploaded to the session's host and its path is typed (no Enter).
(function () {
  var TW = window.TW; if (!TW) return;
  var el = TW.el, MAX = 100 * 1024 * 1024, BLOCKED = /\.(exe|dll|msi|com|scr|bat|cmd|app|dmg|pkg|apk|ipa)$/i, tray = null, zone = null;
  function app() { return TW.app(); }
  function ensure(host) {
    if (tray) return;
    host.style.position = host.style.position || 'relative';
    tray = el('div', 'drop-tray'); tray.setAttribute('role', 'status');
    zone = el('div', 'drop-zone'); zone.hidden = true; zone.append(el('div', 'drop-ico', '🖼️'), el('div', '', i18n('drop.tha_file_vao_day_de')), el('small', '', i18n('drop.anh_txt_md_log_json')));
    host.append(zone, tray);
  }
  function chip(file) {
    var c = el('div', 'drop-chip'), name = el('span', 'drop-name', file.name), st = el('small', '', i18n('drop.dang_tai'));
    c.append(name, st); tray.append(c);
    if (/^image\//.test(file.type)) { var r = new FileReader(); r.onload = function () { var i = el('img', 'drop-thumb'); i.alt = ''; i.src = r.result; c.prepend(i); }; r.readAsDataURL(file); }
    return { state: function (text) { st.textContent = text; }, ok: function (path) { st.textContent = i18n('drop.da_gui'); c.classList.add('ok'); setTimeout(function () { c.remove(); }, 6000); }, fail: function (m) { st.textContent = m; c.classList.add('bad'); c.title = m; setTimeout(function () { c.remove(); }, 9000); } };
  }
  // Uploads one file to a session's host and resolves with its path (the wall's tiles use this too).
  function upload(server, session, file) {
    if (file.size > MAX) return Promise.reject(new Error(i18n('drop.qua_25_mb')));
    if (BLOCKED.test(file.name)) return Promise.reject(new Error(i18n('drop.loai_file_chua_ho_tro')));
    return fetch('/api/features/drop/upload?server=' + encodeURIComponent(server) + '&session=' + encodeURIComponent(session) + '&name=' + encodeURIComponent(file.name),
      { method: 'POST', body: file, credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' } })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || i18n('drop.khong_tai_duoc')); return j.path; }); });
  }
  TW.upload = upload; TW.dropTarget = target;
  // The app's current() is {v: server, s: session}; accept {id, name} too. (Reading cur.id directly sent "server=undefined", so every upload failed.)
  function target(cur) { return cur && cur.v && cur.s ? { id: cur.v.id, name: cur.s.name } : cur && cur.id ? { id: cur.id, name: cur.name } : null; }
  // Pictures are made lighter before they travel: at most 2000 px on the long side (an AI model looks at about that much
  // anyway) and the smallest of PNG / WebP / JPEG, used only when it really is smaller. Text in screenshots stays sharp
  // (PNG/WebP at high quality). Shift while dropping sends the original untouched.
  var SIDE = 2000, LIGHT = 1.5 * 1024 * 1024;
  function mb(n) { return (n / 1048576).toFixed(n < 10485760 ? 1 : 0).replace('.', ',') + ' MB'; }
  function shrink(file, keep) {
    if (keep || !/^image\/(png|jpeg|webp)$/.test(file.type) || !window.createImageBitmap) return Promise.resolve(file);
    return createImageBitmap(file).then(function (img) {
      var big = Math.max(img.width, img.height), k = big > SIDE ? SIDE / big : 1;
      if (k === 1 && file.size <= LIGHT) { img.close && img.close(); return file; }
      var c = document.createElement('canvas'); c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); img.close && img.close();
      var enc = function (type, q) { return new Promise(function (ok) { c.toBlob(function (b) { ok(b && b.type === type ? b : null); }, type, q); }); };
      var tries = file.type === 'image/jpeg' ? [enc('image/jpeg', 0.9), enc('image/webp', 0.9)] : [enc('image/png'), enc('image/webp', 0.92)];
      return Promise.all(tries).then(function (blobs) {
        var best = blobs.filter(Boolean).sort(function (x, y) { return x.size - y.size; })[0];
        if (!best || best.size >= file.size) return file;
        var ext = { 'image/png': 'png', 'image/webp': 'webp', 'image/jpeg': 'jpg' }[best.type];
        var out = new File([best], file.name.replace(/\.[A-Za-z0-9]{1,8}$/, '') + '.' + ext, { type: best.type });
        out.shrunkFrom = file.size; return out;
      });
    }).catch(function () { return file; });
  }
  // At most 3 uploads at a time: 20 dropped screenshots go out steadily instead of all fighting for the link.
  var running = 0, queue = [];
  function next() { while (running < 3 && queue.length) { running++; queue.shift()().finally(function () { running--; next(); }); } }
  function send(file, keep) {
    var a = app(), cur = a && a.current && target(a.current()); if (!cur) { if (a && a.say) a.say(i18n('drop.chua_mo_phien_nao_de'), false, 3000); return; }
    var ui = chip(file);
    if (BLOCKED.test(file.name)) { ui.fail(i18n('drop.loai_file_chua_ho_tro')); return; }
    queue.push(function () {
      ui.state(/^image\//.test(file.type) && !keep ? i18n('drop.thu_nho') : i18n('drop.dang_tai'));
      return shrink(file, keep).then(function (f) {
        if (f.size > MAX) throw new Error(i18n('drop.qua_25_mb'));
        ui.state(f.shrunkFrom ? i18n('drop.da_thu_nho', [mb(f.shrunkFrom), mb(f.size)]) : i18n('drop.dang_tai'));
        return upload(cur.id, cur.name, f);
      }).then(function (path) { ui.ok(path); a.typeText(path + ' '); }).catch(function (e) { ui.fail(e.message); });
    });
    next();
  }
  function files(dt) { return dt && dt.files ? Array.prototype.slice.call(dt.files) : []; }
  function hasFiles(dt) { return !!dt && Array.prototype.indexOf.call(dt.types || [], 'Files') >= 0; }
  function bind() {
    var a = app(), host = a && a.dropTarget && a.dropTarget(); if (!host) return false; ensure(host);
    var depth = 0;
    var inWall = function (e) { return e.target && e.target.closest && e.target.closest('#wall'); };   // the wall's tiles take their own files
    var PATH_TYPE = 'application/x-termnest-path';
    // WebKit hides custom types during dragover and wants dragenter AND dragover cancelled, so the viewer also keeps its drag in window.__twDrag.
    var isPath = function (dt) { return !!window.__twDrag || (!!dt && Array.prototype.indexOf.call(dt.types || [], PATH_TYPE) >= 0); };
    var accept = function (e) { if (inWall(e) || !isPath(e.dataTransfer)) return; e.preventDefault(); try { e.dataTransfer.dropEffect = 'copy'; } catch (err) { /* read-only in some engines */ } };
    host.addEventListener('dragenter', accept, true);
    host.addEventListener('dragover', accept, true);
    // A file dragged out of the viewer: type its path into the selected session (nothing is sent until Enter), if it lives on the same machine.
    host.addEventListener('drop', function (e) {
      if (inWall(e) || !isPath(e.dataTransfer)) return;
      e.preventDefault(); e.stopPropagation();
      var data = window.__twDrag; window.__twDrag = null;
      if (!data) { try { data = JSON.parse(e.dataTransfer.getData(PATH_TYPE)); } catch (err) { return; } }
      var cur = a.current && target(a.current()); if (!cur || !data || typeof data.path !== 'string') { if (a.say) a.say(i18n('drop.chua_mo_phien_nao_de'), false, 3000); return; }
      if (data.host && data.host !== cur.id) { if (a.say) a.say(i18n('drop.khac_may'), false, 3500); return; }
      a.typeText(data.path + ' ');
    }, true);
    // The "drop here" layer must never stay up. Counting enter/leave alone is not enough: Windows sends no dragleave when a
    // drag is cancelled (Esc), dropped outside the pane, or dropped on a listener that stops it. So it also closes when the
    // drag ends anywhere, on Esc, on a click, when the window loses focus, and when dragover stops arriving (it repeats
    // every few hundred ms while a drag is really over the pane).
    var lastOver = 0, watch = null;
    var hideZone = function () { depth = 0; zone.hidden = true; clearInterval(watch); watch = null; };
    var showZone = function () { zone.hidden = false; lastOver = Date.now(); if (!watch) watch = setInterval(function () { if (Date.now() - lastOver > 1200) hideZone(); }, 400); };
    host.addEventListener('dragenter', function (e) { if (inWall(e)) return; if (hasFiles(e.dataTransfer)) { depth++; showZone(); } });
    host.addEventListener('dragover', function (e) { if (inWall(e)) return; if (hasFiles(e.dataTransfer)) { e.preventDefault(); lastOver = Date.now(); if (zone.hidden) showZone(); } });
    host.addEventListener('dragleave', function () { depth = Math.max(0, depth - 1); if (!depth) hideZone(); });
    ['drop', 'dragend'].forEach(function (type) { window.addEventListener(type, hideZone, true); });
    window.addEventListener('blur', hideZone);
    window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !zone.hidden) hideZone(); }, true);
    window.addEventListener('mousedown', function () { if (!zone.hidden) hideZone(); }, true); // the layer lets clicks through
    host.addEventListener('drop', function (e) { if (inWall(e)) return; hideZone(); var f = files(e.dataTransfer); if (!f.length) return; e.preventDefault(); e.stopPropagation(); f.slice(0, 20).forEach(function (x) { send(x, e.shiftKey); }); }, true);
    host.addEventListener('paste', function (e) { if (inWall(e)) return; var f = files(e.clipboardData); if (!f.length) return; e.preventDefault(); e.stopPropagation(); f.slice(0, 20).forEach(function (x) { send(x, false); }); }, true);
    return true;
  }
  // A phone has no drag and drop: a button in the key bar opens the gallery / camera / file picker and sends through the same upload.
  function pickButton() {
    var bar = document.querySelector('.keybar'); if (!bar) return false;
    if (document.getElementById('drop-pick')) return true;
    var input = document.createElement('input'); input.type = 'file'; input.multiple = true; input.hidden = true; input.id = 'drop-input';
    input.addEventListener('change', function () { Array.prototype.slice.call(input.files || []).slice(0, 20).forEach(function (x) { send(x, false); }); input.value = ''; });
    var b = el('button', 'btn', i18n('drop.gui_anh')); b.type = 'button'; b.id = 'drop-pick'; b.title = i18n('drop.gui_anh_hoac_file_vao');
    b.addEventListener('click', function () { chooseFile(b, input); });
    bar.insertBefore(b, bar.firstChild); document.body.append(input);
    return true;
  }
  // "Send file" opens a small menu when there is another connected server: from this computer, or from another server. From another
  // server: pick the machine (skipped when there is only one), then a file in that machine's session folder; it is copied to the machine of
  // the open session and the path is typed in the chat. The bytes travel through TERMNEST, so the two machines need not see each other.
  function popup(anchor, title, entries) {
    var old = document.querySelector('.drop-menu'); if (old) old.remove();
    var m = el('div', 'drop-menu'); m.setAttribute('role', 'menu'); if (title) m.append(el('div', 'drop-menu-title', title));
    entries.forEach(function (e) { var it = el('button', 'drop-menu-item', e[0]); it.type = 'button'; it.setAttribute('role', 'menuitem'); it.onclick = function () { m.remove(); e[1](); }; m.append(it); });
    document.body.append(m);
    var r = anchor.getBoundingClientRect(); m.style.left = Math.max(8, Math.min(r.left, innerWidth - 270)) + 'px'; m.style.bottom = (innerHeight - r.top + 6) + 'px';
    setTimeout(function () { document.addEventListener('pointerdown', function off(ev) { if (!m.contains(ev.target)) { m.remove(); document.removeEventListener('pointerdown', off, true); } }, true); }, 0);
    var first = m.querySelector('button'); if (first) first.focus();
  }
  function otherServers() {
    var a = app(), cur = a && a.current && target(a.current());
    return !cur ? [] : ((a.servers && a.servers()) || []).filter(function (v) { return v.on && v.id !== cur.id && v.sessions && v.sessions.length; });
  }
  function takeFrom(v, cur) {
    // The browser needs a folder to start from: the machine's most recently active session.
    var a = app(), sess = v.sessions.slice().sort(function (x, y) { return (y.activity || 0) - (x.activity || 0); })[0];
    a.pickFile(v.id, sess.name, function (host, name, path) { transfer({ server: host, session: name, path: path }, cur); });
  }
  function chooseFile(anchor, input) {
    var a = app(), cur = a && a.current && target(a.current());
    if (!cur) { if (a && a.say) a.say(i18n('drop.chua_mo_phien_nao_de'), false, 3000); return; }
    var others = otherServers();
    if (!others.length) { input.click(); return; }
    popup(anchor, '', [['💻 ' + i18n('drop.tu_may_nay'), function () { input.click(); }], ['🖥 ' + i18n('drop.tu_may_chu_khac_menu') + (others.length > 1 ? '…' : ' · ' + others[0].name), function () {
      if (others.length === 1) { takeFrom(others[0], cur); return; }
      popup(anchor, i18n('drop.chon_may_nguon'), others.map(function (v) { return ['🖥 ' + v.name, function () { takeFrom(v, cur); }]; }));
    }]]);
  }
  function transfer(from, to) {
    var a = app(); ensure(a.dropTarget()); var ui = chip({ name: from.path.split(/[\\/]/).pop(), type: '' });
    ui.state(i18n('drop.dang_chep'));
    TW.api('POST', '/api/features/drop/transfer', { from: from, to: { server: to.id, session: to.name } })
      .then(function (j) { ui.ok(j.path); a.typeText(j.path + ' '); })
      .catch(function (e) { ui.fail(e.message); });
  }
  // The terminal host is created by app.js after login; bind once it exists.
  var tries = 0, t = setInterval(function () { var host = bind(), btn = pickButton(); if ((host && btn) || ++tries > 60) clearInterval(t); }, 1000);
})();
