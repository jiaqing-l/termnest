'use strict';
// Drag or paste a file onto the terminal: it is uploaded to the session's host and its path is typed (no Enter).
(function () {
  var TW = window.TW; if (!TW) return;
  var el = TW.el, MAX = 25 * 1024 * 1024, BLOCKED = /\.(exe|dll|msi|com|scr|bat|cmd|app|dmg|pkg|apk|ipa)$/i, tray = null, zone = null;
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
  function send(file) {
    var a = app(), cur = a && a.current && target(a.current()); if (!cur) { if (a && a.say) a.say(i18n('drop.chua_mo_phien_nao_de'), false, 3000); return; }
    var ui = chip(file);
    if (file.size > MAX) { ui.fail(i18n('drop.qua_25_mb')); return; }
    if (BLOCKED.test(file.name)) { ui.fail(i18n('drop.loai_file_chua_ho_tro')); return; }
    upload(cur.id, cur.name, file).then(function (path) { ui.ok(path); a.typeText(path + ' '); }).catch(function (e) { ui.fail(e.message); });
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
    host.addEventListener('dragenter', function (e) { if (inWall(e)) return; if (hasFiles(e.dataTransfer)) { depth++; zone.hidden = false; } });
    host.addEventListener('dragover', function (e) { if (inWall(e)) return; if (hasFiles(e.dataTransfer)) e.preventDefault(); });
    host.addEventListener('dragleave', function () { depth = Math.max(0, depth - 1); if (!depth) zone.hidden = true; });
    host.addEventListener('drop', function (e) { if (inWall(e)) return; depth = 0; zone.hidden = true; var f = files(e.dataTransfer); if (!f.length) return; e.preventDefault(); e.stopPropagation(); f.slice(0, 5).forEach(send); }, true);
    host.addEventListener('paste', function (e) { if (inWall(e)) return; var f = files(e.clipboardData); if (!f.length) return; e.preventDefault(); e.stopPropagation(); f.slice(0, 5).forEach(send); }, true);
    return true;
  }
  // A phone has no drag and drop: a button in the key bar opens the gallery / camera / file picker and sends through the same upload.
  function pickButton() {
    var bar = document.querySelector('.keybar'); if (!bar) return false;
    if (document.getElementById('drop-pick')) return true;
    var input = document.createElement('input'); input.type = 'file'; input.multiple = true; input.hidden = true; input.id = 'drop-input';
    input.addEventListener('change', function () { Array.prototype.slice.call(input.files || []).slice(0, 5).forEach(send); input.value = ''; });
    var b = el('button', 'btn', i18n('drop.gui_anh')); b.type = 'button'; b.id = 'drop-pick'; b.title = i18n('drop.gui_anh_hoac_file_vao');
    b.addEventListener('click', function () { chooseFile(b, input); });
    var kbd = document.getElementById('kbd-toggle'); bar.insertBefore(b, kbd ? kbd.nextSibling : bar.firstChild); document.body.append(input);
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
