'use strict';
// Crew panes (prototype): an orchestrator session plus N worker sessions shown together. Every state shown here is measured
// from the live panes (screen text, output age) or from the plan file the orchestrator writes, and says where it came from.
(function () {
  var TW = window.TW; if (!TW) return;
  var el = TW.el, PET = window.PetArt;
  var crews = [], tracks = {}, cur = null, menuOpen = false, layoutMode = 'L', roOff = {}, boxes = [], QUIET = 45;
  var KINDS = ['owl', 'cat', 'fox', 'bunny', 'frog'], COLORS = ['#7c6cf0', '#0fa58a', '#2f80ed', '#e08a00', '#d85aa0'];
  var LABEL = { run: 'Đang chạy', wait: 'Chờ bạn', idle: 'Rảnh', done: 'Xong', quiet: 'Im lặng', gone: 'Mất phiên', off: 'Không đo được' };
  function app() { return TW.app(); }
  function post(path, body) { return TW.api('POST', '/api/features/crewpanes' + path, body); }
  function get(path) { return TW.api('GET', '/api/features/crewpanes' + path); }
  function petSvg(i, st) { return PET ? PET.pet(KINDS[i % KINDS.length], st === 'run' ? 'run' : st === 'wait' ? 'wait' : 'idle') : ''; }
  function ago(sec) { sec = Math.max(0, Math.round(sec)); return sec < 60 ? sec + ' giây trước' : sec < 3600 ? Math.floor(sec / 60) + ' phút trước' : Math.floor(sec / 3600) + ' giờ ' + Math.floor(sec % 3600 / 60) + ' phút trước'; }
  function members(c) { return [c.name].concat(c.workers); }
  function server(c) { return (app().servers() || []).filter(function (v) { return v.id === c.server; })[0]; }
  function sess(c, name) { var v = server(c); return v && v.sessions ? v.sessions.filter(function (s) { return s.name === name; })[0] : null; }
  function tail(s) { return (s && s.lines || []).filter(function (l) { return l.trim(); }).slice(-8).join('\n'); }
  function trackOf(c, worker) { var t = (tracks[c.id] || {}).tracks || []; return t.filter(function (x) { return x.worker === worker.replace(c.name + '-', '') && x.state === 'dispatched'; })[0]; }

  // The honest state of one pane: what its own screen and activity say, never inferred from files that may be stale.
  function paneState(c, name) {
    var v = server(c), s = sess(c, name), isO = name === c.name;
    if (!v || !v.on) return { k: 'off', src: 'máy chủ không phản hồi' };
    if (!s) return { k: 'gone', src: 'phiên không còn trên máy chủ' };
    var age = s.activityAge == null ? null : s.activityAge, text = tail(s), out = age == null ? 'chưa rõ' : 'output ' + ago(age);
    if (isO && (s.asking || /Trả lời OK|\(chờ bạn\)/.test(text.split('\n').slice(-3).join('\n')))) return { k: 'wait', src: 'đo từ pane · ' + out, age: age };
    var tr = !isO && trackOf(c, name);
    if (tr) return age != null && age > QUIET ? { k: 'quiet', src: 'đo từ pane · ' + out + ' · việc ' + tr.id, age: age, track: tr } : { k: 'run', src: 'đo từ pane · ' + out + ' · ' + tr.id, age: age, track: tr };
    if (isO && age != null && age <= 20) return { k: 'run', src: 'đo từ pane · ' + out, age: age };
    return { k: isO && /✔ Tất cả track xong|Báo cáo/.test(text) ? 'done' : 'idle', src: 'đo từ pane · ' + out, age: age };
  }
  function summary(c) {
    var st = members(c).map(function (n) { return paneState(c, n); }), t = (tracks[c.id] || {});
    if (st.some(function (x) { return x.k === 'off'; })) return { k: 'unknown', label: 'Không đo được', cls: 'unknown', sub: 'Mất kết nối tới máy chủ: không đoán trạng thái.', st: st };
    if (st.some(function (x) { return x.k === 'gone'; })) return { k: 'check', label: 'Cần kiểm tra', cls: 'check', sub: 'Có phiên của Crew không còn trên máy chủ.', st: st };
    if (st.some(function (x) { return x.k === 'quiet'; })) return { k: 'check', label: 'Cần kiểm tra', cls: 'check', sub: 'Có thợ im lặng lâu bất thường — không gọi đó là “đang bận”.', st: st };
    if (st[0].k === 'wait') return { k: 'wait', label: 'Chờ bạn', cls: 'wait', sub: 'Điều phối dừng ở câu hỏi chờ bạn trả lời.', st: st };
    if (st.some(function (x) { return x.k === 'run'; })) return { k: 'run', label: 'Đang chạy', cls: 'run', sub: 'Có pane xuất ra nội dung trong vài giây qua.', st: st };
    if (st[0].k === 'done' || t.phase === 'done') return { k: 'done', label: 'Xong · chờ gộp', cls: 'run', sub: 'Mọi track đã xong.', st: st };
    return { k: 'idle', label: 'Đang nghỉ', cls: '', sub: 'Chưa có việc đang chạy.', st: st };
  }
  function crewOf(id, name) { for (var i = 0; i < crews.length; i++) { var c = crews[i]; if (c.server === id && members(c).indexOf(name) >= 0) return c; } return null; }
  TW.crewOf = crewOf;

  // ----- sidebar + overview -----
  function pill(cls, text) { return el('span', 'pill ' + cls, text); }
  TW.sideCrews = function (box, api) {
    crews.forEach(function (c) {
      box.append(el('div', 'group', 'Crew'));
      var g = el('div', 'cp-group'), sm = summary(c);
      members(c).forEach(function (name, i) {
        var st = sm.st[i], b = el('button', 'sess' + (i ? ' w' : '')); b.style.setProperty('--c', COLORS[i % COLORS.length]); b.title = name;
        b.setAttribute('aria-current', String(!!cur && cur.id === c.id && cur.focus === name));
        var a = el('span', 'ava'); a.innerHTML = petSvg(i, st.k); a.append(el('span', 'flag ' + (st.k === 'run' ? 'run' : st.k === 'wait' ? 'wait' : '')));
        var t = el('span', 'txt'); t.append(el('span', 'n', i ? name.replace(c.name + '-', '') : c.name), el('span', 's', i ? LABEL[st.k] : 'điều phối · ' + sm.label));
        b.append(a, t); b.onclick = function () { openCrew(c, name); }; g.append(b);
      });
      box.append(g);
    });
  };
  TW.gridCrews = function (g, v) {
    crews.filter(function (c) { return c.server === v.id; }).forEach(function (c) {
      var sm = summary(c), card = el('div', 'card crewcard' + (sm.k === 'wait' ? ' wait' : '')); card.style.setProperty('--c', COLORS[0]);
      var h = el('div', 'card-head'), pet = el('span', 'cp-pet'); pet.innerHTML = petSvg(0, sm.k);
      var t = el('div', 't'); t.append(el('span', 'n', 'Crew ' + c.name), el('span', 's', '1 điều phối + ' + c.workers.length + ' thợ · ' + c.dir)); h.append(pet, t, pill(sm.cls, sm.label));
      var o = sess(c, c.name), mini = el('div', 'mini'); mini.style.cssText = 'height:auto;padding:8px 13px;margin:0 12px 8px;border-radius:10px';
      var lines = (o && o.lines || []).filter(function (l) { return l.trim(); }); mini.append(el('div', '', lines[lines.length - 1] || '…'));
      var w3 = el('div', 'cp-mini3'); c.workers.forEach(function (n, i) { var s = sess(c, n), st = sm.st[i + 1], m = el('div', 'mini'); m.append(el('div', '', n.replace(c.name + '-', '') + ' · ' + LABEL[st.k].toLowerCase()));
        ((s && s.lines) || []).filter(function (l) { return l.trim(); }).slice(-2).forEach(function (l) { m.append(el('div', '', l)); }); m.onclick = function (e) { e.stopPropagation(); openCrew(c, n); }; w3.append(m); });
      var f = el('div', 'card-foot'); f.append(el('span', 'foot-t', sm.sub), el('span', 'foot-p', c.dir));
      card.append(h, mini, w3, f); card.onclick = function () { openCrew(c, c.name); }; g.append(card);
    });
  };

  // ----- opening a crew in the terminal view -----
  function openCrew(c, focusName) {
    var n = c.workers.length, compact = app().compact(), items, cls, ro;
    cur = { id: c.id, focus: focusName || c.name };
    if (compact || layoutMode === '1') { items = [{ id: c.server, name: cur.focus }]; cls = 'one'; }
    else if (layoutMode === '4') { items = members(c).slice(0, 4).map(function (x) { return { id: c.server, name: x }; }); cls = 'four'; }
    else { items = members(c).map(function (x) { return { id: c.server, name: x }; }); cls = (layoutMode === 'T' ? 'crewT' : 'crewL') + ' n' + n; }
    ro = items.map(function (it) { return it.name !== c.name && !roOff[it.name]; });
    cur.cls = cls; app().showPanes(items, cls, ro);
    var idx = items.map(function (x) { return x.name; }).indexOf(cur.focus); if (idx > 0) app().focusPane(idx);
  }
  TW.on('open-crew', function (c) { openCrew(c, c.name); });
  TW.on('layout', function (cls) {
    if (cur && cur.cls !== cls) cur = null;
    document.getElementById('app').classList.toggle('crew-mode', !!cur);
    if (!cur) document.getElementById('app').classList.remove('cp-detail');
    drawBar(); syncRo();
  });

  // ----- toolbar above the panes -----
  function barNode() {
    var b = document.getElementById('cp-bar');
    if (!b) { b = el('div', 'cp-bar'); b.id = 'cp-bar'; var sp = document.getElementById('split'); sp.parentNode.insertBefore(b, sp); }
    return b;
  }
  function currentCrew() { return cur && crews.filter(function (c) { return c.id === cur.id; })[0]; }
  function seg(items, value, on) {
    var s = el('div', 'seg'); items.forEach(function (it) { var b = el('button', '', it[1]); b.type = 'button'; b.setAttribute('aria-pressed', String(value === it[0])); b.onclick = function () { on(it[0]); }; s.append(b); }); return s;
  }
  function drawBar() {
    var host = barNode(), c = currentCrew(); host.hidden = !c; if (!c) { host.textContent = ''; return; }
    var b = el('div'); // built aside, swapped in only when the markup changed (keeps clicks and focus stable)
    var sm = summary(c), nm = el('div', 'cp-nm'), pt = el('span', 'pt'); pt.innerHTML = petSvg(0, sm.k); nm.append(pt, el('b', '', c.name), pill(sm.cls, sm.label));
    var steps = el('div', 'cp-steps'), t = ((tracks[c.id] || {}).tracks) || [];
    if (!t.length) steps.append(el('span', 'cp-src', 'Chưa có plan — gõ task cho điều phối'));
    t.forEach(function (x, i) {
      if (i) steps.append(el('span', 'cp-arrow', '›'));
      var chip = el('button', 'cp-step ' + x.state); chip.type = 'button'; chip.title = x.title; chip.append(el('i'), document.createTextNode(x.id + ' ' + (x.state === 'done' ? 'xong' : x.state === 'dispatched' ? x.worker : 'chờ')));
      chip.onclick = function () { if (x.worker) openCrew(c, c.name + '-' + x.worker); }; steps.append(chip);
    });
    b.textContent = ''; b.append(nm, steps);
    if (!app().compact()) b.append(seg([['L', 'Trái'], ['T', 'Trên'], ['4', '2×2'], ['1', '1']], layoutMode, function (m) { layoutMode = m; openCrew(c, cur.focus); }));
    var det = el('button', 'btn', 'Chi tiết'); det.type = 'button'; det.onclick = function () { document.getElementById('app').classList.toggle('cp-detail'); };
    var more = el('button', 'btn icon-btn', '⋯'); more.type = 'button'; more.setAttribute('aria-label', 'Thêm'); more.onclick = function () { menuOpen = !menuOpen; drawBar(); };
    b.append(det, more);
    if (menuOpen) {
      var m = el('div', 'cp-menu'); m.setAttribute('role', 'menu');
      [['+ Thêm thợ', function () { addWorker(c); }, c.workers.length >= 4], ['Nhắc điều phối tiếp tục', function () { nudge(c); }], ['Giả lập thợ treo (demo)', function () { hang(c); }], ['Dừng cả Crew', function () { stopCrew(c); }, false, 'dg']].forEach(function (it) {
        var i = el('button', it[3] || '', it[0]); i.type = 'button'; i.disabled = !!it[2]; i.onclick = function () { menuOpen = false; drawBar(); it[1](); }; m.append(i);
      });
      b.append(m);
    }
    if (b.innerHTML !== host.dataset.html) { host.dataset.html = b.innerHTML; host.replaceChildren.apply(host, Array.prototype.slice.call(b.childNodes)); }
    var sl = document.getElementById('cp-slots');
    if (app().compact()) { if (!sl) { sl = el('div', 'cp-slots'); sl.id = 'cp-slots'; host.after(sl); } sl.textContent = ''; members(c).forEach(function (n, i) { var x = el('button', 'tab', i ? n.replace(c.name + '-', '') : 'Điều phối'); x.setAttribute('aria-selected', String(cur.focus === n)); x.onclick = function () { openCrew(c, n); }; sl.append(x); }); }
    else if (sl) sl.remove();
  }
  // Names shown in the panes, in pane order (same rule as openCrew).
  function paneNames(c) { if (app().compact() || layoutMode === '1') return [cur.focus]; var m = members(c); return layoutMode === '4' ? m.slice(0, 4) : m; }
  function syncRo() {
    var c = currentCrew(); document.querySelectorAll('#split .cp-ro').forEach(function (n) { n.remove(); }); if (!c) return;
    var names = paneNames(c);
    document.querySelectorAll('#split .pane').forEach(function (node, i) {
      var name = names[i]; if (!name || name === c.name) return;
      var on = !roOff[name], b = el('button', 'cp-ro' + (on ? '' : ' on'), on ? 'Chỉ xem · bấm để can thiệp' : 'Đang can thiệp · bấm để chỉ xem'); b.type = 'button';
      b.onclick = function (e) { e.stopPropagation(); roOff[name] = on; app().setPaneRo(i, !roOff[name]); syncRo(); if (roOff[name]) app().say('Bạn can thiệp trực tiếp ' + name + ' (điều phối không biết).', true, 3000); };
      node.append(b);
    });
  }

  // ----- actions -----
  function refreshAll() { return get('/list').then(function (r) { crews = r.crews || []; return app().refresh(); }); }
  function addWorker(c) { post('/add-worker', { id: c.id }).then(function () { return refreshAll(); }).then(function () { if (cur) openCrew(currentCrew(), cur.focus); }).catch(function (e) { app().say(e.message, false, 4000); }); }
  function nudge(c) { post('/send', { id: c.id, session: c.name, text: 'Tiếp tục kế hoạch đã duyệt, báo tiến độ.' }).catch(function (e) { app().say(e.message, false, 4000); }); }
  function hang(c) { var w = c.workers.filter(function (n) { return paneState(c, n).k === 'run'; })[0]; if (!w) { app().say('Chưa có thợ nào đang chạy để giả lập treo.', false, 3000); return; } post('/send', { id: c.id, session: w, text: '__hang__' }); app().say(w + ' sẽ im lặng (đang chạy nhưng không xuất gì) — xem “Cần kiểm tra” sau ' + QUIET + ' giây.', true, 5000); }
  function stopCrew(c) {
    var d = el('dialog'), f = el('form', 'f'); f.method = 'dialog'; d.append(f);
    f.append(el('h2', '', 'Dừng cả Crew?'), el('p', '', 'Điều phối và ' + c.workers.length + ' thợ sẽ bị dừng. Việc đang chạy sẽ mất.'));
    var act = el('div', 'dlg-actions'), no = el('button', 'btn', 'Hủy'), go = el('button', 'btn danger-solid', 'Dừng'); no.type = go.type = 'button'; act.append(no, go); f.append(act);
    no.onclick = function () { d.close(); }; d.addEventListener('close', function () { d.remove(); });
    go.onclick = function () { go.disabled = true; post('/stop', { id: c.id }).then(function () { d.close(); cur = null; return refreshAll(); }).then(function () { app().setView('over'); }).catch(function (e) { go.disabled = false; app().say(e.message, false, 4000); }); };
    document.body.append(d); d.showModal();
  }

  // ----- detail box: replaces the old "Crew (leader)" box -----
  function drawBox(target, c) {
    var box = el('div', 'cp-box'), sm = summary(c), t = (tracks[c.id] || {}).tracks || [], done = t.filter(function (x) { return x.state === 'done'; }).length;
    var h = el('div', 'cp-head'); h.append(el('h3', '', 'Crew ' + c.name), pill(sm.cls, sm.label)); box.append(h, el('div', 'cp-src', sm.sub));
    if (sm.k === 'wait') box.append(el('div', 'cp-alert', 'Điều phối đang chờ bạn trả lời (gõ OK trong pane điều phối).'));
    if (sm.k === 'check') { var q = sm.st.filter(function (x) { return x.k === 'quiet'; })[0]; box.append(el('div', 'cp-alert', q ? 'Một thợ không có output ' + ago(q.age) + ' dù tiến trình còn sống: có thể đang nghĩ lâu hoặc treo.' : sm.sub)); }
    if (sm.k === 'unknown') box.append(el('div', 'cp-alert err', 'Không đo được lúc này; các số dưới là lần đo cuối, có thể đã cũ.'));
    if (t.length) {
      var task = el('div', 'crew-task'), bar = el('div', 'crew-bar'), i = el('i'); i.style.width = Math.round(100 * done / t.length) + '%'; bar.append(i);
      task.append(el('b', '', done + '/' + t.length + ' track'), bar); box.append(task);
      var chips = el('div', 'crew-tracks'); t.forEach(function (x) { var b = el('button', 'crew-track ' + (x.state === 'dispatched' ? 'dispatched' : x.state === 'queued' ? 'queued' : '')); b.type = 'button'; b.append(el('b', '', x.id), el('span', '', x.title + ' · ' + (x.state === 'done' ? 'xong' : x.state === 'dispatched' ? x.worker : 'chờ'))); b.onclick = function () { if (x.worker) openCrew(c, c.name + '-' + x.worker); }; chips.append(b); });
      box.append(chips);
    }
    var dl = el('dl', 'cp-fact'); members(c).forEach(function (n, k) {
      var st = sm.st[k], cls = st.k === 'quiet' || st.k === 'wait' ? 'wait' : st.k === 'run' || st.k === 'done' ? 'ok' : st.k === 'gone' || st.k === 'off' ? 'bad' : '';
      var dd = el('dd'); dd.append(el('span', cls, LABEL[st.k] + (st.track ? ' ' + st.track.id : '')), el('span', 'cp-src', ' · ' + st.src)); dl.append(el('dt', '', k ? n.replace(c.name + '-', '') : 'Điều phối'), dd);
    }); box.append(dl);
    box.append(el('div', 'cp-src', 'Mỗi dòng ghi rõ nguồn và độ tươi. Quá ' + QUIET + ' giây không có output khi đang giao việc thì không còn là “đang chạy”.'));
    var acts = el('div', 'cp-acts'), add = el('button', 'btn', '+ Thêm thợ'), nu = el('button', 'btn', 'Nhắc điều phối'), st = el('button', 'btn danger', 'Dừng cả Crew');
    [add, nu, st].forEach(function (b) { b.type = 'button'; }); add.disabled = c.workers.length >= 4;
    add.onclick = function () { addWorker(c); }; nu.onclick = function () { nudge(c); }; st.onclick = function () { stopCrew(c); }; acts.append(add, nu, st); box.append(acts);
    if (box.innerHTML !== target.dataset.html) { target.dataset.html = box.innerHTML; target.replaceChildren.apply(target, Array.prototype.slice.call(box.childNodes)); }
  }
  TW.addDetailSection(function (x) {
    var c = crewOf(x.v.id, x.s.name); if (!c) return null;
    var box = el('section', 'cp-box'); boxes.push({ box: box, id: c.id }); drawBox(box, c); return box;
  });

  // ----- new crew dialog -----
  function newDialog() {
    var vs = (app().servers() || []).filter(function (v) { return v.on && v.hasTmux !== false; });
    if (!vs.length) { app().say('Chưa có máy chủ nào kết nối.', false, 3000); return; }
    var d = el('dialog'); d.id = 'dlg-crew'; var f = el('form', 'f'); f.noValidate = true; d.append(f);
    var state = { workers: 3 };
    f.innerHTML = '<h2>Crew mới</h2><label>Máy chủ<select id="cw-srv"></select></label><label>Tên Crew<input id="cw-name" maxlength="24" value="UIUX" autocomplete="off"></label>' +
      '<label>Thư mục<input id="cw-dir" autocomplete="off" placeholder="Để trống dùng thư mục mặc định"></label><div><div class="lab-s">Số thợ</div><div class="seg" id="cw-n"></div></div>' +
      '<div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap"><div class="cp-diagram" id="cw-dia"></div><div class="cp-src" style="flex:1;min-width:160px">Điều phối (Claude) bên trái; thợ (Codex) bên phải, chỉ chạy khi được giao.</div></div>' +
      '<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="cw-real" style="width:auto"> Dùng Claude/Codex thật (tốn token). Bỏ chọn = agent giả lập để thử giao diện.</label><div class="err" id="cw-err"></div>' +
      '<div class="dlg-actions"><button type="button" class="btn" id="cw-cancel">Hủy</button><button type="submit" class="btn primary" id="cw-go">Tạo Crew</button></div>';
    var srv = f.querySelector('#cw-srv'); vs.forEach(function (v) { var o = el('option', '', v.name); o.value = v.id; srv.append(o); });
    function drawN() {
      var s = f.querySelector('#cw-n'); s.textContent = ''; [1, 2, 3, 4].forEach(function (k) { var b = el('button', '', String(k)); b.type = 'button'; b.setAttribute('aria-pressed', String(state.workers === k)); b.onclick = function () { state.workers = k; drawN(); }; s.append(b); });
      var dia = f.querySelector('#cw-dia'); dia.textContent = ''; dia.style.gridTemplateColumns = '1fr 1fr'; dia.style.gridTemplateRows = state.workers > 1 ? '1fr 1fr' : '1fr';
      var o = el('i', '', 'điều phối'); o.style.gridRow = '1 / -1'; dia.append(o); for (var k = 1; k <= state.workers; k++) dia.append(el('i', '', String(k)));
    }
    drawN();
    f.querySelector('#cw-cancel').onclick = function () { d.close(); }; d.addEventListener('close', function () { d.remove(); });
    f.onsubmit = function (e) {
      e.preventDefault(); var go = f.querySelector('#cw-go'), err = f.querySelector('#cw-err'); go.disabled = true; err.textContent = '';
      post('/create', { server: srv.value, name: f.querySelector('#cw-name').value.trim(), dir: f.querySelector('#cw-dir').value.trim(), workers: state.workers, agent: f.querySelector('#cw-real').checked ? 'real' : 'demo' })
        .then(function (r) { d.close(); return refreshAll().then(function () { var c = crews.filter(function (x) { return x.id === r.crew.id; })[0]; if (c) setTimeout(function () { openCrew(c, c.name); }, 600); }); })
        .catch(function (e2) { go.disabled = false; err.textContent = e2.message; });
    };
    document.body.append(d); d.showModal();
  }

  // ----- start -----
  function addButton() {
    var anchor = document.getElementById('btn-new'); if (!anchor || document.getElementById('btn-crew')) return;
    var b = el('button', 'btn'); b.id = 'btn-crew'; b.type = 'button'; b.innerHTML = '<svg class="i" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="13" width="8" height="7" rx="2"/><rect x="13" y="13" width="8" height="7" rx="2"/></svg><span class="lb">Crew mới</span>';
    b.onclick = newDialog; anchor.parentNode.insertBefore(b, anchor);
  }
  function pollTracks() { crews.forEach(function (c) { get('/tracks?id=' + encodeURIComponent(c.id)).then(function (r) { tracks[c.id] = r; }).catch(function () { /* keep last */ }); }); }
  TW.on('ready', function () {
    addButton();
    refreshAll().catch(function () { /* feature optional */ });
    setInterval(function () { get('/list').then(function (r) { var before = JSON.stringify(crews.map(function (c) { return c.id + c.workers.length; })); crews = r.crews || []; if (before !== JSON.stringify(crews.map(function (c) { return c.id + c.workers.length; }))) app().refresh(); }).catch(function () {}); }, 5000);
    setInterval(pollTracks, 2000);
    setInterval(function () {
      boxes = boxes.filter(function (b) { return b.box.isConnected; });
      boxes.forEach(function (b) { var c = crews.filter(function (x) { return x.id === b.id; })[0]; if (c) drawBox(b.box, c); });
      if (cur) { drawBar(); var want = document.querySelectorAll('#split .pane').length - 1; if (!app().compact() && document.querySelectorAll('#split .cp-ro').length !== want && layoutMode !== '1') syncRo(); }
    }, 1000);
  });
})();
