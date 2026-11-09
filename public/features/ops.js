'use strict';
// Project the actual board sessions and findings once per session. Observation is not task progress.
function opsSessionRows(board, supervision) {
  var out = [], ranks = { asking: 0, unheard: 1, owner: 2, aborted: 3, exited: 4, lost: 4, custom: 5, dormant: 6, finished: 9, unknown: 10 };
  function priority(f) { return /^observed_/.test(f.rule) ? 100 : f.rule in ranks ? ranks[f.rule] : 5; }
  (board.servers || []).forEach(function (srv) {
    var rows = new Map(), issues = new Map(), online = srv.online === true;
    function add(f, session) {
      f = Object.assign({ params: [], since: 0, source: 'status', severity: 'info', session: '' }, f);
      var terminal = f.session && !/^(bg|job|acc):/.test(f.session), key = terminal ? f.session : f.key || f.rule;
      var target = terminal ? rows : issues, previous = target.get(key);
      if (!previous || priority(f) < priority(previous.f)) target.set(key, { f: f, s: srv, session: session || previous && previous.session });
    }
    (srv.sessions || []).forEach(function (session) {
      var ai = session.ai, rule = !online || !ai ? 'observed_unknown' : ai.parked ? 'observed_parked' : ai.status === 'busy' ? 'observed_busy' : ai.status === 'idle' ? 'observed_idle' : ai.status === 'waiting' ? 'observed_waiting' : 'observed_unknown';
      rows.set(session.name, { s: srv, session: session, f: { rule: rule, session: session.name, severity: 'info', params: [], source: 'status', since: 0, routine: true } });
    });
    (srv.findings || []).forEach(function (f) {
      if (!online && f.rule !== 'offline') return;
      var session = (srv.sessions || []).find(function (v) { return v.name === f.session; });
      if (session && session.ai && session.ai.parked && f.rule === 'dormant') f = Object.assign({}, f, { rule: 'observed_parked', routine: true, template: undefined, severity: 'info' });
      if (f.rule === 'finished' || f.rule === 'unknown') f = Object.assign({}, f, { severity: 'info', routine: true });
      add(f, session);
    });
    if (online && supervision && supervision.enabled) {
      var host = (supervision.servers || []).find(function (v) { return v.id === srv.id; });
      var at = host && new Date(host.observedAt || 0).getTime(), freshness = host && host.freshness || {}, maxAge = freshness.maxAgeMs;
      var fresh = host && host.online === true && freshness.snapshotFresh !== false && at > 0 && at <= Date.now() + 5000 && Date.now() - at <= (Number.isFinite(maxAge) && maxAge > 0 ? maxAge : 120000);
      function owner(item, key, audit) {
        if (!fresh || !item.requiresOwner || audit && item.active !== true) return;
        // The leader is busy handling it (e.g. re-running a failed track): do not page the owner yet.
        var lead = !audit && item.session && item.reason && item.reason.code === 'task_track_failed' && (srv.sessions || []).find(function (v) { return v.name === item.session; });
        if (lead && lead.ai && lead.ai.status === 'busy') return;
        var code = typeof item.reason === 'string' ? item.reason : item.reason && item.reason.code || item.code;
        var recovery = item.recovery, unresolved = recovery && recovery.requiresOwner ? recovery.code : code;
        var uncertain = audit ? item.deliveryUncertain === true || ['uncertain', 'opening'].indexOf(item.phase) >= 0 : recovery && recovery.requiresOwner && recovery.delivery === 'uncertain';
        var kind = uncertain || /^(action_uncertain|recovery_uncertain|delivery_uncertain|send_uncertain|prompt_send_uncertain|open_uncertain)$/.test(unresolved) ? 'uncertain' : /^(recovery_no_progress|audit_timeout)$/.test(unresolved) ? 'noresponse' : '';
        // Setup and missing/stale task evidence do not override a measured session state.
        if (!kind && freshness.taskEvidenceFresh === true && !audit) {
          if (item.status === 'waiting_owner' && code === 'owner_decision') kind = 'wait';
          if (item.status === 'blocked' && /^(task_blocked|task_track_failed|session_parked)$/.test(code)) kind = 'blocked';
          if (item.status === 'stalled' && code === 'no_task_progress') kind = 'stalled';
        }
        if (!kind && audit && code === 'audit_waiting_owner') kind = 'wait';
        if (!kind) return;
        var names = host ? Array.from(new Set((host.teams || []).filter(function (t) { return item.root && t.root === item.root && t.session; }).map(function (t) { return t.session; }))) : [];
        var ownerSession = item.session || item.teamSession || (names.length === 1 ? names[0] : '');
        add({ key: 'super/' + srv.id + '/' + key, rule: 'owner', session: ownerSession, ownerKind: kind, reason: item.reason || { code: item.code }, severity: 'urgent', settings: !ownerSession });
      }
      if (host) {
        // Dormant work (nobody leads it, untouched for days) is listed once as dormant, never as needing you.
        (host.teams || []).forEach(function (t) { if (!t.dormant) owner(t, t.id); });
        (host.audits || []).forEach(function (a) { owner(a, a.runId || a.root || 'audit', true); });
      }
    }
    rows.forEach(function (r) { out.push(r); }); issues.forEach(function (r) { out.push(r); });
  });
  return out;
}
if (typeof module !== 'undefined' && module.exports) module.exports = { opsSessionRows: opsSessionRows };
(function () {
  if (typeof window === 'undefined') return;
  var TW = window.TW; if (!TW) return;
  var el = TW.el, page = null, tab = null, data = null, busy = {}, editing = false;
  var pluginPage = null, pluginSnapshot = '', pluginPending = false, pluginRequest = 0, boardError = false, localDelivery = Object.create(null), rulesNode = null, reminderSettings = null;
  var SEV = { urgent: 0, warn: 1, info: 2 };
  // Open/closed state of the collapsible sections, kept across the 10-second redraws (and remembered on this device).
  var opened = {}; try { opened = JSON.parse(localStorage.getItem('tw-ops-open') || '{}') || {}; } catch (e) { opened = {}; }
  function keepOpen(box, id, dflt) {
    box.open = id in opened ? !!opened[id] : dflt;
    box.addEventListener('toggle', function () { opened[id] = box.open; try { localStorage.setItem('tw-ops-open', JSON.stringify(opened)); } catch (e) { /* optional */ } });
  }
  var RULES = ['asking', 'finished', 'dormant', 'aborted', 'unknown', 'bgjob', 'quota', 'exited', 'overload', 'lost', 'offline', 'unheard'];

  // Minutes as a readable span: "45 phút", "3 giờ 20 phút", "1 ngày 2 giờ".
  function span(min) { min = Math.max(0, Math.round(min)); if (min < 60) return i18n('ops.phut', [min]); var h = Math.floor(min / 60); if (h < 24) return i18n('ops.gio_phut', [h, min % 60]); return i18n('ops.ngay_gio', [Math.floor(h / 24), h % 24]); }
  function title(f) { return f.rule === 'custom' ? f.params[0] : f.rule === 'bgjob' ? i18n('ops.r.bgjob', [f.params[0], jobLabel({ tempo: 'blocked', needs: f.params[1] }).text]) : f.rule === 'dormant' ? i18n('ops.r.dormant', [span(f.params[0])]) : i18n('ops.r.' + f.rule, f.params); }
  function who(f) { return f.session.indexOf('bg:') === 0 ? i18n('ops.phien_nen', [f.session.slice(3)]) : f.session.indexOf('job:') === 0 ? i18n('ops.viec_nen', [f.session.slice(4)]) : f.session; }
  function inTerminal(f) { return f.session && !/^(bg|job|acc):/.test(f.session); }
  // A Claude background job in plain words, from the state/tempo/needs Claude wrote; `note` is Claude's own text.
  function jobLabel(j) {
    var needs = j.needs || '';
    if (j.tempo === 'active') return { cls: 'run', text: j.tasks ? i18n('ops.job_active_n', [j.tasks]) : i18n('ops.job_active'), note: j.detail };
    if (j.tempo === 'blocked' || j.state === 'blocked') {
      if (/send a prompt/i.test(needs)) return { cls: 'wait', text: i18n('ops.job_reply'), note: j.detail };
      if (/rate limit|hit your .*limit|usage limit/i.test(needs + ' ' + (j.detail || ''))) return { cls: 'bad', text: i18n('ops.job_limit'), note: needs || j.detail };
      return { cls: 'wait', text: i18n('ops.job_needs'), note: needs || j.detail };
    }
    if (j.state === 'done') return { cls: 'ok', text: i18n('ops.job_done'), note: j.detail };
    if (j.state === 'failed') return { cls: 'bad', text: i18n('ops.job_failed'), note: j.detail };
    if (j.state === 'stopped') return { cls: 'idle', text: i18n('ops.job_stopped'), note: j.detail };
    return { cls: 'idle', text: i18n('ops.job_other', [j.state || '—', j.tempo || '—']), note: j.detail };
  }
  function since(sec) { return sec < 60 ? i18n('ops.vua_moi') : span(sec / 60); }
  function button(label, cls, fn) { var b = el('button', 'btn ' + (cls || ''), label); b.type = 'button'; b.onclick = fn; return b; }
  function post(path, body) { return TW.api('POST', '/api/features/ops' + path, body || {}); }

  // Supervision uses its own persistent DOM: polling never replaces controls or an unfinished edit.
  var supervision = null, supervisionError = false, supervisionPending = false, supervisionFetching = false;
  var supervisionRevision = 0, supervisionBox = null;
  function list(v) { return Array.isArray(v) ? v.filter(function (x) { return x && typeof x === 'object'; }) : []; }
  function text(v) { return typeof v === 'string' || typeof v === 'number' ? String(v) : ''; }
  function explanation(reason) {
    var code = typeof reason === 'string' ? reason : reason && reason.code;
    var key = 'ops.super.reason_' + code, value = i18n(key);
    return value === key ? i18n('ops.super.reason_unknown') : value;
  }
  function stamp(at) {
    var d = new Date(at || 0);
    return at && Number.isFinite(d.getTime()) ? d.toLocaleString(window.TW_I18N ? window.TW_I18N.lang() : undefined) : i18n('ops.super.no_evidence');
  }
  function hostConnected(s) {
    var at = new Date(s.observedAt || 0).getTime(), max = s.freshness && s.freshness.maxAgeMs;
    return s.online === true && Number.isFinite(at) && at > 0 && at <= Date.now() + 5000 && Date.now() - at <= (Number.isFinite(max) && max > 0 ? max : 120000) && !(s.freshness && s.freshness.snapshotFresh === false);
  }
  function hostFresh(s) { return hostConnected(s) && !(s.freshness && s.freshness.taskEvidenceFresh === false); }
  function teamState(s, t) {
    if (!hostFresh(s) || ['progressing', 'idle', 'waiting_owner', 'blocked', 'stalled', 'unknown', 'completed'].indexOf(t.status) < 0) return 'unknown';
    var progress = new Date(t.lastProgressAt || 0).getTime();
    if (t.status === 'progressing' && (!Number.isFinite(progress) || progress <= 0 || progress > Date.now())) return 'unknown';
    // The agent reports itself busy but crew has recorded no round yet: say exactly that, not "unknown".
    var code = t.reason && t.reason.code;
    // A failed track while the leader is busy is the leader fixing it (re-dispatch, fix round): not yet the owner's problem.
    if ((t.status === 'unknown' && code === 'awaiting_task_progress' || t.status === 'blocked' && code === 'task_track_failed') && t.session) { var b = boardSession(s.id, t.session); if (b && b.ai && b.ai.status === 'busy') return 'busy'; }
    return t.status;
  }

  // Crew autopilot settings. Every value shown comes from the backend: the agent's own status file (Claude/Codex),
  // crew files (_crew/tasks, _crew/nudge.conf) and the process table. Missing data is shown as unknown, never inferred.
  var CREW_STATE = { progressing: ['ok', 's_progressing'], idle: ['idle', 's_idle'], waiting_owner: ['wait', 's_waiting'], blocked: ['bad', 's_blocked'],
    stalled: ['wait', 's_stalled'], completed: ['ok', 's_completed'], unknown: ['idle', 's_unknown'], busy: ['ok', 's_busy'] };
  var crewBody = null, crewSwitch = null, crewSwitchNote = null, crewInterval = null, crewMessage = '';
  function c(key, params) { return i18n('ops.crew.' + key, params); }
  function ago(at) {
    var t = new Date(at || 0).getTime(); if (!Number.isFinite(t) || t <= 0 || t > Date.now() + 5000) return '';
    var sec = Math.max(0, (Date.now() - t) / 1000); return sec < 60 ? i18n('ops.vua_moi') : c('ago', [span(sec / 60)]);
  }
  function ids(v) { return Array.isArray(v) ? v.filter(function (x) { return typeof x === 'string' && x; }) : []; }
  function crewOn() { return !!supervision && supervision.enabled === true && supervision.autoEnroll === true; }
  function supervisionCard() {
    if (supervisionBox) return supervisionBox;
    supervisionBox = el('section', 'ops-card ops-super ops-crew');
    supervisionBox.append(el('h3', '', c('title')));
    var how = el('details', 'ops-crew-how'); keepOpen(how, 'crew-how', true);
    how.append(el('summary', '', c('how')));
    [['ok', 'rule_running'], ['idle', 'rule_idle'], ['wait', 'rule_owner'], ['bad', 'rule_blocked']].forEach(function (r) {
      var row = el('div', 'ops-crew-rule'); row.append(el('span', 'ops-crew-dot d-' + r[0]), el('span', '', c(r[1]))); how.append(row);
    });
    var audit = el('p', 'ops-note ops-crew-audit-rule'); how.append(audit, el('p', 'ops-note', c('rule_source')));
    var sw = el('div', 'ops-crew-switch'), label = el('label', 'ops-crew-toggle'), texts = el('div', '');
    crewSwitch = el('input'); crewSwitch.type = 'checkbox'; crewSwitch.name = 'crewAutopilot';
    crewSwitch.onchange = function () {
      var on = crewSwitch.checked;
      crewControl({ enabled: on, autoRecovery: on, autoEnroll: true, intervalMinutes: supervision && supervision.intervalMinutes || 30 }, function (s) { return s.enabled === on && s.autoEnroll === true; });
    };
    label.append(crewSwitch, el('span', 'ops-crew-slider'));
    crewSwitchNote = el('p', 'ops-note');
    texts.append(el('b', '', c('switch')), el('p', 'ops-note', c('switch_help')), crewSwitchNote);
    sw.append(texts, label);
    crewBody = el('div', 'ops-crew-body'); crewBody.setAttribute('aria-live', 'polite');
    var adv = el('details', 'ops-crew-adv'); keepOpen(adv, 'crew-advanced', false);
    adv.append(el('summary', '', c('advanced')));
    crewInterval = el('select'); crewInterval.name = 'crewInterval';
    crewInterval.onchange = function () {
      var v = Number(crewInterval.value);
      crewControl({ enabled: supervision.enabled, intervalMinutes: v }, function (s) { return s.intervalMinutes === v; });
    };
    var il = el('label', 'ops-crew-field'); il.append(el('span', '', c('interval')), crewInterval);
    reminderSettings = el('details', 'ops-reminder-settings'); keepOpen(reminderSettings, 'reminder-settings', false);
    reminderSettings.append(el('summary', '', i18n('ops.reminder_rules')), el('p', 'ops-note', c('reminder_outside')),
      button(i18n('ops.chinh_luat'), 'ops-edit-rules', function () { if (!data || rulesNode && rulesNode.dataset.pending) return; editing = !editing; if (editing && !rulesNode) rulesNode = rulesForm(); if (rulesNode) { if (editing) reminderSettings.append(rulesNode); else rulesNode.remove(); } }));
    adv.append(il, reminderSettings);
    supervisionBox.append(how, sw, crewBody, adv);
    renderSupervision(); return supervisionBox;
  }
  // POST is not authoritative: the change counts only when a fresh GET reads it back.
  function crewControl(body, check) {
    if (supervisionPending || !supervision) return;
    supervisionPending = true; crewMessage = ''; supervisionRevision++; renderSupervision();
    post('/supervision', body).then(function () { return loadSupervision(true); }).then(function () {
      if (!supervision || !check(supervision)) throw Error('readback');
    }).catch(function () { crewMessage = c('save_failed'); }).finally(function () { supervisionPending = false; loadSupervision(true); });
  }
  function boardSession(serverId, name) {
    var srv = data && list(data.servers).find(function (s) { return s.id === serverId; });
    return srv && list(srv.sessions).find(function (s) { return s.name === name; });
  }
  function agentLine(serverId, name) {
    var s = boardSession(serverId, name), ai = s && s.ai;
    if (!ai || !ai.tool) return c('agent_none');
    var st = ai.waitingFor || ai.status === 'waiting' ? 'observed_waiting' : ai.parked ? 'observed_parked' : ai.status === 'busy' ? 'observed_busy' : ai.status === 'idle' ? 'observed_idle' : 'observed_unknown';
    var line = c('agent', [ai.tool === 'codex' ? 'Codex' : ai.tool === 'claude' ? 'Claude' : text(ai.tool), i18n('ops.s.' + st), ago(ai.at) || '—']);
    var workers = list(s.bgAgents);
    if (workers.length) line += ' · ' + c('workers', [workers.length, workers.map(function (w) { return text(w.track) || text(w.kind); }).filter(Boolean).join(', ') || '—']);
    return line;
  }
  function tag(state) { var k = CREW_STATE[state] || CREW_STATE.unknown; return el('span', 'ops-crew-tag t-' + k[0], c(k[1])); }
  function excludedList() { return list(supervision && supervision.excluded).map(function (x) { return { serverId: text(x.serverId), session: text(x.session) }; }); }
  function teamRow(server, d) {
    var team = list(server.teams).find(function (t) { return t.session === d.session && t.root === d.root; });
    var state = d.excluded ? 'unknown' : team ? teamState(server, team) : 'unknown';
    var row = el('div', 'ops-crew-team' + (d.excluded ? ' is-off' : '')), box = el('input'), main = el('div', 'ops-crew-main');
    box.type = 'checkbox'; box.checked = !d.excluded; box.disabled = supervisionPending || !crewOn(); box.title = c('watch'); box.setAttribute('aria-label', c('watch') + ' ' + d.session);
    box.onchange = function () {
      var next = excludedList().filter(function (x) { return !(x.serverId === server.id && x.session === d.session); });
      if (!box.checked) next.push({ serverId: server.id, session: d.session });
      crewControl({ enabled: supervision.enabled, autoEnroll: true, excluded: next }, function (s) { return JSON.stringify(list(s.excluded)) === JSON.stringify(next); });
    };
    var head = el('div', 'ops-crew-head'); head.append(el('b', '', d.session), d.excluded ? el('span', 'ops-crew-tag t-idle', c('excluded')) : tag(state));
    main.append(head, el('div', 'ops-crew-tasks', ids(d.taskIds).length ? ids(d.taskIds).join(' · ') : '—'), el('div', 'ops-note', agentLine(server.id, d.session)));
    if (!d.excluded && team) {
      var detail = [explanation(team.reason)];
      detail.push(team.lastProgressAt ? c('progress', [ago(team.lastProgressAt) || stamp(team.lastProgressAt)]) : c('no_progress'));
      if (team.recovery) detail.push(c('last_nudge', [ago(team.recovery.at) || '—', explanation(team.recovery.code)]));
      var s = boardSession(server.id, d.session);
      if (s && s.ai && s.ai.tool === 'codex') detail.push(c('codex_leader'));
      main.append(el('div', 'ops-note', detail.join(' · ')));
    }
    row.append(box, main); return row;
  }
  // Linux and macOS hosts act; a host whose guard reports no platform support only observes.
  function machineMode(server) {
    // Only the host's own answer counts (Windows without WSL has no tmux); never inferred from the OS name.
    var platformOnly = list(server.coordination).length > 0 && list(server.coordination).every(function (x) { return x.code === 'coordination_platform_unavailable'; });
    if (!hostConnected(server)) return ['bad', 'mode_offline'];
    if (platformOnly) return ['idle', 'mode_watch'];
    return crewOn() ? ['ok', 'mode_auto'] : ['idle', 'mode_off'];
  }
  function bindRow(server, root, taskId) {
    var row = el('div', 'ops-crew-bind'), sel = el('select', 'ops-crew-pick'), leaders = list(server.discovered).map(function (d) { return d.session; });
    var o0 = el('option', '', c('pick')); o0.value = ''; sel.append(o0);
    var b = data && list(data.servers).find(function (s) { return s.id === server.id; });
    list(b && b.sessions).filter(function (s) { return s.agent && leaders.indexOf(s.name) < 0 && !/^tn-/.test(s.name); }).forEach(function (s) { var o = el('option', '', s.name); o.value = s.name; sel.append(o); });
    sel.setAttribute('aria-label', c('pick') + ' ' + taskId);
    var go = button(c('bind'), 'primary', function () {
      if (!sel.value) { TW.app().say(c('pick_first'), false, 2500); return; }
      go.disabled = sel.disabled = true;
      post('/supervision/bind', { serverId: server.id, root: root, session: sel.value, taskId: taskId }).then(function () {
        TW.app().say(c('bound', [sel.value, taskId]), true, 3000);
        setTimeout(function () { loadSupervision(true); }, 1500);
      }).catch(function (e) {
        var key = 'ops.crew.' + (e && /^(invalid_bind|bind_[a-z_]+)$/.test(e.code || '') ? e.code : 'bind_failed'), msg = i18n(key);
        TW.app().say(msg === key ? i18n('ops.crew.bind_failed') : msg, false, 5000);
      }).finally(function () { go.disabled = sel.disabled = false; });
    });
    row.append(el('code', 'ops-crew-id', taskId), sel, go); return row;
  }
  // Open tasks without a leader: recent ones can be bound in one click; dormant ones collapse into one line.
  function unboundBlock(server) {
    // A task already held by a discovered leader is that leader's, even before its identity is verified.
    var held = [].concat.apply([], list(server.discovered).map(function (d) { return ids(d.taskIds); }));
    var box = el('div', 'ops-crew-unbound'), un = list(server.teams).filter(function (t) { return !t.session && ids(t.taskIds).length && t.status !== 'completed' && !ids(t.taskIds).every(function (id) { return held.indexOf(id) >= 0; }); });
    var active = un.filter(function (t) { return !t.dormant; }), dormant = un.filter(function (t) { return t.dormant; });
    var count = function (g) { return g.reduce(function (n, t) { return n + ids(t.taskIds).length; }, 0); };
    if (active.length) {
      box.append(el('p', 'ops-note', c('unbound_active', [count(active)])));
      active.forEach(function (t) { ids(t.taskIds).forEach(function (id) { box.append(bindRow(server, t.root, id)); }); });
    }
    if (dormant.length) {
      var d = el('details', 'ops-crew-dormant'), all = [].concat.apply([], dormant.map(function (t) { return ids(t.taskIds); }));
      d.append(el('summary', 'ops-note', c('dormant', [count(dormant)])), el('p', 'ops-note', c('dormant_hint')), el('p', 'ops-note ops-crew-ids', all.join(' · ')));
      box.append(d);
    }
    return active.length || dormant.length ? box : null;
  }
  function crewMachine(server, inSettings) {
    var found = list(server.discovered), m = el('div', 'ops-crew-machine'), h = el('div', 'ops-crew-mhead'), mode = machineMode(server);
    h.append(el('b', '', text(server.name)), el('span', 'ops-crew-tag t-' + mode[0], c(mode[1])),
      el('span', 'ops-note', hostConnected(server) ? c('observed', [ago(server.observedAt) || stamp(server.observedAt)]) : c('offline', [stamp(server.observedAt)])));
    m.append(h);
    found.forEach(function (d) { m.append(teamRow(server, d)); });
    var ub = unboundBlock(server); if (ub) m.append(ub);
    if (!found.length && !ub) m.append(el('p', 'ops-note', c('no_crew')));
    var last = list(server.audits).filter(function (a) { return !a.active; }).pop();
    if (inSettings && crewOn() && last) m.append(el('p', 'ops-note', c('audit_last', [ago(last.createdAt) || stamp(last.createdAt), explanation(last.reason)])));
    return m;
  }
  // Session side panel: what crew work this session leads (only when it is a discovered leader), from the same data.
  var crewDetails = {};
  var TRACK_DONE = ['merged', 'done', 'landed', 'applied', 'closed'];
  function trackLabel(state) { var k = 'ops.crew.track_' + state, v = i18n(k); return v === k ? text(state) : v; }
  function crewDetail(box, serverId, name) {
    box.textContent = '';
    var server = crewOn() && list(supervision.servers).find(function (v) { return v.id === serverId; });
    var d = server && list(server.discovered).find(function (x) { return x.session === name; });
    box.hidden = !d; if (!d) return;
    var team = list(server.teams).find(function (t) { return t.session === name && t.root === d.root; });
    var head = el('div', 'ops-crew-head'); head.append(el('h3', '', c('detail_title')), d.excluded ? el('span', 'ops-crew-tag t-idle', c('excluded')) : tag(team ? teamState(server, team) : 'unknown'));
    box.append(head);
    // Per task: title, tracks done / total, and one chip per track (state from the crew MANIFEST; "running" when a worker for
    // that track is alive in this session's process tree).
    var live = list((boardSession(serverId, name) || {}).bgAgents).map(function (w) { return text(w.track); });
    var tasks = list(team && team.tasks);
    if (!tasks.length) box.append(el('div', 'ops-crew-tasks', ids(d.taskIds).join(' · ') || '—'));
    tasks.forEach(function (t) {
      var tr = list(t.tracks), done = tr.filter(function (k) { return TRACK_DONE.indexOf(k.state) >= 0; }).length;
      var card = el('div', 'ops-crew-task');
      card.append(el('b', 'ops-crew-task-title', text(t.title) || text(t.id)), el('small', 'ops-note', text(t.id) + ' · ' + text(t.status)));
      if (tr.length) {
        var bar = el('div', 'ops-crew-bar'), fill = el('i'); fill.style.width = Math.round(done / tr.length * 100) + '%'; bar.append(fill);
        card.append(el('small', 'ops-note', c('tracks_done', [done, tr.length])), bar);
        var chips = el('div', 'ops-crew-chips');
        tr.forEach(function (k) {
          var running = live.indexOf(text(k.id)) >= 0, cls = running ? 'run' : TRACK_DONE.indexOf(k.state) >= 0 ? 'done' : /fail|blocked/.test(k.state) ? 'bad' : 'wait';
          var chip = el('button', 'ops-crew-chip c-' + cls, text(k.id) + ' ' + (running ? c('track_running') : trackLabel(k.state)) + (k.fixRounds ? ' · fix ' + k.fixRounds : ''));
          chip.type = 'button'; chip.title = c('track_open');
          chip.onclick = function () { trackPopup(serverId, d.root, t, k, running); };
          chips.append(chip);
        });
        card.append(chips);
      }
      box.append(card);
    });
    box.append(el('div', 'ops-note', agentLine(serverId, name)));
    if (team) box.append(el('div', 'ops-note', team.lastProgressAt ? c('progress', [ago(team.lastProgressAt) || stamp(team.lastProgressAt)]) : c('no_progress')));
    box.append(button(c('detail_open'), 'ghost', function () { TW.app().setView('ops'); }));
  }
  // What one track really did: its rounds, why it failed or is blocked (newest file first, with its time), the worker's last
  // message and report, and the tail of its newest log. Read from the track folder on its machine.
  function trackPopup(serverId, root, t, k, running) {
    var dlg = el('dialog', 'ops-track-dlg'), head = el('div', 'ops-track-head'), body = el('div', 'ops-track-body');
    head.append(el('b', '', text(k.id) + ' · ' + (text(t.title) || text(t.id))), button(i18n('ops.dong'), 'ghost', function () { dlg.close(); }));
    body.append(el('p', 'ops-note', c('track_state', [trackLabel(k.state), running ? c('track_running') : '—', text(t.id)])), el('p', 'ops-note', i18n('ops.loading')));
    dlg.append(head, body); document.body.append(dlg); dlg.addEventListener('close', function () { dlg.remove(); });
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
    var q = 'server=' + encodeURIComponent(serverId) + '&root=' + encodeURIComponent(root) + '&task=' + encodeURIComponent(t.id) + '&track=' + encodeURIComponent(k.id);
    // Live: while the popup is open, re-read the worker's newest log every 3 s and show what it is doing now.
    var liveBox = el('section', 'ops-track-live'), liveHead = el('div', 'ops-track-live-head'), liveList = el('ol', 'ops-track-feed');
    liveBox.append(liveHead, liveList); liveBox.hidden = true; body.insertBefore(liveBox, body.firstChild.nextSibling);
    var ICON = { exec: '▶', say: '💬', think: '…', patch: '✎', tokens: '∑' }, timer = null;
    function drawLive(r) {
      var fresh = r && r.logAt && Date.now() - r.logAt < 120000;
      liveBox.hidden = !(running || fresh) || !r || !list(r.feed).length; if (liveBox.hidden) return;
      liveHead.textContent = c('track_live', [text(r.logName), ago(r.logAt) || stamp(r.logAt)]);
      var stick = liveList.scrollTop + liveList.clientHeight >= liveList.scrollHeight - 8;
      liveList.textContent = '';
      list(r.feed).forEach(function (e, i, all) {
        var li = el('li', 'f-' + text(e.kind) + (e.ok === false ? ' f-bad' : ''));
        var mark = e.kind === 'exec' ? (e.ok === null ? '⏳' : e.ok ? '✓' : '✗ ' + (e.code != null ? e.code : '')) : '';
        li.append(el('span', 'f-at', new Date(e.at).toLocaleTimeString(i18n('lang.locale'), { hour: '2-digit', minute: '2-digit', second: '2-digit' })), el('span', 'f-ic', ICON[e.kind] || '•'), el('span', 'f-tx', text(e.text)), el('span', 'f-ok', mark));
        if (i === all.length - 1 && e.kind === 'exec' && e.ok === null) li.classList.add('f-now');
        liveList.append(li);
      });
      if (stick) liveList.scrollTop = liveList.scrollHeight;
    }
    function pollLive() {
      if (!dlg.isConnected) return;
      TW.api('GET', '/api/features/crewpack/track?' + q + '&live=1').then(drawLive).catch(function () {}).finally(function () { if (dlg.isConnected) timer = setTimeout(pollLive, 3000); });
    }
    dlg.addEventListener('close', function () { clearTimeout(timer); });
    pollLive();
    TW.api('GET', '/api/features/crewpack/track?' + q).then(function (r) {
      body.lastChild.remove();
      var rounds = list(r.rounds);
      if (rounds.length) {
        var last = rounds[rounds.length - 1];
        body.append(el('p', 'ops-track-last', c('track_last', [text(last.round), text(last.kind), text(last.exit), Math.round((last.seconds || 0) / 60), text(last.executor) + ' ' + text(last.model) + ' ' + text(last.effort), stamp(Date.parse(last.endedAt))])));
        var table = el('table', 'ops-track-rounds'), hr = el('tr');
        ['#', c('col_kind'), c('col_exit'), c('col_time'), c('col_model'), c('col_end')].forEach(function (h) { hr.append(el('th', '', h)); }); table.append(hr);
        rounds.slice().reverse().forEach(function (x) { var tr = el('tr'); [x.round, x.kind, x.exit, Math.round((x.seconds || 0) / 60) + "'", text(x.model) + ' ' + text(x.effort), stamp(Date.parse(x.endedAt))].forEach(function (v) { tr.append(el('td', '', text(v))); }); table.append(tr); });
        body.append(table);
      } else body.append(el('p', 'ops-note', c('track_no_rounds')));
      var ch = r.changes || {}, commits = list(ch.commits);
      var cs = el('details', 'ops-track-file'); cs.open = true;
      cs.append(el('summary', '', c('track_changes', [text(ch.repo) || '—', text(ch.branch) || '—', commits.length])));
      if (commits.length) { var ul = el('ul', 'ops-track-commits'); commits.forEach(function (x) { ul.append(el('li', '', text(x.sha) + ' · ' + text(x.at) + ' · ' + text(x.subject))); }); cs.append(ul); }
      else cs.append(el('p', 'ops-note', c('track_no_commits')));
      if (ch.stat) cs.append(el('pre', '', text(ch.stat)));
      body.append(cs);
      var files = r.files && typeof r.files === 'object' ? Object.keys(r.files).map(function (n) { return { n: n, f: r.files[n] }; }) : [];
      files.sort(function (a, b) { return (b.f.at || 0) - (a.f.at || 0); });
      files.forEach(function (x) {
        var sec = el('details', 'ops-track-file'); if (x === files[0]) sec.open = true;
        sec.append(el('summary', '', x.n + ' · ' + (ago(x.f.at) || stamp(x.f.at))), el('pre', '', text(x.f.text)));
        body.append(sec);
      });
      if (r.log) { var lg = el('details', 'ops-track-file'); lg.append(el('summary', '', c('track_log', [text(r.logName)])), el('pre', '', text(r.log))); body.append(lg); }
      if (r.dispatch) { var dp = el('details', 'ops-track-file'); dp.append(el('summary', '', 'dispatch.out'), el('pre', '', text(r.dispatch))); body.append(dp); }
    }).catch(function () { body.lastChild.textContent = c('track_unavailable'); });
  }
  function refreshCrewDetails() {
    Object.keys(crewDetails).forEach(function (k) { var e = crewDetails[k]; if (!e.box.isConnected) { delete crewDetails[k]; return; } crewDetail(e.box, e.serverId, e.name); });
  }
  if (TW.addDetailSection) TW.addDetailSection(function (x) {
    var box = el('section', 'ops-crew-detail'); box.hidden = true;
    crewDetails[x.v.id + '/' + x.s.name] = { box: box, serverId: x.v.id, name: x.s.name }; crewDetail(box, x.v.id, x.s.name); return box;
  });
  function needYou() {
    var out = [];
    if (!crewOn()) return out;
    list(supervision.servers).forEach(function (server) {
      var off = excludedList().filter(function (x) { return x.serverId === server.id; }).map(function (x) { return x.session; });
      list(server.teams).forEach(function (t) {
        if (t.session && off.indexOf(t.session) >= 0) return;
        if (t.dormant) return; // untouched for days and nobody leads it: shown once under "dormant", not as needing you
        var st = teamState(server, t);
        if (['waiting_owner', 'blocked', 'stalled'].indexOf(st) >= 0 || t.recovery && t.recovery.requiresOwner) {
          out.push({ server: server, session: t.session, who: t.session || ids(t.taskIds).join(', '), why: explanation(t.recovery && t.recovery.requiresOwner ? t.recovery.code : t.reason), tasks: ids(t.taskIds), bad: st === 'blocked' });
        }
      });
      var a = list(server.audits).filter(function (x) { return x.requiresOwner; }).pop();
      if (a) out.push({ server: server, who: 'ops-audit', why: explanation(a.reason), tasks: [], bad: false });
    });
    list(supervision.auditReadiness).forEach(function (a) {
      if (!a.requiresOwner || a.code === 'host_unavailable') return;
      var server = list(supervision.servers).find(function (s) { return s.id === a.serverId; });
      // ops-audit only matters where a crew leader works: a workspace with no team needs no audit account.
      if (server && !list(server.discovered).some(function (d) { return d.root === a.root && !d.excluded; })) return;
      if (server) out.push({ server: server, who: c('audit_account_who'), why: explanation(a.code) + ' · ' + text(a.root), tasks: [], bad: false });
    });
    return out;
  }
  function renderSupervision() {
    if (!crewBody) return;
    crewBody.textContent = '';
    var on = crewOn(), legacy = !!supervision && supervision.enabled && !supervision.autoEnroll;
    crewSwitch.checked = on; crewSwitch.disabled = supervisionPending || !supervision;
    var minutes = supervision && supervision.intervalMinutes || 30;
    supervisionBox.querySelector('.ops-crew-audit-rule').textContent = c('rule_audit', [minutes]);
    crewSwitchNote.textContent = !supervision ? '' : legacy ? c('legacy', [list(supervision.leaders).length]) : on ? c('on', [minutes]) : c('off');
    var opts = [15, 30, 60]; if (opts.indexOf(minutes) < 0) opts.push(minutes);
    if (crewInterval.dataset.opts !== opts.join()) { crewInterval.textContent = ''; opts.sort(function (a, b) { return a - b; }).forEach(function (m) { var o = el('option', '', c('minutes', [m])); o.value = String(m); crewInterval.append(o); }); crewInterval.dataset.opts = opts.join(); }
    crewInterval.value = String(minutes); crewInterval.disabled = supervisionPending || !supervision || !supervision.enabled;
    if (supervisionPending) crewBody.append(el('p', 'ops-super-alert', c('saving')));
    if (crewMessage) crewBody.append(el('p', 'ops-super-alert', crewMessage));
    if (!supervision) { crewBody.append(el('p', 'ops-super-alert', i18n(supervisionError ? 'ops.super.unavailable' : 'ops.super.loading'))); return; }
    list(supervision.errors).forEach(function (e) { crewBody.append(el('p', 'ops-super-alert', explanation(e))); });
    if (on) {
      var need = needYou(), nb = el('div', 'ops-crew-need');
      nb.append(el('h4', '', c('need_you', [need.length])));
      if (!need.length) nb.append(el('p', 'ops-note', c('none_need')));
      need.forEach(function (n) {
        var item = el('div', 'ops-crew-item' + (n.bad ? ' is-bad' : ''));
        item.append(el('b', '', text(n.server.name) + ' · ' + n.who), el('span', '', ' — ' + n.why));
        if (n.tasks.length) item.append(el('div', 'ops-note', n.tasks.join(' · ')));
        nb.append(item);
      });
      crewBody.append(nb);
    }
    crewBody.append(el('h4', '', c('teams')));
    var any = false;
    if (on) list(supervision.servers).forEach(function (server) {
      if (!list(server.discovered).length && !list(server.teams).some(function (t) { return !t.session && ids(t.taskIds).length && t.status !== 'completed'; }) && hostConnected(server)) return;
      any = true; crewBody.append(crewMachine(server, true));
    });
    if (!any) crewBody.append(el('p', 'ops-note', on ? c('no_teams') : c('no_teams_off')));
  }

  function loadSupervision(force) {
    if ((!force && supervisionFetching) || (supervisionPending && !force)) return Promise.resolve();
    var revision = ++supervisionRevision; supervisionFetching = true;
    return TW.api('GET', '/api/features/ops/supervision').then(function (r) {
      if (revision !== supervisionRevision) return;
      if (!r || typeof r.enabled !== 'boolean' || !Array.isArray(r.servers)) throw Error('invalid supervision');
      supervision = r; supervisionError = false;
    }).catch(function () { if (revision === supervisionRevision) { supervision = null; supervisionError = true; } })
      .finally(function () { supervisionFetching = false; renderSupervision(); draw(); refreshCrewDetails(); });
  }

  // Short status for the second half of a row ("<session> — <status>"); the session or job name is the first half.
  function status(f) {
    if (f.rule === 'owner') return i18n('ops.owner_' + f.ownerKind);
    if (f.rule.indexOf('observed_') === 0) return i18n('ops.s.' + f.rule);
    if (f.rule === 'unheard') return i18n(f.code === 'OPS_NOT_SENT' ? 'ops.delivery_failed' : f.code && f.code !== 'OPS_NO_RESPONSE' ? 'ops.delivery_uncertain' : 'ops.delivery_noresponse');
    if (f.rule === 'custom') return f.params[0];
    if (f.rule === 'bgjob') return jobLabel({ tempo: 'blocked', needs: f.params[1] }).text;
    if (f.rule === 'dormant') return i18n('ops.s.dormant', [span(f.params[0])]);
    if (f.rule === 'quota') return i18n('ops.s.quota', f.params) + (f.alt ? ' · ' + i18n('ops.goi_y_tk', [f.alt.name, 100 - f.alt.used]) : ' · ' + i18n('ops.khong_tk_khac'));
    return i18n('ops.s.' + f.rule, f.params);
  }
  // AI accounts near a limit, from the token readings TERMNEST already makes (Token AI tab); threshold from the pack.
  var tokens = null;
  function loadTokens() { return TW.api('GET', '/api/tokens?zone=' + encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)).then(function (r) { tokens = r; }).catch(function () { /* optional */ }); }
  // The account of the same tool with the most room left (highest of its 5-hour and weekly use, lowest wins). A suggestion only.
  function used(a) { var l = a.limits || {}, v = [l.session, l.weekly].filter(function (x) { return x && Number.isFinite(x.percent); }).map(function (x) { return x.percent; }); return v.length ? Math.max.apply(null, v) : null; }
  function bestOther(a) {
    var best = null; (tokens.accounts || []).forEach(function (b) { if (b.id === a.id || b.tool !== a.tool) return; var u = used(b); if (u == null || u >= (data.pack.rules.quota.pct || 90)) return; if (!best || u < best.u) best = { u: u, b: b }; });
    return best ? { name: best.b.nickname || ((best.b.tool === 'claude' ? 'Claude' : 'Codex') + (best.b.email ? ' · ' + best.b.email : '')), used: Math.round(best.u) } : null;
  }
  function quotaFindings() {
    var rule = data && data.pack.rules.quota, out = [];
    if (!rule || rule.level === 'off' || !tokens || !tokens.accounts) return out;
    tokens.accounts.forEach(function (a) {
      var limits = [['session', 'ops.han_5_gio'], ['weekly', 'ops.han_tuan']].filter(function (w) { return a.limits && a.limits[w[0]] && a.limits[w[0]].percent >= rule.pct; }).sort(function (aKey, bKey) { return a.limits[bKey[0]].percent - a.limits[aKey[0]].percent; });
      limits.slice(0, 1).forEach(function (w) {
        var x = a.limits && a.limits[w[0]]; if (!x || !(x.percent >= rule.pct)) return;
        var name = a.nickname || ((a.tool === 'claude' ? 'Claude' : 'Codex') + (a.email ? ' · ' + a.email : ''));
        out.push({ key: 'acct/' + a.id + '/' + w[0], rule: 'quota', server: '', session: 'acc:' + name, severity: x.percent >= 100 ? 'urgent' : 'warn', level: 'notify', since: 0, params: [Math.round(x.percent), i18n(w[1])], source: 'machine', alt: bestOther(a) });
      });
    });
    return out;
  }
  function label(f) { return /^(bg|acc):/.test(f.session) ? f.session.slice(f.session.indexOf(':') + 1) : f.session.indexOf('job:') === 0 ? f.session.slice(4) : f.session; }
  var PATHS = {
    ask: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.2"/><path d="M12 16.5h.01"/>',
    idle: '<circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/>',
    job: '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>',
    quota: '<path d="M4 18a8 8 0 1 1 16 0"/><path d="M12 18l4-6"/>',
    issue: '<path d="M12 3l10 18H2L12 3z"/><path d="M12 10v4"/><path d="M12 17.5h.01"/>',
    machine: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
    crew: '<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0"/><circle cx="17" cy="9" r="2.5"/><path d="M15.5 20a5 5 0 0 1 6.5-4.7"/>',
    plug: '<path d="M9 3v5M15 3v5"/><path d="M6 8h12v3a6 6 0 0 1-12 0V8z"/><path d="M12 17v4"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
    log: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  };
  function icon(name) { var i = el('span', 'ops-ic ic-' + name); i.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (PATHS[name] || '') + '</svg>'; return i; }
  // Which group a finding belongs to.
  function group(f) {
    if (f.rule === 'asking') return 'ask';
    if (f.rule === 'dormant' || f.rule === 'finished') return 'idle';
    if (f.rule === 'bgjob') return 'job';
    if (f.rule === 'overload' || f.rule === 'offline' || f.rule === 'lost') return 'machine';
    if (f.rule === 'quota') return 'quota';
    return 'issue';
  }

  function row(f, srv) {
    var r = el('div', 'ops-row ' + f.severity), t = el('div', 'ops-t'), acts = el('div', 'ops-acts'), line = el('div', 'ops-line');
    r.dataset.rule = f.rule; r.dataset.server = srv.id; r.dataset.session = f.session || '';
    r.append(el('span', 'ops-dot'));
    var name = label(f) || srv.name;
    line.append(el('b', 'ops-name', name), el('span', 'ops-status', status(f)));
    var meta = el('small', 'ops-meta');
    meta.append(document.createTextNode([f.session ? srv.name : '', f.since ? since(f.since) : ''].filter(Boolean).join(' · ')));
    t.append(line, meta); r.append(t);
    if (f.rule === 'offline') {
      var reconnect = button(i18n('ops.reconnect'), '', function () {
        if (busy[srv.id]) return; busy[srv.id] = true; reconnect.disabled = true;
        TW.api('POST', '/api/servers/' + encodeURIComponent(srv.id) + '/connect', {}).then(load).catch(function () { TW.app().say(i18n('ops.connect_failed'), false, 4000); }).finally(function () { busy[srv.id] = false; reconnect.disabled = false; });
      }); acts.append(reconnect);
    }
    if (inTerminal(f) && f.rule !== 'offline') acts.append(button(i18n('ops.mo'), '', function () { TW.app().openSession(srv.id, f.session); }));
    if (f.rule === 'quota') acts.append(button(i18n('ops.view_accounts'), '', function () { TW.app().setView('token'); }));
    if (f.settings) acts.append(button(i18n('ops.settings_shortcut'), '', function () { TW.app().openSettings('sessions'); }));
    var session = (srv.sessions || []).find(function (s) { return s.name === f.session; }), ai = session && session.ai;
    var recent = (data.log || []).find(function (n) { return n.server === srv.id && n.session === f.session; }), receipt = localDelivery[f.key];
    var reserved = receipt || recent && (['pending', 'uncertain', 'exhausted'].indexOf(recent.delivery) >= 0 || recent.delivery === 'delivered' && ai && (recent.idleAt === ai.at || recent.at >= ai.at));
    if (reserved && f.rule !== 'unheard' && !(f.rule === 'owner' && ['uncertain', 'noresponse'].indexOf(f.ownerKind) >= 0)) t.append(el('small', 'ops-delivery', deliveryLabel(receipt || recent)));
    if (!boardError && f.rule === 'dormant' && f.template && ['suggest', 'auto'].indexOf(f.level) >= 0 && srv.online === true && ai && ai.status === 'idle' && !ai.parked && Number.isFinite(ai.at) && ai.at > 0 && ai.at <= Date.now() && (!reserved || busy[f.key])) {
      var send = button(i18n('ops.gui_nhac'), 'primary', function () {
        if (busy[f.key]) return; busy[f.key] = true; send.disabled = true;
        var intent = { delivery: 'pending', server: srv.id, session: f.session, idleAt: ai.at, requestedAt: Date.now() }; localDelivery[f.key] = intent;
        post('/nudge', { server: srv.id, key: f.key }).then(function (r) {
          if (localDelivery[f.key] && localDelivery[f.key] !== intent) return;
          if (r && r.delivery === 'delivered') intent.delivery = 'delivered';
          TW.app().say(deliveryLabel(intent), true, 3000);
        }).catch(function (e) {
          if (localDelivery[f.key] && localDelivery[f.key] !== intent) return;
          if (intent.delivery === 'delivered' || intent.responded === true || intent.verified === true) {
            TW.app().say(deliveryLabel(intent), true, 3000); return;
          }
          // An HTTP rejection with a known non-delivery code may be retried after a fresh board read.
          if (e.code && ['OPS_DELIVERY_UNCERTAIN', 'OPS_ONCE', 'OPS_INFLIGHT'].indexOf(e.code) < 0 && localDelivery[f.key] === intent) delete localDelivery[f.key];
          else if (intent.delivery !== 'delivered') intent.delivery = 'uncertain';
          TW.app().say(e.message || i18n('ops.delivery_uncertain'), false, 4000);
        }).finally(function () { busy[f.key] = false; load(); });
      });
      // The message it would type, on hover and for screen readers, instead of a code block on every row.
      send.title = i18n('ops.se_gui', [data.pack.templates[f.template] || '']); send.setAttribute('aria-label', send.title);
      send.disabled = !!busy[f.key]; acts.append(send);
    }
    if (f.key && !f.settings && f.rule !== 'owner') acts.append(button(i18n('ops.bo_qua'), 'ghost', function () { post('/dismiss', { key: f.key }).then(load); }));
    r.append(acts); return r;
  }

  // One card per machine: mode and session counts; clicking a card filters the page to it.
  var filt = { srv: '' };
  function machines(all, crewNeed) {
    var box = el('div', 'ops-machines');
    data.servers.forEach(function (v) {
      var ss = list(v.sessions).filter(function (s) { return s.agent; }), need = all.filter(function (x) { return x.s.id === v.id && dailyGroup(x) === 'attention'; }).length + crewNeed.filter(function (n) { return n.server.id === v.id; }).length;
      var busy = ss.filter(function (s) { return s.ai && s.ai.status === 'busy'; }).length, idle = ss.filter(function (s) { return s.ai && s.ai.status === 'idle'; }).length;
      var sup = supervision && list(supervision.servers).find(function (x) { return x.id === v.id; }), mode = sup ? machineMode(sup) : v.online === true ? null : ['bad', 'mode_offline'];
      var card = el('button', 'ops-mc'); card.type = 'button'; card.setAttribute('aria-pressed', String(filt.srv === v.id));
      card.append(el('b', 'ops-mc-name', v.name));
      if (mode) card.append(el('span', 'ops-crew-tag t-' + mode[0], c(mode[1])));
      var nums = el('div', 'ops-mc-nums');
      nums.append(el('span', '', i18n('ops.m.busy', [busy])), el('span', '', i18n('ops.m.idle', [idle])), el('span', need ? 'is-need' : '', i18n('ops.m.need', [need])));
      card.append(nums);
      card.onclick = function () { filt.srv = filt.srv === v.id ? '' : v.id; draw(); };
      box.append(card);
    });
    return box;
  }

  // Every Claude background job on every machine, as Claude itself reports it.
  function jobList() {
    var rows = [];
    data.servers.forEach(function (srv) { (srv.jobs || []).forEach(function (j) { rows.push({ srv: srv, j: j, l: jobLabel(j) }); }); });
    var order = { run: 0, wait: 1, bad: 2, ok: 3, idle: 4 };
    rows.sort(function (a, b) { return (order[a.l.cls] - order[b.l.cls]) || (b.j.at - a.j.at); });
    var box = el('details', 'ops-card ops-ev ops-jobs'), sum = el('summary', 'ops-card-h'), n = { run: 0, wait: 0 };
    rows.forEach(function (r) { if (r.l.cls === 'run') n.run++; else if (r.l.cls === 'wait' || r.l.cls === 'bad') n.wait++; });
    keepOpen(box, 'jobs', rows.length > 0 && rows.length <= 20);
    var jh = el('h3', ''); jh.append(icon('job'), document.createTextNode(i18n('ops.viec_nen_ten')), el('span', 'ops-count', String(rows.length)));
    sum.append(jh, el('small', 'ops-pack', i18n('ops.viec_nen_tom_tat', [n.run, n.wait, rows.length - n.run - n.wait])));
    box.append(sum);
    if (!rows.length) { box.append(el('p', 'ops-empty', i18n('ops.viec_nen_trong'))); return box; }
    rows.forEach(function (r) {
      var row = el('div', 'ops-job'), t = el('div', 'ops-t');
      t.append(el('b', '', r.j.name || r.j.id), el('small', '', r.srv.name + ' · ' + i18n('ops.cap_nhat', [since(Math.max(0, (Date.now() - r.j.at) / 1000))])));
      if (r.l.note) t.append(el('code', 'ops-msg', i18n('ops.claude_ghi', [r.l.note])));
      row.append(el('span', 'ops-st ' + r.l.cls, r.l.text), t); box.append(row);
    });
    return box;
  }

  // "Plugin & skill": what Claude Code itself reports per machine and account, which open sessions started before a plugin
  // changed, and one button to bring them up to date in place (/reload-plugins when Claude reports idle).
  var plug = null, pluginFeedback = '';
  function pluginNotice(message) {
    pluginFeedback = message;
    var note = pluginPage && pluginPage.querySelector('.pl-feedback');
    if (note) note.textContent = message;
  }
  function openPluginUpdate(id, name, attempt) {
    var app = TW.app();
    return app.refresh().then(function () {
      var server = app.servers().find(function (v) { return v.id === id; });
      if (server && server.sessions.some(function (s) { return s.name === name; })) {
        var dlg = document.getElementById('dlg-set');
        if (dlg && dlg.open) dlg.close();
        pluginNotice('');
        app.openSession(id, name);
        app.say(i18n('pl.dang_cap_nhat', [name]), true, 4000);
        return;
      }
      if (attempt >= 2) throw new Error(i18n('pl.khong_tim_thay_phien', [name]));
      // /api/state reads the server snapshot; cover its normal 3s polling cycle.
      return new Promise(function (resolve) { setTimeout(resolve, 1750); }).then(function () { return openPluginUpdate(id, name, attempt + 1); });
    });
  }
  function pluginError(e) {
    pluginNotice(e.message);
  }
  function drawPlugins() {
    if (!pluginPage || pluginPending) return;
    var snapshot = JSON.stringify(plug);
    if (pluginPage.firstChild && snapshot === pluginSnapshot) return;
    var active = document.activeElement, controls = Array.from(pluginPage.querySelectorAll('summary,input,button'));
    var focusIndex = controls.indexOf(active), focusKey = active && active.dataset.pluginFocus, bar = pluginPage.querySelector('.pl-bar');
    var card = pluginCard();
    // Keep the preference and refresh controls themselves, including pending handlers and pointer focus.
    if (bar) {
      bar.querySelector('input').checked = !!plug.autoReload;
      card.querySelector('.pl-bar').replaceWith(bar);
    }
    pluginSnapshot = snapshot; pluginPage.replaceChildren(card);
    if (focusIndex >= 0) {
      var target = card.contains(active) ? active : focusKey ? Array.from(card.querySelectorAll('[data-plugin-focus]')).find(function (n) { return n.dataset.pluginFocus === focusKey; }) : card.querySelector('summary');
      (target || card.querySelector('summary')).focus({ preventScroll: true });
    }
  }
  function when(ms) { return ms ? new Date(ms).toLocaleString(window.TW_I18N ? window.TW_I18N.lang() : undefined, { dateStyle: 'short', timeStyle: 'short' }) : '—'; }
  function pluginCard() {
    var box = el('details', 'ops-card ops-ev ops-plug'), sum = el('summary', 'ops-card-h'); keepOpen(box, 'plugins', true);
    var stale = 0; ((plug && plug.servers) || []).forEach(function (v) { stale += v.stale.length; });
    var h3 = el('h3', ''); h3.append(icon('plug'), document.createTextNode(i18n('pl.tieu_de')));
    if (stale) h3.append(el('span', 'ops-count warn', String(stale)));
    sum.append(h3, el('small', 'ops-pack', i18n('pl.nguon'))); box.append(sum);
    if (!plug) { box.append(el('p', 'ops-empty', i18n('pl.dang_doc'))); return box; }
    var bar = el('div', 'pl-bar'), auto = el('label', 'pl-auto'), cb = el('input'); cb.type = 'checkbox'; cb.checked = !!plug.autoReload;
    cb.onchange = function () {
      if (pluginPending) return;
      pluginPending = true; ++pluginRequest; cb.disabled = true;
      TW.api('POST', '/api/features/plugins/auto', { on: cb.checked }).then(function () { return loadPlugins(true); }).catch(pluginError).finally(function () {
        pluginPending = false; cb.disabled = false; cb.checked = !!plug.autoReload; drawPlugins();
      });
    };
    auto.append(cb, el('span', '', i18n('pl.tu_nap_lai'))); bar.append(auto);
    bar.append(button(i18n('pl.kiem_lai'), 'ghost', function () { Promise.all(plug.servers.map(function (v) { return TW.api('POST', '/api/features/plugins/refresh', { server: v.id }); })).then(function () { if (!pluginPending) return loadPlugins(true); }).catch(pluginError); }));
    var feedback = el('p', 'ops-note pl-feedback', pluginFeedback); feedback.setAttribute('role', 'status'); box.append(bar, feedback);
    plug.servers.forEach(function (v) {
      var sec = el('div', 'pl-srv'), head = el('div', 'pl-srv-h');
      head.append(el('b', '', v.local ? i18n('app.local_name') : v.name), el('small', '', v.scanned ? i18n('pl.doc_luc', [when(v.scanned)]) : i18n('pl.chua_doc')));
      sec.append(head);
      if (v.windows) { sec.append(el('p', 'ops-note', i18n('pl.windows'))); box.append(sec); return; }
      if (v.noClaude) { sec.append(el('p', 'ops-note', i18n('pl.khong_co_claude'))); box.append(sec); return; }
      if (v.error) sec.append(el('p', 'ops-note', v.error));
      v.accounts.forEach(function (a) {
        a.plugins.forEach(function (pg) {
          var r = el('div', 'pl-row'), t = el('div', 'ops-t'), line = el('div', 'ops-line');
          line.append(el('b', 'ops-name', pg.id.split('@')[0]), el('span', 'pl-ver', pg.running || pg.version || '—'));
          if (pg.folder) line.append(el('span', 'ops-src status', i18n('pl.tu_thu_muc')));
          if (!pg.usedBySessions && !pg.enabled) line.append(el('span', 'ops-src', i18n('pl.khong_bat_o_day')));
          var meta = el('small', 'ops-meta'); meta.append(document.createTextNode([a.cfg, pg.scope, i18n('pl.doi_luc', [when(pg.changedAt)]), pg.folder && pg.version !== pg.running ? i18n('pl.ban_ghi', [pg.version]) : ''].filter(Boolean).join(' · ')));
          t.append(line, meta); r.append(el('span', 'ops-dot'), t);
          var acts = el('div', 'ops-acts');
          if (!pg.folder) {
            var update = button(i18n('pl.cap_nhat'), '', function () {
              TW.api('POST', '/api/features/plugins/update', { server: v.id, cfg: a.cfg, id: pg.id }).then(function (x) { return openPluginUpdate(v.id, x.session, 0); }).catch(pluginError);
            });
            update.dataset.pluginFocus = JSON.stringify(['update', v.id, a.cfg, pg.id]); acts.append(update);
          }
          else acts.title = i18n('pl.thu_muc_goi_y');
          r.append(acts); sec.append(r);
        });
      });
      if (v.stale.length) {
        var st = el('div', 'pl-stale'), sh = el('div', 'pl-stale-h');
        sh.append(el('span', '', i18n('pl.phien_ban_cu', [v.stale.length])));
        var reload = button(i18n('pl.nap_lai_tat_ca', [v.stale.length]), 'primary', function () {
          TW.api('POST', '/api/features/plugins/reload', { server: v.id, all: true }).then(function (x) { pluginNotice(i18n('pl.da_nap', [x.now, x.queued]) + (x.parked && x.parked.length ? ' ' + i18n('pl.parked_note', [x.parked.join(', ')]) : '')); TW.app().say(pluginFeedback, true, 4000); loadPlugins(); }).catch(pluginError);
        });
        reload.dataset.pluginFocus = JSON.stringify(['reload', v.id]); sh.append(reload);
        st.append(sh);
        var chips = el('div', 'pl-chips');
        v.stale.forEach(function (x) {
          var state = x.queued ? 'queued' : x.parked ? 'parked' : x.status;
          var c = el('span', 'pl-chip ' + state); c.append(el('b', '', x.session), el('span', '', i18n('pl.st_' + state)));
          c.title = i18n('pl.mo_truoc', [when(x.changedAt)]); chips.append(c);
        });
        st.append(chips, el('p', 'ops-note', i18n('pl.giai_thich'))); sec.append(st);
      }
      box.append(sec);
    });
    if (plug.log && plug.log.length) {
      var lg = el('div', 'pl-log'); lg.append(el('small', 'ops-pack', i18n('pl.da_gui_gan_day')));
      plug.log.slice(0, 5).forEach(function (n) { lg.append(el('div', 'pl-log-r', when(n.at) + ' · /reload-plugins → ' + n.session + ' · ' + (n.serverName || '') + ' · ' + i18n('pl.vi_' + n.why))); });
      box.append(lg);
    }
    return box;
  }
  function loadPlugins(readback) {
    if (pluginPending && readback !== true) return Promise.resolve();
    var request = ++pluginRequest;
    return TW.api('GET', '/api/features/plugins/data').then(function (r) {
      if (request !== pluginRequest) return;
      plug = r; drawPlugins();
    }).catch(function (e) { if (readback === true) throw e; });
  }

  // What was actually read for every agent session, so any verdict (or its absence) can be checked against the source.
  function evidence() {
    var box = el('details', 'ops-card ops-ev'), rows = []; keepOpen(box, 'evidence', false);
    data.servers.forEach(function (srv) {
      srv.sessions.forEach(function (s) { if (s.agent || s.ai) rows.push({ srv: srv, name: s.name, ai: s.ai, bg: s.bgAgents || [] }); });
      (srv.bg || []).forEach(function (b) { rows.push({ srv: srv, name: i18n('ops.phien_nen', [b.name]), ai: { tool: 'claude', status: b.status, at: b.at } }); });
    });
    var sum = el('summary', 'ops-card-h'), eh = el('h3', ''); eh.append(icon('list'), document.createTextNode(i18n('ops.bang_chung_ten')), el('span', 'ops-count', String(rows.length)));
    sum.append(eh, el('small', 'ops-pack', i18n('ops.bang_chung_ghi_chu'))); box.append(sum);
    rows.forEach(function (r) {
      var row = el('div', 'ops-log'), st = r.ai, label = !st ? i18n('ops.ev_none') : st.tool + ' · ' + st.status + (st.parked ? ' · ' + i18n('ops.ev_parked') : '') + (st.waitingFor ? ' · ' + st.waitingFor : '');
      if (r.bg && r.bg.length) label += ' · ' + i18n('ops.agent_ngam', [r.bg.length, r.bg.map(function (w) { return (w.kind || 'agent') + ' ' + span(w.elapsed / 60); }).join(', ')]);
      row.append(el('span', 'ops-st ' + (!st ? 'bad' : st.status === 'waiting' ? 'wait' : 'ok'), st ? st.status : '—'), el('span', 'ops-log-t', r.name + ' · ' + r.srv.name + ' — ' + label),
        el('time', '', st && st.at ? new Date(st.at).toLocaleString(window.TW_I18N ? window.TW_I18N.lang() : undefined, { dateStyle: 'short', timeStyle: 'short' }) : ''));
      box.append(row);
    });
    return box;
  }

  function logList() {
    var box = el('details', 'ops-card ops-ev ops-log-sec'), head = el('summary', 'ops-card-h'), lh = el('h3', ''); keepOpen(box, 'log', false);
    lh.append(icon('log'), document.createTextNode(i18n('ops.so_ghi')), el('span', 'ops-count', String(data.log.length)));
    head.append(lh);
    if (data.log.length) { var clr = button(i18n('ops.xoa_so'), 'ghost', function (e) { e.preventDefault(); post('/log/clear').then(load); }); head.append(clr); }
    box.append(head);
    if (!data.log.length) { box.append(el('p', 'ops-empty', i18n('ops.so_trong'))); return box; }
    data.log.slice(0, 20).forEach(function (n) {
      var r = el('div', 'ops-log'), st = n.verified === true ? 'ok' : n.verified === false ? 'bad' : 'wait';
      r.append(el('span', 'ops-st ' + st, deliveryLabel(n)), el('span', 'ops-log-t', i18n('ops.n.' + n.rule) + ' → ' + n.session + ' · ' + (n.serverName || '')),
        el('time', '', new Date(n.at).toLocaleString(window.TW_I18N ? window.TW_I18N.lang() : undefined, { dateStyle: 'short', timeStyle: 'short' })));
      box.append(r);
    });
    return box;
  }

  function rulesForm() {
    var box = el('section', 'ops-card ops-rules'), p = JSON.parse(JSON.stringify(data.pack)), head = el('div', 'ops-card-h');
    head.append(el('h3', '', i18n('ops.luat')), el('small', 'ops-pack', i18n('ops.goi', [p.name, p.custom.length])));
    box.append(head, el('p', 'ops-note', i18n('ops.luat_ghi_chu')));
    var grid = el('div', 'ops-grid');
    RULES.forEach(function (id) {
      var r = p.rules[id], name = el('div', 'ops-rn'); name.append(el('b', '', i18n('ops.n.' + id)), el('small', '', i18n('ops.d.' + id)));
      var lv = el('select'); ['off', 'notify', 'suggest', 'auto'].forEach(function (v) {
        if ((v === 'suggest' || v === 'auto') && !r.template) return;
        var o = el('option', '', i18n('ops.lv_' + v)); o.value = v; if (r.level === v) o.selected = true; lv.append(o);
      });
      lv.onchange = function () { r.level = lv.value; };
      // Most rules wait a number of minutes; the quota rule takes a percentage of the limit instead.
      var pctRule = 'pct' in r, after = el('input'); after.type = 'number';
      after.min = pctRule ? '50' : '0'; after.max = pctRule ? '100' : '1440'; after.value = pctRule ? r.pct : r.after;
      after.setAttribute('aria-label', i18n(pctRule ? 'ops.nguong_phan_tram' : 'ops.sau_phut'));
      after.oninput = function () { if (pctRule) r.pct = Number(after.value); else r.after = Number(after.value); };
      var a = el('label', 'ops-after'); a.append(after, el('span', '', pctRule ? '%' : i18n('ops.phut_ngan')));
      grid.append(name, lv, a);
    });
    box.append(grid);
    // Limits of the automatic level: per session per hour, and the quiet hours when nothing is sent automatically.
    var au = el('div', 'ops-tpl ops-auto'); au.append(el('h4', '', i18n('ops.tu_dong_tieu_de')), el('p', 'ops-note', i18n('ops.tu_dong_ghi_chu')));
    var arow = el('div', 'ops-auto-row');
    function field(label, input) { var l = el('label', 'ops-auto-f'); l.append(el('span', '', label), input); return l; }
    var ph = el('input'); ph.type = 'number'; ph.min = '1'; ph.max = '10'; ph.value = p.auto.perHour; ph.oninput = function () { p.auto.perHour = Number(ph.value); };
    var qf = el('input'); qf.type = 'time'; qf.value = p.auto.quietFrom; qf.oninput = function () { p.auto.quietFrom = qf.value; };
    var qt = el('input'); qt.type = 'time'; qt.value = p.auto.quietTo; qt.oninput = function () { p.auto.quietTo = qt.value; };
    arow.append(field(i18n('ops.toi_da_moi_gio'), ph), field(i18n('ops.yen_lang_tu'), qf), field(i18n('ops.yen_lang_den'), qt));
    au.append(arow); box.append(au);
    var tpl = el('div', 'ops-tpl'); tpl.append(el('h4', '', i18n('ops.mau_nhac')));
    Object.keys(p.templates).forEach(function (k) {
      var l = el('label'), ta = el('textarea'); ta.rows = 2; ta.value = p.templates[k]; ta.oninput = function () { p.templates[k] = ta.value; };
      l.append(el('span', '', k), ta); tpl.append(l);
    });
    box.append(tpl);
    var rulesPending = false;
    function writePack(body) {
      if (rulesPending) return Promise.reject(Error(i18n('ops.rules_pending')));
      rulesPending = true; box.dataset.pending = 'true'; box.querySelectorAll('input,textarea,select,button').forEach(function (c) { c.disabled = true; });
      return post('/pack', body).then(function (saved) {
        return TW.api('GET', '/api/features/ops/pack').then(function (current) {
          if (!saved || !current || !saved.rules || !current.templates || ['name', 'version', 'rules', 'custom', 'auto'].some(function (key) { return JSON.stringify(saved[key]) !== JSON.stringify(current[key]); }) || Object.keys(saved.templates || {}).some(function (key) { return saved.templates[key] !== current.templates[key]; })) throw Error(i18n('ops.rules_readback_failed'));
          data.pack = current; return current;
        });
      }).finally(function () { rulesPending = false; delete box.dataset.pending; box.querySelectorAll('input,textarea,select,button').forEach(function (c) { c.disabled = false; }); });
    }
    function resetEditor() { editing = false; rulesNode = null; box.remove(); load(); }
    var bar = el('div', 'ops-bar');
    bar.append(button(i18n('ops.luu'), 'primary', function () { writePack({ pack: p }).then(function () { TW.app().say(i18n('ops.da_luu'), true, 2000); load(); }).catch(function (e) { TW.app().say(e.message, false, 4000); }); }),
      button(i18n('ops.xuat_goi'), '', function () {
        var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' })); a.download = 'termnest-ops-' + (p.name || 'core') + '.json'; a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
      }),
      button(i18n('ops.nhap_goi'), '', function () {
        var f = document.createElement('input'); f.type = 'file'; f.accept = '.json,application/json';
        f.onchange = function () {
          var file = f.files && f.files[0]; if (!file) return;
          file.text().then(function (t) { return writePack({ pack: JSON.parse(t) }); })
            .then(function () { TW.app().say(i18n('ops.da_nhap'), true, 2500); resetEditor(); })
            .catch(function () { TW.app().say(i18n('ops.goi_loi'), false, 4000); });
        };
        f.click();
      }),
      button(i18n('ops.mac_dinh'), 'ghost', function () { writePack({ reset: true }).then(resetEditor).catch(function (e) { TW.app().say(e.message, false, 4000); }); }),
      button(i18n('ops.dong'), 'ghost', function () { editing = false; box.remove(); }));
    box.append(bar); return box;
  }

  function deliveryLabel(n) {
    if (n.delivery === 'uncertain') return i18n('ops.delivery_uncertain');
    if (n.delivery === 'exhausted' || n.delivery === 'failed' || n.delivery === 'not_sent' || n.delivery === 'cancelled') return i18n('ops.delivery_failed');
    if (n.responded === true || n.verified === true) return i18n('ops.delivery_responded');
    if (n.responded === false || n.verified === false) return i18n('ops.delivery_noresponse');
    return i18n(n.delivery === 'delivered' ? 'ops.delivery_delivered' : 'ops.delivery_pending');
  }
  function dailyGroup(x) {
    if (x.f.routine || /^observed_/.test(x.f.rule)) return x.f.rule === 'observed_busy' ? 'running' : 'routine';
    return x.f.rule === 'dormant' ? 'waiting' : 'attention';
  }
  function mountSettings() {
    var mount = document.getElementById('ops-settings-mount'); if (mount && !mount.contains(supervisionCard())) mount.append(supervisionCard());
  }
  function draw() {
    mountSettings();
    var editRules = reminderSettings && reminderSettings.querySelector('.ops-edit-rules'); if (editRules) editRules.disabled = !data;
    drawPlugins();
    if (!page) return;
    page.textContent = '';
    var head = el('div', 'ops-head'), h = el('div', 'ops-title'), tools = el('div', 'ops-tools');
    h.append(el('h2', '', i18n('ops.tieu_de')), el('p', '', data ? i18n('ops.connections', [data.servers.length, data.servers.filter(function (s) { return s.online === true; }).length]) : i18n('ops.loading')));
    tools.append(button(i18n('ops.settings_shortcut'), 'ghost', function () { TW.app().openSettings('sessions'); }));
    if (data && data.dismissed) tools.append(button(i18n('ops.hien_lai', [data.dismissed]), 'ghost', function () { post('/dismiss', { all: true }).then(load); }));
    head.append(h, tools); page.append(head);
    if (boardError) page.append(el('p', 'ops-super-alert', i18n('ops.board_error')));
    if (!data) return;
    var all = opsSessionRows(data, supervision);
    quotaFindings().forEach(function (f) { if (!data.dismissedKeys || data.dismissedKeys.indexOf(f.key) < 0) all.push({ f: f, s: { id: '', name: i18n('ops.tai_khoan_ai'), sessions: [] } }); });
    all.sort(function (a, b) { return (SEV[a.f.severity] - SEV[b.f.severity]) || (b.f.since - a.f.since); });
    var leaders = {}, teamN = 0, crewNeed = needYou();
    // While autopilot is off nothing is scanned, so saved teams would be stale: show none rather than old data.
    if (crewOn()) list(supervision.servers).forEach(function (v) { list(v.discovered).forEach(function (d) { leaders[v.id + '|' + d.session] = true; if (!d.excluded) teamN++; }); });
    var needN = all.filter(function (x) { return dailyGroup(x) === 'attention'; }).length + crewNeed.length;
    h.querySelector('p').textContent = i18n('ops.sumline', [data.servers.length, data.servers.reduce(function (n, v) { return n + list(v.sessions).filter(function (s) { return s.agent; }).length; }, 0), teamN, needN]);
    page.append(machines(all, crewNeed));
    var shown = all.filter(function (x) { return !filt.srv || x.s.id === filt.srv; }), groups = el('div', 'ops-groups');
    function section(id, title, count, open, iconName, note) {
      var box = el('details', 'ops-card ops-group g-' + id), sum = el('summary', 'ops-card-h'); keepOpen(box, 'daily-' + id, open);
      var h3 = el('h3', ''); h3.append(icon(iconName), document.createTextNode(title), el('span', 'ops-count', String(count)));
      if (note) h3.append(el('small', 'ops-note', note));
      sum.append(h3); box.append(sum); groups.append(box); return box;
    }
    var need = shown.filter(function (x) { return dailyGroup(x) === 'attention'; });
    var crewShown = crewNeed.filter(function (n) { return !filt.srv || n.server.id === filt.srv; });
    var nb = section('attention', i18n('ops.daily.attention'), need.length + crewShown.length, true, 'ask');
    if (!need.length && !crewShown.length) nb.append(el('p', 'ops-empty', i18n('ops.none_need')));
    // Crew teams that need a person come first: blocked, waiting for a decision, stalled, audit problems.
    crewShown.forEach(function (n) {
      var r = el('div', 'ops-row ' + (n.bad ? 'urgent' : 'warn')), t = el('div', 'ops-t'), line = el('div', 'ops-line');
      line.append(el('b', 'ops-name', n.who), el('span', 'ops-status', n.why));
      t.append(line, el('small', 'ops-meta', [text(n.server.name)].concat(n.tasks).join(' · ')));
      r.append(el('span', 'ops-dot'), t);
      var acts = el('div', 'ops-acts');
      if (n.session) acts.append(button(i18n('ops.mo'), '', function () { TW.app().openSession(n.server.id, n.session); }));
      r.append(acts); nb.append(r);
    });
    need.forEach(function (x) { nb.append(row(x.f, x.s)); });
    var crew = list(supervision && supervision.servers).filter(function (v) { return !filt.srv || v.id === filt.srv; });
    var cb = section('crew', i18n('ops.daily.crew'), teamN, true, 'user');
    if (!supervision) cb.append(el('p', 'ops-empty', i18n(supervisionError ? 'ops.super.unavailable' : 'ops.super.loading')));
    if (supervision && !crewOn()) {
      cb.append(el('p', 'ops-empty', c('off_view')), button(c('turn_on'), 'primary', function () { TW.app().openSettings('sessions'); }));
    } else crew.forEach(function (v) { cb.append(crewMachine(v, false)); });
    var rest = shown.filter(function (x) { return dailyGroup(x) !== 'attention' && !leaders[x.s.id + '|' + x.f.session]; });
    rest.sort(function (a, b) { return ['waiting', 'running', 'routine'].indexOf(dailyGroup(a)) - ['waiting', 'running', 'routine'].indexOf(dailyGroup(b)); });
    var ob = section('routine', i18n('ops.daily.routine'), rest.length, false, 'list', i18n('ops.others_note'));
    rest.forEach(function (x) { ob.append(row(x.f, x.s)); });
    page.append(groups);
    if (supervisionError || supervision && supervision.enabled && list(supervision.errors).length) page.append(button(i18n('ops.super.review_settings'), 'ghost', function () { TW.app().openSettings('sessions'); }));
    if (TW.serverBackupIssue) { var issue = TW.serverBackupIssue(data.servers); if (issue) page.append(issue); }
    page.append(logList());
    if (tab) { tab.textContent = i18n('ops.tab'); if (needN) tab.append(el('span', 'ops-badge', String(needN))); }
  }
  function load() {
    loadSupervision();
    return TW.api('GET', '/api/features/ops/board').then(function (r) {
      if (!r || !Array.isArray(r.servers) || !r.servers.every(function (s) { return s && typeof s.id === 'string' && typeof s.name === 'string' && Array.isArray(s.sessions) && Array.isArray(s.findings); }) || !Array.isArray(r.log) || !r.pack || !r.pack.rules || !r.pack.templates) throw Error('invalid board');
      data = r; boardError = false;
      Object.keys(localDelivery).forEach(function (key) {
        var intent = localDelivery[key], receipt = r.log.find(function (n) { return n.server === intent.server && n.session === intent.session && (n.idleAt === intent.idleAt || n.at >= intent.requestedAt); });
        if (receipt && receipt.delivery) { intent.delivery = receipt.delivery; intent.verified = receipt.verified; intent.responded = receipt.responded; }
        if (intent.delivery !== 'delivered') return;
        var finding = r.servers.flatMap(function (s) { return s.findings || []; }).find(function (f) { return f.key === key; });
        if (!finding) delete localDelivery[key];
      }); draw();
    }).catch(function () { boardError = true; draw(); });
  }

  (function () {
    var v = TW.addView({ id: 'ops', label: i18n('ops.tab'), mount: function (box) { page = box; box.classList.add('ops-page'); box.append(el('p', 'ops-empty', i18n('ops.loading'))); }, onShow: load });
    if (v) tab = v.tab;
    pluginPage = document.getElementById('plugins-settings-mount');
    if (pluginPage) pluginPage.addEventListener('focusout', function () { setTimeout(drawPlugins, 0); });
    TW.on('ready', draw); TW.on('server-backup-updated', draw); mountSettings();
    load(); loadPlugins(); loadTokens(); setInterval(function () { if (!document.hidden) { load(); loadPlugins(); } }, 10000);
    setInterval(function () { if (!document.hidden) loadTokens(); }, 60000);
  })();
})();
