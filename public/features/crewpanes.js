'use strict';
// Crew panes (prototype): an orchestrator session plus N worker sessions shown together. Every state shown here is measured
// from the live panes (screen text, output age) or from the plan file the orchestrator writes, and says where it came from.
(function () {
  var TW = window.TW; if (!TW) return;
  var el = TW.el, PET = window.PetArt;
  var demoMode = false, crews = [], registry = [], derived = [], tracks = {}, cur = null, menuOpen = false, layoutMode = 'T', boxes = [], QUIET = 45;
  var KINDS = ['owl', 'cat', 'fox', 'bunny', 'frog'], COLORS = ['#7c6cf0', '#0fa58a', '#2f80ed', '#e08a00', '#d85aa0'];
  var LABEL = { run: i18n('cp.state_run'), wait: i18n('cp.state_wait'), idle: i18n('cp.state_idle'), done: i18n('cp.state_done'), quiet: i18n('cp.state_quiet'), queued: i18n('cp.state_queued'), failed: i18n('cp.state_failed'), gone: i18n('cp.state_gone'), off: i18n('cp.state_off') };
  function app() { return TW.app(); }
  // A real Crew is not registered here: it is the leader session plus the tracks of its task in _crew/tasks, exactly what the
  // Vận hành screen reads (opshub fleet: tasks[].leader, tasks[].tracks, sessions[].workers). A worker is a track, not a session.
  var TRACK_UI = { running: 'run', dispatched: 'run', fix: 'run', review: 'run', queued: 'queued', pending: 'queued', blocked: 'queued', failed: 'failed', done: 'done', merged: 'done' };
  function deriveCrews(fleet) {
    var by = {}, kinds = {};
    (fleet.sessions || []).forEach(function (s) { (s.workers || []).forEach(function (w) { if (w.task && w.track) kinds[s.machine + '|' + w.task + '|' + w.track] = w.kind || ''; }); });
    (fleet.tasks || []).forEach(function (t) {
      if (!t.leader || !(t.tracks || []).length) return;
      var id = t.machine + '/' + t.leader, c = by[id] || (by[id] = { id: id, server: t.machine, name: t.leader, dir: t.root, derived: true, workers: [], kinds: {}, trackMap: {}, tasks: [] });
      c.tasks.push({ id: t.id, title: t.title });
      t.tracks.forEach(function (k) {
        var nm = c.trackMap[k.id] ? t.id + '/' + k.id : k.id;
        c.workers.push(nm); c.kinds[nm] = kinds[t.machine + '|' + t.id + '|' + k.id] || ''; c.trackMap[nm] = { task: t.id, track: k.id, state: k.state, title: t.title };
      });
    });
    return Object.keys(by).map(function (k) { return by[k]; });
  }
  function mergeCrews() { crews = registry.concat(derived.filter(function (d) { return !registry.some(function (r) { return r.id === d.id; }); })); }
  function planOfDerived(c) {
    return { task: c.tasks.map(function (t) { return t.title; }).join(' · '), phase: 'running', tracks: c.workers.map(function (nm) {
      var ui = TRACK_UI[c.trackMap[nm].state] || 'queued'; return { id: nm, title: c.trackMap[nm].title, state: ui === 'done' ? 'done' : ui === 'run' ? 'dispatched' : ui === 'failed' ? 'failed' : 'queued', worker: nm, agent: c.kinds[nm] };
    }) };
  }
  function loadDerived() {
    return TW.api('GET', '/api/features/opshub/state').then(function (r) { derived = deriveCrews((r && r.fleet) || {}); derived.forEach(function (c) { tracks[c.id] = planOfDerived(c); }); mergeCrews(); }).catch(function () { derived = []; mergeCrews(); });
  }
  // With pets turned off the app shows initials in the avatar; the Crew rows must do the same (they were blank squares).
  function ini(name) { var p = String(name).split(/[-_\s.\/]+/).filter(Boolean); return ((p[0] || '?')[0] + (p[1] ? p[1][0] : (p[0] || '').slice(1, 2))).toUpperCase(); }
  function kindLabel(c, n) { var k = (c.kinds || {})[n]; return k === 'claude' ? 'Claude' : k === 'codex' ? 'Codex' : 'track'; }
  function post(path, body) { return TW.api('POST', '/api/features/crewpanes' + path, body); }
  function get(path) { return TW.api('GET', '/api/features/crewpanes' + path); }
  function petSvg(i, st) { return PET ? PET.pet(KINDS[i % KINDS.length], st === 'run' ? 'run' : st === 'wait' ? 'wait' : 'idle') : ''; }
  function ago(sec) { sec = Math.max(0, Math.round(sec)); return sec < 60 ? sec + i18n('cp.ago_s') : sec < 3600 ? Math.floor(sec / 60) + i18n('cp.ago_m') : Math.floor(sec / 3600) + i18n('cp.ago_h') + Math.floor(sec % 3600 / 60) + i18n('cp.ago_m'); }
  // Workers that belong to the current plan. Sessions left from an earlier plan (demo crews keep theirs) are not part of it.
  function liveWorkers(c) {
    if (c.derived) return c.workers; var t = ((tracks[c.id] || {}).tracks) || []; if (!t.length) return c.workers;
    var ids = t.map(function (x) { return c.name + '-' + x.id; }); return c.workers.filter(function (n) { return ids.indexOf(n) >= 0; });
  }
  // A track counts as done when the plan says so or when its worker's own screen says so.
  function trackDone(c, x) { return x.state === 'done' || (!c.derived && paneState(c, c.name + '-' + x.id).k === 'done'); }
  function members(c) { return [c.name].concat(liveWorkers(c).slice().sort()); } // W1, W2, W3: the plan's order, not the order they happened to start
  function server(c) { return (app().servers() || []).filter(function (v) { return v.id === c.server; })[0]; }
  function sess(c, name) { var v = server(c); return v && v.sessions ? v.sessions.filter(function (s) { return s.name === name; })[0] : null; }
  function tail(s) { return (s && s.lines || []).filter(function (l) { return l.trim(); }).slice(-8).join('\n'); }
  function trackOf(c, worker) { var t = (tracks[c.id] || {}).tracks || []; return t.filter(function (x) { return x.worker === worker.replace(c.name + '-', '') && x.state === 'dispatched'; })[0]; }

  function derivedState(c, name) {
    var t = c.trackMap[name]; if (!t) return { k: 'gone', src: i18n('cp.src_track_gone') };
    var ui = TRACK_UI[t.state] || 'queued'; return { k: ui, src: i18n('cp.src_crew') + t.state, track: ui === 'run' ? { id: t.track, title: t.title } : null };
  }
  // The honest state of one pane: what its own screen and activity say, never inferred from files that may be stale.
  function paneState(c, name) {
    var v = server(c), s = sess(c, name), isO = name === c.name;
    if (!v || !v.on) return { k: 'off', src: i18n('cp.src_host_off') };
    if (!isO && c.derived) return derivedState(c, name);
    if (!s) return { k: 'gone', src: i18n('cp.src_session_gone') };
    var age = s.activityAge == null ? null : s.activityAge, text = tail(s), out = age == null ? i18n('cp.src_unknown') : 'output ' + ago(age);
    if (isO && (s.asking || /Trả lời OK|\(chờ bạn\)/.test(text.split('\n').slice(-3).join('\n')))) return { k: 'wait', src: i18n('cp.src_pane') + out, age: age };
    var tr = !isO && trackOf(c, name);
    if (tr) return age != null && age > QUIET ? { k: 'quiet', src: i18n('cp.src_pane') + out + i18n('cp.src_job') + tr.id, age: age, track: tr } : { k: 'run', src: i18n('cp.src_pane') + out + ' · ' + tr.id, age: age, track: tr };
    if (isO && age != null && age <= 20) return { k: 'run', src: i18n('cp.src_pane') + out, age: age };
    // A worker whose own screen ends with its DONE line is finished, whatever the plan file says about a later plan.
    if (!isO && /STATUS: DONE/.test(text.split('\n').slice(-4).join('\n'))) return { k: 'done', src: i18n('cp.src_pane') + out, age: age };
    return { k: isO && /✔ Tất cả track xong|Báo cáo/.test(text) ? 'done' : 'idle', src: i18n('cp.src_pane') + out, age: age };
  }
  function summary(c) {
    var st = members(c).map(function (n) { return paneState(c, n); }), t = (tracks[c.id] || {});
    if (st.some(function (x) { return x.k === 'off'; })) return { k: 'unknown', label: i18n('cp.state_off'), cls: 'unknown', sub: i18n('cp.sub_off'), st: st };
    if (st.some(function (x) { return x.k === 'gone'; })) return { k: 'check', label: i18n('cp.sum_check'), cls: 'check', sub: i18n('cp.sub_gone'), st: st };
    if (st.some(function (x) { return x.k === 'failed'; })) return { k: 'check', label: i18n('cp.sum_check'), cls: 'check', sub: i18n('cp.sub_failed'), st: st };
    if (st.some(function (x) { return x.k === 'quiet'; })) return { k: 'check', label: i18n('cp.sum_check'), cls: 'check', sub: i18n('cp.sub_quiet'), st: st };
    if (st[0].k === 'wait') return { k: 'wait', label: i18n('cp.state_wait'), cls: 'wait', sub: i18n('cp.sub_wait'), st: st };
    if (st.some(function (x) { return x.k === 'run'; })) return { k: 'run', label: i18n('cp.state_run'), cls: 'run', sub: i18n('cp.sub_run'), st: st };
    if (st[0].k === 'done' || t.phase === 'done') return { k: 'done', label: i18n('cp.sum_done'), cls: 'run', sub: i18n('cp.sub_done'), st: st };
    return { k: 'idle', label: i18n('cp.sum_idle'), cls: '', sub: i18n('cp.sub_idle'), st: st };
  }
  function crewOf(id, name) { for (var i = 0; i < crews.length; i++) { var c = crews[i]; if (c.server === id && members(c).indexOf(name) >= 0) return c; } return null; }
  TW.crewOf = crewOf; TW.deriveCrews = deriveCrews;
  // Opening a Crew's lead (tab, link) shows the whole Crew, not the lead alone.
  // Picking a worker (chip, sidebar row, dot, detail row) lights up its pane: a bright border that stays until another is picked.
  function paneNodeOf(c, name) {
    if (c.derived) return document.querySelector('#split .cp-wlog[data-w="' + (window.CSS && CSS.escape ? CSS.escape(name) : name) + '"]');
    var i = paneNames(c).indexOf(name); return i < 0 ? null : document.querySelectorAll('#split .pane')[i] || null;
  }
  var pickTimer = null, PICK_MS = 5000;
  // The bright border is a pointer, not a state: it fades after a few seconds, a second click on the same chip clears it at once,
  // and so does a click in the orchestrator's pane.
  function clearPick() {
    clearTimeout(pickTimer); document.querySelectorAll('#split .cx-pick').forEach(function (n) { n.classList.remove('cx-pick', 'cx-pulse'); });
    var c = cur && currentCrew(); if (c) cur.focus = c.name; if (cur) drawBar();
  }
  function highlight(c, name) {
    clearTimeout(pickTimer); document.querySelectorAll('#split .cx-pick').forEach(function (n) { n.classList.remove('cx-pick'); });
    var node = paneNodeOf(c, name); if (!node) return false;
    node.classList.add('cx-pick'); node.classList.remove('cx-pulse'); void node.offsetWidth; node.classList.add('cx-pulse');
    if (cur) cur.focus = name;
    pickTimer = setTimeout(clearPick, PICK_MS);
    drawBar(); return true;
  }
  function selectWorker(c, name) {
    if (liveWorkers(c).indexOf(name) < 0) { app().say(i18n('cp.no_worker'), false, 2500); return; }
    var inView = cur && cur.id === c.id && !hidden[c.id] && layoutMode !== '1' && (cur.shown || []).indexOf(name) >= 0;
    if (inView) { highlight(c, name); return; }
    openCrew(c, name);
  }
  TW.openCrewFor = function (id, name) { var c = crewOf(id, name); if (!c || name !== c.name) return false; openCrew(c, name); return true; }; // always re-lay the whole Crew: falling through put the lead into whichever pane was focused (a worker's)
  // "2 thợ · 1 cần bạn": the note the ordinary sidebar row of a Crew's leader carries.
  TW.crewNote = function (id, name) {
    var c = crewOf(id, name); if (!c || name !== c.name) return ''; var w = liveWorkers(c); if (!w.length) return '';
    var ks = w.map(function (n) { return paneState(c, n).k; }), need = ks.filter(function (k) { return k === 'wait' || k === 'quiet' || k === 'gone' || k === 'failed'; }).length, run = ks.filter(function (k) { return k === 'run'; }).length;
    return w.length + i18n('cp.n_workers') + (need ? ' · ' + need + i18n('cp.n_need') : run ? ' · ' + run + i18n('cp.n_running') : '');
  };
  TW.crewWorker = function (id, name) { var c = crewOf(id, name); return !!c && name !== c.name; };
  // More workers than panes: panes go to the ones that need a look (waiting, quiet, running); the rest stay as chips.
  var MAXPANES = 6, TIDY_MS = 8000, pins = {}, showAll = {}, doneSeen = {}, hidden = loadHidden(), LEADKEY = 'tw-crew-lead', HIDEKEY = 'tw-crew-hide';
  function loadHidden() { try { return JSON.parse(localStorage.getItem('tw-crew-hide') || '{}') || {}; } catch (e) { return {}; } }
  function setHidden(id, on) { if (on) hidden[id] = true; else delete hidden[id]; try { localStorage.setItem(HIDEKEY, JSON.stringify(hidden)); } catch (e) { /* optional */ } }
  function leadShare() { try { var v = parseFloat(localStorage.getItem(LEADKEY)); return v >= 0.25 && v <= 0.85 ? v : 0; } catch (e) { return 0; } }
  function prio(c, n) { var k = paneState(c, n).k; return k === 'wait' || k === 'quiet' || k === 'gone' || k === 'failed' ? 3 : k === 'run' ? 2 : k === 'idle' || k === 'queued' ? 1 : 0; }
  // Tidy: a worker that has finished leaves the grid a few seconds later (its chip stays); waiting, failed and running ones stay,
  // and so does any worker the person picked. When everything is done the grid folds away and the orchestrator's chat gets the space.
  function visibleBase(c) {
    var all = liveWorkers(c).slice().sort(); if (showAll[c.id]) return all;
    var now = Date.now(), pin = pins[c.id] || [];
    return all.filter(function (n) {
      var key = c.id + '|' + n, k = paneState(c, n).k;
      if (k !== 'done') { delete doneSeen[key]; return true; }
      if (!doneSeen[key]) doneSeen[key] = now;
      return pin.indexOf(n) >= 0 || now - doneSeen[key] < TIDY_MS;
    });
  }
  function allDone(c) { var w = liveWorkers(c); return w.length > 0 && w.every(function (n) { return paneState(c, n).k === 'done'; }); }
  function pickShown(c) {
    var w = visibleBase(c);
    if (w.length <= MAXPANES) return w;
    var pin = (pins[c.id] || []).filter(function (n) { return w.indexOf(n) >= 0; });
    var rest = w.filter(function (n) { return pin.indexOf(n) < 0; }).sort(function (a, b) { return prio(c, b) - prio(c, a) || (a < b ? -1 : 1); });
    return pin.concat(rest).slice(0, MAXPANES).sort();
  }
  function pin(c, name) { if (name === c.name) return; pins[c.id] = [name].concat((pins[c.id] || []).filter(function (n) { return n !== name; })).slice(0, MAXPANES - 1); }

  // ----- sidebar + overview -----
  function pill(cls, text) { return el('span', 'pill ' + cls, text); }
  // "Tất cả": one compact card per Crew (workers are not cards): status, counts, the orchestrator's last lines, and a dot per worker.
  TW.gridCrews = function (g, v) {
    crews.filter(function (c) { return c.server === v.id; }).forEach(function (c) {
      var sm = summary(c), ws = sm.st.slice(1), n = function (ks) { return ws.filter(function (x) { return ks.indexOf(x.k) >= 0; }).length; };
      var card = el('div', 'card crewcard' + (sm.k === 'wait' || sm.k === 'check' ? ' wait' : '')); card.style.setProperty('--c', COLORS[0]); card.tabIndex = 0;
      var h = el('div', 'card-head'), pet = el('span', 'cp-pet'); pet.innerHTML = petSvg(0, sm.k);
      var t = el('div', 't'), parts = [];
      if (liveWorkers(c).length) { parts.push(liveWorkers(c).length + i18n('cp.n_workers')); if (n(['done'])) parts.push(n(['done']) + i18n('cp.n_done')); if (n(['run'])) parts.push(n(['run']) + i18n('cp.n_running')); } else parts.push(i18n('cp.no_workers'));
      t.append(el('span', 'n', c.name), el('span', 's cp-sub', parts.join(' · '))); h.append(pet, t, pill(sm.cls, sm.label));
      var need = n(['wait', 'quiet', 'gone', 'failed']);
      var o = sess(c, c.name), mini = el('div', 'mini'); mini.style.cssText = 'height:auto;padding:6px 12px;margin:0 12px 8px;border-radius:10px';
      (o && o.lines || []).filter(function (l) { return l.trim(); }).slice(-2).forEach(function (l) { mini.append(el('div', '', l)); });
      card.append(h, mini);
      if (liveWorkers(c).length) {
        var dots = el('div', 'cp-dots');
        liveWorkers(c).slice().sort().forEach(function (name) {
          var st = paneState(c, name), d = el('button', 'cp-dotb ' + (st.k === 'wait' || st.k === 'quiet' || st.k === 'gone' || st.k === 'failed' ? 'need' : st.k === 'run' ? 'run' : st.k === 'done' ? 'done' : ''), name.replace(c.name + '-', ''));
          d.type = 'button'; d.title = name.replace(c.name + '-', '') + ' · ' + LABEL[st.k] + (st.track ? ' · ' + st.track.title : '');
          d.onclick = function (e) { e.stopPropagation(); openCrew(c, name); }; dots.append(d);
        });
        card.append(dots);
      }
      var f = el('div', 'card-foot'); var ft = el('span', 'foot-t', need ? need + i18n('cp.need_look') : sm.label); ft.title = sm.sub; f.append(ft, el('span', 'foot-p', c.dir)); card.append(f);
      card.onclick = function () { openCrew(c, c.name); }; g.append(card);
    });
  };

  // ----- opening a crew in the terminal view -----
  function openCrew(c, focusName) {
    var compact = app().compact(), items, cls, ro;
    if (focusName && focusName !== c.name) { pin(c, focusName); setHidden(c.id, false); } // asking for a worker brings the workers back
    var shown = hidden[c.id] ? [] : pickShown(c), n = shown.length;
    cur = { id: c.id, focus: focusName || c.name, shown: shown };
    if (compact || layoutMode === '1') { items = [{ id: c.server, name: cur.focus }]; cls = 'one'; }
    else if (c.derived) { items = [{ id: c.server, name: c.name }]; cls = 'crewT n' + n; }
    else { items = [c.name].concat(shown).map(function (x) { return { id: c.server, name: x }; }); cls = 'crewT n' + n; }
    ro = items.map(function (it) { return it.name !== c.name; }); // workers are watched, never typed into: the orchestrator is the one to ask
    removeLogs(); cur.cls = cls; app().showPanes(items, cls, ro); applyLead(n); if (c.derived && cls !== 'one') shown.forEach(function (nm) { document.getElementById('split').append(wlogPane(c, nm)); }); refreshLogs(); requestAnimationFrame(function () { placeGut(); if (focusName && focusName !== c.name) highlight(c, focusName); });
    var idx = items.map(function (x) { return x.name; }).indexOf(cur.focus); if (idx > 0) app().focusPane(idx);
  }
  // A worker pane of a real Crew shows the tail of its track log (read-only): the worker is a process, not a session.
  function removeLogs() { document.querySelectorAll('#split .cp-wlog').forEach(function (n) { n.remove(); }); }
  function wlogPane(c, nm) {
    var t = c.trackMap[nm] || {}, p = el('section', 'cp-wlog'); p.dataset.w = nm; p.dataset.crew = c.id;
    var h = el('div', 'cp-wh'); h.append(el('i', 'cp-dot'), el('b', '', nm), el('span', 'cp-kind', kindLabel(c, nm)), el('span', 'cp-wt', t.title || ''), el('span', 'cp-st', ''));
    p.append(h, el('pre', 'cp-wl', i18n('cp.log_reading')), el('div', 'cp-wf')); return p;
  }
  function stripAnsi(x) { return String(x || '').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\r/g, ''); }
  function refreshLogs() {
    document.querySelectorAll('#split .cp-wlog').forEach(function (p) {
      var c = crews.filter(function (x) { return x.id === p.dataset.crew; })[0]; if (!c) return; var nm = p.dataset.w, t = c.trackMap[nm]; if (!t) return;
      var st = paneState(c, nm), dot = p.querySelector('.cp-dot'); dot.className = 'cp-dot ' + (st.k === 'run' || st.k === 'done' ? 'ok' : st.k === 'failed' ? 'bad' : st.k === 'wait' ? 'wait' : ''); p.querySelector('.cp-st').textContent = LABEL[st.k] || '';
      p.classList.toggle('need', st.k === 'failed');
      // The end of a worker's pane says how it ended: a green line when done, red when failed, grey while it waits its turn.
      var wf = p.querySelector('.cp-wf'), mark = st.k === 'done' ? ['done', '✔ ' + LABEL.done] : st.k === 'failed' ? ['failed', '✖ ' + LABEL.failed] : st.k === 'queued' ? ['queued', '… ' + LABEL.queued] : null;
      wf.className = 'cp-wf' + (mark ? ' ' + mark[0] : ''); wf.textContent = mark ? mark[1] : '';
      var q = 'server=' + encodeURIComponent(c.server) + '&session=' + encodeURIComponent(c.name) + '&task=' + encodeURIComponent(t.task) + '&track=' + encodeURIComponent(t.track);
      TW.api('GET', '/api/features/crew/log?' + q).then(function (r) {
        var pre = p.querySelector('.cp-wl'), near = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40, lines = stripAnsi(r.text).split('\n').slice(-200).join('\n');
        if (pre.textContent !== lines) { pre.textContent = lines || i18n('cp.log_none'); if (near) pre.scrollTop = pre.scrollHeight; }
      }).catch(function () { var pre = p.querySelector('.cp-wl'); if (!pre.dataset.err) { pre.dataset.err = '1'; pre.textContent = i18n('cp.log_error'); } });
    });
  }
  // The orchestrator's share of the height is the person's to set: drag the thin bar between it and the workers (double-click resets).
  function applyLead(n) {
    var sp = document.getElementById('split'), r = leadShare();
    if (!r || !n) sp.style.removeProperty('--lead'); else sp.style.setProperty('--lead', (r / (1 - r) * (n > 3 ? 2 : 1)).toFixed(3) + 'fr');
  }
  function gut() {
    var sp = document.getElementById('split'), g = document.getElementById('cp-gut');
    if (!cur || !/crewT/.test(sp.className) || /\bn0\b/.test(sp.className) || /\bone\b/.test(sp.className)) { if (g) g.remove(); return null; }
    if (!g) {
      g = el('div'); g.id = 'cp-gut'; g.title = i18n('cp.gut_tip'); g.setAttribute('role', 'separator');
      g.ondblclick = function () { try { localStorage.removeItem(LEADKEY); } catch (e) { /* optional */ } applyLead(cur && cur.shown.length); requestAnimationFrame(placeGut); };
      g.onpointerdown = function (e) {
        e.preventDefault(); g.setPointerCapture(e.pointerId); g.classList.add('drag');
        var r0 = sp.getBoundingClientRect();
        function mv(ev) { var r = Math.min(0.85, Math.max(0.25, (ev.clientY - r0.top) / r0.height)); try { localStorage.setItem(LEADKEY, String(r)); } catch (x) { /* optional */ } applyLead(cur && cur.shown.length); placeGut(); }
        g.addEventListener('pointermove', mv); g.addEventListener('pointerup', function () { g.classList.remove('drag'); g.removeEventListener('pointermove', mv); }, { once: true });
      };
      sp.append(g);
    }
    return g;
  }
  function placeGut() {
    var g = gut(); if (!g) return; var lead = document.querySelector('#split .pane.crew-lead') || document.querySelector('#split .pane');
    if (lead) g.style.top = (lead.offsetTop + lead.offsetHeight - 3) + 'px';
  }
  document.getElementById('split').addEventListener('mousedown', function (e) { if (e.target.closest && e.target.closest('.crew-lead') && document.querySelector('#split .cx-pick')) clearPick(); });
  TW.on('open-crew', function (c) { openCrew(c, c.name); });
  TW.on('layout', function (cls) {
    if (cur && cur.cls !== cls) cur = null;
    document.getElementById('app').classList.toggle('crew-mode', !!cur);
    if (!cur) { document.getElementById('app').classList.remove('cp-detail'); removeLogs(); }
    drawBar();
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
    var host = barNode(), c = currentCrew(); host.hidden = !c; if (!c) { host.textContent = ''; delete host.dataset.html; return; } // forget the markup too, or the same bar is never drawn again after leaving the Crew
    var b = el('div'); // built aside, swapped in only when the markup changed (keeps clicks and focus stable)
    var sm = summary(c), nm = el('div', 'cp-nm'), pt = el('span', 'pt'); pt.innerHTML = petSvg(0, sm.k); nm.append(pt, el('b', '', c.name), pill(sm.cls, sm.label));
    var steps = el('div', 'cp-steps'), t = ((tracks[c.id] || {}).tracks) || [];
    if (!t.length) steps.append(el('span', 'cp-src', liveWorkers(c).length ? '' : i18n('cp.bar_hint')));
    t.forEach(function (x) {
      var wname = c.derived ? x.id : c.name + '-' + x.id;
      var chip = el('button', 'cp-step ' + (trackDone(c, x) ? 'done' : x.state) + (cur.focus === wname ? ' sel' : '')); chip.type = 'button';
      chip.title = x.id + ' · ' + x.title + ' · ' + (trackDone(c, x) ? i18n('cp.done_l') : x.state === 'dispatched' ? i18n('cp.chip_running') + x.agent + ')' : i18n('cp.chip_queued'));
      chip.append(el('i'), document.createTextNode(x.id)); chip.onclick = function () { if (cur && cur.focus === wname && document.querySelector('#split .cx-pick')) clearPick(); else selectWorker(c, wname); }; steps.append(chip);
    });
    b.textContent = ''; b.append(nm, steps);
    if (liveWorkers(c).length > MAXPANES) { var hid = el('span', 'cp-hid', cur.shown.length + '/' + liveWorkers(c).length); hid.title = i18n('cp.showing') + cur.shown.length + i18n('cp.panes_tip'); b.append(hid); }
    // The action used most is one click away; only rare ones (stop, layout) sit in the ⋯ menu.
    var nd = el('button', 'btn icon-btn'); nd.innerHTML = '<svg class="i" viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 21h4"/></svg>'; nd.type = 'button'; nd.title = i18n('cp.nudge'); nd.setAttribute('aria-label', i18n('cp.nudge')); nd.onclick = function () { nudge(c); };
    var tg = el('button', 'btn icon-btn'); tg.type = 'button';
    var manual = !!hidden[c.id], folded = !manual && !(cur.shown || []).length && liveWorkers(c).length > 0 && !showAll[c.id], off = manual || folded;
    tg.innerHTML = '<svg class="i" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 13h18"' + (off ? ' stroke-dasharray="2 2"' : '') + '/></svg>';
    tg.title = manual ? i18n('cp.tg_show') : folded ? i18n('cp.tg_show_done') : showAll[c.id] ? i18n('cp.tg_only_needed') : i18n('cp.tg_hide'); tg.setAttribute('aria-label', tg.title); tg.setAttribute('aria-pressed', String(off));
    tg.onclick = function () { if (manual) setHidden(c.id, false); else if (folded) showAll[c.id] = true; else if (showAll[c.id]) delete showAll[c.id]; else setHidden(c.id, true); openCrew(c, c.name); };
    var det = el('button', 'btn icon-btn', 'ⓘ'); det.type = 'button'; det.title = i18n('cp.detail'); det.setAttribute('aria-label', i18n('cp.detail')); det.onclick = function () { document.getElementById('app').classList.toggle('cp-detail'); };
    var more = el('button', 'btn icon-btn', '⋯'); more.type = 'button'; more.title = i18n('cp.more'); more.setAttribute('aria-label', i18n('cp.more')); more.onclick = function () { menuOpen = !menuOpen; drawBar(); };
    b.append(nd, tg, det, more);
    if (menuOpen) {
      var m = el('div', 'cp-menu'); m.setAttribute('role', 'menu');
      var items = c.derived ? [] : [[layoutMode === '1' ? i18n('cp.view_crew') : 'Xem 1 pane', function () { layoutMode = layoutMode === '1' ? 'T' : '1'; openCrew(c, cur.focus); }]];
      if (demoMode) items.push(['Giả lập thợ treo (demo)', function () { hang(c); }]);
      if (!c.derived) items.push([i18n('cp.stop_crew'), function () { stopCrew(c); }, true]);
      if (!items.length) menuOpen = false;
      items.forEach(function (it) { var i2 = el('button', it[2] ? 'dg' : '', it[0]); i2.type = 'button'; i2.onclick = function () { menuOpen = false; drawBar(); it[1](); }; m.append(i2); });
      b.append(m);
    }
    if (b.innerHTML !== host.dataset.html) { host.dataset.html = b.innerHTML; host.replaceChildren.apply(host, Array.prototype.slice.call(b.childNodes)); }
    var sl = document.getElementById('cp-slots');
    if (app().compact()) { if (!sl) { sl = el('div', 'cp-slots'); sl.id = 'cp-slots'; host.after(sl); } sl.textContent = ''; members(c).forEach(function (n, i) { var x = el('button', 'tab', i ? n.replace(c.name + '-', '') : i18n('cp.orch')); x.type = 'button'; x.onclick = function () { openCrew(c, n); }; sl.append(x); }); }
    else if (sl) sl.remove();
  }
  // Names shown in the panes, in pane order (same rule as openCrew).
  function paneNames(c) { if (app().compact() || layoutMode === '1') return [cur.focus]; return [c.name].concat(cur.shown || liveWorkers(c).slice().sort()); }
  // ----- actions -----
  function refreshAll() { return get('/list').then(function (r) { registry = r.crews || []; mergeCrews(); if (r.demo && !demoMode) { demoMode = true; addButton(); } return loadDerived().then(function () { return app().refresh(); }); }); }
  function nudge(c) { if (c.derived) { TW.api('POST', '/api/servers/' + c.server + '/sessions/' + encodeURIComponent(c.name) + '/keys', { text: i18n('cp.nudge_text'), enter: true }).catch(function (e) { app().say(e.message, false, 4000); }); return; } post('/send', { id: c.id, session: c.name, text: i18n('cp.nudge_text') }).catch(function (e) { app().say(e.message, false, 4000); }); }
  function hang(c) { var w = c.workers.filter(function (n) { return paneState(c, n).k === 'run'; })[0]; if (!w) { app().say('Chưa có thợ nào đang chạy để giả lập treo.', false, 3000); return; } post('/send', { id: c.id, session: w, text: '__hang__' }); app().say(w + ' sẽ im lặng (đang chạy nhưng không xuất gì) — xem “Cần kiểm tra” sau ' + QUIET + ' giây.', true, 5000); }
  function stopCrew(c) {
    var d = el('dialog'), f = el('form', 'f'); f.method = 'dialog'; d.append(f);
    f.append(el('h2', '', i18n('cp.stop_title')), el('p', '', i18n('cp.stop_a') + c.workers.length + i18n('cp.stop_b')));
    var act = el('div', 'dlg-actions'), no = el('button', 'btn', i18n('cp.cancel')), go = el('button', 'btn danger-solid', i18n('cp.stop')); no.type = go.type = 'button'; act.append(no, go); f.append(act);
    no.onclick = function () { d.close(); }; d.addEventListener('close', function () { d.remove(); });
    go.onclick = function () { go.disabled = true; post('/stop', { id: c.id }).then(function () { d.close(); cur = null; return refreshAll(); }).then(function () { app().setView('over'); }).catch(function (e) { go.disabled = false; app().say(e.message, false, 4000); }); };
    document.body.append(d); d.showModal();
  }

  // ----- detail box: replaces the old "Crew (leader)" box -----
  function drawBox(target, c) {
    var box = el('div', 'cp-box'), sm = summary(c), t = (tracks[c.id] || {}).tracks || [], done = t.filter(function (x) { return trackDone(c, x); }).length;
    var h = el('div', 'cp-head'); h.append(el('h3', '', 'Crew'), pill(sm.cls, sm.label)); box.append(h);
    if (sm.k === 'wait') box.append(el('div', 'cp-alert', i18n('cp.alert_wait')));
    if (sm.k === 'check') { var q = sm.st.filter(function (x) { return x.k === 'quiet'; })[0]; box.append(el('div', 'cp-alert', q ? i18n('cp.alert_quiet_a') + ago(q.age) + i18n('cp.alert_quiet_b') : sm.sub)); }
    if (sm.k === 'unknown') box.append(el('div', 'cp-alert err', i18n('cp.alert_off')));
    if (t.length) { var bar = el('div', 'crew-bar'), i = el('i'); i.style.width = Math.round(100 * done / t.length) + '%'; bar.append(i); box.append(el('div', 'cp-prog', done + '/' + t.length + i18n('cp.n_done_tracks')), bar); }
    var list = el('div', 'cp-list'); members(c).forEach(function (n, k) {
      var st = sm.st[k], row = el('button', 'cp-row'); row.type = 'button'; row.title = st.src;
      var dot = el('i', 'cp-dot ' + (st.k === 'run' || st.k === 'done' ? 'ok' : st.k === 'wait' || st.k === 'quiet' ? 'wait' : st.k === 'gone' || st.k === 'off' || st.k === 'failed' ? 'bad' : ''));
      var kind = k ? kindLabel(c, n) : 'Claude';
      row.append(dot, el('b', '', k ? n.replace(c.name + '-', '') : i18n('cp.orch')), el('span', 'cp-kind', kind), el('span', 'cp-st', LABEL[st.k] + (st.track ? ' ' + st.track.id : '')));
      row.onclick = function () { if (k) selectWorker(c, n); else openCrew(c, n); }; list.append(row);
    }); box.append(list);
    if (box.innerHTML !== target.dataset.html) { target.dataset.html = box.innerHTML; target.replaceChildren.apply(target, Array.prototype.slice.call(box.childNodes)); }
  }
  TW.addDetailSection(function (x) {
    var c = crewOf(x.v.id, x.s.name); if (!c) return null;
    var box = el('section', 'cp-box'); boxes.push({ box: box, id: c.id }); drawBox(box, c); return box;
  });

  // ----- new crew dialog -----
  function newDialog() {
    var vs = (app().servers() || []).filter(function (v) { return v.on && v.hasTmux !== false; });
    if (!vs.length) { app().say(i18n('cp.no_server'), false, 3000); return; }
    var d = el('dialog'); d.id = 'dlg-crew'; var f = el('form', 'f'); f.noValidate = true; d.append(f);
    f.innerHTML = '<h2>Crew mới</h2><label>Máy chủ<select id="cw-srv"></select></label><label>Tên Crew<input id="cw-name" maxlength="24" value="UIUX" autocomplete="off"></label>' +
      '<label>Thư mục<input id="cw-dir" autocomplete="off" placeholder="Để trống dùng thư mục mặc định"></label><div class="cp-src">Chỉ tạo phiên điều phối (Claude) ở trên. Thợ (Codex hoặc Claude, tối đa 4) do điều phối tự tạo khi giao việc và hiện ở hàng dưới.</div>' +
      '<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="cw-real" style="width:auto"> Dùng Claude/Codex thật (tốn token). Bỏ chọn = agent giả lập để thử giao diện.</label><div class="err" id="cw-err"></div>' +
      '<div class="dlg-actions"><button type="button" class="btn" id="cw-cancel">Hủy</button><button type="submit" class="btn primary" id="cw-go">Tạo Crew</button></div>';
    var srv = f.querySelector('#cw-srv'); vs.forEach(function (v) { var o = el('option', '', v.name); o.value = v.id; srv.append(o); });
    f.querySelector('#cw-cancel').onclick = function () { d.close(); }; d.addEventListener('close', function () { d.remove(); });
    f.onsubmit = function (e) {
      e.preventDefault(); var go = f.querySelector('#cw-go'), err = f.querySelector('#cw-err'); go.disabled = true; err.textContent = '';
      post('/create', { server: srv.value, name: f.querySelector('#cw-name').value.trim(), dir: f.querySelector('#cw-dir').value.trim(), agent: f.querySelector('#cw-real').checked ? 'real' : 'demo' })
        .then(function (r) { d.close(); return refreshAll().then(function () { var c = crews.filter(function (x) { return x.id === r.crew.id; })[0]; if (c) setTimeout(function () { openCrew(c, c.name); }, 600); }); })
        .catch(function (e2) { go.disabled = false; err.textContent = e2.message; });
    };
    document.body.append(d); d.showModal();
  }

  // ----- start -----
  // Normal use has one button, "Phiên mới": a Claude session becomes a Crew when it spawns workers. This button only exists to try
  // the prototype with fake agents (server started with TW_CREW_DEMO=1).
  function addButton() {
    var anchor = document.getElementById('btn-new'); if (!anchor || document.getElementById('btn-crew') || !demoMode) return;
    var b = el('button', 'btn'); b.id = 'btn-crew'; b.type = 'button'; b.innerHTML = '<svg class="i" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="13" width="8" height="7" rx="2"/><rect x="13" y="13" width="8" height="7" rx="2"/></svg><span class="lb">Thử Crew (demo)</span>';
    b.onclick = newDialog; anchor.parentNode.insertBefore(b, anchor);
  }
  function pollTracks() { crews.forEach(function (c) { if (c.derived) return; get('/tracks?id=' + encodeURIComponent(c.id)).then(function (r) { tracks[c.id] = r; }).catch(function () { /* keep last */ }); }); }
  TW.on('ready', function () {
    addButton();
    refreshAll().catch(function () { /* feature optional */ });
    // The orchestrator creates workers one after another: re-lay the panes once, after the list has stopped changing
    // (attaching to a session that was started a moment ago left a blank pane).
    var seenKey = null, stable = 0, pendingLayout = false, key = function (l) { return JSON.stringify(l.map(function (c) { return c.id + liveWorkers(c).join(); })); };
    setInterval(function () {
      get('/list').then(function (r) {
        registry = r.crews || []; mergeCrews(); var k = key(crews);
        if (seenKey === null) { seenKey = k; return; } // what is already on screen at load needs no second layout (it blanked the panes for a while)
        if (k !== seenKey) { seenKey = k; stable = 0; pendingLayout = true; app().refresh(); return; }
        if (pendingLayout && ++stable >= 2) { pendingLayout = false; app().refresh().then(function () { if (cur && currentCrew()) openCrew(currentCrew(), cur.focus); }); }
      }).catch(function () {});
    }, 2000);
    setInterval(pollTracks, 2000);
    setInterval(loadDerived, 5000); setInterval(function () { if (!document.hidden) refreshLogs(); }, 2500);
    setInterval(function () {
      boxes = boxes.filter(function (b) { return b.box.isConnected; });
      boxes.forEach(function (b) { var c = crews.filter(function (x) { return x.id === b.id; })[0]; if (c) drawBox(b.box, c); });
      if (cur) {
        var c2 = currentCrew();
        if (c2 && !allDone(c2)) delete showAll[c2.id];
        if (c2 && layoutMode !== '1' && !hidden[c2.id] && cur.cls !== 'one' && pickShown(c2).join() !== (cur.shown || []).join()) openCrew(c2, c2.name);
        else { drawBar(); placeGut(); }
      }
    }, 1000);
  });
})();
