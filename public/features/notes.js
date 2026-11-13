'use strict';
// Work notes with time-only reminders. Data lives in the encrypted vault (lib/features/notes.js); all user text is
// rendered with textContent. Reminders fire while Termnest is open; ones missed while it was closed are listed once.
(function () {
  var TW = window.TW, NC = window.NotesCore, PA = window.PetArt;
  if (!TW || !NC) return;
  var el = TW.el;
  var state = { notes: [], reminders: [], slots: [], settings: { bell: true, os: true, sound: false, quiet: true, slotsOnlyOpen: false, snooze: i18n('notes.10_phut'), current: '' } };
  var tab = 'edit', loaded = false, saveTimer = null, missed = [], ui = {}, appendOpen = false;
  var QUIET = ['22:00', '07:00'];
  var SAY = { dog: i18n('notes.gau_minh_canh_ghi_chu'), cat: i18n('notes.meo_ghi_nhanh_thoi_nao'), pig: i18n('notes.ut_it_nho_luu_nha'), cow: i18n('notes.moo_viec_hom_nay_dau'), duck: i18n('notes.cac_cac_xong_viec_nao'), wolf: i18n('notes.awoo_khong_bo_sot_viec'), capy: i18n('notes.cu_tu_tu_ban_lam'), fox: i18n('notes.minh_nho_het_giup_ban'), bunny: i18n('notes.nhay_nhay_ghi_chu_xong'), owl: i18n('notes.khuya_roi_nho_luu_nhe'), penguin: i18n('notes.lanh_qua_ghi_nhanh_roi'), frog: i18n('notes.op_op_viec_ke_tiep'), dora: i18n('notes.de_minh_lay_bao_boi'), nobi: i18n('notes.hom_nay_lam_xong_som'), xuka: i18n('notes.ban_nho_nghi_ngoi_mot'), chaien: i18n('notes.lam_cho_xong_di_dung'), xeko: i18n('notes.xem_to_ghi_chu_dep'), tom: i18n('notes.meo_viec_nay_minh_bat'), jerry: i18n('notes.chit_chit_da_luu_roi'), shin: i18n('notes.oi_phai_lam_ca_viec') };
  var TEMPLATES = { today: i18n('notes.viec_hom_nay'), decide: i18n('notes.quyet_dinh'), next: i18n('notes.viec_ke_tiep') };

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
    clearTimeout(saveTimer); setSaved(i18n('notes.dang_luu'), 'warn');
    var run = function () { api('PUT', '/data', state).then(function () { setSaved(i18n('notes.da_luu'), 'ok'); }).catch(function (e) { setSaved(i18n('notes.chua_luu_duoc'), 'bad'); say(i18n('notes.khong_luu_duoc_ghi_chu', [e.message]), false, 4000); }); };
    if (now) run(); else saveTimer = setTimeout(run, 700);
  }
  function load() {
    return api('GET', '/data').then(function (doc) {
      state = doc; loaded = true; if (!Array.isArray(state.slots)) state.slots = [];
      if (!state.notes.length) newNote(true);
      if (!state.settings.current) state.settings.current = state.notes[0].id;
      draw();
    }).catch(function (e) { loaded = false; if (ui.box) ui.box.textContent = i18n('notes.khong_tai_duoc_ghi_chu', [e.message]); });
  }
  function newNote(silent) {
    var n = { id: uid('n'), title: i18n('notes.ghi_chu_moi'), text: i18n('notes.ghi_chu_moi_2'), pet: '', session: '', updatedAt: Date.now() };
    state.notes.unshift(n); state.settings.current = n.id; if (!silent) { draw(); save(); }
  }

  // ---------- export ----------
  function exportNote(ext) {
    var n = note(), name = NC.fileName(n, ext), body = NC.exportBody(n, ext), D = window.TW_DESKTOP;
    if (D && D.save) { Promise.resolve(D.save(name, body)).then(function () { say(i18n('notes.da_luu_2', [name]), true); }, function () { say(i18n('notes.khong_luu_duoc_tep'), false, 3500); }); return; }
    var url = URL.createObjectURL(new Blob([body], { type: 'text/plain;charset=utf-8' })), a = document.createElement('a');
    a.href = url; a.download = name; a.click(); setTimeout(function () { URL.revokeObjectURL(url); }, 1000); say(i18n('notes.da_tai', [name]), true);
  }
  function sessionsList() { var a = TW.app(), out = []; if (!a) return out; a.servers().forEach(function (v) { v.sessions.forEach(function (s) { out.push({ key: v.id + '|' + s.name, label: v.name + ' / ' + s.name, id: v.id, name: s.name }); }); }); return out; }
  function doAppend() {
    var n = note(), sel = ui.sess.value.split('|'), path = ui.apath.value.trim();
    if (!sel[1]) { say(i18n('notes.chon_phien_may_chua_file'), false, 3500); return; }
    if (!path) { say(i18n('notes.nhap_duong_dan_file_md'), false, 3500); return; }
    var text = /\.txt$/i.test(path) ? NC.toTxt(n.text) : n.text;
    api('POST', '/append', { server: sel[0], session: sel.slice(1).join('|'), path: path, text: text })
      .then(function (r) { say(i18n('notes.da_noi_byte_vao_cuoi', [r.bytes, path]), true, 4000); appendOpen = false; draw(); })
      .catch(function (e) { say(e.message, false, 5000); });
  }

  // ---------- pet picker (also used by the session dialog's data: PetArt.GROUPS) ----------
  function pickPet(n) {
    var back = el('div', 'nt-back'), box = el('div', 'nt-dlg'); back.append(box);
    box.append(el('b', 'nt-h', i18n('notes.doi_thu_cung', [(n.title || i18n('notes.ghi_chu'))])));
    var groups = [['animals', i18n('notes.thu_cung')], ['characters', i18n('notes.nhan_vat_hoat_hinh')]];
    function close() { back.remove(); }
    back.onclick = function (e) { if (e.target === back) close(); };
    function item(kind, label, svg) {
      var b = el('button', 'nt-pp'); b.type = 'button'; b.setAttribute('aria-pressed', String(kind === '' ? !n.pet : n.pet === kind)); b.title = label;
      var v = el('span', 'nt-pv'); v.innerHTML = svg; b.append(v, el('small', '', label));
      b.onclick = function () { n.pet = kind; n.updatedAt = Date.now(); close(); draw(); save(); }; return b;
    }
    var auto = el('div', 'nt-prow'); auto.append(item('', i18n('app.tu_dong'), '<span class="nt-auto">✨</span>')); box.append(auto);
    groups.forEach(function (g) {
      var list = ((PA && PA.GROUPS) || {})[g[0]] || []; list = list.filter(function (k) { return PA.PETS[k]; }); if (!list.length) return;
      box.append(el('div', 'nt-pt', g[1]));
      var row = el('div', 'nt-prow'); list.forEach(function (k) { row.append(item(k, (PA.LABELS || {})[k] || k, petSvg(k))); }); box.append(row);
    });
    var cancel = el('button', 'btn', i18n('fileviewer.dong')); cancel.type = 'button'; cancel.onclick = close; box.append(cancel);
    document.body.append(back);
  }

  // ---------- reminders ----------
  function addReminder() {
    var n = note(), time = ui.rtime.value || '09:00';
    if (!NC.TIME.test(time)) { say(i18n('notes.gio_chua_dung_dang_15'), false, 3000); return; }
    var title = ui.rtitle.value.trim() || (i18n('notes.nhac', [n.title]));
    state.reminders.push({ id: uid('r'), noteId: n.id, time: time, title: title, daily: ui.rdaily.checked, on: true, link: ui.rlink.value, createdAt: Date.now(), lastFired: 0 });
    ui.rtitle.value = ''; if (state.settings.os && window.Notification && Notification.permission === 'default') { try { Notification.requestPermission(); } catch (e) { /* optional */ } }
    save(); draw(); say(i18n('notes.da_them_nhac_luc', [time, (ui.rdaily.checked ? i18n('notes.lap_moi_ngay') : '')]), true);
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
    var n = state.notes.filter(function (x) { return x.id === rem.noteId; })[0], title = rem.title + (late ? i18n('notes.da_tre') : '');
    var now = new Date(), silent = state.settings.quiet && NC.quiet(now, QUIET[0], QUIET[1]);
    if (state.settings.bell) {
      TW.banner.show({ id: 'rem-' + rem.id, level: 'warn', title: '⏰ ' + rem.time + ' · ' + title, detail: n ? i18n('notes.ghi_chu_2', [n.title]) : '', actions: [
        { label: i18n('notes.mo'), primary: true, onClick: function () { TW.banner.hide('rem-' + rem.id); openFor(rem); } },
        { label: i18n('notes.hoan', [state.settings.snooze]), onClick: function () { NC.snooze(rem, state.settings.snooze, new Date()); TW.banner.hide('rem-' + rem.id); save(); draw(); } },
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
    var q = { on: state.settings.quiet, from: QUIET[0], to: QUIET[1] };
    NC.dueSlots(state.slots, now, { notes: state.notes, onlyOpen: state.settings.slotsOnlyOpen, quiet: q }).forEach(function (d) {
      d.slot.lastFired = d.at.getTime(); changed = true;
      if (d.skip) return;
      if (d.late) missed.push({ rem: { time: d.slot.time, title: d.slot.msg || i18n('notes2.slot_default_msg') }, at: d.at }); else ringSlot(d.slot, d.open, d.silent);
    });
    if (changed) { save(); draw(); }
  }
  function openNotes() { tab = 'edit'; TW.app().setView('notes'); draw(); }
  function ringSlot(slot, open, silent, noSnooze) {
    var id = 'slot-' + slot.id, title = '⏰ ' + slot.time + ' · ' + (slot.msg || i18n('notes2.slot_default_msg')), detail = i18n('notes2.slot_card', [open]);
    if (state.settings.bell) {
      var actions = [{ label: i18n('notes.mo'), primary: true, onClick: function () { TW.banner.hide(id); openNotes(); } }];
      if (!noSnooze) actions.push({ label: i18n('notes.hoan', [i18n('notes.1_gio')]), onClick: function () { TW.banner.hide(id); setTimeout(function () { ringSlot(slot, NC.openTotal(state.notes), false, true); }, 3600000); } });
      actions.push({ label: i18n('notes2.done'), onClick: function () { TW.banner.hide(id); } });
      TW.banner.show({ id: id, level: 'warn', title: title, detail: detail, actions: actions });
    }
    if (state.settings.os && window.Notification && Notification.permission === 'granted') {
      try { var nt = new Notification(title, { body: detail }); nt.onclick = function () { try { window.focus(); } catch (e) { /* optional */ } openNotes(); }; } catch (e) { /* optional */ }
    }
    if (state.settings.sound && !silent) beep();
  }
  function drawSlots() {
    var h = ui.slotsHost; if (!h) return; h.textContent = '';
    var card = el('div', 'nt-card'), s = state.settings;
    card.append(el('h4', '', i18n('notes2.slots_title')), el('p', 'nt-lim', i18n('notes2.slots_sub')));
    if (!state.slots.length) card.append(el('div', 'nt-empty', i18n('notes2.slots_empty')));
    state.slots.slice().sort(function (a, b) { return a.time.localeCompare(b.time); }).forEach(function (x) {
      var row = el('div', 'nt-slot' + (x.on ? '' : ' off')), top = el('div', 'nt-slot-top');
      var tm = field('input', 'nt-slot-time', { type: 'time', 'aria-label': i18n('notes.gio_nhac') }); tm.value = x.time;
      tm.onchange = function () { if (NC.TIME.test(tm.value)) { x.time = tm.value; x.lastFired = 0; x.createdAt = Date.now(); save(); draw(); } else tm.value = x.time; };
      var msg = field('input', 'nt-slot-msg', { 'aria-label': i18n('notes2.slot_msg'), maxlength: '200', placeholder: i18n('notes2.slot_default_msg') }); msg.value = x.msg;
      msg.oninput = function () { x.msg = msg.value; save(); };
      var del = el('button', 'btn nt-danger', '🗑'); del.type = 'button'; del.title = i18n('notes2.slot_delete'); del.onclick = function () { state.slots.splice(state.slots.indexOf(x), 1); save(); draw(); };
      top.append(tm, msg, sw(x.on, function (v) { x.on = v; if (v) { x.lastFired = Date.now(); } save(); draw(); }, i18n('notes.bat_tat_nhac')), del);
      var days = el('div', 'nt-days'); days.append(el('span', 'nt-lim', i18n('notes2.repeat_on')));
      [1, 2, 3, 4, 5, 6, 7].forEach(function (d) {
        var b = el('button', 'nt-dow', d === 7 ? i18n('notes2.dow_sun') : i18n('notes2.dow_' + d)); b.type = 'button'; b.setAttribute('aria-pressed', String(x.days.indexOf(d) >= 0));
        b.onclick = function () { x.days = NC.toggleDay(x.days, d); save(); draw(); }; days.append(b);
      });
      var kind = NC.daysText(x.days);
      [['work', 'notes2.workdays', NC.WORKDAYS], ['all', 'notes2.everyday', NC.ALLDAYS]].forEach(function (p) {
        var b = el('button', 'nt-chipb', i18n(p[1])); b.type = 'button'; b.setAttribute('aria-pressed', String(kind === p[0])); b.onclick = function () { x.days = p[2].slice(); save(); draw(); }; days.append(b);
      });
      row.append(top, days); card.append(row);
    });
    var add = el('div', 'nt-slot-add'), t = field('input', 'nt-slot-time', { type: 'time', 'aria-label': i18n('notes.gio_nhac') }); t.value = '15:00';
    var ab = el('button', 'btn primary', i18n('notes2.add_slot')); ab.type = 'button';
    ab.onclick = function () {
      if (!NC.TIME.test(t.value)) { say(i18n('notes.gio_chua_dung_dang_15'), false, 3000); return; }
      state.slots.push({ id: uid('s'), time: t.value, msg: i18n('notes2.slot_default_msg'), days: NC.WORKDAYS.slice(), on: true, createdAt: Date.now(), lastFired: 0 });
      if (state.settings.os && window.Notification && Notification.permission === 'default') { try { Notification.requestPermission(); } catch (e) { /* optional */ } }
      save(); draw();
    };
    var prev = el('button', 'btn', i18n('notes.xem_thu_thong_bao')); prev.type = 'button';
    prev.onclick = function () { ringSlot({ id: 'test', time: hhmm(new Date()), msg: i18n('notes2.slot_default_msg') }, NC.openTotal(state.notes), false, true); };
    add.append(t, ab, prev); card.append(add);
    var only = el('label', 'nt-setrow'), lab = el('span', ''); lab.append(el('b', '', i18n('notes2.only_open')), el('small', 'nt-lim', i18n('notes2.only_open_sub')));
    only.append(lab, sw(!!s.slotsOnlyOpen, function (v) { s.slotsOnlyOpen = v; save(); draw(); }, i18n('notes2.only_open')));
    card.append(only); h.append(card);
  }

  // ---------- drawing ----------
  function field(tag, cls, attrs) { var e = el(tag, cls); Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); }); return e; }
  function sw(on, onToggle, label) {
    var s = el('span', 'nt-sw'); s.setAttribute('role', 'switch'); s.tabIndex = 0; s.setAttribute('aria-checked', String(on)); s.setAttribute('aria-label', label || ''); s.title = on ? i18n('notes.dang_bat') : i18n('notes.dang_tat');
    var f = function () { onToggle(!on); }; s.onclick = f; s.onkeydown = function (e) { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); f(); } }; return s;
  }
  function drawList() {
    ui.list.textContent = '';
    state.notes.forEach(function (n) {
      var b = el('button', 'nt-item'); b.type = 'button'; b.setAttribute('aria-pressed', String(n.id === note().id));
      var pv = el('span', 'nt-pv'); pv.innerHTML = petSvg(petOf(n)); var t = el('span', 'nt-it'); t.append(el('b', '', n.title || i18n('notes.khong_ten')), el('small', '', n.session ? n.session.replace('|', ' / ') : i18n('notes.ghi_chu_chung')));
      var open = NC.openTasks(n.text); if (open) t.append(el('span', 'nt-open', i18n('notes2.open_tasks', [open])));
      b.append(pv, t); b.onclick = function () { save(true); state.settings.current = n.id; draw(); }; ui.list.append(b);
    });
  }
  function drawEditor() {
    var n = note(); ui.pet.innerHTML = petSvg(petOf(n), 'run'); ui.title.value = n.title; ui.say.textContent = SAY[petOf(n)] || i18n('notes.minh_se_canh_ghi_chu');
    if (document.activeElement !== ui.text) ui.text.value = n.text;
    var sel = ui.sess; sel.textContent = ''; var none = el('option', '', i18n('notes.khong_gan_phien')); none.value = ''; sel.append(none);
    sessionsList().forEach(function (s) { var o = el('option', '', s.label); o.value = s.key; sel.append(o); }); sel.value = n.session || '';
    var rcount = remsOf(n).filter(function (r) { return r.on; }).length; ui.rcount.textContent = String(rcount); ui.rcount.hidden = !rcount;
    ui.paneEdit.hidden = tab !== 'edit'; ui.paneRem.hidden = tab !== 'rem';
    ui.tabs.forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.t === tab)); });
    ui.appendBox.hidden = !appendOpen;
    var oc = NC.openTasks(n.text); ui.openTag.textContent = i18n('notes2.open_tasks', [oc]); ui.openTag.hidden = !oc;
    ui.paneSet.hidden = tab !== 'set';
  }
  function drawReminders() {
    var n = note(), l = ui.rlist; l.textContent = ''; var items = remsOf(n), now = new Date();
    ui.rcountLine.textContent = i18n('notes.dang_bat_2', [items.filter(function (r) { return r.on; }).length]);
    if (!items.length) l.append(el('div', 'nt-empty', i18n('notes.chua_co_nhac_nao_chon')));
    items.forEach(function (r) {
      var row = el('div', 'nt-rem' + (r.on ? '' : ' off')); var t = el('div', 'nt-rt'); var b = el('b', '', r.title); b.title = r.title;
      t.append(b, el('small', '', NC.whenText(r, now) + ' · ' + ({ note: i18n('notes.mo_ghi_chu_nay'), sess: i18n('notes.mo_phien_lien_quan'), none: i18n('notes.chi_thong_bao') }[r.link] || '')));
      var del = el('button', 'btn', '🗑'); del.type = 'button'; del.title = i18n('notes.xoa_nhac'); del.onclick = function () { state.reminders.splice(state.reminders.indexOf(r), 1); save(); draw(); };
      row.append(el('time', '', r.time), t, sw(r.on, function (v) { r.on = v; if (v) { delete r.snoozeUntil; r.lastFired = Date.now(); } save(); draw(); }, i18n('notes.bat_tat_nhac')), del); l.append(row);
    });
    ui.missed.hidden = !missed.length;
    if (missed.length) { ui.missedText.textContent = i18n('notes.nhac_bi_lo_khi_app', [missed.length, missed.slice(0, 3).map(function (m) { return m.rem.time + ' ' + m.rem.title; }).join(' · ')]); }
    ui.settingsHost.textContent = '';
    var s = state.settings;
    [['bell', i18n('notes.chuong_trong_termnest_khung_canh')], ['os', i18n('notes.thong_bao_he_dieu_hanh')], ['sound', i18n('notes.am_thanh_nhe_khi_nhac')], ['quiet', i18n('notes.gio_yen_lang_khong_phat', [QUIET[0], QUIET[1]])]].forEach(function (p) {
      var row = el('label', 'nt-setrow'); row.append(el('span', '', p[1]), sw(s[p[0]], function (v) { s[p[0]] = v; save(); draw(); }, p[1])); ui.settingsHost.append(row);
    });
    var sn = el('label', 'nt-setrow'); sn.append(el('span', '', i18n('notes.hoan_nhanh'))); var sel = el('select'); [i18n('notes.10_phut'), i18n('notes.1_gio'), i18n('notes.sang_mai_08_00')].forEach(function (o) { sel.append(el('option', '', o)); }); sel.value = s.snooze;
    sel.onchange = function () { s.snooze = sel.value; save(); }; sn.append(sel); ui.settingsHost.append(sn);
  }
  function draw() { if (!ui.box || !loaded) return; drawList(); drawEditor(); drawReminders(); drawSlots(); }

  // ---------- mount ----------
  function mount(box) {
    ui.box = box; box.classList.add('nt-page');
    var wrap = el('div', 'nt-wrap'), side = el('aside', 'nt-side'), head = el('div', 'nt-side-h'), add = el('button', 'btn primary', i18n('notes.moi')); add.type = 'button';
    add.onclick = function () { newNote(); }; head.append(el('b', '', i18n('notes.ghi_chu_3')), add); ui.list = el('div', 'nt-list'); side.append(head, ui.list);
    var ed = el('div', 'nt-editor'), nh = el('div', 'nt-head');
    ui.pet = el('button', 'nt-petbtn'); ui.pet.type = 'button'; ui.pet.title = i18n('notes.doi_thu_cung_cua_ghi'); ui.pet.onclick = function () { pickPet(note()); };
    ui.title = field('input', 'nt-title', { 'aria-label': i18n('notes.tieu_de_ghi_chu'), maxlength: '120' }); ui.saved = el('span', 'nt-chip ok', i18n('notes.da_luu'));
    var del = el('button', 'btn', '🗑'); del.type = 'button'; del.title = i18n('notes.xoa_ghi_chu_nay'); del.onclick = function () {
      if (del.dataset.arm !== '1') { del.dataset.arm = '1'; del.textContent = i18n('notes.xoa_that'); setTimeout(function () { del.dataset.arm = '0'; del.textContent = '🗑'; }, 3000); return; }
      var n = note(); state.notes = state.notes.filter(function (x) { return x.id !== n.id; }); state.reminders = state.reminders.filter(function (r) { return r.noteId !== n.id; });
      if (!state.notes.length) newNote(true); state.settings.current = state.notes[0].id; del.dataset.arm = '0'; del.textContent = '🗑'; draw(); save();
    };
    nh.append(ui.pet, ui.title, ui.saved, del);
    ui.title.oninput = function () { var n = note(); n.title = ui.title.value; n.updatedAt = Date.now(); drawList(); save(); };
    ui.say = el('div', 'nt-bubble');
    var tabs = el('div', 'nt-tabs'); tabs.setAttribute('role', 'tablist'); ui.tabs = [];
    [['edit', i18n('notes.ghi_chu_4')], ['rem', i18n('notes.nhac_viec')], ['set', i18n('notes2.tab_settings')]].forEach(function (p) {
      var b = el('button', '', p[1]); b.type = 'button'; b.dataset.t = p[0]; b.setAttribute('role', 'tab'); b.onclick = function () { tab = p[0]; draw(); };
      if (p[0] === 'rem') { ui.rcount = el('span', 'nt-cnt', '0'); b.append(ui.rcount); } ui.tabs.push(b); tabs.append(b);
    });
    // edit pane
    ui.paneEdit = el('div', 'nt-pane'); var tpl = el('div', 'nt-tpl');
    [['today', i18n('notes.viec_hom_nay_2')], ['decide', i18n('notes.quyet_dinh_2')], ['next', i18n('notes.viec_ke_tiep_2')], ['time', i18n('notes.chen_gio')]].forEach(function (p) {
      var b = el('button', '', p[1]); b.type = 'button'; b.onclick = function () { var n = note(); n.text += p[0] === 'time' ? '\n[' + hhmm(new Date()) + '] ' : TEMPLATES[p[0]]; n.updatedAt = Date.now(); ui.text.value = n.text; ui.text.focus(); save(); }; tpl.append(b);
    });
    ui.text = field('textarea', 'nt-text', { spellcheck: 'false', 'aria-label': i18n('notes.noi_dung_ghi_chu') });
    ui.text.oninput = function () { var n = note(); n.text = ui.text.value; n.updatedAt = Date.now(); save(); };
    var act = el('div', 'nt-act'), md = el('button', 'btn primary', i18n('notes.xuat_md')), tx = el('button', 'btn', i18n('notes.xuat_txt')), ap = el('button', 'btn', i18n('notes.noi_vao_file'));
    [md, tx, ap].forEach(function (b) { b.type = 'button'; });
    md.onclick = function () { exportNote('md'); }; tx.onclick = function () { exportNote('txt'); }; ap.onclick = function () { appendOpen = !appendOpen; draw(); };
    ui.sess = el('select', 'nt-sess'); ui.sess.setAttribute('aria-label', i18n('notes.phien_lien_quan'));
    ui.sess.onchange = function () { var n = note(); n.session = ui.sess.value; save(); drawList(); };
    ui.openTag = el('span', 'nt-open'); ui.openTag.hidden = true;
    act.append(md, tx, ap, ui.openTag, el('span', 'nt-hint', i18n('notes.tu_luu_khong_dung_ai')));
    ui.appendBox = el('div', 'nt-append'); ui.appendBox.hidden = true;
    ui.apath = field('input', 'nt-apath', { placeholder: i18n('notes.duong_dan_file_co_san'), 'aria-label': i18n('notes.file_can_noi') });
    var go = el('button', 'btn primary', i18n('notes.noi_vao_cuoi_file')); go.type = 'button'; go.onclick = doAppend;
    ui.appendBox.append(el('small', '', i18n('notes.chi_noi_vao_file_da')), ui.apath, go);
    var sessRow = el('label', 'nt-sessrow'); sessRow.append(el('span', '', i18n('notes.phien_lien_quan')), ui.sess);
    ui.paneEdit.append(tpl, ui.text, sessRow, act, ui.appendBox);
    // reminders pane
    ui.paneRem = el('div', 'nt-pane'); ui.paneRem.hidden = true;
    var add2 = el('div', 'nt-radd'); ui.rtitle = field('input', 'nt-rtitle', { placeholder: i18n('notes.nhac_toi_vi_du_xem'), 'aria-label': i18n('notes.noi_dung_nhac'), maxlength: '200' });
    var timeRow = el('div', 'nt-rtime'), tb = el('label', 'nt-timebox'); ui.rtime = field('input', '', { type: 'time', 'aria-label': i18n('notes.gio_nhac') }); ui.rtime.value = '15:00'; tb.append(el('span', '', i18n('notes.luc')), ui.rtime);
    var quick = el('div', 'nt-quick'); [[10, i18n('notes.10_phut_2')], [30, i18n('notes.30_phut')], [60, i18n('notes.1_gio_2')]].forEach(function (q) { var b = el('button', '', q[1]); b.type = 'button'; b.onclick = function () { ui.rtime.value = hhmm(new Date(Date.now() + q[0] * 60000)); }; quick.append(b); });
    timeRow.append(tb, quick);
    var opts = el('div', 'nt-ropts'), dl = el('label', 'nt-chk'); ui.rdaily = field('input', '', { type: 'checkbox' }); dl.append(ui.rdaily, document.createTextNode(i18n('notes.lap_moi_ngay_2')));
    ui.rlink = el('select'); ui.rlink.setAttribute('aria-label', i18n('notes.khi_nhac_thi')); [['note', i18n('notes.mo_ghi_chu_nay')], ['sess', i18n('notes.mo_phien_lien_quan')], ['none', i18n('notes.chi_thong_bao')]].forEach(function (o) { var op = el('option', '', o[1]); op.value = o[0]; ui.rlink.append(op); });
    var addBtn = el('button', 'btn primary nt-go', i18n('notes.them_nhac')); addBtn.type = 'button'; addBtn.onclick = addReminder; opts.append(dl, ui.rlink, addBtn);
    add2.append(ui.rtitle, timeRow, opts);
    var lh = el('div', 'nt-rh'); ui.rcountLine = el('span', 'nt-chip', ''); lh.append(el('b', '', i18n('notes.nhac_cua_ghi_chu_nay')), ui.rcountLine); ui.rlist = el('div', 'nt-rlist');
    ui.settingsHost = el('div');
    var foot = el('div', 'nt-rfoot'), test = el('button', 'btn', i18n('notes.xem_thu_thong_bao')); test.type = 'button';
    test.onclick = function () { ring({ id: 'test', noteId: note().id, time: hhmm(new Date()), title: i18n('notes.thong_bao_thu'), link: 'note' }, new Date(), false); };
    ui.missed = el('span', 'nt-missed'); ui.missed.hidden = true; ui.missedText = el('span'); var ok = el('button', 'btn', i18n('notes.da_xem')); ok.type = 'button'; ok.onclick = function () { missed = []; draw(); }; ui.missed.append(ui.missedText, ok);
    foot.append(ui.missed);
    ui.paneRem.append(add2, lh, ui.rlist, foot);
    // settings pane: check-in slots + notification channels
    ui.paneSet = el('div', 'nt-pane nt-setpane'); ui.paneSet.hidden = true; ui.slotsHost = el('div', 'nt-slots');
    var chan = el('div', 'nt-card'); chan.append(el('h4', '', i18n('notes.cai_dat_thong_bao')), ui.settingsHost, el('p', 'nt-lim', i18n('notes.nhac_viec_chi_keu_khi')), test);
    ui.paneSet.append(ui.slotsHost, chan);
    ed.append(nh, ui.say, tabs, ui.paneEdit, ui.paneRem, ui.paneSet); wrap.append(side, ed); box.append(wrap);
  }
  var view = TW.addView({ id: 'notes', label: i18n('notes.ghi_chu_3'), mount: mount, onShow: function () { if (!loaded) load(); else draw(); } });
  if (view) { load(); setInterval(tick, 15000); }
  TW.on('state', function () { if (loaded && ui.box && !ui.paneEdit.hidden && document.getElementById('v-notes') && document.getElementById('v-notes').classList.contains('on')) drawEditor(); });
})();
