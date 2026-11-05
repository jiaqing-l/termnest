'use strict';
// Drag or paste a file onto the terminal: it is uploaded to the session's host and its path is typed (no Enter).
(function () {
  var TW = window.TW; if (!TW) return;
  var el = TW.el, MAX = 10 * 1024 * 1024, OK = /\.(png|jpe?g|gif|webp|txt|md|log|json|csv|pdf)$/i, tray = null, zone = null;
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
    return { ok: function (path) { st.textContent = i18n('drop.da_gui'); c.classList.add('ok'); setTimeout(function () { c.remove(); }, 6000); }, fail: function (m) { st.textContent = m; c.classList.add('bad'); c.title = m; setTimeout(function () { c.remove(); }, 9000); } };
  }
  // Uploads one file to a session's host and resolves with its path (the wall's tiles use this too).
  function upload(server, session, file) {
    if (file.size > MAX) return Promise.reject(new Error(i18n('drop.qua_10_mb')));
    if (!OK.test(file.name)) return Promise.reject(new Error(i18n('drop.loai_file_chua_ho_tro')));
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
    if (file.size > MAX) { ui.fail(i18n('drop.qua_10_mb')); return; }
    if (!OK.test(file.name)) { ui.fail(i18n('drop.loai_file_chua_ho_tro')); return; }
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
    input.accept = 'image/*,.txt,.md,.log,.json,.csv,.pdf';
    input.addEventListener('change', function () { Array.prototype.slice.call(input.files || []).slice(0, 5).forEach(send); input.value = ''; });
    var b = el('button', 'btn', i18n('drop.gui_anh')); b.type = 'button'; b.id = 'drop-pick'; b.title = i18n('drop.gui_anh_hoac_file_vao');
    b.addEventListener('click', function () { input.click(); });
    var kbd = document.getElementById('kbd-toggle'); bar.insertBefore(b, kbd ? kbd.nextSibling : bar.firstChild); document.body.append(input);
    return true;
  }
  // The terminal host is created by app.js after login; bind once it exists.
  var tries = 0, t = setInterval(function () { var host = bind(), btn = pickButton(); if ((host && btn) || ++tries > 60) clearInterval(t); }, 1000);
})();
