'use strict';
// Crew panes (prototype): an orchestrator session plus N worker sessions shown together. Every state shown here is measured
// from the live panes (screen text, output age) or from the plan file the orchestrator writes, and says where it came from.
(function () {
  var TW = window.TW; if (!TW) return;
  var el = TW.el, PET = window.PetArt;
  var demoMode = false, crews = [], registry = [], derived = [], tracks = {}, cur = null, menuOpen = '', layoutMode = 'T', boxes = [], QUIET = 45;
  var KINDS = ['owl', 'cat', 'fox', 'bunny', 'frog'], COLORS = ['#7c6cf0', '#0fa58a', '#2f80ed', '#e08a00', '#d85aa0'];
  var LABEL = { run: i18n('cp.state_run'), wait: i18n('cp.state_wait'), idle: i18n('cp.state_idle'), done: i18n('cp.state_done'), quiet: i18n('cp.state_quiet'), queued: i18n('cp.state_queued'), failed: i18n('cp.state_failed'), gone: i18n('cp.state_gone'), off: i18n('cp.state_off') };
  function app() { return TW.app(); }
  // A real Crew is not registered here: it is the leader session plus the tracks of its task in _crew/tasks, exactly what the
  // Vận hành screen reads (opshub fleet: tasks[].leader, tasks[].tracks, sessions[].workers). A worker is a track, not a session.
  var TRACK_UI = { running: 'run', dispatched: 'run', fix: 'run', review: 'run', queued: 'queued', pending: 'queued', blocked: 'queued', failed: 'failed', done: 'done', merged: 'done' };
  function deriveCrews(fleet) {
    var by = {}, kinds = {}, kindOf = function (x) { return /codex/i.test(x || '') ? 'codex' : /claude/i.test(x || '') ? 'claude' : ''; };
    (fleet.sessions || []).forEach(function (s) { (s.workers || []).forEach(function (w) { if (w.task && w.track) kinds[s.machine + '|' + w.task + '|' + w.track] = { kind: w.kind || '', model: w.model || '', running: true }; }); });
    // A task whose workers have all finished stays a Crew too (opshub 'wrapped'): the Crew does not vanish with the work.
    var seen = {};
    (fleet.tasks || []).concat(fleet.wrapped || []).filter(function (t) { var k = t.machine + '|' + t.root + '|' + t.id; return seen[k] ? false : (seen[k] = true); }).forEach(function (t) {
      if (!t.leader || !(t.tracks || []).length) return;
      var id = t.machine + '/' + t.leader, c = by[id] || (by[id] = { id: id, server: t.machine, name: t.leader, dir: t.root, derived: true, workers: [], kinds: {}, models: {}, kindSrc: {}, trackMap: {}, tasks: [] });
      c.tasks.push({ id: t.id, title: t.title });
      t.tracks.forEach(function (k) {
        var nm = c.trackMap[k.id] ? t.id + '/' + k.id : k.id;
        c.workers.push(nm);
        // What is really running beats what was written down: the process, then the last round's record, then the manifest's declaration.
        var live = kinds[t.machine + '|' + t.id + '|' + k.id] || {}, fromRun = kindOf(live.kind), fromRec = kindOf(k.executor);
        c.kinds[nm] = fromRun || fromRec || ''; c.models[nm] = fromRun ? (live.model || (fromRec === fromRun ? k.model : '') || '') : (k.model || '');
        c.kindSrc[nm] = fromRun ? 'process' : fromRec ? (k.executorSrc === 'manifest' ? 'manifest' : 'round') : ''; // The files are scanned every 30-120 s but the process table every few seconds: a dispatch that is running right now is "running",
        // whatever the manifest still says (it can lag behind a leader that has just dispatched).
        var ranNow = !!(live.kind || live.model || live.running) && k.state !== 'done' && k.state !== 'merged';
        c.trackMap[nm] = { task: t.id, track: k.id, state: ranNow ? 'running' : k.state, title: t.title, fromProcess: ranNow };
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
  // A Crew is only known once the first scan of _crew has finished (up to a couple of minutes after the app starts). A leader that was
  // opened before that stays in the plain single-pane view: switch it to the Crew layout, once, as soon as the Crew is known.
  var adopted = {};
  function adoptOpenLeader() {
    var a = app(); if (!a.current || !a.view || a.view() !== 'focus') return;
    var x = a.current(); if (!x) return; var xid = x.v ? x.v.id : x.id, xname = x.s ? x.s.name : x.name; // the app's current item is { v: server, s: session }
    var c = crewOf(xid, xname); if (!c || xname !== c.name || adopted[c.id]) return;
    adopted[c.id] = true;
    if (/crew[TL]/.test(document.getElementById('split').className)) return;
    if (!liveWorkers(c).length) { delete adopted[c.id]; return; }
    openCrew(c, c.name);
  }
  function loadDerived() {
    return TW.api('GET', '/api/features/opshub/state').then(function (r) { derived = deriveCrews((r && r.fleet) || {}); derived.forEach(function (c) { tracks[c.id] = planOfDerived(c); }); mergeCrews(); adoptOpenLeader(); }).catch(function () { derived = []; mergeCrews(); });
  }
  // With pets turned off the app shows initials in the avatar; the Crew rows must do the same (they were blank squares).
  function ini(name) { var p = String(name).split(/[-_\s.\/]+/).filter(Boolean); return ((p[0] || '?')[0] + (p[1] ? p[1][0] : (p[0] || '').slice(1, 2))).toUpperCase(); }
  function kindLabel(c, n) { var k = (c.kinds || {})[n], m = (c.models || {})[n]; return (k === 'claude' ? 'Claude' : k === 'codex' ? 'Codex' : 'track') + (m ? ' · ' + m : ''); }
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
  TW.crewWorkerCount = function () { return crews.reduce(function (n, c) { return n + liveWorkers(c).length; }, 0); };
  TW.crewWorker = function (id, name) { var c = crewOf(id, name); return !!c && name !== c.name; };
  // More workers than panes: panes go to the ones that need a look (waiting, quiet, running); the rest stay as chips.
  var MAXPANES = 6, pins = {}, hidden = loadHidden(), LEADKEY = 'tw-crew-lead', HIDEKEY = 'tw-crew-hide';
  function loadHidden() { try { return JSON.parse(localStorage.getItem('tw-crew-hide') || '{}') || {}; } catch (e) { return {}; } }
  function setHidden(id, on) { if (on) hidden[id] = true; else delete hidden[id]; try { localStorage.setItem(HIDEKEY, JSON.stringify(hidden)); } catch (e) { /* optional */ } }
  function leadShare() { try { var v = parseFloat(localStorage.getItem(LEADKEY)); return v >= 0.25 && v <= 0.85 ? v : 0; } catch (e) { return 0; } }
  function prio(c, n) { var k = paneState(c, n).k; return k === 'wait' || k === 'quiet' || k === 'gone' || k === 'failed' ? 3 : k === 'run' ? 2 : k === 'idle' || k === 'queued' ? 1 : 0; }
  // Every worker of the Crew stays in the grid, finished or not (only the person hides them, with the button in the bar).
  // "Hiện cả thợ đã xong" (Crew options menu, remembered): on by default, so nothing changes until the person turns it off.
  function showDone() { try { return localStorage.getItem('tw-crew-done') !== '0'; } catch (e) { return true; } }
  function visibleBase(c) { return liveWorkers(c).slice().sort().filter(function (n) { return showDone() || paneState(c, n).k !== 'done'; }); }
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
  // "Tổng quan": the leader of a Crew keeps its ordinary session card; the Crew adds one row of chips (count + a chip per worker).
  TW.addCardDecorator(function (card, v, s) {
    var c = crewOf(v.id, s.name); if (!c || s.name !== c.name) return;
    var ws = liveWorkers(c); if (!ws.length) return;
    var sm = summary(c), need = sm.st.slice(1).filter(function (x) { return x.k === 'wait' || x.k === 'quiet' || x.k === 'gone' || x.k === 'failed'; }).length;
    var row = el('div', 'cp-dots'), note = TW.crewNote(v.id, s.name); row.append(el('span', 'cp-dnote' + (need ? ' need' : ''), note));
    ws.slice().sort().forEach(function (name) {
      var st = paneState(c, name), d = el('button', 'cp-dotb ' + (st.k === 'wait' || st.k === 'quiet' || st.k === 'gone' || st.k === 'failed' ? 'need' : st.k === 'run' ? 'run' : st.k === 'done' ? 'done' : ''), name.replace(c.name + '-', ''));
      d.type = 'button'; d.title = name.replace(c.name + '-', '') + ' · ' + kindLabel(c, name) + ' · ' + LABEL[st.k] + (st.track ? ' · ' + st.track.title : '');
      d.onclick = function (e) { e.stopPropagation(); openCrew(c, name); }; row.append(d);
    });
    var foot = card.querySelector('.card-foot'); if (foot) card.insertBefore(row, foot); else card.append(row);
  });

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
    var h = el('div', 'cp-wh'); h.append(el('i', 'cp-dot'), el('b', '', nm), (function () { var kb = el('span', 'cp-kind ' + ((c.kinds || {})[nm] || 'none'), kindLabel(c, nm)); var src = (c.kindSrc || {})[nm]; kb.title = src ? i18n('cp.src_kind_' + src) : i18n('cp.src_kind_none'); return kb; })(), el('span', 'cp-wt', t.title || ''), el('span', 'cp-st', ''));
    var mem = logMem[memKey(c, t)], first = el('pre', 'cp-wl', mem ? (mem.feed || stripAnsi(mem.text).split('\n').slice(-200).join('\n')) : i18n('cp.log_reading')); if (!mem) first.dataset.skel = '1';
    p.append(h, first, el('div', 'cp-wf')); return p;
  }
  function stripAnsi(x) { return String(x || '').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\r/g, ''); }
  // Last known text of every worker pane (per crew/task/track): a re-opened Crew shows it at once instead of "reading…".
  var logMem = {}, logFlight = {}, logRetry = {};
  function memKey(c, t) { return c.id + '|' + t.task + '/' + t.track; }
  function paintLog(p, c, nm, st, r) {
    var pre = p.querySelector('.cp-wl'), near = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40, lines = r.feed || stripAnsi(r.text).split('\n').slice(-200).join('\n');
    delete pre.dataset.err; delete pre.dataset.skel;
    if (pre.textContent !== lines) { pre.textContent = lines || (st.k === 'run' ? i18n('cp.log_wait_running') : i18n('cp.log_none')); if (near) pre.scrollTop = pre.scrollHeight; }
  }
  // ONE request per crew and tick (not one per worker): the server reads every track log with a single command on the host.
  function refreshLogs() {
    if (document.hidden) return;
    var byCrew = {};
    document.querySelectorAll('#split .cp-wlog').forEach(function (p) {
      var c = crews.filter(function (x) { return x.id === p.dataset.crew; })[0]; if (!c) return; var nm = p.dataset.w, t = c.trackMap[nm]; if (!t) return;
      var st = paneState(c, nm), dot = p.querySelector('.cp-dot'); dot.className = 'cp-dot ' + (st.k === 'run' || st.k === 'done' ? 'ok' : st.k === 'failed' ? 'bad' : st.k === 'wait' ? 'wait' : ''); p.querySelector('.cp-st').textContent = LABEL[st.k] || '';
      p.classList.toggle('need', st.k === 'failed');
      // The end of a worker's pane says how it ended: a green line when done, red when failed, grey while it waits its turn.
      var wf = p.querySelector('.cp-wf'), mark = st.k === 'done' ? ['done', '✔ ' + LABEL.done] : st.k === 'failed' ? ['failed', '✖ ' + LABEL.failed] : st.k === 'queued' ? ['queued', '… ' + LABEL.queued] : null;
      wf.className = 'cp-wf' + (mark ? ' ' + mark[0] : ''); wf.textContent = mark ? mark[1] : '';
      var mem = logMem[memKey(c, t)]; if (mem) paintLog(p, c, nm, st, mem);
      (byCrew[c.id] = byCrew[c.id] || { c: c, items: [] }).items.push({ p: p, nm: nm, t: t, st: st });
    });
    Object.keys(byCrew).forEach(function (id) {
      var g = byCrew[id], c = g.c; if (logFlight[id] || Date.now() < (logRetry[id] || 0)) return; // a slow host is never queued behind itself
      logFlight[id] = true;
      TW.api('POST', '/api/features/crew/logs', { server: c.server, session: c.name, tracks: g.items.map(function (i) { return { task: i.t.task, track: i.t.track }; }) }).then(function (r) {
        logFlight[id] = false; logRetry[id] = r.stale ? Date.now() + 5000 : 0;
        g.items.forEach(function (i) {
          var rec = (r.logs || {})[i.t.task + '/' + i.t.track];
          if (rec && !rec.error) { logMem[memKey(c, i.t)] = rec; if (i.p.isConnected) paintLog(i.p, c, i.nm, i.st, rec); }
          else if (i.p.isConnected && !logMem[memKey(c, i.t)]) { var pre = i.p.querySelector('.cp-wl'); if (!pre.dataset.err) { pre.dataset.err = '1'; pre.textContent = i18n('cp.log_error'); } }
        });
      }).catch(function () {
        logFlight[id] = false; logRetry[id] = Date.now() + 5000;
        g.items.forEach(function (i) { if (!logMem[memKey(c, i.t)] && i.p.isConnected) { var pre = i.p.querySelector('.cp-wl'); if (!pre.dataset.err) { pre.dataset.err = '1'; pre.textContent = i18n('cp.log_error'); } } });
      });
    });
  }
  // The orchestrator's share of the height is the person's to set: drag the thin bar between it and the workers (double-click resets).
  function applyLead(n) {
    var sp = document.getElementById('split'), r = leadShare();
    if (!r || !n) sp.style.removeProperty('--lead'); else sp.style.setProperty('--lead', (r / (1 - r) * (n > 3 ? 2 : 1)).toFixed(3) + 'fr');
    var tw = sp.parentElement; if (tw) { if (!r || !n) tw.style.removeProperty('--lead-row'); else tw.style.setProperty('--lead-row', Math.round(r * 100) + '%'); }   // the crew grid keeps the orchestrator row in this variable
  }
  function gut() {
    var sp = document.getElementById('split'), g = document.getElementById('cp-gut');
    if (!cur || !/crewT/.test(sp.className) || /\bn0\b/.test(sp.className) || /\bone\b/.test(sp.className)) { if (g) g.remove(); return null; }
    if (!g) {
      g = el('div'); g.id = 'cp-gut'; g.title = i18n('cp.gut_tip'); g.setAttribute('role', 'separator');
      g.ondblclick = function () { try { localStorage.removeItem(LEADKEY); } catch (e) { /* optional */ } applyLead(cur && cur.shown.length); requestAnimationFrame(placeGut); };
      g.onpointerdown = function (e) {
        e.preventDefault(); g.setPointerCapture(e.pointerId); g.classList.add('drag');
        var r0 = (sp.parentElement || sp).getBoundingClientRect();
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
  // ----- session bar: icon buttons with a quick tooltip (data-tip); everything else sits in two menus -----
  var ICONS = {
    users: '<circle cx="9" cy="8" r="3.2"/><path d="M3 19c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5"/><circle cx="17" cy="9" r="2.4"/><path d="M16.5 14c2.6.1 4.5 1.9 4.5 5"/>',
    sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>'
  };
  function ib(icon, tip, on, fn, tag) {
    var b = el('button', 'btn ib icon-btn' + (on ? ' tgl' : '')); b.type = 'button'; b.innerHTML = '<svg class="i" viewBox="0 0 24 24">' + ICONS[icon] + '</svg>';
    b.dataset.tip = tip; b.setAttribute('aria-label', tip); if (on != null) b.setAttribute('aria-pressed', String(!!on)); if (tag) b.dataset[tag] = '1'; b.onclick = fn; return b;
  }
  // A button with its dropdown: items are [label, run, danger] or null for a divider.
  function dropdown(id, btn, items) {
    var w = el('span', 'mw'); w.append(btn);
    if (menuOpen === id) {
      var m = el('div', 'menu'); m.setAttribute('role', 'menu');
      items.forEach(function (it) {
        if (!it) { m.append(el('div', 'menu-sep')); return; }
        var a = el('a', it[2] ? 'dg' : '', it[0]); a.tabIndex = 0; a.setAttribute('role', 'menuitem');
        var go = function () { menuOpen = ''; drawBar(); it[1](); }; a.onclick = go; a.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } }; m.append(a);
      });
      w.append(m);
    }
    return w;
  }
  function toggleMenu(id) { return function (e) { if (e) e.stopPropagation(); menuOpen = menuOpen === id ? '' : id; drawBar(); }; }
  document.addEventListener('click', function (e) { if (menuOpen && !(e.target.closest && e.target.closest('#cp-bar .mw'))) { menuOpen = ''; drawBar(); } });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && menuOpen) { menuOpen = ''; drawBar(); } });
  // The session's own actions live in other panels (detail, move, handoff); the menu reaches them in one click.
  function clickIn(q) { return function () { var t = document.querySelector(q); if (t && !t.disabled) t.click(); else app().say(i18n('cp.no_session_detail'), false, 2500); }; }
  function clearScroll(id, name) {
    return function () { if (!window.confirm(i18n('history.xoa_lich_su_cuon') + '?')) return; TW.api('POST', '/api/features/history/clear', { server: id, session: name }).then(function () { app().say(i18n('history.da_xoa_lich_su_cuon'), true, 3000); }).catch(function (e) { app().say(e.message, false, 4000); }); };
  }
  function sessionItems(id, name) {
    var items = [[i18n('app.thu_cung'), clickIn('#detail > button.btn')], [i18n('move.button'), clickIn('#detail .mv-detail button')], [i18n('history.xoa_lich_su_cuon'), clearScroll(id, name)]];
    if (document.documentElement.classList.contains('pets-off')) items = items.slice(1);   // no pets: nothing to change
    if (TW.handoffMenu) items.push([i18n('ux2.act_handoff'), function () { var a = document.querySelector('#cp-bar [data-more]'); if (a) TW.handoffMenu(a, id, name); }]);
    return items;
  }
  function avatar(name) { return window.TWUX2 ? window.TWUX2.monoNode(name) : document.createDocumentFragment(); }
  // An ordinary session gets the same slim bar as a Crew: name, state, where it runs, then ⓘ (details on demand) and ⋯ (pet, move, handoff, stop).
  function drawPlainBar(host) {
    var app0 = document.getElementById('app'), a = app(), x = a.current && a.view && a.view() === 'focus' ? a.current() : null, split = document.getElementById('split');
    var v = x && x.v ? (a.servers() || []).filter(function (q) { return q.id === x.v.id; })[0] : null, s0 = v && v.sessions ? v.sessions.filter(function (q) { return q.name === x.s.name; })[0] : null;
    if (!s0 || a.compact() || split.hidden || split.className !== 'one') { host.hidden = true; host.textContent = ''; delete host.dataset.html; app0.classList.remove('slim', 'cp-detail'); return; }
    var b = el('div'), nm = el('div', 'cp-nm');
    nm.append(avatar(s0.name), el('b', '', s0.name), pill(s0.state === 'wait' ? 'wait' : s0.state === 'run' ? 'run' : '', s0.state === 'wait' ? i18n('app.cho_ban') : s0.state === 'run' ? i18n('app.dang_chay') : i18n('app.dang_nghi')));
    var where = el('div', 'cp-task', v.name + (s0.path ? ' · ' + s0.path : '')); where.title = where.textContent;
    var det = ib('info', i18n('cp.detail_session'), app0.classList.contains('cp-detail'), function () { app0.classList.toggle('cp-detail'); drawBar(); });
    var items = sessionItems(v.id, s0.name); items.push(null, [i18n('app.roi_van_chay'), clickIn('#detail .detail-actions .btn:not(.danger)')], [i18n('app.dung'), clickIn('#detail .detail-actions .btn.danger'), true]);
    b.append(nm, where, det, dropdown('more', ib('more', i18n('cp.more'), null, toggleMenu('more'), 'more'), items));
    host.hidden = false; app0.classList.add('slim');
    if (b.innerHTML !== host.dataset.html) { host.dataset.html = b.innerHTML; host.replaceChildren.apply(host, Array.prototype.slice.call(b.childNodes)); }
  }
  function drawBar() {
    var host = barNode(), c = currentCrew(); if (!c) { drawPlainBar(host); return; } document.getElementById('app').classList.remove('slim'); host.hidden = false; // forget the markup too, or the same bar is never drawn again after leaving the Crew
    var b = el('div'); // built aside, swapped in only when the markup changed (keeps clicks and focus stable)
    var sm = summary(c), nm = el('div', 'cp-nm'), pt = el('span', 'pt'); pt.innerHTML = petSvg(0, sm.k); nm.append(pt, avatar(c.name), el('b', '', c.name), pill(sm.cls, sm.label));
    var steps = el('div', 'cp-steps'), t = ((tracks[c.id] || {}).tracks) || [];
    if (!t.length) steps.append(el('span', 'cp-src', liveWorkers(c).length ? '' : i18n('cp.bar_hint')));
    t.forEach(function (x) {
      var wname = c.derived ? x.id : c.name + '-' + x.id;
      var chip = el('button', 'cp-step ' + (trackDone(c, x) ? 'done' : x.state) + (cur.focus === wname ? ' sel' : '')); chip.type = 'button';
      chip.title = x.id + ' · ' + kindLabel(c, wname) + ' · ' + x.title + ' · ' + (trackDone(c, x) ? i18n('cp.done_l') : x.state === 'dispatched' ? i18n('cp.chip_running') + x.agent + ')' : i18n('cp.chip_queued'));
      chip.append(el('i'), document.createTextNode(x.id)); chip.onclick = function () { if (cur && cur.focus === wname && document.querySelector('#split .cx-pick')) clearPick(); else selectWorker(c, wname); }; steps.append(chip);
    });
    b.textContent = ''; b.append(nm, steps);
    if (liveWorkers(c).length > MAXPANES) { var hid = el('span', 'cp-hid', cur.shown.length + '/' + liveWorkers(c).length); hid.title = i18n('cp.showing') + cur.shown.length + i18n('cp.panes_tip'); b.append(hid); }
    // Crew buttons: 👥 shows or hides the workers (its own quick button), the sliders menu holds the rare crew options.
    var off = !!hidden[c.id], app0 = document.getElementById('app');
    var tg = ib('users', off ? i18n('cp.tg_show') : i18n('cp.tg_hide'), !off, function () { setHidden(c.id, !hidden[c.id]); openCrew(c, c.name); });
    var opts = dropdown('crew', ib('sliders', i18n('ux2.crew_opts'), menuOpen === 'crew', toggleMenu('crew')), [
      [i18n('cp.nudge'), function () { nudge(c); }],
      [(showDone() ? '✓ ' : '') + i18n('ux2.show_done'), function () { try { localStorage.setItem('tw-crew-done', showDone() ? '0' : '1'); } catch (e) { /* optional */ } openCrew(c, cur.focus); }]]);
    var det = ib('info', i18n('cp.detail'), app0.classList.contains('cp-detail'), function () { app0.classList.toggle('cp-detail'); drawBar(); });
    // The session's own actions (detach / stop) are the ones of the detail panel; the menu reaches them in one click.
    var items = sessionItems(c.server, c.name); items.push(null);
    if (!c.derived) items.push([layoutMode === '1' ? i18n('cp.view_crew') : i18n('cp.view_one'), function () { layoutMode = layoutMode === '1' ? 'T' : '1'; openCrew(c, cur.focus); }]);
    items.push([i18n('app.roi_van_chay'), clickIn('#detail .detail-actions .btn:not(.danger)')]);
    if (demoMode) items.push(['Giả lập thợ treo (demo)', function () { hang(c); }]);
    if (c.derived) items.push([i18n('cp.stop_leader'), clickIn('#detail .detail-actions .btn.danger'), true]); else items.push([i18n('cp.stop_crew'), function () { stopCrew(c); }, true]);
    b.append(tg, opts, det, dropdown('more', ib('more', i18n('cp.more'), null, toggleMenu('more'), 'more'), items));
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
    // Nothing here needs to run while the window is hidden; one catch-up pass runs when it comes back (see visibilitychange below).
    setInterval(function () {
      if (document.hidden) return;
      get('/list').then(function (r) {
        registry = r.crews || []; mergeCrews(); var k = key(crews);
        if (seenKey === null) { seenKey = k; return; } // what is already on screen at load needs no second layout (it blanked the panes for a while)
        if (k !== seenKey) { seenKey = k; stable = 0; pendingLayout = true; app().refresh(); return; }
        if (pendingLayout && ++stable >= 2) { pendingLayout = false; app().refresh().then(function () { if (cur && currentCrew()) openCrew(currentCrew(), cur.focus); }); }
      }).catch(function () {});
    }, 2000);
    setInterval(function () { if (!document.hidden) pollTracks(); }, 2000);
    setInterval(function () { if (!document.hidden) loadDerived(); }, 5000); setInterval(function () { if (!document.hidden) refreshLogs(); }, 2500);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) { loadDerived().catch(function () {}); pollTracks(); refreshLogs(); } });
    setInterval(function () {
      if (document.hidden) return;
      boxes = boxes.filter(function (b) { return b.box.isConnected; });
      boxes.forEach(function (b) { var c = crews.filter(function (x) { return x.id === b.id; })[0]; if (c) drawBox(b.box, c); });
      if (cur) { drawBar(); placeGut(); } else drawPlainBar(barNode());
    }, 1000);
  });
})();
