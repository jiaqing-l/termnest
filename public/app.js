'use strict';
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var art = window.PetArt || { PETS: { cat: { c: '#ffa63d' } }, ORDER: ['cat'] };
  var pet = function () { try { return art.pet.apply(null, arguments); } catch (e) { return ''; } }, PETS = art.PETS, ORDER = art.ORDER;
  var CREW_POLL_MS = 1500;
  var LABEL = { run: 'Đang chạy', wait: 'Chờ bạn', idle: 'Đang nghỉ' };
  var HP = { cpu: ['CPU', '#ff5c7a'], ram: ['RAM', '#8c6dff'], disk: ['Disk', '#0fb5ae'] };
  var SRV_ICON = '<svg class="i srv-i" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="7" rx="2"/><rect x="4" y="13" width="16" height="7" rx="2"/><path d="M8 7.5h.01M8 16.5h.01"/></svg>';
  var servers = [], scope = 'all', view = 'over', cur = null, online = true, signature = '', pollTimer = null, tokenTimer = null, firstState = true;
  var cardRefs = {}, delTarget = null, passTarget = null, killTarget = null;
  var rebootTarget = null, rebootBusy = false;
  var dirServer = '', dirCurrent = null, dirRequest = 0;
  var panes = [], focusedPane = 0, paneCount = 1, pendingPaneWidth = null, pendingSplit = null;
  var prefs = { limits: { cpu: 95, ram: 90, disk: 90 }, templates: [], commands: [], recentDirs: [] };
  var query = '', filter = 'all', browserOn = false, waitStates = null, restoreNotes = {};
  var detailId = null, historyRequest = 0, installPrompt = null, limitTimer = null;
  try { browserOn = localStorage.getItem('tw-notifications') === 'true'; } catch (e) { /* optional */ }

  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function api(method, path, body) {
    return fetch(path, { method: method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) { var e = new Error(j.error || 'Có lỗi xảy ra.'); e.status = r.status; throw e; }
          return j;
        });
      });
  }
  var tokens = window.TokenUI({api:api,view:setView,scope:function(){return scope;},prefs:function(){return prefs;},servers:function(){return servers;},save:savePrefs,updated:renderSessionTokens});
  function renderSessionTokens() {
  }
  function hash(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
  function petOf(name) { return /claude/i.test(name) ? 'cat' : ORDER[hash(name) % ORDER.length]; }
  function petFor(v, s) { var choice = (prefs.pets || {})[v.id + '/' + s.name]; return choice && PETS[choice.kind] ? choice.kind : petOf(s.name); }
  function color(s) { return PETS[petOf(s.name)].c; }
  function srv(id) { return servers.filter(function (v) { return v.id === id; })[0]; }
  function subOf(s) { return s.state === 'wait' ? 'Chờ bạn' : s.state === 'idle' ? 'Đang nghỉ' : 'Đang chạy ' + s.cmd; }
  function ago(sec) {
    if (sec < 60) return 'vừa xong';
    if (sec < 3600) return Math.floor(sec / 60) + ' phút trước';
    if (sec < 86400) return Math.floor(sec / 3600) + ' giờ trước';
    return Math.floor(sec / 86400) + ' ngày trước';
  }
  function span(sec) {
    if (sec < 60) return Math.max(0, Math.floor(sec)) + ' giây';
    if (sec < 3600) return Math.max(1, Math.floor(sec / 60)) + ' phút';
    if (sec < 86400) return Math.floor(sec / 3600) + ' giờ ' + Math.floor(sec % 3600 / 60) + ' phút';
    return Math.floor(sec / 86400) + ' ngày';
  }
  function scoped() { return scope === 'all' ? servers : servers.filter(function (v) { return v.id === scope; }); }
  function vis() {
    var out = [];
    scoped().forEach(function (v) { v.sessions.forEach(function (s) { out.push({ v: v, s: s }); }); });
    return out;
  }
  function matches(s) { return (filter === 'all' || s.state === filter) && (!query || (s.name + ' ' + s.path + ' ' + (s.lines || []).join(' ')).toLowerCase().indexOf(query) >= 0); }
  function cnt(st) { return vis().filter(function (x) { return x.s.state === st; }).length; }
  function workers() { var n = 0; scoped().forEach(function (v) { n += v.workers.length; }); return n; }
  function curItem() {
    if (!cur) return null;
    var v = srv(cur.id), s = v && v.sessions.filter(function (x) { return x.name === cur.name; })[0];
    return s ? { v: v, s: s } : null;
  }

  function sparkSVG(data, c) {
    if (data.length < 2) return '<svg class="spark" viewBox="0 0 120 28" aria-hidden="true"></svg>';
    var w = 120, h = 28, step = w / (data.length - 1), lo = Math.min.apply(null, data), hi = Math.max.apply(null, data), sp = Math.max(hi - lo, 10);
    var line = data.map(function (v, i) { return (i * step).toFixed(1) + ',' + (h - 4 - ((v - lo) / sp) * (h - 9)).toFixed(1); }).join(' ');
    return '<svg class="spark" viewBox="0 0 120 28" preserveAspectRatio="none" aria-hidden="true"><polygon points="0,28 ' + line + ' 120,28" fill="' + c + '" opacity=".18"/><polyline points="' + line + '" fill="none" stroke="' + c + '" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>';
  }

  function renderServers() {
    var sel = $('srv-sel'); sel.textContent = '';
    var all = el('option', '', 'Tất cả máy chủ'); all.value = 'all'; sel.append(all);
    servers.forEach(function (v) { var o = el('option', '', (v.local ? 'Máy này · ' + v.hostname : v.user + '@' + v.name) + (v.on ? '' : ' (mất kết nối)')); o.value = v.id; sel.append(o); });
    sel.value = scope;
  }
  function renderHero() {
    var w = cnt('wait'), r = cnt('run'), on = servers.filter(function (v) { return v.on; }).length, n = workers();
    $('hero-t').textContent = !servers.length ? 'Thêm máy chủ đầu tiên' : w ? ('Có ' + w + ' việc đang chờ bạn') : (r || n) ? 'Mọi việc đang chạy tốt' : 'Chưa có việc nào đang chạy';
    var box = $('chips'); box.textContent = '';
    function chip(num, t, c) { var e = el('span', 'chip ' + (c || '')); e.append(el('b', '', num), t); box.append(e); }
    chip(on + '/' + servers.length, 'máy chủ'); chip(vis().length, 'phiên'); chip(r, 'đang chạy');
    if (n) chip(n, 'worker Crew');
    if (w) chip(w, 'chờ bạn', 'alert');
    box.append(el('span', 'chip conn', online ? 'Đã kết nối' : 'Mất mạng'));
    $('shelf').innerHTML = scoped().flatMap(function (v) { return (v.houseSessions || v.sessions).map(function (s) { return { v: v, s: s }; }); }).slice(0, 5).map(function (x) { return pet(petFor(x.v, x.s), x.s.state); }).join('');
  }
  function renderSide() {
    var box = $('side'); box.textContent = '';
    box.append(el('div', 'group', 'Máy chủ'));
    function row(id, title, sub, count, off) {
      var b = el('button', 'sess srv-row'); b.style.setProperty('--c', off ? '#7a879f' : '#2f80ed');
      b.setAttribute('aria-current', scope === id ? 'true' : 'false');
      var a = el('span', 'ava'); a.innerHTML = SRV_ICON; a.append(el('span', 'flag ' + (off ? 'off' : 'run')));
      var t = el('span', 'txt'); t.append(el('span', 'n', title), el('span', 's', sub));
      b.append(a, t); if (count) b.append(el('span', 'badge', count));
      b.onclick = function () { setScope(id); }; box.append(b);
    }
    function waitOf(v) { return v.sessions.filter(function (s) { return s.state === 'wait'; }).length; }
    var total = 0; servers.forEach(function (v) { total += waitOf(v); });
    row('all', 'Tất cả máy chủ', servers.length + ' tài khoản', total, false);
    servers.forEach(function (v) { row(v.id, v.name, v.local ? v.hostname + ' · không cần SSH' : v.on ? v.user : v.user + ' · mất kết nối', waitOf(v), !v.on); });
    var add = el('button', 'btn add-srv', '+ Thêm máy chủ'); add.onclick = addDlg; box.append(add);
    [['wait', 'Chờ bạn'], ['run', 'Đang chạy'], ['idle', 'Đang nghỉ']].forEach(function (g) {
      var list = vis().filter(function (x) { return x.s.state === g[0] && matches(x.s); }); if (!list.length) return;
      box.append(el('div', 'group', g[1]));
      list.forEach(function (x) {
        var b = el('button', 'sess'); b.style.setProperty('--c', color(x.s));
        b.setAttribute('aria-current', (view === 'focus' && cur && cur.id === x.v.id && cur.name === x.s.name) ? 'true' : 'false');
        var a = el('span', 'ava'); a.innerHTML = pet(petFor(x.v, x.s), x.s.state); a.append(el('span', 'flag ' + x.s.state));
        var t = el('span', 'txt'); t.append(el('span', 'n', x.s.name), el('span', 's', scope === 'all' ? x.v.name : subOf(x.s)));
        b.append(a, t); b.onclick = function () { openSession(x.v.id, x.s.name); }; box.append(b);
      });
    });
  }
  function renderHealth() {
    var box = $('health'), v = srv(scope); box.textContent = ''; box.hidden = !v || !v.on; if (box.hidden) return;
    Object.keys(HP).forEach(function (k) {
      var a = v.history[k] || [], r = el('div', 'hrow'); r.append(el('span', '', HP[k][0]));
      var c = el('div'); c.innerHTML = sparkSVG(a, HP[k][1]);
      r.append(c, el('b', '', v[k] == null ? '—' : number(v[k]) + '%')); box.append(r);
    });
  }
  function fillCard(ref, s) {
    if (ref.input && (ref.input === document.activeElement || ref.input.value)) return;
    if (ref.question) ref.question.textContent = question(s);
    var m = ref.mini; m.textContent = '';
    s.lines.slice(-5).forEach(function (l) { m.append(el('div', '', l)); });
    ref.foot.textContent = (s.attached ? 'Có người đang xem · ' : '') + 'Hoạt động ' + ago(s.activityAge);
    ref.path.textContent = s.path;
  }
  function sessionCard(v, s) {
    var c = el('div', 'card' + (s.state === 'wait' ? ' wait' : '')); c.style.setProperty('--c', color(s));
    c.setAttribute('aria-label', 'Mở phiên ' + s.name);
    var h = el('div', 'card-head'); h.append(petSlot(v, s));
    var t = el('div', 't'), sub = el('span', 's', subOf(s)); t.append(el('span', 'n', s.name), sub); h.append(t, el('span', 'pill ' + s.state, LABEL[s.state]));
    var ref = { card: c, mini: el('div', 'mini'), foot: el('span', 'foot-t'), path: el('span', 'foot-p'), sub: sub };
    var f = el('div', 'card-foot'); band(v,s,f);f.append(ref.foot, ref.path);
    c.append(h, ref.mini, f); fillCard(ref, s); cardRefs[v.id + '/' + s.name] = ref;
    if (window.TW) window.TW.decorateCard(c, v, s);
    c.setAttribute('role', 'button'); c.tabIndex = 0;
    c.onkeydown = function (e) { if (e.target === c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openSession(v.id, s.name); } };
    addReply(c, ref, v, s);
    renderSessionTokens();
    c.onclick = function () { openSession(v.id, s.name); };
    return c;
  }
  var crewSelection = null, crewPaused = false, crewFollow = true, crewBusy = false, crewGeneration = 0;
  var crewMinimized = false, crewScrollTop = 0;
  try { crewMinimized = localStorage.getItem('tw-crew-minimized') === 'true'; } catch (e) { /* optional */ }
  function renderCrewSize() {
    $('crew-output').hidden = crewMinimized;
    $('crew-min').textContent = crewMinimized ? 'Mở rộng' : 'Thu nhỏ';
    $('crew-min').setAttribute('aria-expanded', String(!crewMinimized));
  }
  renderCrewSize();
  function closeCrew() { crewSelection = null; crewGeneration++; $('crew-panel').hidden = true; }
  function openCrew(v, w, load) {
    crewGeneration++; crewSelection = { id: v.id, task: w.task, track: w.track, load: load }; crewPaused = false; crewFollow = true;
    $('crew-title').title = w.task + ' / ' + w.track; $('crew-title').textContent = w.track + ' · ' + w.task; // track first: the long task name is what gets cut off $('crew-output').textContent = (w.lines || []).join('\n');
    $('crew-panel').hidden = false; $('crew-pause').textContent = 'Tạm dừng'; pollCrew();
  }
  function pollCrew() {
    if (!crewSelection || crewPaused || crewBusy || document.hidden) return;
    var selected = crewSelection, generation = crewGeneration; crewBusy = true;
    (selected.load ? selected.load() : api('GET', '/api/servers/' + selected.id + '/crew-log?task=' + encodeURIComponent(selected.task) + '&track=' + encodeURIComponent(selected.track)))
      .then(function (log) {
        if (generation !== crewGeneration || crewPaused) return;
        var output = $('crew-output'), oldTop = output.scrollTop;
        if (output.textContent !== log.text) output.textContent = log.text;
        output.scrollTop = crewFollow ? output.scrollHeight : oldTop;
        if (log.status) $('crew-status').textContent = log.status; else $('crew-status').textContent = (log.finishedAt ? 'Đã kết thúc · ' + log.result : 'Đang chạy') + ' · ' + span(log.elapsed) + ' · 64 KiB cuối';
      }).catch(function (e) { if (generation === crewGeneration) $('crew-status').textContent = e.message; })
      .finally(function () { crewBusy = false; });
  }
  $('crew-output').onscroll = function () { if (!crewMinimized) crewFollow = this.scrollHeight - this.scrollTop - this.clientHeight < 24; };
  $('crew-min').onclick = function () {
    if (!crewMinimized) crewScrollTop = $('crew-output').scrollTop;
    crewMinimized = !crewMinimized; renderCrewSize();
    if (!crewMinimized) $('crew-output').scrollTop = crewFollow ? $('crew-output').scrollHeight : crewScrollTop;
    try { localStorage.setItem('tw-crew-minimized', String(crewMinimized)); } catch (e) { /* optional */ }
  };
  $('crew-panel').addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing || e.keyCode === 229 || document.querySelector('dialog[open]')) return;
    e.preventDefault(); e.stopPropagation(); closeCrew();
  });
  $('crew-pause').onclick = function () { crewPaused = !crewPaused; this.textContent = crewPaused ? 'Tiếp tục' : 'Tạm dừng'; if (!crewPaused) pollCrew(); };
  $('crew-close').onclick = closeCrew;
  setInterval(pollCrew, CREW_POLL_MS);
  function petSync() {
    try { if (window.PetScene) window.PetScene.sync(scoped(), online, view === 'over', openSession, prefs.limits, prefs.pets); }
    catch (e) { /* decoration is optional */ }
  }
  function petEvent(id, name, type) { try { if (window.PetScene) window.PetScene.event(id, name, type); } catch (e) { /* optional */ } }
  function owned(v, s) { return v.workers.filter(function (w) { return w.owner && w.owner.name === s.name && w.owner.created === s.created; }); }
  function petSlot(v, s) {
    var n = el('div', 'pet-slot'); n.dataset.key = v.id + '/' + s.name + '/' + s.created; return n;
  }
  function band(v, s, node) { var count = owned(v, s).length; if (count) node.append(el('span', 'crew-band', '🎽 ' + count)); }
  function renderWorkers(v, sec, session) {
    var list = session ? owned(v, session) : v.workers.filter(function (w) { return !w.owner || !v.sessions.some(function (s) { return w.owner.name === s.name && w.owner.created === s.created; }); });
    if (!list.length) { if (session) sec.append(el('p', '', 'Crew của phiên này · 0')); return; }
    var box = el('div', 'crew');
    box.append(el('div', 'crew-t', (session ? 'Crew của phiên này · ' : 'Tổng quan Crew · ') + list.length));
    if (session) {
      var tasks = Array.from(new Set(list.map(function (w) { return w.task; })));
      tasks.forEach(function (task) {
        var celebrating = list.some(function (w) { return w.task === task && w.finishedAt && w.result === 'DONE' && window.PetState && Date.now() - w.resultAt < window.PetState.LIMITS.effect; });
        var room = el('div', 'meeting-room' + (celebrating ? ' meeting-celebrate' : '')); room.title = task; room.append(el('b', 'meeting-table', 'Crew'));
        list.filter(function (w) { return w.task === task; }).forEach(function (w) {
          var member = el('button', 'meeting-member' + (w.finishedAt ? ' meeting-left' : '') + (w.finishedAt && window.PetState && Date.now() - w.finishedAt < window.PetState.LIMITS.effect ? ' meeting-departing' : ''));
          member.innerHTML = pet(petOf(w.track), w.finishedAt ? 'idle' : 'run'); member.append(el('span', 'crew-band', '🎽 ' + w.track), el('small', '', w.finishedAt ? 'Đã rời bàn · ' + w.result : 'Đang làm'));
          member.onclick = function () { openCrew(v, w); }; room.append(member);
        }); box.append(room);
      });
    }
    list.forEach(function (w) {
      var r = el(session ? 'button' : 'div', 'crew-row' + (session ? ' crew-worker-button' : ''));
      if (session) { r.type = 'button'; r.title = (w.lines || []).join('\n'); }
      if (w.task && w.track) {
        r.onclick = function () { openCrew(v, w); };
        if (!session) r.append(el('button', 'btn', 'Xem log'));
      }
      var mascot = el('span', 'crew-pet' + (w.finishedAt && w.result === 'DONE' && window.PetState && Date.now() - w.resultAt < window.PetState.LIMITS.effect ? ' high-five' : ''));
      mascot.innerHTML = pet('fox', w.finishedAt ? 'idle' : 'run') + pet('cat', w.finishedAt ? 'idle' : 'run');
      mascot.append(el('span', 'team-band', 'CREW')); if (!session) r.append(mascot);
      var head = el('div', 'crew-h');
      head.append(el('span', 'pill run', w.finishedAt ? (w.result === 'unknown' ? 'Đã kết thúc · chưa rõ kết quả' : w.result) : (session ? 'Đang chạy' : (w.kind || 'worker'))));
      head.append(el('b', '', w.track ? w.track + (session ? '' : ' · ' + w.task) : (w.cwd || 'Không rõ thư mục')));
      head.append(el('span', 'crew-time', span(w.elapsed)));
      if (!session) head.append(el('span', '', w.owner ? 'Phiên đã đóng: ' + w.owner.name : 'Chưa rõ phiên'));
      r.append(head);
      if (!session && w.lines && w.lines.length) { var m = el('div', 'crew-log'); w.lines.forEach(function (l) { m.append(el('div', '', l)); }); r.append(m); }
      box.append(r);
    });
    sec.append(box);
  }
  function renderGrid() {
    var active = document.activeElement, selection = active && active.tagName === 'INPUT' ? [active.selectionStart, active.selectionEnd] : null;
    var box = $('grid'), previous = cardRefs;
    box.textContent = ''; cardRefs = {};
    if ((query || filter !== 'all') && !vis().some(function (x) { return matches(x.s); })) box.append(el('p', 'empty', 'Không có phiên nào khớp.'));
    if (!servers.length) {
      var e = el('div', 'off-tile'), b = el('button', 'btn primary', 'Thêm máy chủ');
      e.append(el('b', '', 'Chưa có máy chủ nào.'), b); b.onclick = addDlg; box.append(e); return;
    }
    scoped().forEach(function (v) {
      var sec = el('section', 'srv-sec'), h = el('div', 'srv-head');
      var t = el('div', 't'); t.append(el('b', '', v.name), el('span', 'mono', (v.local ? v.hostname + ' · không cần SSH' : v.user + '@' + v.host)));
      h.append(el('span', 'flag-d ' + (v.on ? 'on' : 'off')), t);
      if (window.TW) window.TW.decorateServer(h, v);

      if (!v.local) { var rm = el('button', 'btn', 'Gỡ'); rm.setAttribute('aria-label', 'Gỡ ' + (v.local ? 'Máy này · ' + v.hostname : v.user + '@' + v.name)); rm.onclick = function () { delDlg(v); }; h.append(rm); }
      sec.append(h); addLost(sec, v);
      if (v.local && !v.persistent) sec.append(el('p', 'empty', v.guidance));
      if (!v.on) {
        var o = el('div', 'off-tile'), r = el('button', 'btn primary', 'Kết nối lại'), tx = el('div');
        tx.append(el('b', '', v.error || 'Không vào được máy chủ này'), el('span', '', 'Việc trên máy chủ không bị ảnh hưởng.'));
        r.onclick = function () { connectAgain(v, r); }; o.append(tx, r); sec.append(o); renderWorkers(v, sec); box.append(sec); return;
      }
      if (!v.hasTmux) {
        var n = el('div', 'off-tile'), nt = el('div');
        nt.append(el('b', '', 'Máy chủ này chưa có tmux'), el('span', 'mono', v.guidance || 'sudo apt install tmux')); n.append(nt); sec.append(n);
      } else {
        var g = el('div', 'grid');
        v.sessions.filter(matches).forEach(function (s) {
          var key = v.id + '/' + s.name, old = previous[key];
          if (old && old.input && (old.input === active || old.input.value)) { var message = old.card.querySelector('.pet-message'); if (message) message.classList.remove('message-arrives'); cardRefs[key] = old; g.append(old.card); signature = '';  }
          else g.append(sessionCard(v, s));
        });
        var add = el('button', 'card add'); add.innerHTML = pet(ORDER[v.sessions.length % ORDER.length], 'run'); add.append('Phiên mới');
        add.setAttribute('aria-label', 'Tạo phiên mới trên ' + v.name); add.onclick = function () { newDlg(v.id); }; g.append(add);
        sec.append(g);
      }
      renderWorkers(v, sec);
      box.append(sec);
    });
    if (active && active.isConnected && selection) { active.focus({ preventScroll: true }); active.setSelectionRange(selection[0], selection[1]); }
  }
  // Tabs can be closed (hidden). The session itself is untouched: it stays in the sidebar and overview.
  var tabHide = window.TabHide ? window.TabHide.create((function () { try { return window.localStorage; } catch (e) { return { getItem: function () { return null; }, setItem: function () {} }; } })()) : null;
  function tabKey(x) { return x.v.id + '/' + x.s.name; }
  function closeTab(x) {
    if (!tabHide) return;
    var list = vis().filter(function (y) { return !tabHide.isHidden(tabKey(y)); }), i = list.findIndex(function (y) { return tabKey(y) === tabKey(x); });
    var wasCurrent = cur && cur.id === x.v.id && cur.name === x.s.name, next = list[i + 1] || list[i - 1];
    tabHide.hide(tabKey(x));
    if (wasCurrent && next && next !== x) { cur = { id: next.v.id, name: next.s.name }; if (panes.length) panes[focusedPane].cur = cur; connectTerm(); }
    renderTabs(); renderDetail(); renderBar();
    sayUndo('Đã đóng tab ' + x.s.name + '. Phiên vẫn chạy.', 'Hoàn tác', function () { tabHide.show(tabKey(x)); renderTabs(); }, 4500);
  }
  function hiddenItems() { return tabHide ? vis().filter(function (y) { return tabHide.isHidden(tabKey(y)); }) : []; }
  function renderTabs() {
    var box = $('tabs'); box.textContent = '';
    // Only forget a hidden tab once its host is loaded, online and really no longer has that session.
    if (tabHide) tabHide.prune(function (k) { var id = k.split('/')[0], v = srv(id); return !v || !v.on || v.sessions.some(function (s) { return id + '/' + s.name === k; }); });
    vis().filter(function (x) { return !tabHide || !tabHide.isHidden(tabKey(x)); }).forEach(function (x) {
      var b = el('button', 'tab'); b.style.setProperty('--c', color(x.s)); b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', (cur && cur.id === x.v.id && cur.name === x.s.name) ? 'true' : 'false');
      b.innerHTML = pet(petFor(x.v, x.s), x.s.state); b.append(x.s.name); band(x.v, x.s, b);
      if (tabHide) {
        var close = el('span', 'tab-x', '✕'); close.setAttribute('role', 'button'); close.setAttribute('aria-label', 'Đóng tab ' + x.s.name); close.title = 'Đóng tab (phiên vẫn chạy)';
        close.onclick = function (e) { e.stopPropagation(); closeTab(x); }; b.append(close);
        b.onauxclick = function (e) { if (e.button === 1) { e.preventDefault(); closeTab(x); } };
      }
      b.onclick = function () { openSession(x.v.id, x.s.name); }; box.append(b);
    });
    var hid = hiddenItems();
    if (hid.length) {
      var waits = hid.filter(function (y) { return y.s.state === 'wait'; }).length;
      var more = el('button', 'tab tab-more' + (waits ? ' wait' : ''), '↩ Tab đã đóng (' + hid.length + ')' + (waits ? ' · ' + waits + ' chờ bạn' : ''));
      more.setAttribute('aria-haspopup', 'menu'); more.onclick = function (e) { e.stopPropagation(); tabMenu(more, hid); }; box.append(more);
    }
  }
  function tabMenu(anchor, hid) {
    var old = document.querySelector('.tab-menu'); if (old) { old.remove(); return; }
    var menu = el('div', 'tab-menu'); menu.setAttribute('role', 'menu');
    hid.forEach(function (y) { var it = el('button', 'tab-menu-item'); it.setAttribute('role', 'menuitem'); it.innerHTML = pet(petFor(y.v, y.s), y.s.state); it.append(y.s.name + (y.s.state === 'wait' ? ' · chờ bạn' : '')); it.onclick = function () { menu.remove(); tabHide.show(tabKey(y)); renderTabs(); }; menu.append(it); });
    var all = el('button', 'tab-menu-item', 'Mở lại tất cả'); all.setAttribute('role', 'menuitem'); all.onclick = function () { menu.remove(); tabHide.showAll(); renderTabs(); }; menu.append(all);
    var r = anchor.getBoundingClientRect(); menu.style.left = Math.max(8, Math.min(r.left, innerWidth - 240)) + 'px'; menu.style.top = r.bottom + 4 + 'px';
    document.body.append(menu);
    setTimeout(function () { document.addEventListener('click', function close() { menu.remove(); document.removeEventListener('click', close); }); }, 0);
  }
  var detailSignature = '';
  function renderDetail() {
    var box = $('detail'), x = curItem();
    var nextSignature = JSON.stringify(x ? [x.v.id, x.v.name, x.v.user, [x.s.name, x.s.state, x.s.cmd, x.s.path, ago(x.s.activityAge), x.s.created, x.s.diary], owned(x.v,x.s).map(function(w) { return [w.task,w.track,w.owner,w.finishedAt,w.result,w.resultAt,span(w.elapsed),w.lines]; }), prefs.pets, tokens.session(x.v.id,x.s.name)] : null);
    if (nextSignature === detailSignature) return;
    detailSignature = nextSignature; box.textContent = ''; if (!x) return;
    renderWorkers(x.v, box, x.s);
    var w = el('div', 'who'); w.style.setProperty('--c', color(x.s)); w.append(petSlot(x.v, x.s));
    w.append(el('b', '', x.s.name), el('span', 'pill ' + x.s.state, LABEL[x.s.state]));
    var a = el('div'); a.append(el('h3', '', 'Thông tin'));
    var dl = el('dl', 'kv');
    [['Máy chủ', x.v.user + '@' + x.v.name], ['Đang chạy', x.s.cmd], ['Thư mục', x.s.path], ['Hoạt động', ago(x.s.activityAge)], ['Tạo lúc', new Date(x.s.created * 1000).toLocaleString('vi-VN')]]
      .forEach(function (p) { dl.append(el('dt', '', p[0]), el('dd', '', p[1])); });
    a.append(dl);
    var acts = el('div', 'detail-actions'), d = el('button', 'btn', 'Rời (vẫn chạy)'), k = el('button', 'btn danger', 'Dừng');
    d.onclick = detach; k.onclick = killDlg; acts.append(d, k); box.append(w, a);
    var edit = el('button', 'btn', 'Đổi thú cưng'); edit.onclick = function () { editPet(x); }; box.append(edit);
    var journal = el('section', 'pet-diary'); journal.append(el('h3', '', 'Nhật ký thú'));
    var labels = { observed: 'Bắt đầu quan sát phiên', waiting: 'Chờ bạn', resumed: 'Phiên hết chờ', answered: 'Đã gửi trả lời từ web', finish: 'Đã kết thúc', failure: 'Thất bại' };
    var timeline = el('ol');
    (x.s.diary || []).slice().reverse().forEach(function (e) { timeline.append(el('li', '', new Date(e.at).toLocaleString('vi-VN') + ' · ' + (labels[e.type] || e.type) + (e.detail ? ' · ' + e.detail : ''))); });
    journal.append(timeline); if (!timeline.children.length) journal.append(el('p', '', 'Chưa có sự kiện quan sát.'));
    box.append(journal, acts); if (window.TW) window.TW.renderDetail(box, x); petSync();
  }
  function renderBar() {
    var x = curItem();
    if (!x) { $('bar-s').textContent = ''; $('bar-h').textContent = ''; $('m-title').textContent = 'Terminal'; return; }
    $('term-wrap').style.setProperty('--c', color(x.s));
    $('bar-s').textContent = '[' + x.s.name + ']'; $('bar-h').textContent = x.v.user + '@' + x.v.name; $('m-title').textContent = x.s.name;
  }
  function setView(v) {
    view = v; tokens.setView(v); if (window.TW) window.TW.setView(v); $('app').classList.toggle('in-focus', v === 'focus');
    $('v-over').classList.toggle('on', v === 'over'); $('v-focus').classList.toggle('on', v === 'focus');
    ['tab-over', 'nav-over'].forEach(function (i) { $(i).setAttribute('aria-pressed', v === 'over'); });
    ['tab-focus', 'nav-focus'].forEach(function (i) { $(i).setAttribute('aria-pressed', v === 'focus'); });
    render();
    if (v === 'focus') {
      if (!curItem()) { var all = vis(), l = all.filter(function (y) { return !tabHide || !tabHide.isHidden(tabKey(y)); })[0] || all[0]; if (l) { openSession(l.v.id, l.s.name); return; } }
      ensureTerm(); connectTerm(); if (panes.length) focusPane(focusedPane, true);
    }
  }
  function render() {
    petSync(); renderServers(); renderSide(); renderHealth(); renderFleet(); renderBell(); renderCommands(); syncPanePickers();
    if (view === 'over') { renderHero(); renderGrid(); } else if(view==='token'){tokens.render();} else { renderTabs(); renderDetail(); renderBar(); }
    petSync(); deliverMessages();
  }
  function say(t, good, ms, floating) {
    var b = $('banner'); b.textContent = t; b.className = 'show' + (good ? ' good' : '') + (floating ? ' text-hint' : '');
    if (ms) setTimeout(function () { if (b.textContent === t) b.className = ''; }, ms);
  }
  // Same banner as say(), with one action button (used by "close tab").
  function sayUndo(t, label, run, ms) {
    var b = $('banner'); b.textContent = ''; b.append(document.createTextNode(t + ' '));
    var btn = el('button', 'btn', label); btn.type = 'button'; btn.onclick = function () { run(); b.className = ''; }; b.append(btn); b.className = 'show good';
    setTimeout(function () { if (b.contains(btn)) b.className = ''; }, ms || 4500);
  }
  var viewControls = window.ViewControls({ document: document, window: window, navigator: navigator,
    get storage() { return localStorage; }, app: $('app'), panes: function () { return panes; }, composing: terminalComposing,
    fit: function () { requestAnimationFrame(sizeTerm); }, say: say,
    showTerminal: function () { if (view !== 'focus') setView('focus'); },
    terminalHost: $('split'), crewPanel: $('crew-panel'), crewOutput: $('crew-output'),
    termMinus: $('term-font-minus'), termPlus: $('term-font-plus'), termReset: $('term-font-reset'),
    crewMinus: $('crew-font-minus'), crewPlus: $('crew-font-plus'), fullscreenButton: $('term-fullscreen'), exitChip: $('fullscreen-exit') });
  function setScope(id) { scope = id; var x = curItem(); if (id !== 'all' && x && x.v.id !== id) { closeTerm(); cur = null; } setView(view === 'focus' && !vis().length ? 'over' : view); }

  /* Each pane owns its terminal, socket, observer and reconnect timer. */
  function terminalComposing() { return panes.some(function (p) { return p.ime && p.ime.isComposing(); }); }
  function focusTerminal(p) { if (!terminalComposing()) p.term.focus(); }
  function paneInputIdle() {
    if (terminalComposing()) return;
    if (pendingPaneWidth !== null) { var width = pendingPaneWidth; pendingPaneWidth = null; resizePanes(width); }
    if (pendingSplit !== null) { var count = pendingSplit; pendingSplit = null; setSplit(count); }
    syncPanePickers(); panes.forEach(connectPane); sizeTerm();
  }
  function paneItem(p) {
    var v = p && p.cur && srv(p.cur.id), session = v && v.sessions.filter(function (s) { return s.name === p.cur.name; })[0];
    return session ? { v: v, s: session } : null;
  }
  function closePane(p) {
    clearTimeout(p.retry); p.key = '';
    p.scroll = null; p.sendChain = null; if (p.bar) p.bar.hidden = true;
    if (p.ime) p.ime.reset();
    if (p.ws) { p.ws.onclose = null; p.ws.close(); p.ws = null; }
  }
  function focusPane(index, focus) {
    if (focusedPane === index && cur === panes[index].cur) { if (focus) focusTerminal(panes[index]); return; }
    focusedPane = index; cur = panes[index].cur;
    panes.forEach(function (p, i) { p.node.classList.toggle('active', i === index); });
    renderTabs(); renderDetail(); renderBar();
    if (focus) focusTerminal(panes[index]);
  }
  function ensureTerm() {
    if (!panes.length) createPane();
    panes[focusedPane].cur = cur; syncPanePickers(); requestAnimationFrame(sizeTerm);
  }
  var fileViewer = window.FileViewer.create(api);
  // ---- Text selection: Claude Code turns on mouse reporting, which makes xterm hand every drag to the app.
  function appMouse() { try { return localStorage.getItem('termnest.appMouse') === '1'; } catch (e) { return false; } }
  function setMouseLabel() { var b = $('mouse-mode'); if (!b) return; var on = appMouse(); b.textContent = on ? 'Chuột: ứng dụng' : 'Chọn chữ'; b.setAttribute('aria-pressed', String(!on)); b.title = on ? 'Đang gửi chuột cho ứng dụng trong phiên (giữ Option/Shift để chọn chữ). Bấm để chuyển sang chọn chữ.' : 'Kéo chuột để chọn và sao chép chữ. Bấm để trả chuột cho ứng dụng (nhấp để mở, cuộn trong ứng dụng).'; }
  function toggleMouseMode() {
    try { localStorage.setItem('termnest.appMouse', appMouse() ? '0' : '1'); } catch (e) { /* private mode */ }
    setMouseLabel();
    if (appMouse()) { panes.forEach(function (p) { if (p.cur) { closePane(p); connectPane(p); } }); say('Chuột đã trả cho ứng dụng. Giữ Option (Mac) hoặc Shift để chọn chữ.', true, 3500); }
    else { panes.forEach(function (p) { p.term.write(window.MouseFilter ? window.MouseFilter.RESET : ''); }); say('Kéo chuột để chọn chữ, Cmd+C để sao chép.', true, 3000); }
  }
  function copySelection(p) {
    var text = p && p.term.getSelection(); if (!text) { say('Chưa chọn đoạn chữ nào. Kéo chuột trên màn hình phiên để chọn.', false, 2500); return Promise.resolve(); }
    return (window.TW_DESKTOP ? window.TW_DESKTOP.copy(text) : navigator.clipboard.writeText(text)).then(function () { say('Đã sao chép ' + text.length + ' ký tự', true, 1600); }).catch(function () { say('Không sao chép được. Hãy dùng menu Sao chép của trình duyệt.', false, 4000); });
  }
  // ---- Scrollback: tmux owns the history, so wheel and scrollbar drive tmux copy-mode (lib/scroll.js).
  function rawSend(p, d) { if (p.ws && p.ws.readyState === 1) p.ws.send(new TextEncoder().encode(d)); }
  // Typing while tmux is in copy-mode would hit copy-mode keys: leave it first, keeping keystroke order.
  function paneSend(p, d) {
    if (p.scroll && p.scroll.inMode) {
      p.scroll.inMode = false;
      p.sendChain = scrollCall(p, 'bottom').catch(function () {}).then(function () { rawSend(p, d); });
      return;
    }
    if (p.sendChain) { p.sendChain = p.sendChain.then(function () { rawSend(p, d); }); return; }
    rawSend(p, d);
  }
  function scrollPath(p) { return '/api/servers/' + p.cur.id + '/sessions/' + encodeURIComponent(p.cur.name) + '/scroll'; }
  function scrollCall(p, op, n) {
    if (!p.cur) return Promise.reject(new Error('no session'));
    return api('POST', scrollPath(p), { op: op, n: n }).then(function (st) { p.scroll = st; drawScrollbar(p); return st; });
  }
  function drawScrollbar(p) {
    var st = p.scroll, bar = p.bar;
    if (!bar) return;
    if (!st || st.history <= 0 || st.alternate) { bar.hidden = true; return; }
    bar.hidden = false; // measure only after it is shown: a hidden element has no height
    var total = st.history + st.height, track = bar.clientHeight || 1;
    var size = Math.max(24, Math.round(track * st.height / total));
    p.thumb.style.height = size + 'px';
    p.thumb.style.top = Math.round((track - size) * (st.history - st.position) / st.history) + 'px';
    bar.classList.toggle('scrolled', st.inMode && st.position > 0);
  }
  function scrollbar(p) {
    p.bar = el('div', 'tscroll'); p.thumb = el('div', 'tscroll-thumb'); p.bar.append(p.thumb); p.bar.hidden = true; p.host.append(p.bar);
    var pending = 0, busy = false, hinted = '';
    function flush() {
      if (busy || !pending) return;
      var n = pending; pending = 0; busy = true;
      scrollCall(p, n > 0 ? 'up' : 'down', Math.abs(n)).catch(function () {}).then(function () { busy = false; flush(); });
    }
    function lines(e) {
      if (e.deltaMode === 1) return Math.round(e.deltaY);
      if (e.deltaMode === 2) return Math.round(e.deltaY * p.term.rows);
      var cell = (p.host.clientHeight / p.term.rows) || 16;
      return Math.round(e.deltaY / cell) || Math.sign(e.deltaY);
    }
    // Capture on the host keeps xterm from turning the wheel into Up/Down keys for the app; Ctrl+wheel stays zoom.
    p.host.addEventListener('wheel', function (e) {
      if (e.ctrlKey || !p.cur || !e.deltaY) return;
      e.preventDefault(); e.stopPropagation();
      if (p.scroll && p.scroll.alternate) {
        // Fullscreen apps (Claude, Codex) keep their conversation on the alternate screen: hand the wheel to the app as
        // mouse wheel events when it asked for the mouse, instead of showing the shell history underneath.
        var key0 = p.cur.id + '/' + p.cur.name;
        if (p.scroll.mouse) {
          var r = p.host.getBoundingClientRect(), col = Math.max(1, Math.min(p.term.cols, Math.floor((e.clientX - r.left) / r.width * p.term.cols) + 1)), row = Math.max(1, Math.min(p.term.rows, Math.floor((e.clientY - r.top) / r.height * p.term.rows) + 1));
          var seq = '\x1b[<' + (e.deltaY < 0 ? 64 : 65) + ';' + col + ';' + row + 'M', n = Math.min(5, Math.max(1, Math.abs(lines(e))));
          rawSend(p, new Array(n + 1).join(seq));
        } else if (hinted !== key0) { hinted = key0; say('Ứng dụng trong phiên đang dùng màn hình thay thế và không nhận cuộn chuột. Với Codex, chạy lại bằng --no-alt-screen.', false, 6000); }
        return;
      }
      if (p.scroll && p.scroll.history <= 0) {
        var key = p.cur.id + '/' + p.cur.name;
        if (hinted !== key && p.scroll.alternate) { hinted = key; say('Ứng dụng trong phiên đang dùng màn hình thay thế nên chưa có lịch sử để cuộn. Với Codex, chạy lại bằng --no-alt-screen.', false, 6000); }
        return;
      }
      pending = Math.max(-500, Math.min(500, pending - lines(e))); flush(); // wheel down (deltaY > 0) scrolls toward the newest output
    }, { capture: true, passive: false });
    function toPosition(y) {
      var st = p.scroll; if (!st || st.history <= 0) return;
      var rect = p.bar.getBoundingClientRect(), size = p.thumb.offsetHeight;
      var ratio = Math.max(0, Math.min(1, (y - rect.top - size / 2) / Math.max(1, rect.height - size)));
      var target = Math.round(st.history * (1 - ratio)), delta = target - st.position;
      if (delta) { pending += delta; flush(); }
    }
    p.bar.addEventListener('pointerdown', function (e) {
      e.preventDefault(); e.stopPropagation(); p.bar.setPointerCapture(e.pointerId); toPosition(e.clientY);
      var move = function (ev) { toPosition(ev.clientY); };
      p.bar.addEventListener('pointermove', move);
      p.bar.addEventListener('pointerup', function () { p.bar.removeEventListener('pointermove', move); }, { once: true });
    });
    // Keep the thumb honest when the pane changes on its own (new output, resize, another client).
    p.scrollTimer = setInterval(function () { if (view === 'focus' && p.cur && p.ws && p.ws.readyState === 1 && !busy) scrollCall(p, 'state').catch(function () {}); }, 3000);
  }
  function createPane() {
    var p = { cur: null, ws: null, key: '', retry: null }, index = panes.length;
    p.node = el('div', 'pane'); p.node.classList.toggle('active', index === focusedPane); p.picker = el('select'); p.picker.setAttribute('aria-label', 'Phiên ô ' + (index + 1));
    p.host = el('div', 'terminal'); p.node.append(p.picker, p.host); $('split').append(p.node); panes.push(p);
    p.term = new window.Terminal({ cursorBlink: true, macOptionClickForcesSelection: true, fontFamily: '"JetBrains Mono",monospace', fontSize: viewControls.font(), scrollback: 3000, theme: { background: '#101527', foreground: '#dfe6f5' } });
    p.fit = new window.FitAddon.FitAddon(); p.term.loadAddon(p.fit); p.term.open(p.host);
    p.term.registerLinkProvider(window.FileViewer.provider(p.term, function(path) { if (p.cur) fileViewer.open(p.cur.id, p.cur.name, path); }));
    function send(d) { paneSend(p, d); }
    scrollbar(p);
    p.ime = window.TerminalIME.attach(p.term, send, { onIdle: function () { paneInputIdle(); viewControls.flush(); viewControls.applyTerminalFont(); } });
    p.term.attachCustomKeyEventHandler(function(event) {
      if (viewControls.handleKey(event)) return false;
      if (event.type === 'keydown' && event.key.toLowerCase() === 'c' && (event.ctrlKey && event.shiftKey || event.metaKey) && p.term.getSelection()) {
        event.preventDefault(); copySelection(p);
      }
      // Mac editing keys and Shift+Enter: the default keydown would also fire a keypress, so cancel it here.
      var keySeq = window.TerminalKeys && window.TerminalKeys.sequence(event, /Mac/.test(navigator.platform || ''));
      if (keySeq != null) { event.preventDefault(); send(keySeq); return false; }
      if (window.TW_DESKTOP && event.type === 'keydown' && event.key.toLowerCase() === 'v' && (event.metaKey || event.ctrlKey && event.shiftKey)) {
        event.preventDefault(); window.TW_DESKTOP.paste().then(function(text) { p.ime.preparePaste(); p.term.paste(text); }).catch(function() { say('Không dán được.', false, 4000); }); return false;
      }
      return true;
    });
    p.term.onData(p.ime.onData); p.term.onBinary(send);
    p.term.onResize(function (size) { if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify({ t: 'resize', cols: size.cols, rows: size.rows })); });
    p.observer = new ResizeObserver(function () { fitPane(p); }); p.observer.observe(p.host);
    p.node.addEventListener('pointerdown', function () { focusPane(index, false); });
    p.node.addEventListener('focusin', function () { if (focusedPane !== index) focusPane(index, false); });
    p.picker.onchange = function () { var x = p.picker.value === '' ? null : vis()[Number(p.picker.value)]; closePane(p); p.cur = x ? { id: x.v.id, name: x.s.name } : null; focusPane(index, false); connectPane(p); };
  }
  function syncPanePickers() {
    var list = vis();
    panes.forEach(function (p) {
      if (p.ime.isComposing()) return;
      if (p.cur && !list.some(function (x) { return x.v.id === p.cur.id && x.s.name === p.cur.name; })) { closePane(p); p.cur = null; p.term.reset(); }
      p.picker.textContent = ''; var empty = el('option', '', 'Chọn phiên'); empty.value = ''; p.picker.append(empty);
      list.forEach(function (x, i) { var o = el('option', '', x.v.name + ' / ' + x.s.name); o.value = i; p.picker.append(o); if (p.cur && p.cur.id === x.v.id && p.cur.name === x.s.name) p.picker.value = String(i); });
      if (!p.cur) p.picker.value = '';
    });
    if (panes.length) cur = panes[focusedPane].cur;
  }
  function fitPane(p) { if (!p.ime.isComposing() && view === 'focus' && p.host.clientWidth && p.host.clientHeight) { try { p.fit.fit(); } catch (e) { /* hidden */ } } }
  function sizeTerm() { panes.forEach(fitPane); }
  function sendData(d) { var p = panes[focusedPane]; if (p) paneSend(p, d); }
  function closeTerm() { panes.forEach(function (p) { closePane(p); p.cur = null; p.term.reset(); }); }
  function connectTerm() { if (panes.length) { panes[focusedPane].cur = cur; panes.forEach(connectPane); syncPanePickers(); } }
  function connectPane(p) {
    var x = paneItem(p); if (!x || p.ime.isComposing()) return;
    var key = x.v.id + '/' + x.s.name;
    if (p.key === key && p.ws && p.ws.readyState <= 1) return;
    closePane(p); p.key = key; p.term.reset(); fitPane(p);
    var q = 'server=' + encodeURIComponent(x.v.id) + '&session=' + encodeURIComponent(x.s.name) + '&cols=' + p.term.cols + '&rows=' + p.term.rows;
    var sock = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/term?' + q); p.ws = sock; sock.binaryType = 'arraybuffer';
    sock.onopen = function () { scrollCall(p, 'state').catch(function () {}); fitPane(p); if (p === panes[focusedPane] && (document.activeElement === document.body || p.node.contains(document.activeElement))) focusTerminal(p); };
    p.mouse = window.MouseFilter ? window.MouseFilter.create() : null;
    // Output goes through the mouse filter unless the user chose to hand the mouse to the app (see mouse-mode below).
    sock.onmessage = function (e) { if (p.ws !== sock) return; var bytes = new Uint8Array(e.data); p.term.write(p.mouse && !appMouse() ? p.mouse.push(bytes) : bytes); };
    function retry() { clearTimeout(p.retry); p.retry = setTimeout(function () { if (view === 'focus' && paneItem(p)) connectPane(p); }, 2000); }
    sock.onclose = function (e) {
      if (p.ws !== sock) return; p.ws = null; p.key = '';
      if (e.code === 4001) { refresh().then(function () { if (panes.indexOf(p) < 0 || p.ime.isComposing()) return; if (!paneItem(p)) { p.cur = null; p.ime.reset(); p.term.reset(); syncPanePickers(); if (p === panes[focusedPane]) { cur = null; renderDetail(); renderBar(); } say('Phiên đã kết thúc.', true, 2500); } else retry(); }); }
      else retry();
    };
  }
  function setSplit(n) {
    if (terminalComposing()) { pendingSplit = n; return; }
    if ($('app').classList.contains('compact')) n = 1;
    if (!panes.length) createPane();
    var chosen = cur;
    if (n === 1 && focusedPane) { closePane(panes[0]); panes[0].cur = chosen; }
    while (panes.length > n) { var p = panes.pop(); closePane(p); p.observer.disconnect(); p.ime.dispose(); p.term.dispose(); p.node.remove(); }
    while (panes.length < n) { createPane(); var x = vis()[panes.length - 1]; if (x) panes[panes.length - 1].cur = { id: x.v.id, name: x.s.name }; }
    paneCount = n; focusedPane = Math.min(focusedPane, n - 1); $('split').className = n === 4 ? 'four' : n === 2 ? 'two' : 'one';
    focusPane(focusedPane, false); syncPanePickers(); if (view === 'focus') panes.forEach(connectPane); renderCommands(); requestAnimationFrame(sizeTerm);
  }
  function openSession(id, name) { var v = srv(id), s = v && v.sessions.find(function (s) { return s.name === name; }); if (s && s.created > 0) say('Em chạy ' + span(Math.max(0, Date.now() / 1000 - s.created)) + ' rồi', true, 3000); cur = { id: id, name: name }; if (tabHide) tabHide.show(id + '/' + name); if (panes.length) panes[focusedPane].cur = cur; setView('focus'); }
  var KEYS = { ctrlc: '\x03', esc: '\x1b', tab: '\t', up: '\x1b[A', down: '\x1b[B', ctrlb: '\x02', nl: '\n' };
  document.querySelectorAll('.keybar .btn').forEach(function (b) { b.onclick = function () { sendData(KEYS[b.dataset.k]); if (panes.length) focusTerminal(panes[focusedPane]); }; });
  function detach() { if (cur) petEvent(cur.id, cur.name, 'wave'); var n = cur && cur.name; if (panes.length) { closePane(panes[focusedPane]); panes[focusedPane].cur = null; panes[focusedPane].term.reset(); } cur = null; if (n) say('Đã rời ' + n + '. Việc vẫn chạy.', true, 2800); setView('over'); }

  /* Overview tools */
  function question(s) { return (s.lines || []).filter(function (line) { return line.trim(); }).slice(-1)[0] || 'Phiên đang chờ bạn'; }
  function sendKeys(id, name, text) { return api('POST', '/api/servers/' + id + '/sessions/' + encodeURIComponent(name) + '/keys', { text: text, enter: true }); }
  function addReply(card, ref, v, s) {
    if (s.state !== 'wait') return;
    var area = el('div', 'qr'), row = el('div', 'qr-b'), input = el('input'), send = el('button', 'btn', 'Gửi');
    ref.input = input; ref.question = el('p', '', question(s));
    input.placeholder = 'Trả lời khác'; input.setAttribute('aria-label', 'Trả lời ' + s.name); input.maxLength = 4000;
    function reply(text) {
      if (!text) return;
      var buttons = area.querySelectorAll('button'); buttons.forEach(function (b) { b.disabled = true; });
      sendKeys(v.id, s.name, text).then(function () { input.value = ''; say('Đã gửi tới ' + s.name + '.', true, 2500); return refresh(true); })
        .catch(function (err) { say(err.message, false, 4000); }).finally(function () { buttons.forEach(function (b) { b.disabled = false; }); });
    }
    [['Yes', 'y'], ['No', 'n']].forEach(function (x) { var b = el('button', 'btn', x[0]); b.type = 'button'; b.onclick = function () { reply(x[1]); }; row.append(b); });
    send.type = 'button'; send.onclick = function () { reply(input.value.trim()); };
    input.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); reply(input.value.trim()); } };
    area.addEventListener('click', function (e) { e.stopPropagation(); }); area.addEventListener('keydown', function (e) { e.stopPropagation(); });
    row.append(input, send); area.append(ref.question, row); card.append(area);
  }
  function addLost(sec, v) {
    if (!(v.lost || []).length && !restoreNotes[v.id]) return;
    var box = el('div', 'lost'), text = el('div'), restore = el('button', 'btn primary', 'Khôi phục'), dismiss = el('button', 'btn', 'Bỏ qua');
    text.append(el('b', '', (v.lost || []).length + ' phiên có thể khôi phục'), el('span', '', restoreNotes[v.id] || (v.lost.map(function (s) { return s.name; }).join(' · ') + (v.local && v.lost.some(function (s) { return s.run === 'codex'; }) ? ' — Codex: chọn hội thoại trong terminal nếu CLI hỗ trợ resume; nếu không, mở mới tại thư mục cũ.' : ''))));
    restore.disabled = !v.on || !v.lost.length;
    restore.onclick = function () {
      restore.disabled = true;
      api('POST', '/api/servers/' + v.id + '/restore', {}).then(function (r) {
        var result = 'Đã khôi phục: ' + (r.restored.join(', ') || 'chưa có');
        if (r.failed.length) restoreNotes[v.id] = result + '. Chưa khôi phục: ' + r.failed.map(function (f) { return f.name + ': ' + f.error; }).join('; ');
        else { delete restoreNotes[v.id]; say(result + '.', true, 3000); }
        return refresh(true);
      }).catch(function (err) { restoreNotes[v.id] = err.message; renderGrid(); });
    };
    dismiss.onclick = function () { dismiss.disabled = true; api('DELETE', '/api/servers/' + v.id + '/lost').then(function () { delete restoreNotes[v.id]; return refresh(true); }).catch(function (err) { say(err.message, false, 4000); dismiss.disabled = false; }); };
    box.append(text, restore, dismiss); sec.append(box);
  }
  function hot(v, k) { return v.on && v[k] != null && v[k] >= prefs.limits[k]; }
  function problems(v) { if (!v.on) return ['Mất kết nối']; return Object.keys(HP).filter(function (k) { return hot(v, k); }).map(function (k) { return HP[k][0] + ' cao (' + number(v[k]) + '%, ngưỡng ' + prefs.limits[k] + '%)'; }); }
  function number(n) { return Number.isFinite(n) ? Math.round(n * 100) / 100 : '—'; }
  function compactNumber(n) { return Number.isFinite(n) ? Math.round(n * 10) / 10 : '—'; }
  function ring(v, k, label, value) {
    var r = el('div', 'rg' + (hot(v, k) ? ' hot' : '')), d = el('div', 'd');
    d.style.setProperty('--c', HP[k][1]); d.style.setProperty('--v', Number.isFinite(v[k]) ? Math.max(0, Math.min(100, v[k])) : 0);
    d.append(el('i', '', Number.isFinite(v[k]) ? Math.round(v[k]) + '%' : '—')); r.append(d, el('span', 'rg-name', label), el('span', 'rg-value', value || '—')); return r;
  }
  function resourceRow(label, pct, color, text) {
    var r = el('div', 'fr'), bar = el('div', 'bar'), i = el('i'); i.style.setProperty('--c', color); i.style.setProperty('--v', Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0); bar.append(i); r.append(el('span', '', label), bar, el('b', '', text)); return r;
  }
  function renderFleet() {
    var box = $('fleet'); box.textContent = '';
    scoped().forEach(function (v) {
      var sys = v.sys, p = problems(v), card = el('article', 'fc' + (p.length ? ' hot' : '') + (v.on ? '' : ' off')), head = el('div', 'fc-h'), title = el('div', 't');
      var details = el('button', 'fc-details'); details.type = 'button'; details.setAttribute('aria-label', 'Chi tiết ' + v.name); details.onclick = function () { openDetail(v.id); };
      title.append(el('b', '', v.name), el('small', '', v.rebooting ? 'Đang khởi động lại' : !v.on ? 'Mất kết nối ' + (v.offSince ? span(Math.max(0, (Date.now() - v.offSince) / 1000)) : 'từ lúc chưa xác định') : sys ? [sys.os, sys.cores != null ? sys.cores + ' lõi' : '', sys.uptimeSec != null ? 'chạy ' + span(sys.uptimeSec) : ''].filter(function (part) { return part; }).join(' · ') : 'Đang chờ số liệu hệ thống'));
      details.append(title); head.append(details, el('span', 'pill ' + (p.length ? 'bad' : 'run'), v.rebooting ? 'Đang khởi động lại' : p[0] || 'Ổn định')); card.append(head);
      {
        var rs = el('div', 'rings'), disk = sys && (sys.disks || []).filter(function (d) { return d.mount === '/'; })[0];
        rs.append(ring(v, 'cpu', 'CPU', sys && sys.cores != null ? sys.cores + ' lõi' : ''), ring(v, 'ram', 'RAM', sys ? compactNumber(sys.ramUsedGb) + '/' + compactNumber(sys.ramTotalGb) + 'G' : ''), ring(v, 'disk', 'Disk', disk ? compactNumber(disk.usedGb) + '/' + compactNumber(disk.totalGb) + 'G' : ''));
        card.append(rs);
        if (sys) {
          var rows = el('div', 'fc-rows'); rows.append(resourceRow('Tải 1 phút', sys.load1 / sys.cores * 100, HP.cpu[1], number(sys.load1) + ' / ' + sys.cores), resourceRow('Swap', sys.swapTotalGb ? sys.swapUsedGb / sys.swapTotalGb * 100 : 0, HP.ram[1], number(sys.swapUsedGb) + ' / ' + number(sys.swapTotalGb) + ' GB'));
          var net = el('div', 'fr'), graph = el('div'); graph.innerHTML = sparkSVG((sys.net || []).filter(Number.isFinite), '#2f80ed'); net.append(el('span', '', 'Mạng'), graph, el('b', '', '↓' + number(sys.downMBs) + ' ↑' + number(sys.upMBs) + ' MB/s')); rows.append(net);
          var top = el('div', 'fc-top'); (sys.top || []).slice(0, 2).forEach(function (x) { var row = el('div'); row.append(el('span', '', x.cmd), el('span', '', number(x.cpu) + '% · ' + number(x.memGb) + ' GB')); top.append(row); }); card.append(rows, top);
        }
      }
      var tags = el('div', 'tags'), waits = v.sessions.filter(function (s) { return s.state === 'wait'; }).length;
      tags.append(el('span', 'tg', v.sessions.length + ' phiên'));
      if (waits) tags.append(el('span', 'tg w', waits + ' chờ bạn'));
      if (v.workers.length) tags.append(el('span', 'tg', v.workers.length + ' worker Crew'));
      if (sys && (sys.failed || []).length) tags.append(el('span', 'tg b', sys.failed.length + ' dịch vụ lỗi'));
      if (sys && sys.rebootRequired) {
        if (!v.local) {
          var reboot = el('button', 'btn danger reboot', v.rebooting ? 'Đang khởi động lại' : 'Khởi động lại');
          reboot.type = 'button'; reboot.disabled = !v.on || v.rebooting;
          reboot.onclick = function () { rebootDlg(v); }; tags.append(reboot);
        } else tags.append(el('span', 'tg b', 'Cần khởi động lại'));
      }
      if (sys && sys.updates) tags.append(el('span', 'tg w', sys.updates + ' bản cập nhật'));
      card.append(tags); box.append(card);
    });
  }
  function rebootDlg(v) {
    rebootTarget = v; rebootBusy = false;
    $('reboot-warning').textContent = 'Khởi động lại ' + v.name + ' sẽ kết thúc ' + v.sessions.length + ' phiên tmux. Lưu công việc trước khi tiếp tục.';
    $('reboot-name').value = ''; $('reboot-error').textContent = ''; $('reboot-ok').disabled = true;
    $('dlg-reboot').showModal(); $('reboot-name').focus();
  }
  $('reboot-name').oninput = function () { $('reboot-ok').disabled = rebootBusy || !rebootTarget || this.value !== rebootTarget.name; };
  $('form-reboot').onsubmit = function (e) {
    e.preventDefault();
    if (rebootBusy || !rebootTarget || $('reboot-name').value !== rebootTarget.name) return;
    var v = rebootTarget; rebootBusy = true; $('reboot-ok').disabled = true;
    api('POST', '/api/servers/' + v.id + '/reboot', { name: $('reboot-name').value }).then(function () {
      v.rebooting = true; renderFleet(); $('dlg-reboot').close(); return refresh(true);
    }).catch(function (err) { $('reboot-error').textContent = err.message; })
      .finally(function () { rebootBusy = false; $('reboot-name').oninput(); });
  };
  function alerts() {
    var out = [];
    servers.forEach(function (v) {
      v.sessions.forEach(function (s) { if (s.state === 'wait') out.push({ title: s.name + ' đang chờ bạn', text: v.name + ' · ' + question(s), go: function () { openSession(v.id, s.name); } }); });
      problems(v).forEach(function (p) { out.push({ title: v.name + ': ' + p, text: (v.local ? v.hostname + ' · không cần SSH' : v.user + '@' + v.host), go: function () { openDetail(v.id); } }); });
      if ((v.lost || []).length) out.push({ title: v.name + ' vừa khởi động lại', text: v.lost.length + ' phiên có thể khôi phục', go: function () { setScope(v.id); setView('over'); } });
      ((v.sys && v.sys.failed) || []).forEach(function (f) { out.push({ title: v.name + ': dịch vụ lỗi', text: f, go: function () { openDetail(v.id); } }); });
    }); return out;
  }
  function renderAlertList() {
    var box = $('al-list'), list = alerts(); box.textContent = '';
    if (!list.length) box.append(el('p', 'hint', 'Không có cảnh báo nào.'));
    list.forEach(function (a) { var b = el('button', 'al'), text = el('div'), dot = el('i'); dot.style.setProperty('--c', 'var(--wait)'); text.append(el('b', '', a.title), el('span', '', a.text)); b.append(dot, text); b.onclick = function () { $('dlg-alerts').close(); a.go(); }; box.append(b); });
  }
  function renderBell() {
    var count = alerts().length, wait = 0; servers.forEach(function (v) { wait += v.sessions.filter(function (s) { return s.state === 'wait'; }).length; });
    $('bell-n').textContent = count; $('bell-n').hidden = !count; document.title = (wait ? '(' + wait + ') ' : '') + 'Termnest';
    if ($('dlg-alerts').open) renderAlertList();
  }
  var audioContext = null;
  function armAudio() {
    if (!prefs.sound) return;
    try { if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
      if (audioContext.state === 'suspended') audioContext.resume().catch(function () {});
    } catch (e) { /* audio unavailable */ }
  }
  document.addEventListener('pointerdown', armAudio);
  document.addEventListener('keydown', armAudio);
  function meow() {
    if (!prefs.sound || !audioContext || audioContext.state !== 'running') return;
    try {
      var t = audioContext.currentTime, o = audioContext.createOscillator(), g = audioContext.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(660, t); o.frequency.exponentialRampToValueAtTime(920, t + .08); o.frequency.exponentialRampToValueAtTime(400, t + .28);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(.06, t + .03); g.gain.exponentialRampToValueAtTime(.001, t + .3);
      o.connect(g); g.connect(audioContext.destination); o.start(t); o.stop(t + .32); o.onended = function () { o.disconnect(); g.disconnect(); };
    } catch (e) { /* optional sound never interrupts input */ }
  }
  $('set-auto-restore').onchange = function () { savePrefs({ autoRestoreLocal: this.checked }).catch(settingsError); };
  $('set-sound').onchange = function () { var on = this.checked; prefs.sound = on; if (on) armAudio(); savePrefs({ sound: on }).catch(settingsError); };
  var editingPet = null;
  // Grid picker: automatic, then every registered pet, grouped. The hidden #pet-kind keeps the form code unchanged.
  function drawPetPick() {
    var box = $('pet-pick'); box.textContent = ''; var current = $('pet-kind').value;
    function item(kind, label, svg) {
      var b = el('button', 'pp'); b.type = 'button'; b.setAttribute('aria-pressed', String(current === kind)); b.title = label;
      var v = el('span', 'pv'); v.innerHTML = svg; b.append(v, el('small', '', label));
      b.onclick = function () { $('pet-kind').value = kind; drawPetPick(); }; return b;
    }
    var auto = el('div', 'pp-row'); auto.append(item('', 'Tự động', '<span class="pp-auto">✨</span>')); box.append(auto);
    var groups = [['animals', 'Thú cưng'], ['characters', 'Nhân vật hoạt hình']];
    groups.forEach(function (g) {
      var list = ((art.GROUPS || {})[g[0]] || []).filter(function (k) { return PETS[k]; }); if (!list.length) return;
      box.append(el('div', 'pp-title', g[1]));
      var row = el('div', 'pp-row'); list.forEach(function (k) { row.append(item(k, (art.LABELS || {})[k] || k, pet(k, 'run'))); }); box.append(row);
    });
  }
  function editPet(x) {
    editingPet = x.v.id + '/' + x.s.name; var choice = (prefs.pets || {})[editingPet] || {};
    $('pet-nickname').value = choice.name || ''; $('pet-kind').value = choice.kind && PETS[choice.kind] ? choice.kind : ''; $('pet-hat').value = choice.hat || ''; drawPetPick();
    $('pet-error').textContent = ''; $('dlg-pet').showModal();
  }
  $('form-pet').onsubmit = function (e) {
    e.preventDefault(); var pets = Object.assign({}, prefs.pets || {});
    pets[editingPet] = { name: $('pet-nickname').value.trim(), kind: $('pet-kind').value, hat: $('pet-hat').value };
    savePrefs({ pets: pets }).then(function () { $('dlg-pet').close(); render(); }).catch(function (e) { $('pet-error').textContent = e.message; });
  };
  function renderRanking(data) {
    if (!data) return; var box = $('daily-ranking'); box.textContent = '';
    box.append(el('b', '', 'Xếp hạng hôm nay · ' + data.day), el('p', '', 'Thời gian quan sát được · lỗi có exit status xác nhận'));
    function rows(leaders, target) {
      [['run', 'Chạy lâu nhất'], ['wait', 'Chờ lâu nhất'], ['failures', 'Nhiều lỗi nhất']].forEach(function (pair) {
        var col = el('div', 'ranking-column'); col.append(el('strong', '', pair[1]));
        var list = leaders[pair[0]] || []; if (!list.length) col.append(el('p', '', 'Chưa có dữ liệu'));
        list.slice(0, 1).forEach(function (r) {
          var server = srv(r.server), session = server && server.sessions.find(function (s) { return s.name === r.name; });
          var row = el('div', 'ranking-row'), icon = el('span', 'ranking-pet');
          icon.innerHTML = pet(session ? petFor(server, session) : petOf(r.name), pair[0] === 'wait' ? 'wait' : 'run');
          row.title = (server ? server.name : r.server) + ' · ' + r.name;
          row.append(icon, el('b', '', r.name), el('span', '', pair[0] === 'failures' ? r.value + ' lỗi' : span(r.value / 1000))); col.append(row);
        }); target.append(col);
      });
    }
    var grid = el('div', 'ranking-grid'); rows(data.leaders, grid); box.append(grid);
    if (data.summary) { var summary = el('details'); summary.append(el('summary', '', 'Tổng kết ngày ' + data.summary.day)); rows(data.summary.leaders, summary); box.append(summary); }
  }
  var waitCalls = new Map(), deliveries = new Map();
  try { deliveries = new Map(JSON.parse(sessionStorage.getItem('tw-deliveries') || '[]')); } catch (e) { /* optional */ }
  function notifyWaits() {
    var next = {}, live = new Set();
    servers.forEach(function (v) { (v.houseSessions || v.sessions).forEach(function (s) {
      var key = v.id + '/' + s.name + '/' + s.created; live.add(key); next[key] = s.state;
      if (!v.on) return;
      if (s.state !== 'wait') { waitCalls.delete(key); deliveries.delete(key); return; }
      if (waitStates && waitStates[key] && waitStates[key] !== 'wait') meow();
      var since = s.stateSince;
      if (!Number.isFinite(since) || Date.now() - since < window.PetState.LIMITS.wait || waitCalls.get(key) === since ||
          !browserOn || !('Notification' in window) || Notification.permission !== 'granted') return;
      waitCalls.set(key, since);
      // Rasterise local SVG artwork; no remote image or push service.
      var img = new Image();
      img.onload = function () {
        try {
          var current = srv(v.id), session = current && current.sessions.find(function (x) { return x.name === s.name && x.created === s.created; });
          if (!browserOn || !current.on || !session || session.state !== 'wait' || session.stateSince !== since) return;
          var canvas = document.createElement('canvas'); canvas.width = canvas.height = 96;
          canvas.getContext('2d').drawImage(img, 0, 0, 96, 96);
          var n = new Notification(s.name + ' chờ bạn hơn 2 phút', { body: v.name + ': ' + question(session), tag: key, icon: canvas.toDataURL('image/png') });
          n.onclick = function () { window.focus(); openSession(v.id, s.name); n.close(); };
        } catch (e) { /* notification support varies */ }
      };
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(pet(petFor(v, s), 'wait').replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" '));
    }); });
    waitCalls.forEach(function (_, k) { if (!live.has(k)) waitCalls.delete(k); });
    deliveries.forEach(function (_, k) { if (!live.has(k)) deliveries.delete(k); });
    waitStates = next;
  }
  function deliverMessages() {
    try {
      if (view !== 'over' || document.hidden || document.documentElement.classList.contains('pets-off')) return;
      vis().forEach(function (x) {
        var s = x.s, key = x.v.id + '/' + s.name + '/' + s.created, ref = cardRefs[x.v.id + '/' + s.name];
        if (!x.v.on || s.state !== 'wait' || !ref || !ref.card.isConnected || !ref.input || ref.card.querySelector('.pet-message')) return;
        var fresh = deliveries.get(key) !== s.stateSince;
        deliveries.set(key, s.stateSince);
        try { sessionStorage.setItem('tw-deliveries', JSON.stringify(Array.from(deliveries))); } catch (e) { /* optional */ }
        var note = el('button', 'pet-message'), face = el('span'), text = el('span', '', '📜 ' + question(s));
        note.type = 'button'; face.innerHTML = pet(petFor(x.v, s), 'wait'); note.append(face, text);
        note.setAttribute('aria-label', 'Trả lời: ' + question(s));
        note.onclick = function (e) { e.stopPropagation(); ref.input.focus(); ref.input.scrollIntoView({ block: 'nearest' }); };
        ref.card.append(note);
        if (fresh && window.PetState.motion(true, matchMedia('(prefers-reduced-motion: reduce)').matches, document.hidden)) {
          note.style.setProperty('--travel', '-' + (ref.card.getBoundingClientRect().left + ref.card.offsetWidth) + 'px');
          note.classList.add('message-arrives');
          note.addEventListener('animationend', function () { note.classList.remove('message-arrives'); }, { once: true });
        }
      });
    } catch (e) { /* decoration must not interrupt terminal input */ }
  }
  function savePrefs(patch) {
    return api('PUT', '/api/prefs', patch).then(function (data) { prefs = data; renderCommands(); renderTemplates(); renderFleet(); renderBell(); return data; });
  }
  function renderTemplates() {
    var box = $('templates'); box.textContent = ''; $('templates-block').hidden = !prefs.templates.length; $('recent-block').hidden = !prefs.recentDirs.length;
    prefs.templates.forEach(function (t, index) {
      var row = el('span', 'template'), use = el('button', 'btn', t.name), remove = el('button', 'btn', '×'); use.type = remove.type = 'button'; remove.setAttribute('aria-label', 'Xóa mẫu ' + t.name);
      use.onclick = function () { $('n-name').value = t.name; $('n-dir').value = t.dir; $('n-run').value = t.run; };
      remove.onclick = function () { savePrefs({ templates: prefs.templates.filter(function (_, i) { return i !== index; }) }).catch(function (err) { $('n-err').textContent = err.message; }); };
      row.append(use, remove); box.append(row);
    });
    $('recent').textContent = ''; prefs.recentDirs.forEach(function (dir) { var b = el('button', 'btn', dir); b.type = 'button'; b.onclick = function () { $('n-dir').value = dir; }; $('recent').append(b); });
  }
  function renderCommands() {
    var box = $('command-list'); box.textContent = '';
    [1, 2, 4].forEach(function (n) { var b = el('button', 'btn' + (n > 1 ? ' split-option' : ''), n + ' ô'); b.setAttribute('aria-pressed', paneCount === n); b.onclick = function () { setSplit(n); }; box.append(b); });
    prefs.commands.forEach(function (c) { var b = el('button', 'btn', c); b.onclick = function () { var x = curItem(); if (!x) { say('Chọn phiên trước khi gửi lệnh.', false, 2500); return; } sendKeys(x.v.id, x.s.name, c).catch(function (err) { say(err.message, false, 4000); }); }; box.append(b); });
  }
  function renderSettings() {
    $('set-auto-restore').checked = !!prefs.autoRestoreLocal;
    $('set-sound').checked = !!prefs.sound;
    $('set-browser').checked = browserOn;
    Object.keys(HP).forEach(function (k) { $('lim-' + k).value = prefs.limits[k]; $('lim-' + k + '-v').textContent = prefs.limits[k] + '%'; });
    var box = $('set-commands'); box.textContent = '';
    prefs.commands.forEach(function (c, index) { var b = el('button', 'btn', c + ' ×'); b.setAttribute('aria-label', 'Xóa lệnh ' + c); b.onclick = function () { savePrefs({ commands: prefs.commands.filter(function (_, i) { return i !== index; }) }).then(renderSettings).catch(settingsError); }; box.append(b); });
  }
  function settingsError(err) { $('set-note').textContent = err.message; }
  function table(box, rows) {
    box.textContent = ''; var t = el('table', 'mt'); rows.forEach(function (r) { var tr = el('tr'); tr.append(el('td', '', r[0]), el('td', '', r[1])); t.append(tr); }); box.append(t);
  }
  function svgNode(tag, attrs) { var node = document.createElementNS('http://www.w3.org/2000/svg', tag); Object.keys(attrs).forEach(function (k) { node.setAttribute(k, attrs[k]); }); return node; }
  function drawHistory(points, hours) {
    var box = $('dt-chart'); box.textContent = '';
    points = points.filter(function (p) { return Number.isFinite(p.t); }).sort(function (a, b) { return a.t - b.t; });
    if (points.length < 2) { box.append(el('p', 'empty', 'Chưa đủ dữ liệu, cần chờ thêm.')); return; }
    var end = Date.now(), start = end - hours * 3600000, chart = svgNode('svg', { viewBox: '0 0 700 190', class: 'chart', role: 'img', 'aria-label': 'Lịch sử CPU, RAM và Disk theo phần trăm; khoảng trống là lúc thiếu dữ liệu' });
    [0, 50, 100].forEach(function (value) { var y = 165 - value * 1.45; chart.append(svgNode('line', { x1: 34, x2: 690, y1: y, y2: y, stroke: 'var(--line)' })); var label = svgNode('text', { x: 2, y: y + 4, fill: 'var(--fg-3)', 'font-size': 11 }); label.textContent = value + '%'; chart.append(label); });
    Object.keys(HP).forEach(function (k) {
      var d = '', last = null;
      points.forEach(function (p) { if (!Number.isFinite(p[k])) { last = null; return; } var x = 34 + (p.t - start) / (end - start) * 656, y = 165 - Math.max(0, Math.min(100, p[k])) * 1.45; d += (last !== null && p.t - last <= 180000 ? ' L' : ' M') + x.toFixed(2) + ',' + y.toFixed(2); chart.append(svgNode('circle', { cx: x.toFixed(2), cy: y.toFixed(2), r: 1.7, fill: HP[k][1] })); last = p.t; });
      chart.append(svgNode('path', { d: d, fill: 'none', stroke: HP[k][1], 'stroke-width': 2 }));
    });
    [start, end].forEach(function (time, i) { var text = svgNode('text', { x: i ? 690 : 34, y: 185, 'text-anchor': i ? 'end' : 'start', fill: 'var(--fg-3)', 'font-size': 11 }); text.textContent = new Date(time).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }); chart.append(text); }); box.append(chart);
  }
  function loadHistory(hours) {
    var id = detailId, request = ++historyRequest; $('dt-chart').textContent = 'Đang tải...';
    document.querySelectorAll('#dt-range button').forEach(function (b) { b.setAttribute('aria-pressed', Number(b.dataset.r.replace('h', '')) === hours); });
    api('GET', '/api/servers/' + id + '/history?hours=' + hours).then(function (data) { if (request === historyRequest && $('dlg-detail').open) drawHistory(data.points, hours); }).catch(function (err) { if (request === historyRequest) $('dt-chart').textContent = err.message; });
  }
  function openDetail(id) {
    var v = srv(id); if (!v) return; detailId = id; var sys = v.sys;
    $('dt-title').textContent = v.name;
    table($('dt-disks'), sys ? (sys.disks || []).map(function (d) { return [d.mount, number(d.usedGb) + '/' + number(d.totalGb) + ' GB · ' + number(d.pct) + '%']; }) : [['Số liệu', 'Đang chờ']]);
    table($('dt-top'), sys ? (sys.top || []).map(function (p) { return [p.cmd, number(p.cpu) + '% · ' + number(p.memGb) + ' GB']; }) : [['Số liệu', 'Đang chờ']]);
    var rows = [['Kết nối', v.on ? 'Đã kết nối' : 'Mất kết nối']];
    if (sys) rows = rows.concat([['Hệ điều hành', sys.os], ['Thời gian chạy', span(sys.uptimeSec)], ['Dịch vụ lỗi', (sys.failed || []).join(', ') || 'Không có'], ['Khởi động lại', sys.rebootRequired ? 'Cần khởi động lại' : 'Chưa cần'], ['Bản cập nhật', sys.updates == null ? 'Chưa có số liệu' : sys.updates]]);
    table($('dt-sys'), rows); if (!$('dlg-detail').open) $('dlg-detail').showModal(); loadHistory(24);
  }
  $('q').oninput = function () { query = this.value.trim().toLowerCase(); renderSide(); renderGrid(); };
  document.querySelectorAll('#f button').forEach(function (b) { b.onclick = function () { filter = b.dataset.f; document.querySelectorAll('#f button').forEach(function (a) { a.setAttribute('aria-pressed', a === b); }); renderSide(); renderGrid(); }; });
  $('bell').onclick = function () { renderAlertList(); $('dlg-alerts').showModal(); };
  $('set').onclick = function () { renderSettings(); $('set-note').textContent = ''; $('dlg-set').showModal(); };
  document.querySelectorAll('dialog [data-close]').forEach(function (b) { b.onclick = function () { b.closest('dialog').close(); }; });
  $('dt-see').onclick = function () { $('dlg-detail').close(); setScope(detailId); setView('over'); };
  document.querySelectorAll('#dt-range button').forEach(function (b) { b.onclick = function () { loadHistory(Number(b.dataset.r.replace('h', ''))); }; });
  $('dlg-detail').addEventListener('close', function () { historyRequest++; });
  $('n-save').onclick = function () {
    var t = { name: $('n-name').value.trim(), dir: $('n-dir').value, run: $('n-run').value };
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(t.name)) { $('n-err').textContent = 'Tên chỉ dùng chữ không dấu, số, - hoặc _ (tối đa 32 ký tự).'; return; }
    var templates = prefs.templates.filter(function (x) { return x.name !== t.name; }); templates.push(t);
    savePrefs({ templates: templates }).then(function () { $('n-err').textContent = ''; say('Đã lưu mẫu.', true, 2500); }).catch(function (err) { $('n-err').textContent = err.message; });
  };
  $('set-browser').onchange = function () {
    var checkbox = this; browserOn = checkbox.checked;
    function store() { checkbox.checked = browserOn; try { localStorage.setItem('tw-notifications', String(browserOn)); } catch (e) { /* optional */ } }
    if (!browserOn) { store(); return; }
    if (!('Notification' in window)) { browserOn = false; store(); return; }
    if (Notification.permission === 'denied') { browserOn = false; store(); return; }
    try { Promise.resolve(Notification.requestPermission()).then(function (permission) { browserOn = permission === 'granted'; store(); }).catch(function () { browserOn = false; store(); }); } catch (e) { browserOn = false; store(); }
  };
  Object.keys(HP).forEach(function (k) {
    $('lim-' + k).oninput = function () { prefs.limits[k] = Number(this.value); $('lim-' + k + '-v').textContent = this.value + '%'; renderFleet(); renderBell(); };
    $('lim-' + k).onchange = function () { clearTimeout(limitTimer); var limits = Object.assign({}, prefs.limits); limitTimer = setTimeout(function () { savePrefs({ limits: limits }).then(function () { $('set-note').textContent = 'Đã lưu ngưỡng.'; }).catch(settingsError); }, 400); };
  });
  $('form-command').onsubmit = function (e) { e.preventDefault(); var command = $('command-text').value.trim(); if (!command) return; savePrefs({ commands: prefs.commands.concat([command]) }).then(function () { $('command-text').value = ''; renderSettings(); }).catch(settingsError); };
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); installPrompt = e; });
  $('set-pwa').onclick = function () { if (!installPrompt) { $('set-note').textContent = 'Mở menu trình duyệt và chọn Cài đặt ứng dụng hoặc Thêm vào màn hình chính. Khi truy cập từ xa, hãy dùng SSH tunnel.'; return; } var prompt = installPrompt; installPrompt = null; Promise.resolve(prompt.prompt()).then(function () { return prompt.userChoice; }).catch(settingsError); };
  try { if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(function () { /* optional */ }); } catch (e) { /* optional */ }

  /* Dialogs */
  function loadDirs(path) {
    var request = ++dirRequest;
    dirCurrent = null; $('dir-ok').disabled = true; $('dir-up').disabled = true;
    $('dir-path').textContent = path || 'Thư mục mặc định';
    $('dir-list').textContent = ''; $('dir-list').setAttribute('aria-busy', 'true');
    $('dir-note').textContent = 'Đang tải...'; $('dir-err').textContent = '';
    api('GET', '/api/servers/' + dirServer + '/dirs?path=' + encodeURIComponent(path))
      .then(function (data) {
        if (request !== dirRequest || !$('dlg-dir').open) return;
        dirCurrent = data; $('dir-path').textContent = data.path;
        $('dir-ok').disabled = false; $('dir-up').disabled = data.parent === null;
        $('dir-note').textContent = data.truncated ? 'Chỉ hiển thị 500 thư mục đầu tiên.' : '';
        if (!data.dirs.length) $('dir-list').append(el('p', 'hint', 'Không có thư mục con.'));
        data.dirs.forEach(function (name) {
          var b = el('button', 'btn dir-folder', name); b.type = 'button';
          b.onclick = function () { loadDirs((data.path.endsWith('/') || data.path.endsWith('\\') ? data.path : data.path + (data.path.includes('\\') ? '\\' : '/')) + name); };
          $('dir-list').append(b);
        });
      }).catch(function (err) {
        if (request !== dirRequest || !$('dlg-dir').open) return;
        $('dir-note').textContent = ''; $('dir-err').textContent = err.message;
      }).finally(function () {
        if (request === dirRequest) $('dir-list').setAttribute('aria-busy', 'false');
      });
  }
  function newDlg(id) {
    var ons = servers.filter(function (v) { return v.on; }), sel = $('n-srv'); sel.textContent = '';
    if (!ons.length) { addDlg(); return; }
    ons.forEach(function (v) { var o = el('option', '', (v.local ? 'Máy này · ' + v.hostname : v.user + '@' + v.name)); o.value = v.id; sel.append(o); });
    sel.value = (typeof id === 'string' && srv(id) && srv(id).on) ? id : (scope !== 'all' && srv(scope).on ? scope : ons[0].id);
    $('n-pet').innerHTML = pet('frog', 'run'); $('n-name').value = ''; $('n-dir').value = ''; $('n-err').textContent = ''; renderTemplates(); $('dlg-new').showModal(); $('n-name').focus();
  }
  function addDlg() {
    ['s-host', 's-user', 's-pass', 's-phrase', 's-key'].forEach(function (i) { $(i).value = ''; });
    $('s-port').value = '22'; $('s-err').textContent = ''; $('dlg-srv').showModal(); $('s-host').focus();
  }
  function delDlg(v) { delTarget = v; $('d-title').textContent = 'Gỡ ' + (v.local ? 'Máy này · ' + v.hostname : v.user + '@' + v.name) + '?'; $('dlg-del').showModal(); $('d-cancel').focus(); }
  function killDlg() { killTarget = curItem(); if (!killTarget) return; $('k-title').textContent = 'Dừng ' + killTarget.s.name + '?'; $('k-err').textContent = ''; $('dlg-kill').showModal(); $('k-cancel').focus(); }
  function connectAgain(v, b) {
    if (v.needsPassword) { passTarget = v; $('p-title').textContent = 'Kết nối ' + (v.local ? 'Máy này · ' + v.hostname : v.user + '@' + v.name); $('p-pass').value = ''; $('p-err').textContent = ''; $('dlg-pass').showModal(); $('p-pass').focus(); return; }
    b.disabled = true; b.textContent = 'Đang kết nối...';
    api('POST', '/api/servers/' + v.id + '/connect', {}).then(function () { say('Đã kết nối lại ' + v.name + '. Việc vẫn còn đó.', true, 3000); return refresh(true); })
      .catch(function (e) { say(e.message, false, 4000); b.disabled = false; b.textContent = 'Kết nối lại'; });
  }

  $('n-cancel').onclick = function () { $('dlg-new').close(); };
  $('n-srv').onchange = function () { $('n-dir').value = ''; };
  $('n-browse').onclick = function () {
    dirServer = $('n-srv').value; $('dlg-dir').showModal(); loadDirs($('n-dir').value);
  };
  $('dir-up').onclick = function () { if (dirCurrent && dirCurrent.parent !== null) loadDirs(dirCurrent.parent); };
  $('dir-cancel').onclick = function () { $('dlg-dir').close(); };
  $('dlg-dir').onclose = function () { dirRequest++; dirCurrent = null; };
  $('dir-ok').onclick = function () {
    if (!dirCurrent) return;
    $('n-dir').value = dirCurrent.path; $('dlg-dir').close(); $('n-dir').focus();
  };
  $('s-cancel').onclick = function () { $('dlg-srv').close(); };
  $('p-cancel').onclick = function () { $('dlg-pass').close(); };
  $('k-cancel').onclick = function () { $('dlg-kill').close(); };
  $('d-cancel').onclick = function () { $('dlg-del').close(); };
  $('s-auth').onchange = function () {
    var k = this.value === 'key'; $('s-kl').hidden = !k; $('s-ppl').hidden = !k; $('s-pl').hidden = k;
    $('s-hint').textContent = k ? 'Khóa được mã hóa khi lưu.' : 'Không lưu mật khẩu. Web khởi động lại thì phải nhập lại.';
  };
  $('form-new').onsubmit = function (e) {
    e.preventDefault(); var n = $('n-name').value.trim(), id = $('n-srv').value;
    if (!/^[A-Za-z0-9_-]+$/.test(n)) { $('n-err').textContent = 'Tên chỉ dùng chữ không dấu, số, - hoặc _.'; return; }
    api('POST', '/api/servers/' + id + '/sessions', { name: n, dir: $('n-dir').value, run: $('n-run').value })
      .then(function () { $('dlg-new').close(); api('GET', '/api/prefs').then(function (data) { prefs = data; }).catch(function () { /* next login reloads prefs */ }); return refresh(true); }).then(function () { openSession(id, n); })
      .catch(function (err) { $('n-err').textContent = err.message; });
  };
  $('form-srv').onsubmit = function (e) {
    e.preventDefault();
    var auth = $('s-auth').value, body = { host: $('s-host').value.trim(), port: Number($('s-port').value), user: $('s-user').value.trim(), auth: auth };
    if (!body.host) { $('s-err').textContent = 'Nhập địa chỉ máy chủ.'; return; }
    if (!body.user) { $('s-err').textContent = 'Nhập tài khoản.'; return; }
    var send = function () {
      $('s-ok').disabled = true; $('s-err').textContent = 'Đang kết nối...';
      api('POST', '/api/servers', body).then(function (r) { $('dlg-srv').close(); return refresh(true).then(function () { setScope(r.id); say('Đã thêm máy chủ.', true, 2500); }); })
        .catch(function (err) { $('s-err').textContent = err.message; }).finally(function () { $('s-ok').disabled = false; });
    };
    if (auth === 'password') {
      body.password = $('s-pass').value; if (!body.password) { $('s-err').textContent = 'Nhập mật khẩu.'; return; }
      send(); return;
    }
    var f = $('s-key').files[0]; if (!f) { $('s-err').textContent = 'Chọn file khóa SSH.'; return; }
    body.passphrase = $('s-phrase').value;
    f.text().then(function (t) { body.key = t; send(); });
  };
  $('form-pass').onsubmit = function (e) {
    e.preventDefault(); var v = passTarget, p = $('p-pass').value; if (!p) { $('p-err').textContent = 'Nhập mật khẩu.'; return; }
    api('POST', '/api/servers/' + v.id + '/connect', { password: p }).then(function () { $('dlg-pass').close(); return refresh(true); }).catch(function (err) { $('p-err').textContent = err.message; });
  };
  $('k-ok').onclick = function () {
    var x = killTarget;
    petEvent(x.v.id, x.s.name, 'stop');
    api('DELETE', '/api/servers/' + x.v.id + '/sessions/' + encodeURIComponent(x.s.name)).then(function () {
      $('dlg-kill').close(); closeTerm(); cur = null; say('Đã dừng ' + x.s.name + '.', true, 2500); return refresh(true);
    }).then(function () { setView('over'); }).catch(function (err) { petEvent(x.v.id, x.s.name, null); $('k-err').textContent = err.message; });
  };
  $('d-ok').onclick = function () {
    var v = delTarget;
    api('DELETE', '/api/servers/' + v.id).then(function () { $('dlg-del').close(); if (scope === v.id) scope = 'all'; if (cur && cur.id === v.id) { closeTerm(); cur = null; } return refresh(true); })
      .then(function () { setView('over'); say('Đã gỡ ' + (v.local ? 'Máy này · ' + v.hostname : v.user + '@' + v.name) + '.', true, 2500); }).catch(function (err) { say(err.message, false, 4000); });
  };

  /* Nav */
  ['tab-over', 'nav-over'].forEach(function (i) { $(i).onclick = function () { setView('over'); }; });
  ['tab-focus', 'nav-focus'].forEach(function (i) { $(i).onclick = function () { setView('focus'); }; });
  $('btn-new').onclick = newDlg;
  $('h-detach').onclick = detach; $('h-kill').onclick = killDlg;
  $('srv-sel').onchange = function () { setScope(this.value); };
  $('theme').onclick = function () {
    var r = document.documentElement, dark = r.getAttribute('data-theme') !== 'dark';
    if (dark) r.setAttribute('data-theme', 'dark'); else r.removeAttribute('data-theme');
    try { localStorage.setItem('tw-theme', dark ? 'dark' : ''); } catch (e) { /* optional */ }
  };
  try { if (localStorage.getItem('tw-theme') === 'dark') document.documentElement.setAttribute('data-theme', 'dark'); } catch (e) { /* optional */ }
  function resizePanes(w) {
    if (terminalComposing()) { pendingPaneWidth = w; return; }
    $('app').classList.toggle('compact', w < 760); $('app').classList.toggle('narrow', w < 1120); if (w < 760 && paneCount > 1) setSplit(1);
  }
  new ResizeObserver(function (e) { resizePanes(e[0].contentRect.width); viewControls.applyTerminalFont(); }).observe($('app'));

  /* Data */
  function sig() {
    return JSON.stringify(servers.map(function (v) {
      return [v.id, v.name, v.on, v.hasTmux, v.error, v.lost, v.sessions.map(function (s) { return [s.name, s.state, s.cmd, s.diary]; }), v.workers.map(function (w) { return [w.finishedAt, w.result, w.kind, w.task, w.track, w.owner, w.elapsed >> 6, (w.lines || []).join()]; })];
    }));
  }
  function refresh(force) {
    return api('GET', '/api/state').then(function (st) {
      servers = st.servers; renderRanking(st.daily);
      if (window.TW) window.TW.emit('state', { servers: servers, scope: scope, current: cur });
      try { notifyWaits(); } catch (e) { /* optional notification/pet logic */ }
      petSync();
      var ended = cur && srv(cur.id) && srv(cur.id).on && !curItem();
      if (scope !== 'all' && !srv(scope)) scope = 'all';
      if (!online) { online = true; $('app').classList.remove('offline'); say('Đã kết nối lại. Không việc nào bị dừng.', true, 3200); force = true; }
      var s = sig();
      if (force || s !== signature) { signature = s; render(); }
      else {
        renderHealth(); renderFleet(); renderBell();
        if (query) { renderSide(); if (view === 'over') renderGrid(); }
        if (view === 'focus') syncPanePickers();
        if (view === 'over') {
          servers.forEach(function (v) { v.sessions.forEach(function (x) { var r = cardRefs[v.id + '/' + x.name]; if (r) fillCard(r, x); }); });
        }
      }
      deliverMessages();
      if (view === 'focus' && ended && !terminalComposing()) { say('Phiên đã kết thúc.', true, 2500); if (paneCount === 1) setView('over'); }
      if (firstState) { firstState = false; if (!servers.length) addDlg(); }
    }).catch(function (e) {
      if (e.status === 401) { showLogin(); return; }
      if (online) { online = false; $('app').classList.add('offline'); say('Mất kết nối tới web. Việc trên máy chủ vẫn chạy. Đang kết nối lại...'); if (view === 'over') renderHero(); petSync(); }
    });
  }
  function startPolling() { stopPolling(); pollTimer = setInterval(function(){refresh();}, 2500); tokenTimer = setInterval(function(){tokens.poll();}, 5000); }
  function stopPolling() { clearInterval(pollTimer); clearInterval(tokenTimer); pollTimer = null; tokenTimer = null; }
  var setupToken = new URLSearchParams(location.hash.slice(1)).get('setup');
  if (setupToken) history.replaceState(null, '', location.pathname + location.search);
  $('form-setup').onsubmit = function (e) {
    e.preventDefault();
    if ($('setup-pass').value !== $('setup-confirm').value) { $('setup-err').textContent = 'Hai lần nhập không giống nhau.'; return; }
    api('POST', '/api/setup', { password: $('setup-pass').value, setupToken: setupToken }).then(function () {
      setupToken = null; $('setup-pass').value = ''; $('setup-confirm').value = ''; showLogin();
    }).catch(function (err) { $('setup-err').textContent = err.message; });
  };
  $('set-quit').onclick = function () {
    api('POST', '/api/quit').then(function () { stopPolling(); $('dlg-set').close(); say('Ứng dụng đã dừng. Bạn có thể đóng trang này.', false); }).catch(settingsError);
  };
  function showLogin() {
    stopPolling(); fileViewer.close(); tokens.clear(); closeCrew(); closeTerm(); cur = null; firstState = true; waitStates = null; document.title = 'Termnest';
    document.querySelectorAll('dialog[open]').forEach(function (d) { d.close(); });
    $('login').hidden = false; $('login-pass').value = '';
    api('GET', '/api/status').then(function (s) { $('login-setup').hidden = s.setup; $('form-setup').hidden = !(s.webSetup && setupToken); $('setup-hint').hidden = !!(s.webSetup && setupToken); $('set-quit').hidden = !s.packaged; $('form-login').hidden = !s.setup; if (s.setup) $('login-pass').focus(); });
  }
  (function wireSelectionButtons() {
    var m = $('mouse-mode'), c = $('copy-sel');
    if (m) { m.onclick = toggleMouseMode; setMouseLabel(); }
    if (c) c.onclick = function () { copySelection(panes[focusedPane]); };
  })();
  function enter() { $('login').hidden = true; api('GET', '/api/prefs').then(function (data) { prefs = data; renderSettings(); renderCommands(); renderFleet(); renderBell(); }).catch(function (e) { say(e.message, false, 4000); }); refresh(true).then(function () { setView('over'); startPolling(); tokens.poll(true); if (window.TW) { window.TW.attach({ typeText: function (t) { var p = panes[focusedPane]; if (p) { p.term.paste(t); focusTerminal(p); } }, dropTarget: function () { return $('split'); }, crewPopup: function (id, task, track, load) { openCrew({ id: id }, { task: task, track: track }, load); }, api: api, setView: setView, openSession: openSession, say: say, servers: function () { return servers; }, current: function () { return curItem(); } }); window.TW.load().then(function () { render(); }); } }); }
  $('form-login').onsubmit = function (e) {
    e.preventDefault(); $('login-err').textContent = '';
    api('POST', '/api/login', { password: $('login-pass').value }).then(enter).catch(function (err) { $('login-err').textContent = err.message; });
  };
  $('logout').onclick = function () { api('POST', '/api/logout').finally(showLogin); };

  api('GET', '/api/status').then(function (s) { $('set-quit').hidden = !s.packaged; if (s.authed) enter(); else showLogin(); });
})();
