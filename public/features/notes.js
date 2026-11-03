'use strict';
// Work notes with time-only reminders. Data lives in the encrypted vault (lib/features/notes.js); all user text is
// rendered with textContent. Reminders fire while Termnest is open; ones missed while it was closed are listed once.
(function () {
  var TW = window.TW, NC = window.NotesCore, PA = window.PetArt;
  if (!TW || !NC) return;
  var el = TW.el;
  var state = { notes: [], reminders: [], settings: { bell: true, os: true, sound: false, quiet: true, snooze: '10 phút', current: '' } };
  var tab = 'edit', loaded = false, saveTimer = null, missed = [], ui = {}, appendOpen = false;
  var QUIET = ['22:00', '07:00'];
  var SAY = { dog: 'Gâu! Mình canh ghi chú giúp bạn.', cat: 'Meo~ ghi nhanh thôi nào.', pig: 'Ụt ịt, nhớ lưu nha!', cow: 'Moo! Việc hôm nay đâu rồi?', duck: 'Cạc cạc, xong việc nào bạn ơi!', wolf: 'Awoo! Không bỏ sót việc nào đâu.', capy: 'Cứ từ từ, bạn làm được mà.', fox: 'Mình nhớ hết giúp bạn nhé.', bunny: 'Nhảy nhảy, ghi chú xong rồi!', owl: 'Khuya rồi, nhớ lưu nhé.', penguin: 'Lạnh quá, ghi nhanh rồi nghỉ thôi.', frog: 'Ộp ộp! Việc kế tiếp là gì?', dora: 'Để mình lấy bảo bối cho bạn nhé!', nobi: 'Hôm nay làm xong sớm được không nhỉ…', xuka: 'Bạn nhớ nghỉ ngơi một chút nha.', chaien: 'Làm cho xong đi, đừng lề mề!', xeko: 'Xem tớ ghi chú đẹp chưa này.', tom: 'Meo! Việc này mình bắt kịp rồi.', jerry: 'Chít chít! Đã lưu rồi đó.', shin: 'Ôi, phải làm cả việc này nữa sao?' };
  var TEMPLATES = { today: '\n## Việc hôm nay\n- [ ] \n', decide: '\n## Quyết định\n- \n', next: '\n## Việc kế tiếp\n- \n' };

  function api(method, path, body) { return TW.api(method, '/api/features/notes' + path, body); }
  function uid(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function say(text, good, ms) { var a = TW.app(); if (a && a.say) a.say(text, good !== false, ms || 3000); }
  function hash(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
  function petOf(n) { var order = (PA && PA.ORDER) || ['cat']; var k = n.pet && PA && PA.PETS[n.pet] ? n.pet : order[hash(n.id) % order.length]; return k; }
  function petSvg(kind, st) { try { return PA.pet(kind, st || 'run'); } catch (e) { return ''; } }
  function note() { return state.notes.filter(function (n) { return n.id === state.settings.current; })[0] || state.notes[0]; }
  function remsOf(n) { return state.reminders.filter(function (r) { return r.noteId === n.id; }).sort(function (a, b) { return a.time.localeCompare(b.time); }); }
  function hhmm(d) { return (d.getHours() < 10 ? '0' : '') + d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes(); }

  // ---------- persistence ----------
  function setSaved(text, cls) { if (ui.saved) { ui.saved.textContent = text; ui.saved.className = 'nt-chip ' + (cls || ''); } }
  function save(now) {
    clearTimeout(saveTimer); setSaved('đang lưu…', 'warn');
    var run = function () { api('PUT', '/data', state).then(function () { setSaved('đã lưu', 'ok'); }).catch(function (e) { setSaved('chưa lưu được', 'bad'); say('Không lưu được ghi chú: ' + e.message, false, 4000); }); };
    if (now) run(); else saveTimer = setTimeout(run, 700);
  }
  function load() {
    return api('GET', '/data').then(function (doc) {
      state = doc; loaded = true;
      if (!state.notes.length) newNote(true);
      if (!state.settings.current) state.settings.current = state.notes[0].id;
      draw();
    }).catch(function (e) { loaded = false; if (ui.box) ui.box.textContent = 'Không tải được ghi chú: ' + e.message; });
  }
  function newNote(silent) {
    var n = { id: uid('n'), title: 'Ghi chú mới', text: '# Ghi chú mới\n\n', pet: '', session: '', updatedAt: Date.now() };
    state.notes.unshift(n); state.settings.current = n.id; if (!silent) { draw(); save(); }
  }

  // ---------- export ----------
  function exportNote(ext) {
    var n = note(), name = NC.fileName(n, ext), body = NC.exportBody(n, ext), D = window.TW_DESKTOP;
    if (D && D.save) { Promise.resolve(D.save(name, body)).then(function () { say('Đã lưu ' + name, true); }, function () { say('Không lưu được tệp.', false, 3500); }); return; }
    var url = URL.createObjectURL(new Blob([body], { type: 'text/plain;charset=utf-8' })), a = document.createElement('a');
    a.href = url; a.download = name; a.click(); setTimeout(function () { URL.revokeObjectURL(url); }, 1000); say('Đã tải ' + name, true);
  }
  function sessionsList() { var a = TW.app(), out = []; if (!a) return out; a.servers().forEach(function (v) { v.sessions.forEach(function (s) { out.push({ key: v.id + '|' + s.name, label: v.name + ' / ' + s.name, id: v.id, name: s.name }); }); }); return out; }
  function doAppend() {
    var n = note(), sel = ui.sess.value.split('|'), path = ui.apath.value.trim();
    if (!sel[1]) { say('Chọn phiên (máy) chứa file cần nối.', false, 3500); return; }
    if (!path) { say('Nhập đường dẫn file .md hoặc .txt (tính từ thư mục của phiên).', false, 3500); return; }
    var text = /\.txt$/i.test(path) ? NC.toTxt(n.text) : n.text;
    api('POST', '/append', { server: sel[0], session: sel.slice(1).join('|'), path: path, text: text })
      .then(function (r) { say('Đã nối ' + r.bytes + ' byte vào cuối ' + path, true, 4000); appendOpen = false; draw(); })
      .catch(function (e) { say(e.message, false, 5000); });
  }

  // ---------- pet picker (also used by the session dialog's data: PetArt.GROUPS) ----------
  function pickPet(n) {
    var back = el('div', 'nt-back'), box = el('div', 'nt-dlg'); back.append(box);
    box.append(el('b', 'nt-h', 'Đổi thú cưng · ' + (n.title || 'ghi chú')));
    var groups = [['animals', '🐾 Thú cưng'], ['characters', '🎬 Nhân vật hoạt hình']];
    function close() { back.remove(); }
    back.onclick = function (e) { if (e.target === back) close(); };
    function item(kind, label, svg) {
      var b = el('button', 'nt-pp'); b.type = 'button'; b.setAttribute('aria-pressed', String(kind === '' ? !n.pet : n.pet === kind)); b.title = label;
      var v = el('span', 'nt-pv'); v.innerHTML = svg; b.append(v, el('small', '', label));
      b.onclick = function () { n.pet = kind; n.updatedAt = Date.now(); close(); draw(); save(); }; return b;
    }
    var auto = el('div', 'nt-prow'); auto.append(item('', 'Tự động', '<span class="nt-auto">✨</span>')); box.append(auto);
    groups.forEach(function (g) {
      var list = ((PA && PA.GROUPS) || {})[g[0]] || []; list = list.filter(function (k) { return PA.PETS[k]; }); if (!list.length) return;
      box.append(el('div', 'nt-pt', g[1]));
      var row = el('div', 'nt-prow'); list.forEach(function (k) { row.append(item(k, (PA.LABELS || {})[k] || k, petSvg(k))); }); box.append(row);
    });
    var cancel = el('button', 'btn', 'Đóng'); cancel.type = 'button'; cancel.onclick = close; box.append(cancel);
    document.body.append(back);
  }

  // ---------- reminders ----------
  function addReminder() {
    var n = note(), time = ui.rtime.value || '09:00';
    if (!NC.TIME.test(time)) { say('Giờ chưa đúng (dạng 15:30).', false, 3000); return; }
    var title = ui.rtitle.value.trim() || ('Nhắc: ' + n.title);
    state.reminders.push({ id: uid('r'), noteId: n.id, time: time, title: title, daily: ui.rdaily.checked, on: true, link: ui.rlink.value, createdAt: Date.now(), lastFired: 0 });
    ui.rtitle.value = ''; if (state.settings.os && window.Notification && Notification.permission === 'default') { try { Notification.requestPermission(); } catch (e) { /* optional */ } }
    save(); draw(); say('Đã thêm nhắc lúc ' + time + (ui.rdaily.checked ? ', lặp mỗi ngày' : ''), true);
  }
  function beep() {
    try { var C = window.AudioContext || window.webkitAudioContext, c = new C(), o = c.createOscillator(), g = c.createGain(); o.frequency.value = 660; g.gain.value = 0.04; o.connect(g); g.connect(c.destination); o.start(); setTimeout(function () { o.stop(); c.close(); }, 220); } catch (e) { /* optional */ }
  }
  function openFor(rem) {
    var n = state.notes.filter(function (x) { return x.id === rem.noteId; })[0];
    if (rem.link === 'sess' && n && n.session) { var p = n.session.split('|'); var a = TW.app(); if (a && p[1]) { a.openSession(p[0], p.slice(1).join('|')); return; } }
    if (n) { state.settings.current = n.id; tab = 'edit'; TW.app().setView('notes'); draw(); }
  }
  function ring(rem, at, late) {
    var n = state.notes.filter(function (x) { return x.id === rem.noteId; })[0], title = rem.title + (late ? ' (đã trễ)' : '');
    var now = new Date(), silent = state.settings.quiet && NC.quiet(now, QUIET[0], QUIET[1]);
    if (state.settings.bell) {
      TW.banner.show({ id: 'rem-' + rem.id, level: 'warn', title: '⏰ ' + rem.time + ' · ' + title, detail: n ? 'Ghi chú: ' + n.title : '', actions: [
        { label: 'Mở', primary: true, onClick: function () { TW.banner.hide('rem-' + rem.id); openFor(rem); } },
        { label: 'Hoãn ' + state.settings.snooze, onClick: function () { NC.snooze(rem, state.settings.snooze, new Date()); TW.banner.hide('rem-' + rem.id); save(); draw(); } },
        { label: 'Xong', onClick: function () { TW.banner.hide('rem-' + rem.id); } }] });
    }
    if (state.settings.os && window.Notification && Notification.permission === 'granted') { try { new Notification('⏰ ' + rem.time + ' · ' + title, { body: n ? n.title : '' }); } catch (e) { /* optional */ } }
    if (state.settings.sound && !silent) beep();
  }
  function tick() {
    if (!loaded) return;
    var now = new Date(), list = NC.due(state.reminders, now), changed = false;
    list.forEach(function (d) {
      NC.markFired(d.rem, d.at, now); changed = true;
      if (d.late) missed.push({ rem: d.rem, at: d.at }); else ring(d.rem, d.at, false);
    });
    if (changed) { save(); draw(); }
  }

  // ---------- drawing ----------
  function field(tag, cls, attrs) { var e = el(tag, cls); Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); }); return e; }
  function sw(on, onToggle, label) {
    var s = el('span', 'nt-sw'); s.setAttribute('role', 'switch'); s.tabIndex = 0; s.setAttribute('aria-checked', String(on)); s.setAttribute('aria-label', label || ''); s.title = on ? 'Đang bật' : 'Đang tắt';
    var f = function () { onToggle(!on); }; s.onclick = f; s.onkeydown = function (e) { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); f(); } }; return s;
  }
  function drawList() {
    ui.list.textContent = '';
    state.notes.forEach(function (n) {
      var b = el('button', 'nt-item'); b.type = 'button'; b.setAttribute('aria-pressed', String(n.id === note().id));
      var pv = el('span', 'nt-pv'); pv.innerHTML = petSvg(petOf(n)); var t = el('span', 'nt-it'); t.append(el('b', '', n.title || '(không tên)'), el('small', '', n.session ? n.session.replace('|', ' / ') : 'ghi chú chung'));
      b.append(pv, t); b.onclick = function () { save(true); state.settings.current = n.id; draw(); }; ui.list.append(b);
    });
  }
  function drawEditor() {
    var n = note(); ui.pet.innerHTML = petSvg(petOf(n), 'run'); ui.title.value = n.title; ui.say.textContent = SAY[petOf(n)] || 'Mình sẽ canh ghi chú này giúp bạn!';
    if (document.activeElement !== ui.text) ui.text.value = n.text;
    var sel = ui.sess; sel.textContent = ''; var none = el('option', '', 'Không gắn phiên'); none.value = ''; sel.append(none);
    sessionsList().forEach(function (s) { var o = el('option', '', s.label); o.value = s.key; sel.append(o); }); sel.value = n.session || '';
    var rcount = remsOf(n).filter(function (r) { return r.on; }).length; ui.rcount.textContent = String(rcount); ui.rcount.hidden = !rcount;
    ui.paneEdit.hidden = tab !== 'edit'; ui.paneRem.hidden = tab !== 'rem';
    ui.tabs.forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.t === tab)); });
    ui.appendBox.hidden = !appendOpen;
  }
  function drawReminders() {
    var n = note(), l = ui.rlist; l.textContent = ''; var items = remsOf(n), now = new Date();
    ui.rcountLine.textContent = items.filter(function (r) { return r.on; }).length + ' đang bật';
    if (!items.length) l.append(el('div', 'nt-empty', 'Chưa có nhắc nào. Chọn giờ ở trên rồi bấm “Thêm nhắc”.'));
    items.forEach(function (r) {
      var row = el('div', 'nt-rem' + (r.on ? '' : ' off')); var t = el('div', 'nt-rt'); var b = el('b', '', r.title); b.title = r.title;
      t.append(b, el('small', '', NC.whenText(r, now) + ' · ' + ({ note: 'Mở ghi chú này', sess: 'Mở phiên liên quan', none: 'Chỉ thông báo' }[r.link] || '')));
      var del = el('button', 'btn', '🗑'); del.type = 'button'; del.title = 'Xoá nhắc'; del.onclick = function () { state.reminders.splice(state.reminders.indexOf(r), 1); save(); draw(); };
      row.append(el('time', '', r.time), t, sw(r.on, function (v) { r.on = v; if (v) { delete r.snoozeUntil; r.lastFired = Date.now(); } save(); draw(); }, 'Bật tắt nhắc'), del); l.append(row);
    });
    ui.missed.hidden = !missed.length;
    if (missed.length) { ui.missedText.textContent = '⚠ ' + missed.length + ' nhắc bị lỡ khi app tắt: ' + missed.slice(0, 3).map(function (m) { return m.rem.time + ' ' + m.rem.title; }).join(' · '); }
    ui.settingsHost.textContent = '';
    var s = state.settings;
    [['bell', 'Chuông trong Termnest (khung cảnh báo phía trên)'], ['os', 'Thông báo hệ điều hành (app desktop)'], ['sound', 'Âm thanh nhẹ khi nhắc'], ['quiet', 'Giờ yên lặng ' + QUIET[0] + ' – ' + QUIET[1] + ' (không phát âm)']].forEach(function (p) {
      var row = el('label', 'nt-setrow'); row.append(el('span', '', p[1]), sw(s[p[0]], function (v) { s[p[0]] = v; save(); draw(); }, p[1])); ui.settingsHost.append(row);
    });
    var sn = el('label', 'nt-setrow'); sn.append(el('span', '', 'Hoãn nhanh')); var sel = el('select'); ['10 phút', '1 giờ', 'Sáng mai 08:00'].forEach(function (o) { sel.append(el('option', '', o)); }); sel.value = s.snooze;
    sel.onchange = function () { s.snooze = sel.value; save(); }; sn.append(sel); ui.settingsHost.append(sn);
  }
  function draw() { if (!ui.box || !loaded) return; drawList(); drawEditor(); drawReminders(); }

  // ---------- mount ----------
  function mount(box) {
    ui.box = box; box.classList.add('nt-page');
    var wrap = el('div', 'nt-wrap'), side = el('aside', 'nt-side'), head = el('div', 'nt-side-h'), add = el('button', 'btn primary', '＋ Mới'); add.type = 'button';
    add.onclick = function () { newNote(); }; head.append(el('b', '', 'Ghi chú'), add); ui.list = el('div', 'nt-list'); side.append(head, ui.list);
    var ed = el('div', 'nt-editor'), nh = el('div', 'nt-head');
    ui.pet = el('button', 'nt-petbtn'); ui.pet.type = 'button'; ui.pet.title = 'Đổi thú cưng của ghi chú này'; ui.pet.onclick = function () { pickPet(note()); };
    ui.title = field('input', 'nt-title', { 'aria-label': 'Tiêu đề ghi chú', maxlength: '120' }); ui.saved = el('span', 'nt-chip ok', 'đã lưu');
    var del = el('button', 'btn', '🗑'); del.type = 'button'; del.title = 'Xoá ghi chú này'; del.onclick = function () {
      if (del.dataset.arm !== '1') { del.dataset.arm = '1'; del.textContent = 'Xoá thật?'; setTimeout(function () { del.dataset.arm = '0'; del.textContent = '🗑'; }, 3000); return; }
      var n = note(); state.notes = state.notes.filter(function (x) { return x.id !== n.id; }); state.reminders = state.reminders.filter(function (r) { return r.noteId !== n.id; });
      if (!state.notes.length) newNote(true); state.settings.current = state.notes[0].id; del.dataset.arm = '0'; del.textContent = '🗑'; draw(); save();
    };
    nh.append(ui.pet, ui.title, ui.saved, del);
    ui.title.oninput = function () { var n = note(); n.title = ui.title.value; n.updatedAt = Date.now(); drawList(); save(); };
    ui.say = el('div', 'nt-bubble');
    var tabs = el('div', 'nt-tabs'); tabs.setAttribute('role', 'tablist'); ui.tabs = [];
    [['edit', '📝 Ghi chú'], ['rem', '⏰ Nhắc việc']].forEach(function (p) {
      var b = el('button', '', p[1]); b.type = 'button'; b.dataset.t = p[0]; b.setAttribute('role', 'tab'); b.onclick = function () { tab = p[0]; draw(); };
      if (p[0] === 'rem') { ui.rcount = el('span', 'nt-cnt', '0'); b.append(ui.rcount); } ui.tabs.push(b); tabs.append(b);
    });
    // edit pane
    ui.paneEdit = el('div', 'nt-pane'); var tpl = el('div', 'nt-tpl');
    [['today', '+ Việc hôm nay'], ['decide', '+ Quyết định'], ['next', '+ Việc kế tiếp'], ['time', '⏱ Chèn giờ']].forEach(function (p) {
      var b = el('button', '', p[1]); b.type = 'button'; b.onclick = function () { var n = note(); n.text += p[0] === 'time' ? '\n[' + hhmm(new Date()) + '] ' : TEMPLATES[p[0]]; n.updatedAt = Date.now(); ui.text.value = n.text; ui.text.focus(); save(); }; tpl.append(b);
    });
    ui.text = field('textarea', 'nt-text', { spellcheck: 'false', 'aria-label': 'Nội dung ghi chú' });
    ui.text.oninput = function () { var n = note(); n.text = ui.text.value; n.updatedAt = Date.now(); save(); };
    var act = el('div', 'nt-act'), md = el('button', 'btn primary', '⬇ Xuất .md'), tx = el('button', 'btn', '⬇ Xuất .txt'), ap = el('button', 'btn', '＋ Nối vào file…');
    [md, tx, ap].forEach(function (b) { b.type = 'button'; });
    md.onclick = function () { exportNote('md'); }; tx.onclick = function () { exportNote('txt'); }; ap.onclick = function () { appendOpen = !appendOpen; draw(); };
    ui.sess = el('select', 'nt-sess'); ui.sess.setAttribute('aria-label', 'Phiên liên quan');
    ui.sess.onchange = function () { var n = note(); n.session = ui.sess.value; save(); drawList(); };
    act.append(md, tx, ap, el('span', 'nt-hint', 'Tự lưu · không dùng AI'));
    ui.appendBox = el('div', 'nt-append'); ui.appendBox.hidden = true;
    ui.apath = field('input', 'nt-apath', { placeholder: 'Đường dẫn file có sẵn, ví dụ docs/Implementation/X/01-TRACKING.md', 'aria-label': 'File cần nối' });
    var go = el('button', 'btn primary', 'Nối vào cuối file'); go.type = 'button'; go.onclick = doAppend;
    ui.appendBox.append(el('small', '', 'Chỉ nối vào file đã có (.md hoặc .txt) trong thư mục của phiên đã gắn; không ghi đè, không tạo mới.'), ui.apath, go);
    var sessRow = el('label', 'nt-sessrow'); sessRow.append(el('span', '', 'Phiên liên quan'), ui.sess);
    ui.paneEdit.append(tpl, ui.text, sessRow, act, ui.appendBox);
    // reminders pane
    ui.paneRem = el('div', 'nt-pane'); ui.paneRem.hidden = true;
    var add2 = el('div', 'nt-radd'); ui.rtitle = field('input', 'nt-rtitle', { placeholder: 'Nhắc tôi… (ví dụ: xem lại pipeline)', 'aria-label': 'Nội dung nhắc', maxlength: '200' });
    var timeRow = el('div', 'nt-rtime'), tb = el('label', 'nt-timebox'); ui.rtime = field('input', '', { type: 'time', 'aria-label': 'Giờ nhắc' }); ui.rtime.value = '15:00'; tb.append(el('span', '', 'Lúc'), ui.rtime);
    var quick = el('div', 'nt-quick'); [[10, '+10 phút'], [30, '+30 phút'], [60, '+1 giờ']].forEach(function (q) { var b = el('button', '', q[1]); b.type = 'button'; b.onclick = function () { ui.rtime.value = hhmm(new Date(Date.now() + q[0] * 60000)); }; quick.append(b); });
    timeRow.append(tb, quick);
    var opts = el('div', 'nt-ropts'), dl = el('label', 'nt-chk'); ui.rdaily = field('input', '', { type: 'checkbox' }); dl.append(ui.rdaily, document.createTextNode(' Lặp mỗi ngày'));
    ui.rlink = el('select'); ui.rlink.setAttribute('aria-label', 'Khi nhắc thì'); [['note', 'Mở ghi chú này'], ['sess', 'Mở phiên liên quan'], ['none', 'Chỉ thông báo']].forEach(function (o) { var op = el('option', '', o[1]); op.value = o[0]; ui.rlink.append(op); });
    var addBtn = el('button', 'btn primary nt-go', '＋ Thêm nhắc'); addBtn.type = 'button'; addBtn.onclick = addReminder; opts.append(dl, ui.rlink, addBtn);
    add2.append(ui.rtitle, timeRow, opts);
    var lh = el('div', 'nt-rh'); ui.rcountLine = el('span', 'nt-chip', ''); lh.append(el('b', '', 'Nhắc của ghi chú này'), ui.rcountLine); ui.rlist = el('div', 'nt-rlist');
    var det = el('details', 'nt-set'); det.append(el('summary', '', '⚙ Cài đặt thông báo')); ui.settingsHost = el('div'); det.append(ui.settingsHost, el('p', 'nt-lim', 'Nhắc việc chỉ kêu khi Termnest đang chạy. Nếu app tắt, nhắc bị lỡ sẽ hiện ở dòng “Bỏ lỡ” khi mở lại.'));
    var foot = el('div', 'nt-rfoot'), test = el('button', 'btn', '🔔 Xem thử thông báo'); test.type = 'button';
    test.onclick = function () { ring({ id: 'test', noteId: note().id, time: hhmm(new Date()), title: 'Thông báo thử', link: 'note' }, new Date(), false); };
    ui.missed = el('span', 'nt-missed'); ui.missed.hidden = true; ui.missedText = el('span'); var ok = el('button', 'btn', 'Đã xem'); ok.type = 'button'; ok.onclick = function () { missed = []; draw(); }; ui.missed.append(ui.missedText, ok);
    foot.append(test, ui.missed);
    ui.paneRem.append(add2, lh, ui.rlist, det, foot);
    ed.append(nh, ui.say, tabs, ui.paneEdit, ui.paneRem); wrap.append(side, ed); box.append(wrap);
  }
  var view = TW.addView({ id: 'notes', label: 'Ghi chú', mount: mount, onShow: function () { if (!loaded) load(); else draw(); } });
  if (view) { load(); setInterval(tick, 15000); }
  TW.on('state', function () { if (loaded && ui.box && !ui.paneEdit.hidden && document.getElementById('v-notes') && document.getElementById('v-notes').classList.contains('on')) drawEditor(); });
})();
