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
    zone = el('div', 'drop-zone'); zone.hidden = true; zone.append(el('div', 'drop-ico', '🖼️'), el('div', '', 'Thả file vào đây để gửi cho phiên'), el('small', '', 'ảnh, txt, md, log, json, csv, pdf · tối đa 10 MB · lưu tạm trên máy xa, tự xoá sau 1 ngày'));
    host.append(zone, tray);
  }
  function chip(file) {
    var c = el('div', 'drop-chip'), name = el('span', 'drop-name', file.name), st = el('small', '', 'đang tải…');
    c.append(name, st); tray.append(c);
    if (/^image\//.test(file.type)) { var r = new FileReader(); r.onload = function () { var i = el('img', 'drop-thumb'); i.alt = ''; i.src = r.result; c.prepend(i); }; r.readAsDataURL(file); }
    return { ok: function (path) { st.textContent = 'đã gửi'; c.classList.add('ok'); setTimeout(function () { c.remove(); }, 6000); }, fail: function (m) { st.textContent = m; c.classList.add('bad'); c.title = m; setTimeout(function () { c.remove(); }, 9000); } };
  }
  function send(file) {
    var a = app(), cur = a && a.current && a.current(); if (!cur) { if (a && a.say) a.say('Chưa mở phiên nào để nhận file.', false, 3000); return; }
    var ui = chip(file);
    if (file.size > MAX) { ui.fail('quá 10 MB'); return; }
    if (!OK.test(file.name)) { ui.fail('loại file chưa hỗ trợ'); return; }
    fetch('/api/features/drop/upload?server=' + encodeURIComponent(cur.id) + '&session=' + encodeURIComponent(cur.name) + '&name=' + encodeURIComponent(file.name),
      { method: 'POST', body: file, credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' } })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || 'Không tải được.'); return j; }); })
      .then(function (j) { ui.ok(j.path); a.typeText(j.path + ' '); })
      .catch(function (e) { ui.fail(e.message); });
  }
  function files(dt) { return dt && dt.files ? Array.prototype.slice.call(dt.files) : []; }
  function hasFiles(dt) { return !!dt && Array.prototype.indexOf.call(dt.types || [], 'Files') >= 0; }
  function bind() {
    var a = app(), host = a && a.dropTarget && a.dropTarget(); if (!host) return false; ensure(host);
    var depth = 0;
    host.addEventListener('dragenter', function (e) { if (hasFiles(e.dataTransfer)) { depth++; zone.hidden = false; } });
    host.addEventListener('dragover', function (e) { if (hasFiles(e.dataTransfer)) e.preventDefault(); });
    host.addEventListener('dragleave', function () { depth = Math.max(0, depth - 1); if (!depth) zone.hidden = true; });
    host.addEventListener('drop', function (e) { depth = 0; zone.hidden = true; var f = files(e.dataTransfer); if (!f.length) return; e.preventDefault(); e.stopPropagation(); f.slice(0, 5).forEach(send); }, true);
    host.addEventListener('paste', function (e) { var f = files(e.clipboardData); if (!f.length) return; e.preventDefault(); e.stopPropagation(); f.slice(0, 5).forEach(send); }, true);
    return true;
  }
  // A phone has no drag and drop: a button in the key bar opens the gallery / camera / file picker and sends through the same upload.
  function pickButton() {
    var bar = document.querySelector('.keybar'); if (!bar) return false;
    if (document.getElementById('drop-pick')) return true;
    var input = document.createElement('input'); input.type = 'file'; input.multiple = true; input.hidden = true; input.id = 'drop-input';
    input.accept = 'image/*,.txt,.md,.log,.json,.csv,.pdf';
    input.addEventListener('change', function () { Array.prototype.slice.call(input.files || []).slice(0, 5).forEach(send); input.value = ''; });
    var b = el('button', 'btn', '📎 Gửi ảnh'); b.type = 'button'; b.id = 'drop-pick'; b.title = 'Gửi ảnh hoặc file vào phiên đang mở';
    b.addEventListener('click', function () { input.click(); });
    var kbd = document.getElementById('kbd-toggle'); bar.insertBefore(b, kbd ? kbd.nextSibling : bar.firstChild); document.body.append(input);
    return true;
  }
  // The terminal host is created by app.js after login; bind once it exists.
  var tries = 0, t = setInterval(function () { var host = bind(), btn = pickButton(); if ((host && btn) || ++tries > 60) clearInterval(t); }, 1000);
})();
