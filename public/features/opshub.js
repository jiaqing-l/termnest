'use strict';
// Ops hub ("Trạm Ops") at the top of the Operations page: progress of every team in one search box (0 token), the periodic
// Ops report (rules, or the Ops session's AI audit), free questions to the Ops session, and its settings.
(function () {
  var slot = document.getElementById('ops-hub-slot');
  if (!slot || !window.TW) return;
  var API = '/api/features/opshub';
  var auditBusy = false, data = null, tokens = null, reports = null, cfgView = null, tab = 'progress', query = '', reportAt = '', loadErr = false, settingsDirty = false;
  var DONE = ['done', 'merged', 'accepted', 'audited', 'verified', 'closed', 'landed'], FINAL = ['done', 'closed', 'abandoned', 'archived', 'merged'];
  function h(k, p) { return i18n('hub.' + k, p); }
  function el(t, c, x) { var e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; }
  function btn(label, cls, fn) { var b = el('button', 'btn ' + (cls || ''), label); b.type = 'button'; b.onclick = fn; return b; }
  function list(v) { return Array.isArray(v) ? v : []; }
  function txt(v) { return typeof v === 'string' || typeof v === 'number' ? String(v) : ''; }
  function api(m, p, b) { return TW.api(m, API + p, b); }
  function say(t, ok) { var a = TW.app && TW.app(); if (a && a.say) a.say(t, ok !== false, 3500); }
  function hm(at) { return at ? new Date(at).toLocaleTimeString(window.TW_I18N ? window.TW_I18N.lang() : undefined, { hour: '2-digit', minute: '2-digit' }) : '—'; }
  function ago(at) {
    if (!at) return '';
    var m = Math.max(0, Math.round((Date.now() - at) / 60000));
    return m < 1 ? h('now') : m < 60 ? h('min_ago', [m]) : m < 1440 ? h('hour_ago', [Math.round(m / 60)]) : h('day_ago', [Math.round(m / 1440)]);
  }
  function visible() { var v = slot.closest('.view'); return !document.hidden && (!v || v.classList.contains('on')); }
  function findingText(f) {
    var k = 'cp.c.' + f.code, t = i18n(k, f.params);
    return t !== k ? t : h('f.' + f.code, f.params);
  }
  function md(text) {
    var box = el('div', 'hub-md');
    if (window.markdownit) { try { box.innerHTML = window.markdownit({ html: false, linkify: true, breaks: true }).render(String(text || '')); return box; } catch (e) { /* plain text below */ } }
    box.textContent = String(text || ''); box.style.whiteSpace = 'pre-wrap'; return box;
  }
  function tag(cls, label) { return el('span', 'hub-tag t-' + cls, label); }
  var STATE_CLS = { busy: 'run', asking: 'bad', quota: 'bad', idle: 'wait', fresh: 'idle', parked: 'idle', shell: 'idle', unknown: 'idle' };
  function stateTag(s) { return tag(STATE_CLS[s.state] || 'idle', h('st.' + s.state)); }
  var VERDICT = { verified: 'ok', verify_failed: 'bad', blocked: 'bad', coded: 'wait', unverified: 'wait' };
  function trackCls(k, running) { return running ? 'run' : DONE.indexOf(k.state) >= 0 ? 'ok' : VERDICT[k.verdict] ? VERDICT[k.verdict] : k.lastExit === '7' ? 'wait' : /fail|blocked/.test(k.state) ? 'bad' : k.lastExit === '8' ? 'idle' : 'wait'; }
  function trackLabel(k, running) {
    if (running) return h('tr.running');
    if (DONE.indexOf(k.state) >= 0) return h('tr.done');
    if (VERDICT[k.verdict]) return h('tr.' + k.verdict, [k.proof ? k.proof.failed : 0]);
    if (k.lastExit === '7') return h('tr.unverified');
    if (k.lastExit === '8') return h('tr.queued');
    if (k.lastExit === '11') return h('tr.quota');
    var key = 'tr.' + k.state, t = h(key); return t === 'hub.' + key ? txt(k.state) : t;
  }

  // ---------- persistent frame ----------
  var root = el('section', 'hub'), hero = el('div', 'hub-hero'), copy = el('div', 'hub-copy'), opsCard = el('div', 'hub-opscard');
  var eyebrow = el('div', 'hub-eyebrow'), title = el('h2', 'hub-title'), sub = el('p', 'hub-sub'), chips = el('div', 'hub-chips');
  copy.append(eyebrow, title, sub, chips); hero.append(copy, opsCard);
  var askWrap = el('div', 'hub-askwrap'), ask = el('div', 'hub-ask'), input = el('input'), kbd = el('span', 'hub-kbd', '⌘K'), deepBtn = btn('✨ ' + h('deep_btn'), 'hub-ai', function () { openDeep(input.value); });
  input.type = 'search'; input.placeholder = h('ask_ph'); input.autocomplete = 'off'; input.setAttribute('aria-label', h('ask_ph'));
  var icon = el('span', 'hub-search-ic'); icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
  ask.append(icon, input, kbd, deepBtn);
  var sugg = el('div', 'hub-sugg'); sugg.hidden = true;
  var quick = el('div', 'hub-quick');
  askWrap.append(ask, sugg, quick);
  var cols = el('div', 'hub-cols'), panel = el('section', 'hub-panel'), ph = el('div', 'hub-panel-h'), seg = el('div', 'seg hub-tabs'), body = el('div', 'hub-panel-b');
  var TABS = ['progress', 'report', 'deep', 'settings'], tabBtns = {};
  TABS.forEach(function (t) { var b = el('button', '', h('tab.' + t)); b.type = 'button'; b.onclick = function () { setTab(t); }; tabBtns[t] = b; seg.append(b); });
  // Refresh: now (button) and automatically every N seconds while this tab is open (per viewer, remembered locally).
  // The button makes every machine poll and every crew folder rescan (SSH work). The timer only reads what Termnest already
  // keeps up to date (the open page polls every few seconds), so several open tabs or phones never multiply the SSH load.
  var refreshing = false;
  function refreshNow(quiet) {
    if (refreshing) return Promise.resolve(); refreshing = true;
    if (quiet) return load().catch(function () { /* the next tick retries */ }).finally(function () { refreshing = false; });
    refreshBtn.disabled = true; refreshBtn.textContent = '↻ ' + h('refreshing');
    return api('POST', '/refresh', {}).then(function () { reports = null; return load(); }).catch(function () { if (!quiet) say(h('action_failed'), false); })
      .finally(function () { refreshing = false; refreshBtn.disabled = false; refreshBtn.textContent = '↻ ' + h('refresh'); });
  }
  var refresh = el('div', 'hub-refresh'), refreshAt = el('small', 'hub-foot'), refreshBtn = btn('↻ ' + h('refresh'), 'hub-sm', function () { refreshNow(false); });
  var autoSel = el('select', 'hub-auto'); autoSel.setAttribute('aria-label', h('auto_refresh'));
  [['0', h('auto_off')], ['30', h('auto_s', [30])], ['60', h('auto_m', [1])], ['120', h('auto_m', [2])], ['300', h('auto_m', [5])]].forEach(function (o) { var x = el('option', '', h('auto_label', [o[1]])); x.value = o[0]; autoSel.append(x); });
  var autoSec = 60; try { var saved = localStorage.getItem('tw-hub-auto'); if (saved !== null && /^(0|30|60|120|300)$/.test(saved)) autoSec = Number(saved); } catch (e) { /* optional */ }
  autoSel.value = String(autoSec);
  var autoTimer = null;
  function armAuto() { clearInterval(autoTimer); autoTimer = autoSec ? setInterval(function () { if (visible()) refreshNow(true); }, autoSec * 1000) : null; }
  autoSel.onchange = function () { autoSec = Number(autoSel.value); try { localStorage.setItem('tw-hub-auto', String(autoSec)); } catch (e) { /* optional */ } armAuto(); };
  armAuto();
  refresh.append(refreshAt, autoSel, refreshBtn);
  ph.append(seg, refresh); panel.append(ph, body);
  setInterval(function () { if (data) refreshAt.textContent = h('updated', [ago(data.fleet.at)]); }, 5000);
  var rail = el('aside', 'hub-rail'), waitBox = el('section', 'hub-card'), quotaBox = el('section', 'hub-card');
  rail.append(waitBox, quotaBox); cols.append(panel, rail);
  root.append(hero, askWrap, cols); slot.append(root);

  function setTab(t) { tab = t; TABS.forEach(function (x) { tabBtns[x].setAttribute('aria-pressed', String(x === t)); }); settingsDirty = false; drawBody(true); }

  // ---------- search ----------
  input.addEventListener('input', function () { query = input.value; suggest(); if (tab === 'progress') drawBody(); });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { sugg.hidden = true; query = input.value; setTab('progress'); }
    if (e.key === 'Escape') { sugg.hidden = true; }
  });
  document.addEventListener('click', function (e) { if (!askWrap.contains(e.target)) sugg.hidden = true; });
  document.addEventListener('keydown', function (e) { if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 'k' && visible()) { e.preventDefault(); input.focus(); input.select(); } });
  function pick(v) { input.value = v; query = v; sugg.hidden = true; setTab('progress'); }
  function suggest() {
    sugg.textContent = ''; var v = query.trim().toLowerCase(); if (!v || !data) { sugg.hidden = true; return; }
    var items = [];
    list(data.fleet.sessions).forEach(function (s) { if (s.name.toLowerCase().indexOf(v) >= 0) items.push(['session', s.name, s.machineName + ' · ' + h('st.' + s.state), s.name]); });
    activeTasks().forEach(function (t) { if (t.id.toLowerCase().indexOf(v) >= 0 || t.title.toLowerCase().indexOf(v) >= 0) items.push(['task', t.id, t.title, t.id]); });
    activeTasks().forEach(function (t) { list(t.tracks).forEach(function (k) { if (k.id.toLowerCase() === v) items.push(['track', k.id + ' · ' + t.id, trackLabel(k, false), k.id]); }); });
    var last = '';
    items.slice(0, 8).forEach(function (it) {
      if (it[0] !== last) { last = it[0]; sugg.append(el('div', 'hub-sugg-h', h('kind.' + it[0]))); }
      var b = el('button', ''); b.type = 'button'; b.append(el('b', '', it[1]), el('small', '', it[2])); b.onclick = function () { pick(it[3]); }; sugg.append(b);
    });
    if (!items.length) sugg.append(el('div', 'hub-sugg-h', h('no_match_deep')));
    sugg.hidden = false;
  }

  // ---------- data ----------
  function activeTasks() { return data ? list(data.fleet.tasks).filter(function (t) { return FINAL.indexOf(t.status) < 0; }) : []; }
  function sessionOf(machine, name) { return data && list(data.fleet.sessions).find(function (s) { return s.machine === machine && s.name === name; }); }
  function runningTracks(t) {
    var s = sessionOf(t.machine, t.leader), out = {};
    list(s && s.workers).forEach(function (w) { if (w.task === t.id && w.track) out[w.track] = true; });
    return out;
  }
  // Redraw only when something changed (or once a minute for the "x minutes ago" texts): no DOM rebuild every 10 s on a
  // phone, and open sections, scroll position and text selection stay as they are.
  var drawnSig = '', drawnAt = 0;
  function load() {
    return api('GET', '/state').then(function (r) {
      var sig = ''; try { sig = JSON.stringify(Object.assign({}, r, { fleet: Object.assign({}, r.fleet, { at: 0 }) })); } catch (e) { /* draw */ }
      var same = sig && sig === drawnSig && !loadErr && Date.now() - drawnAt < 60000;
      data = r; loadErr = false;
      if (same) { refreshAt.textContent = h('updated', [ago(data.fleet.at)]); return; }
      drawnSig = sig; drawnAt = Date.now(); draw();
    }).catch(function () { loadErr = true; drawnSig = ''; draw(); });
  }
  function loadTokens() {
    return TW.api('GET', '/api/tokens?zone=' + encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone) + (tokens && tokens.etag ? '&etag=' + tokens.etag : '')).then(function (r) { if (!(r && r.notModified && tokens)) tokens = r; drawQuota(); }).catch(function () { /* optional */ });
  }
  function loadReports() { return api('GET', '/reports').then(function (r) { reports = list(r.reports); if (tab === 'report') drawBody(true); }).catch(function () { reports = []; }); }

  // ---------- drawing ----------
  function draw() { refreshAt.textContent = data ? h('updated', [ago(data.fleet.at)]) : ''; drawHero(); drawQuick(); drawWaiting(); drawQuota(); drawBody(); }
  function drawHero() {
    if (!data) { title.textContent = loadErr ? h('load_error') : h('loading'); return; }
    var f = data.fleet, teams = activeTasks().length, wait = list(f.waiting).length, on = list(f.machines).filter(function (m) { return m.online; }).length, o = data.ops;
    var noai = o.cfg.enabled && (o.phase === 'paused' || o.code === 'ops_quota');
    hero.classList.toggle('noai', !!noai);
    eyebrow.textContent = h('eyebrow', [on, list(f.machines).length]);
    title.textContent = noai ? h('title_noai') : wait ? h('title', [teams, wait]) : h('title_calm', [teams]);
    sub.textContent = noai ? h('sub_noai') : o.cfg.enabled ? h('sub_ai', [o.cfg.interval]) : h('sub_rules', [o.cfg.interval]);
    chips.textContent = '';
    var rep = data.report, n = rep ? rep.counts : null;
    [[list(f.sessions).filter(function (s) { return s.tool; }).length, h('chip.sessions'), function () { pick(''); }],
      [teams, h('chip.teams'), function () { pick(''); }],
      [wait, h('chip.waiting'), function () { pick(h('q_waiting')); }],
      [n ? n.BLOCKER : 0, h('chip.blockers', [hm(rep && rep.at)]), function () { setTab('report'); }]].forEach(function (c) {
      var b = el('button', 'hub-chip'); b.type = 'button'; b.append(el('b', '', String(c[0])), document.createTextNode(' ' + c[1])); b.onclick = c[2]; chips.append(b);
    });
    drawOpsCard();
  }
  function line(a, b) { var d = el('div', 'hub-l'); d.append(el('span', '', a), el('span', 'hub-mono', b)); return d; }
  function drawOpsCard() {
    var o = data.ops, c = o.cfg; opsCard.textContent = '';
    var head = el('div', 'hub-oh'), dot = el('span', 'hub-pulse');
    var phase = !c.enabled ? 'off' : o.phase;
    dot.classList.toggle('off', ['ready', 'running', 'busy'].indexOf(phase) < 0);
    head.append(dot, el('b', '', h('ph.' + phase)));
    opsCard.append(head);
    if (o.code && ['error', 'paused', 'waiting'].indexOf(phase) >= 0) opsCard.append(el('div', 'hub-l hub-why', h('code.' + o.code)));
    if (c.enabled) opsCard.append(line(h('ops.account'), o.account || '.claude'), line(h('ops.model'), c.model));
    opsCard.append(line(h('ops.last'), data.ops.lastReportAt ? hm(data.ops.lastReportAt) : '—'), line(h('ops.next'), hm(data.ops.nextReportAt)));
    var row = el('div', 'hub-orow');
    var now = btn(h('audit_now'), '', function () {
      if (auditBusy) return; auditBusy = true; now.disabled = true;
      api('POST', '/audit', {}).then(function () { say(h(c.enabled ? 'audit_sent_ai' : 'audit_sent')); reports = null; return load(); }).then(function () { setTab('report'); })
        .catch(function () { say(h('action_failed'), false); }).finally(function () { auditBusy = false; now.disabled = false; });
    });
    now.disabled = auditBusy; row.append(now);
    if (!c.enabled) row.append(btn(h('turn_on'), '', function () { setTab('settings'); }));
    else if (phase === 'paused' && c.accounts.length > 1) row.append(btn(h('switch_account'), '', function () { setTab('settings'); }));
    else if (['error', 'waiting'].indexOf(phase) >= 0 || o.code === 'ops_quota') row.append(btn(phase === 'waiting' ? h('open_ops') : h('restart_ops'), '', function () {
      if (phase === 'waiting') TW.app().openSession(c.server, data.ops.session);
      else api('POST', '/ops/restart', {}).then(load).catch(function () { say(h('action_failed'), false); });
    }));
    else row.append(btn(h('open_ops'), '', function () { TW.app().openSession(c.server, data.ops.session); }));
    opsCard.append(row);
  }
  function drawQuick() {
    if (quick.childNodes.length) return;
    quick.append(el('span', 'hub-quick-l', h('quick')));
    [h('q_waiting'), h('q_teams')].forEach(function (q) { var b = el('button', 'hub-qchip', q); b.type = 'button'; b.onclick = function () { pick(q === h('q_teams') ? '' : q); }; quick.append(b); });
  }
  function drawWaiting() {
    waitBox.textContent = '';
    var w = data ? list(data.fleet.waiting) : [], hd = el('div', 'hub-card-h');
    hd.append(el('h3', '', h('rail.waiting')), el('span', 'hub-cnt' + (w.length ? ' bad' : ''), String(w.length)));
    waitBox.append(hd);
    if (!w.length) { waitBox.append(el('p', 'hub-empty', h('rail.none_waiting'))); return; }
    w.slice(0, 8).forEach(function (s) {
      var d = el('div', 'hub-wq'), t = el('div', 'hub-wq-t');
      t.append(el('b', '', s.name), el('small', '', s.machineName + ' · ' + ago(s.since)));
      d.append(t);
      if (s.state === 'quota') d.append(tag('bad', h('st.quota')));
      if (s.question) d.append(el('q', '', s.question));
      d.append(btn(h('open_answer'), 'primary hub-sm', function () { TW.app().openSession(s.machine, s.name); }));
      waitBox.append(d);
    });
    waitBox.append(el('p', 'hub-foot', h('rail.never_answer')));
  }
  function drawQuota() {
    quotaBox.textContent = '';
    var hd = el('div', 'hub-card-h'); hd.append(el('h3', '', h('rail.quota')));
    quotaBox.append(hd);
    var accs = tokens ? list(tokens.accounts).filter(function (a) { var l = a.limits || {}; return (a.tool === 'claude' || a.tool === 'codex') && (l.session || l.weekly); }) : [];
    if (!accs.length) { quotaBox.append(el('p', 'hub-empty', h('rail.no_quota'))); return; }
    var used = data && data.ops.cfg.enabled ? data.ops.account : '';
    accs.slice(0, 8).forEach(function (a) {
      var lim = a.limits || {}, w = [lim.session, lim.weekly].filter(function (x) { return x && isFinite(x.percent); }).sort(function (x, y) { return y.percent - x.percent; })[0];
      var dir = txt(a.directory).split('/').pop(), name = txt(a.nickname) || txt(a.email) || dir || a.tool;
      var row = el('div', 'hub-acct'), top = el('div', 'hub-acct-t'), nm = el('b', '', name);
      var mine = used && (dir === used || list(a.dirs).some(function (d) { return txt(d).split('/').pop() === used; }));
      top.append(nm); if (mine) top.append(el('span', 'hub-badge', h('rail.ops_uses')));
      top.append(el('span', 'hub-mono', w ? (w.percent >= 100 ? h('rail.reset', [hm(w.resetAt * (w.resetAt < 1e12 ? 1000 : 1))]) : h('rail.left', [Math.max(0, 100 - Math.round(w.percent))])) : '—'));
      var bar = el('div', 'hub-meter' + (w && w.percent >= 100 ? ' bad' : w && w.percent >= 80 ? ' warn' : '')), fill = el('i'); fill.style.width = (w ? Math.min(100, w.percent) : 0) + '%'; bar.append(fill);
      row.append(top, bar); quotaBox.append(row);
    });
    quotaBox.append(el('p', 'hub-foot', h('rail.quota_note')));
  }

  function drawBody(force) {
    if (!data) { body.textContent = ''; body.append(el('p', 'hub-empty', loadErr ? h('load_error') : h('loading'))); return; }
    if (tab === 'settings' && !force) return; // never redraw a form while someone edits it
    if (tab === 'deep' && !force && document.activeElement && body.contains(document.activeElement)) { drawDeepAnswers(); return; }
    body.textContent = '';
    if (tab === 'progress') drawProgress();
    else if (tab === 'report') drawReport();
    else if (tab === 'deep') drawDeep();
    else drawSettings();
  }

  // ---------- progress (0 token) ----------
  function drawProgress() {
    var v = query.trim().toLowerCase();
    if (v && (v === h('q_waiting').toLowerCase() || /chờ tôi|chờ anh|waiting for me/.test(v))) { drawWaitingList(); return; }
    if (!v) {
      var ts = activeTasks();
      body.append(el('div', 'hub-h3', h('teams_running', [ts.length])));
      if (!ts.length) body.append(el('p', 'hub-empty', h('no_teams')));
      ts.forEach(function (t) { body.append(taskCard(t, true)); });
      var others = list(data.fleet.sessions).filter(function (s) { return s.tool && !s.task; });
      if (others.length) { body.append(el('div', 'hub-h3', h('other_sessions', [others.length]))); body.append(sessionTable(others)); }
      return;
    }
    var hit = false;
    list(data.fleet.sessions).filter(function (s) { return s.name.toLowerCase().indexOf(v) >= 0; }).slice(0, 4).forEach(function (s) {
      hit = true;
      var t = s.task && activeTasks().find(function (x) { return x.machine === s.machine && x.id === s.task; });
      body.append(t ? taskCard(t, false) : sessionCard(s));
    });
    activeTasks().filter(function (t) { return (t.id.toLowerCase().indexOf(v) >= 0 || t.title.toLowerCase().indexOf(v) >= 0) && t.leader.toLowerCase().indexOf(v) < 0; }).slice(0, 4).forEach(function (t) { hit = true; body.append(taskCard(t, false)); });
    activeTasks().forEach(function (t) { var k = list(t.tracks).find(function (x) { return x.id.toLowerCase() === v; }); if (k && !hit) { hit = true; body.append(taskCard(t, false, k.id)); } });
    if (!hit) {
      var c = el('div', 'hub-callout'); c.append(el('b', '', h('not_found', [query])), el('p', '', h('not_found_hint')), btn('✨ ' + h('deep_btn'), 'hub-ai hub-sm', function () { openDeep(query); }));
      body.append(c);
    }
  }
  function taskCard(t, compact, focusTrack) {
    var card = el('div', 'hub-task' + (compact ? ' compact' : '')), running = runningTracks(t), tracks = list(t.tracks);
    var n = { ok: 0, wait: 0, run: 0, bad: 0, idle: 0 };
    tracks.forEach(function (k) { n[trackCls(k, running[k.id])]++; });
    var leader = t.leader ? sessionOf(t.machine, t.leader) : null;
    var head = el('div', 'hub-task-h'), ava = el('span', 'hub-ava', (t.leader || t.id).charAt(0).toUpperCase()), who = el('div', 'hub-task-who');
    who.append(el('b', 'hub-mono', t.leader || h('no_leader')), el('small', '', t.machineName + ' · ' + t.id));
    head.append(ava, who, leader ? stateTag(leader) : tag('idle', h('no_leader')));
    card.append(head, el('div', 'hub-task-title', t.title || t.id));
    // Why no leader was found (machine, workspace and chats were checked): what to do about it, in one line.
    if (!t.leader && t.leaderHint && t.leaderHint.code) card.append(el('div', 'hub-foot', h('leader_hint.' + t.leaderHint.code, [list(t.leaderHint.sessions).join(', '), t.id])));
    if (tracks.length) {
      var prog = el('div', 'hub-prog'), stack = el('div', 'hub-stack');
      ['ok', 'wait', 'run', 'bad', 'idle'].forEach(function (k) { if (n[k]) { var i = el('i', 'c-' + k); i.style.width = (n[k] / tracks.length * 100) + '%'; stack.append(i); } });
      prog.append(stack, el('b', 'hub-mono', h('done_of', [n.ok, tracks.length])));
      card.append(prog);
      var legend = el('div', 'hub-legend');
      ['ok', 'wait', 'run', 'bad', 'idle'].forEach(function (k) { if (n[k]) { var s = el('span', ''); s.append(el('i', 'c-' + k), document.createTextNode(h('lg.' + k, [n[k]]))); legend.append(s); } });
      card.append(legend);
    }
    var mine = list(data.findings).filter(function (f) { return f.task === t.id && f.machine === t.machine && f.cat !== 'INFO'; });
    var dl = el('dl', 'hub-sum');
    function row(k, v) { if (!v) return; dl.append(el('dt', '', k)); var dd = el('dd'); if (typeof v === 'string') dd.textContent = v; else dd.append(v); dl.append(dd); }
    if (!compact || mine.length) {
      row(h('sum.doing'), leader ? doingText(leader, running) : h('no_leader_doing'));
      row(h('sum.blocked'), mine.length ? mine.map(findingText).join(' · ') : (t.blocked || h('sum.none')));
      var owner = mine.some(function (f) { return f.owner === 'you'; }) ? 'you' : mine.length ? 'leader' : 'none';
      var who2 = el('span', owner === 'you' ? 'hub-bad' : 'hub-ok', h('owner.' + owner)); row(h('sum.who'), who2);
      card.append(dl);
    }
    if (tracks.length) {
      var tr = el('div', 'hub-tracks');
      tracks.forEach(function (k) {
        var cls = trackCls(k, running[k.id]), b = el('button', 'hub-trk c-' + cls + (focusTrack === k.id ? ' focus' : '')); b.type = 'button';
        b.append(el('b', 'hub-mono', k.id), el('span', '', trackLabel(k, running[k.id]) + (k.fixRounds ? ' · fix ' + k.fixRounds : '') + (k.lastAt ? ' · ' + ago(k.lastAt) : '')));
        b.title = (k.proof ? proofText(k.proof) + '\n' : '') + h('track_open');
        b.onclick = function () { if (TW.opsTrackPopup) TW.opsTrackPopup(t.machine, t.root, { id: t.id, title: t.title }, k, !!running[k.id]); };
        tr.append(b);
      });
      card.append(tr);
    }
    var acts = el('div', 'hub-acts');
    if (t.leader) acts.append(btn(h('open_leader'), 'hub-sm', function () { TW.app().openSession(t.machine, t.leader); }));
    acts.append(btn('✨ ' + h('ask_when'), 'hub-ai hub-sm', function () { openDeep(h('ask_when_q', [t.id])); }));
    acts.append(el('span', 'hub-foot', h('zero_token')));
    card.append(acts);
    return card;
  }
  function proofText(p) {
    return p.line ? h('proof_status', [p.file, hm(p.at), p.line]) : h('proof_verify', [p.file, hm(p.at), p.passed, p.failed]);
  }
  function doingText(s, running) {
    var r = Object.keys(running);
    if (s.state === 'busy') return r.length ? h('doing.workers', [r.join(', ')]) : h('doing.busy');
    if (s.state === 'asking') return h('doing.asking', [s.question || '—']);
    if (s.state === 'quota') return h('doing.quota', [s.account || '—']);
    if (s.state === 'fresh') return h('doing.fresh');
    if (s.state === 'idle') return r.length ? h('doing.idle_workers', [ago(s.since), r.join(', ')]) : h('doing.idle', [ago(s.since)]);
    return h('st.' + s.state);
  }
  function sessionCard(s) {
    var card = el('div', 'hub-task'), head = el('div', 'hub-task-h'), who = el('div', 'hub-task-who');
    who.append(el('b', 'hub-mono', s.name), el('small', '', s.machineName + (s.tool ? ' · ' + s.tool : '') + (s.account ? ' · ' + s.account : '')));
    head.append(el('span', 'hub-ava', s.name.charAt(0).toUpperCase()), who, stateTag(s));
    card.append(head, el('div', 'hub-state', doingText(s, {})));
    if (s.question) card.append(el('q', 'hub-q', s.question));
    card.append(el('p', 'hub-foot', s.name === data.ops.session ? h('ops_session_note') : h('not_crew')));
    var acts = el('div', 'hub-acts'); acts.append(btn(h('open'), 'hub-sm', function () { TW.app().openSession(s.machine, s.name); })); card.append(acts);
    return card;
  }
  function sessionTable(rows) {
    var t = el('div', 'hub-rows');
    rows.slice(0, 30).forEach(function (s) {
      var r = el('button', 'hub-row'); r.type = 'button';
      r.append(el('b', 'hub-mono', s.name), el('span', 'hub-row-m', s.machineName), el('span', 'hub-row-d', doingText(s, {})), stateTag(s));
      r.onclick = function () { pick(s.name); }; t.append(r);
    });
    return t;
  }
  function drawWaitingList() {
    var w = list(data.fleet.waiting);
    body.append(el('div', 'hub-h3', h('waiting_title', [w.length])));
    if (!w.length) body.append(el('p', 'hub-empty', h('rail.none_waiting')));
    w.forEach(function (s) { body.append(sessionCard(s)); });
  }

  // ---------- report ----------
  function drawReport() {
    if (!reports) { body.append(el('p', 'hub-empty', h('loading'))); loadReports(); return; }
    var bar = el('div', 'hub-rbar'), hist = el('div', 'seg hub-hist');
    if (!reports.length) { body.append(el('p', 'hub-empty', h('no_reports'))); body.append(btn(h('audit_now'), 'primary', function () { api('POST', '/audit', {}).then(function () { reports = null; drawBody(true); }); })); return; }
    var cur = reports.find(function (r) { return r.id === reportAt; }) || reports[0];
    reports.slice(0, 12).forEach(function (r) { var b = el('button', '', hm(r.at)); b.type = 'button'; b.setAttribute('aria-pressed', String(r.id === cur.id)); b.onclick = function () { reportAt = r.id; drawBody(true); }; hist.append(b); });
    bar.append(hist, el('span', 'hub-foot', h('report_meta', [cur.stats ? cur.stats.online : '—', cur.stats ? cur.stats.sessions : '—', h('trig.' + cur.trigger)])));
    body.append(bar);
    var k = el('div', 'hub-kpis');
    [['BLOCKER', 'bad'], ['WASTE', 'wait'], ['DRIFT', 'run'], ['INFO', '']].forEach(function (x) { var d = el('div', 'hub-kpi ' + x[1]); d.append(el('b', '', String(cur.counts[x[0]] || 0)), el('span', '', x[0])); k.append(d); });
    body.append(k);
    var ai = cur.ai;
    if (ai && ai.status === 'done') {
      var head = el('div', 'hub-aihead'); head.append(tag('run', h('ai_label', [ai.model || '', ai.account || ''])), el('span', 'hub-foot', hm(ai.at)));
      body.append(head);
      if (ai.summary) body.append(el('p', 'hub-aisum', ai.summary));
      list(ai.findings).forEach(function (f) {
        var d = el('div', 'hub-find'), w = el('div', 'hub-find-w');
        w.append(el('b', '', [f.session || f.task, f.machine].filter(Boolean).join(' · ') || '—'), el('p', '', f.problem));
        if (f.cause) w.append(el('div', 'hub-nx', h('cause') + ': ' + f.cause));
        if (f.next) w.append(el('div', 'hub-nx', h('next') + ': ' + f.next + ' · ' + h('who') + ': ' + h('owner.' + f.owner)));
        if (f.evidence) w.append(el('div', 'hub-ev', f.evidence));
        d.append(el('span', 'hub-sev s-' + f.cat, f.cat), w); body.append(d);
      });
      var box = el('details', 'hub-rulesbox'); box.append(el('summary', '', h('rules_too', [cur.findings.length])));
      cur.findings.forEach(function (f) { box.append(ruleRow(f)); }); body.append(box);
      return;
    }
    var note = el('div', 'hub-callout soft');
    note.append(el('b', '', h('rules_label')), el('p', '', ai ? h('ai.' + ai.status, [h('code.' + (ai.code || 'none'))]) : h('ai.off')));
    body.append(note);
    if (!cur.findings.length) body.append(el('p', 'hub-empty', h('no_findings')));
    cur.findings.forEach(function (f) { body.append(ruleRow(f)); });
  }
  function ruleRow(f) {
    var d = el('div', 'hub-find'), w = el('div', 'hub-find-w');
    w.append(el('b', '', [f.session || f.task, f.machineName].filter(Boolean).join(' · ')), el('p', '', findingText(f)));
    w.append(el('div', 'hub-nx', h('who') + ': ' + h('owner.' + (f.owner || 'none'))));
    d.append(el('span', 'hub-sev s-' + f.cat, f.cat), w);
    if (f.session) d.append(btn(h('open'), 'hub-sm', function () { TW.app().openSession(f.machine, f.session); }));
    return d;
  }

  // ---------- deep questions (AI) ----------
  var composer = null;
  function openDeep(q) { setTab('deep'); if (composer && q) { composer.value = q; composer.focus(); } }
  function drawDeep() {
    var o = data.ops;
    if (!o.cfg.enabled) {
      var c = el('div', 'hub-callout'); c.append(el('b', '', h('deep_off')), el('p', '', h('deep_off_hint')), btn(h('turn_on'), 'primary hub-sm', function () { setTab('settings'); })); body.append(c);
    } else if (o.phase === 'paused' || o.code === 'ops_quota') {
      var p = el('div', 'hub-callout'); p.append(el('b', '', h('deep_quota')), el('p', '', h('deep_quota_hint'))); body.append(p);
    }
    var chat = el('div', 'hub-chat'); chat.id = 'hub-chat'; body.append(chat); drawDeepAnswers();
    var form = el('form', 'hub-composer'); composer = el('input'); composer.placeholder = h('deep_ph'); composer.maxLength = 500;
    if (input.value && !composer.value) composer.value = input.value;
    var send = btn(h('send'), 'hub-ai hub-sm', null); send.type = 'submit';
    form.append(composer, send);
    form.onsubmit = function (e) {
      e.preventDefault(); var q = composer.value.trim(); if (q.length < 3) return;
      send.disabled = true;
      api('POST', '/ask', { q: q }).then(function () { composer.value = ''; return load(); }).catch(function () { say(h('action_failed'), false); }).finally(function () { send.disabled = false; drawBody(true); });
    };
    body.append(form);
    var ex = el('div', 'hub-quick'); [h('ex1'), h('ex2'), h('ex3')].forEach(function (q) { var b = el('button', 'hub-qchip', q); b.type = 'button'; b.onclick = function () { composer.value = q; composer.focus(); }; ex.append(b); });
    body.append(ex);
  }
  function drawDeepAnswers() {
    var chat = document.getElementById('hub-chat'); if (!chat) return;
    chat.textContent = '';
    var asks = list(data.asks).slice().reverse();
    if (!asks.length) chat.append(el('div', 'hub-msg ops', h('deep_hello')));
    asks.forEach(function (a) {
      chat.append(el('div', 'hub-msg me', a.q));
      var m = el('div', 'hub-msg ops'), meta = el('span', 'hub-meta', 'Ops · ' + hm(a.doneAt || a.at));
      m.append(meta);
      if (a.state === 'done') m.append(md(a.answer));
      else if (a.state === 'failed' || a.state === 'unavailable') { m.classList.add('fail'); m.append(el('span', '', h('ask.' + a.state, [h('code.' + (a.code || 'none'))]))); }
      else m.append(el('span', 'hub-typing', h('ask.' + a.state)));
      chat.append(m);
    });
  }

  // ---------- settings ----------
  function field(label, control, note) { var d = el('label', 'hub-field'); d.append(el('span', 'hub-field-l', label), control); if (note) d.append(el('small', 'hub-foot', note)); return d; }
  function select(opts, val) { var s = el('select'); opts.forEach(function (o) { var x = el('option', '', o[1]); x.value = o[0]; if (o[0] === val) x.selected = true; s.append(x); }); return s; }
  function drawSettings() {
    body.append(el('p', 'hub-empty', h('loading')));
    api('GET', '/config').then(function (r) { cfgView = r; if (tab === 'settings') { body.textContent = ''; settingsForm(r); } }).catch(function () { body.textContent = ''; body.append(el('p', 'hub-empty', h('load_error'))); });
  }
  function settingsForm(r) {
    var c = r.cfg, n = r.notify, servers = list(r.choices);
    var a = el('section', 'hub-set'); a.append(el('h3', '', h('set.ops_title')), el('p', 'hub-foot', h('set.ops_note')));
    var on = el('input'); on.type = 'checkbox'; on.checked = !!c.enabled;
    var onL = el('label', 'hub-check'); onL.append(on, document.createTextNode(' ' + h('set.enabled'))); a.append(onL);
    var srv = select([['', h('set.pick_machine')]].concat(servers.map(function (s) { return [s.id, s.name + (s.online ? '' : ' (' + h('offline') + ')') + (s.windows ? ' — ' + h('set.no_windows') : '')]; })), c.server);
    var rootIn = el('input'); rootIn.value = c.root || ''; rootIn.placeholder = '/home/me/xspire-workspaces'; rootIn.setAttribute('list', 'hub-roots');
    var dl = el('datalist'); dl.id = 'hub-roots';
    var accBox = el('div', 'hub-accs'), order = list(c.accounts).slice();
    function fillServer() {
      var s = servers.find(function (x) { return x.id === srv.value; }) || { roots: [], accounts: ['.claude'] };
      dl.textContent = ''; s.roots.forEach(function (x) { var o = el('option'); o.value = x; dl.append(o); });
      if (!rootIn.value && s.roots.length) rootIn.value = s.roots[0];
      accBox.textContent = '';
      var all = order.concat(s.accounts.filter(function (x) { return order.indexOf(x) < 0; }));
      all.forEach(function (acct) {
        var lab = el('label', 'hub-check'), cb = el('input'); cb.type = 'checkbox'; cb.checked = order.indexOf(acct) >= 0;
        var num = el('span', 'hub-num', cb.checked ? String(order.indexOf(acct) + 1) : '');
        cb.onchange = function () { var i = order.indexOf(acct); if (cb.checked && i < 0) order.push(acct); if (!cb.checked && i >= 0) order.splice(i, 1); fillServer(); };
        lab.append(cb, num, document.createTextNode(' ' + acct)); accBox.append(lab);
      });
    }
    srv.onchange = function () { rootIn.value = ''; fillServer(); }; fillServer();
    var model = select([['sonnet', 'Sonnet (' + h('set.recommended') + ')'], ['opus', 'Opus'], ['haiku', 'Haiku']], c.model);
    var perm = select([['auto', h('set.perm_auto')], ['dontAsk', h('set.perm_dontask')], ['acceptEdits', h('set.perm_edits')], ['manual', h('set.perm_ask')]], c.perm);
    var every = select([['15', '15 ' + h('minutes')], ['30', '30 ' + h('minutes')], ['60', '60 ' + h('minutes')], ['120', '120 ' + h('minutes')]], String(c.interval));
    a.append(field(h('set.machine'), srv), field(h('set.root'), rootIn, h('set.root_note')), dl, field(h('set.accounts'), accBox, h('set.accounts_note')),
      field(h('set.model'), model), field(h('set.perm'), perm, h('set.perm_note')), field(h('set.interval'), every, h('set.interval_note')));
    var save1 = btn(h('save'), 'primary', function () {
      save1.disabled = true;
      api('POST', '/config', { enabled: on.checked, server: srv.value, root: rootIn.value.trim(), accounts: order, model: model.value, perm: perm.value, interval: Number(every.value) })
        .then(function () { say(h('saved')); return load(); }).catch(function (e) { say(h('err.' + ((e && e.code) || 'save')) , false); }).finally(function () { save1.disabled = false; });
    });
    a.append(save1);
    var b = el('section', 'hub-set'); b.append(el('h3', '', h('set.notify_title')), el('p', 'hub-foot', h('set.notify_note')));
    var tgTok = el('input'), tgChat = el('input'); tgTok.placeholder = n.telegram ? n.telegram.token : '123456:ABC…'; tgChat.value = n.telegram ? n.telegram.chat : ''; tgChat.placeholder = '-1001234567890';
    var whUrl = el('input'), whKind = select([['teams', 'Microsoft Teams (Workflows)'], ['text', 'Slack / Google Chat / ' + h('set.other')]], n.webhook ? n.webhook.kind : 'teams');
    whUrl.placeholder = n.webhook ? n.webhook.url : 'https://…';
    b.append(field('Telegram bot token', tgTok), field('Telegram chat id', tgChat, h('set.tg_note')), field(h('set.webhook'), whUrl), field(h('set.webhook_kind'), whKind));
    var evBox = el('div', 'hub-accs'), evs = {};
    ['owner_question', 'quota', 'blocker', 'ops_down', 'daily'].forEach(function (k) { var lab = el('label', 'hub-check'), cb = el('input'); cb.type = 'checkbox'; cb.checked = n.events[k] !== false; evs[k] = cb; lab.append(cb, document.createTextNode(' ' + h('ev.' + k))); evBox.append(lab); });
    var hour = select(Array.from({ length: 24 }, function (_, i) { return [String(i), (i < 10 ? '0' : '') + i + ':00']; }), String(n.dailyHour));
    b.append(field(h('set.events'), evBox), field(h('set.daily_hour'), hour));
    if (data && data.notifyError) b.append(el('p', 'hub-bad', h('set.notify_error', [hm(data.notifyError.at), data.notifyError.code])));
    var row = el('div', 'hub-acts');
    var save2 = btn(h('save'), 'primary', function () {
      var body2 = { events: {}, dailyHour: Number(hour.value) };
      Object.keys(evs).forEach(function (k) { body2.events[k] = evs[k].checked; });
      if (tgTok.value.trim() || tgChat.value.trim() !== (n.telegram ? n.telegram.chat : '')) body2.telegram = tgChat.value.trim() ? { token: tgTok.value.trim() || undefined, chat: tgChat.value.trim() } : null;
      if (whUrl.value.trim() || whKind.value !== (n.webhook ? n.webhook.kind : 'teams')) body2.webhook = (whUrl.value.trim() || n.webhook) ? { url: whUrl.value.trim() || undefined, kind: whKind.value } : null;
      save2.disabled = true;
      api('POST', '/notify', body2).then(function () { say(h('saved')); setTab('settings'); }).catch(function (e) { say(h('err.' + ((e && e.code) || 'save')), false); }).finally(function () { save2.disabled = false; });
    });
    row.append(save2, btn(h('set.test'), '', function () { api('POST', '/notify/test', {}).then(function () { say(h('set.test_ok')); }).catch(function (e) { say(h('set.test_fail', [(e && e.code) || '']), false); }); }));
    if (n.telegram) row.append(btn(h('set.remove_tg'), 'ghost', function () { api('POST', '/notify', { telegram: null }).then(function () { setTab('settings'); }); }));
    if (n.webhook) row.append(btn(h('set.remove_wh'), 'ghost', function () { api('POST', '/notify', { webhook: null }).then(function () { setTab('settings'); }); }));
    b.append(row);
    var how = el('section', 'hub-set'); how.append(el('h3', '', h('how.title')));
    ['rules', 'ops', 'ask', 'noai'].forEach(function (k) { var p = el('p', 'hub-how'); p.append(el('b', '', h('how.' + k + '_t') + ' '), document.createTextNode(h('how.' + k))); how.append(p); });
    body.append(a, b, how);
  }

  setTab('progress');
  load(); loadTokens();
  setInterval(function () { if (visible()) { load(); if (tab === 'report') loadReports(); } }, 10000);
  setInterval(function () { if (visible()) loadTokens(); }, 60000);
  var v = slot.closest('.view');
  if (v && window.MutationObserver) new MutationObserver(function () { if (v.classList.contains('on')) { load(); reports = null; } }).observe(v, { attributes: true, attributeFilter: ['class'] });
})();
