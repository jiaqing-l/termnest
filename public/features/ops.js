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
        var code = typeof item.reason === 'string' ? item.reason : item.reason && item.reason.code || item.code;
        var recovery = item.recovery, unresolved = recovery && recovery.requiresOwner ? recovery.code : code;
        var uncertain = audit ? item.deliveryUncertain === true || ['uncertain', 'opening'].indexOf(item.phase) >= 0 : recovery && recovery.requiresOwner && recovery.delivery === 'uncertain';
        var kind = uncertain || /^(action_uncertain|recovery_uncertain|delivery_uncertain|send_uncertain|prompt_send_uncertain|open_uncertain)$/.test(unresolved) ? 'uncertain' : /^(recovery_no_progress|audit_timeout)$/.test(unresolved) ? 'noresponse' : '';
        // Setup and missing/stale task evidence do not override a measured session state.
        if (!kind && freshness.taskEvidenceFresh === true && !audit) {
          if (item.status === 'waiting_owner' && code === 'owner_decision') kind = 'wait';
          if (item.status === 'blocked' && /^(task_blocked|session_parked)$/.test(code)) kind = 'blocked';
          if (item.status === 'stalled' && code === 'no_task_progress') kind = 'stalled';
        }
        if (!kind && audit && code === 'audit_waiting_owner') kind = 'wait';
        if (!kind) return;
        var names = host ? Array.from(new Set((host.teams || []).filter(function (t) { return item.root && t.root === item.root && t.session; }).map(function (t) { return t.session; }))) : [];
        var ownerSession = item.session || item.teamSession || (names.length === 1 ? names[0] : '');
        add({ key: 'super/' + srv.id + '/' + key, rule: 'owner', session: ownerSession, ownerKind: kind, reason: item.reason || { code: item.code }, severity: 'urgent', settings: !ownerSession });
      }
      if (host) {
        (host.teams || []).forEach(function (t) { owner(t, t.id); });
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
  var pluginPage = null, pluginTab = null, boardError = false, localDelivery = Object.create(null), rulesNode = null, reminderSettings = null;
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
  var supervisionRevision = 0, supervisionBox = null, supervisionStatus = null, supervisionForm = null, supervisionDraft = null;
  var accountUI = null, accountProof = null, accountMessage = '', accountGeneration = 0, accountTimer = null, accountChecking = false;
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
    return t.status;
  }
  function sameLeader(a, b) {
    return !!a && !!b && a.serverId === b.serverId && a.session === b.session && a.root === b.root &&
      ['bootId', 'sessionId', 'created', 'pane', 'agentPid', 'agentStartedAt', 'config'].every(function (k) { return a.identity && b.identity && a.identity[k] != null && String(a.identity[k]) === String(b.identity[k]); });
  }
  function recoveryReady() {
    var r = supervision && supervision.runtime;
    if (r && (typeof r.registrationReady === 'boolean' || typeof r.recoveryReady === 'boolean')) return r.registrationReady === true || r.recoveryReady === true;
    return !!supervision && list(supervision.leaders).some(function (l) { return list(supervision.registrationCandidates).some(function (c) { return sameLeader(l, c); }) && list(supervision.servers).some(function (s) { return s.id === l.serverId && hostFresh(s); }); });
  }
  function registrationSelected() {
    return supervisionForm && supervisionForm.querySelector('[name=leader]') && supervisionForm.querySelector('[name=leader]').value !== '' && supervisionForm.querySelector('[name=confirmLeader]').checked;
  }
  function supervisionCard() {
    if (supervisionBox) return supervisionBox;
    supervisionBox = el('section', 'ops-card ops-super');
    supervisionBox.append(el('h3', '', i18n('settings.tab_sessions')), el('p', 'ops-note', i18n('ops.manual_help')));
    supervisionStatus = el('div', 'ops-super-status'); supervisionStatus.setAttribute('aria-live', 'polite');
    supervisionForm = el('details', 'ops-super-settings'); keepOpen(supervisionForm, 'super-settings', true);
    supervisionForm.append(el('summary', '', i18n('ops.super.settings')));
    reminderSettings = el('details', 'ops-reminder-settings'); keepOpen(reminderSettings, 'reminder-settings', false);
    reminderSettings.append(el('summary', '', i18n('ops.reminder_rules')), el('p', 'ops-note', i18n('ops.reminder_rules_help')),
      button(i18n('ops.chinh_luat'), 'ops-edit-rules', function () { if (!data || rulesNode && rulesNode.dataset.pending) return; editing = !editing; if (editing && !rulesNode) rulesNode = rulesForm(); if (rulesNode) { if (editing) reminderSettings.append(rulesNode); else rulesNode.remove(); } }));
    supervisionBox.append(reminderSettings, supervisionStatus, supervisionForm);
    supervisionForm.append(el('p', 'ops-note', i18n('ops.super.advanced_help')));
    renderSupervision(); return supervisionBox;
  }
  // Account discovery never derives identity from leader config or saves policy implicitly.
  function accountScope() {
    if (!accountUI || !supervision) return null;
    return list(supervision.workspaces).find(function (w) { return JSON.stringify([w.serverId, w.root]) === accountUI.scope.value; });
  }
  function accountFresh(proof) {
    var w = accountScope(), at = proof && new Date(proof.observedAt).getTime();
    return !!proof && !!w && proof.serverId === w.serverId && proof.root === w.root && proof.auditConfig === accountUI.profile.value &&
      Number.isFinite(at) && at > 0 && at <= Date.now() + 5000 && Date.now() - at < 60000 &&
      list(supervision.servers).some(function (s) { return s.id === w.serverId && hostConnected(s); });
  }
  function accountConfirmable(proof) {
    return accountFresh(proof) && ['audit_account_registration_required', 'audit_ready'].indexOf(proof.code) >= 0;
  }
  function invalidateAccount(message) {
    accountGeneration++; accountProof = null; accountMessage = message || '';
    clearTimeout(accountTimer);
  }
  function makeAccountForm() {
    if (accountUI) return;
    var box = el('div', 'ops-super-form ops-super-account'), scope = el('select'), profile = el('input'), result = el('p', 'ops-note');
    scope.name = 'accountWorkspace'; profile.name = 'accountProfile'; profile.type = 'text'; profile.value = '.claude'; profile.maxLength = 128;
    result.setAttribute('aria-live', 'polite');
    function field(key, input) { var label = el('label'); label.append(el('span', '', i18n(key)), input); return label; }
    var check = button(i18n('ops.super.account_check'), '', function () {
      if (supervisionPending) return;
      invalidateAccount();
      var w = accountScope(), config = profile.value;
      if (!w || !/^\.claude(?:-[A-Za-z0-9_.-]{1,60})?$/.test(config) || !list(supervision.servers).some(function (s) { return s.id === w.serverId && hostConnected(s); })) {
        accountMessage = i18n('ops.super.account_invalid'); renderSupervision(); return;
      }
      var request = { serverId: w.serverId, root: w.root, auditConfig: config }, generation = accountGeneration;
      supervisionPending = true; accountChecking = true; supervisionRevision++; renderSupervision();
      post('/supervision/account', request).then(function (r) {
        if (generation !== accountGeneration) return;
        if (!r || !accountFresh(r)) throw Error('account scope or freshness');
        accountMessage = explanation(r.code);
        if (!/^[a-f0-9]{64}$/.test(r.accountRef) || typeof r.label !== 'string' || !r.label.trim() || r.label.length > 200) return;
        accountProof = { serverId: r.serverId, root: r.root, auditConfig: r.auditConfig, accountRef: r.accountRef, label: r.label, code: r.code, observedAt: r.observedAt };
        accountTimer = setTimeout(function () { invalidateAccount(i18n('ops.super.account_expired')); renderSupervision(); }, Math.max(1, 60000 - (Date.now() - new Date(r.observedAt).getTime())));
      }).catch(function () { if (generation === accountGeneration) invalidateAccount(i18n('ops.super.account_failed')); })
        .finally(function () { supervisionPending = false; accountChecking = false; renderSupervision(); });
    });
    check.name = 'checkAccount';
    var confirm = button(i18n('ops.super.account_confirm'), '', function () {
      if (supervisionPending) return;
      if (!accountConfirmable(accountProof)) { invalidateAccount(i18n('ops.super.account_expired')); renderSupervision(); return; }
      var proof = accountProof, generation = accountGeneration;
      // Use saved settings, never unsaved edits. Omit leaders and autoRecovery: OFF exposes only its effective value.
      var body = { enabled: supervision.enabled, intervalMinutes: supervision.intervalMinutes,
        workspaces: list(supervision.workspaces).map(function (w) { return Object.assign({}, w, w.serverId === proof.serverId && w.root === proof.root ? { auditConfig: proof.auditConfig, auditAccount: proof.accountRef } : {}); }) };
      supervisionPending = true; supervisionRevision++; renderSupervision();
      post('/supervision', body).then(function () { return loadSupervision(true); }).then(function () {
        if (generation !== accountGeneration || !accountFresh(proof)) throw Error('account changed');
        var w = accountScope();
        if (!w || w.auditConfig !== proof.auditConfig || w.auditAccount !== proof.accountRef) throw Error('account readback mismatch');
        invalidateAccount(i18n('ops.super.account_saved', [proof.label]));
      }).catch(function () { invalidateAccount(i18n('ops.super.account_failed')); })
        .finally(function () { supervisionPending = false; renderSupervision(); });
    });
    confirm.name = 'confirmAccount';
    scope.onchange = function () { invalidateAccount(); var w = accountScope(); profile.value = w && typeof w.auditConfig === 'string' ? w.auditConfig : '.claude'; renderSupervision(); };
    profile.oninput = function () { invalidateAccount(); renderSupervision(); };
    var choice = el('select'); choice.name = 'accountChoice';
    choice.onchange = function () { profile.value = choice.value; invalidateAccount(); renderSupervision(); };
    var advanced = el('details'); advanced.append(el('summary', '', i18n('ops.super.custom_profile')), field('ops.super.account_profile', profile));
    box.append(el('h4', '', i18n('ops.super.account_title')), field('ops.super.account_workspace', scope), field('ops.super.account_choice', choice),
      el('p', 'ops-note', i18n('ops.super.account_choices_help')), advanced,
      el('p', 'ops-note', i18n('ops.super.account_help')), check, result, confirm);
    accountUI = { box: box, scope: scope, profile: profile, choice: choice, result: result, check: check, confirm: confirm, options: null };
    supervisionForm.append(box);
  }
  function renderAccount() {
    if (!accountUI) return;
    if (!supervision) { invalidateAccount(i18n('ops.super.account_failed')); accountUI.result.textContent = accountMessage; return; }
    var scopes = list(supervision.workspaces), options = JSON.stringify(scopes.map(function (w) { return [w.serverId, w.root]; }));
    if (options !== accountUI.options) {
      var selected = accountUI.scope.value;
      accountUI.scope.textContent = '';
      scopes.forEach(function (w) {
        var server = list(supervision.servers).find(function (s) { return s.id === w.serverId; });
        var option = el('option', '', text(server && server.name || w.serverId) + ' · ' + text(w.root)); option.value = JSON.stringify([w.serverId, w.root]); accountUI.scope.append(option);
      });
      if (scopes.some(function (w) { return JSON.stringify([w.serverId, w.root]) === selected; })) accountUI.scope.value = selected;
      else { invalidateAccount(); var w = accountScope(); accountUI.profile.value = w && w.auditConfig || '.claude'; }
      accountUI.options = options;
    }
    var currentScope = accountScope(), profiles = ['.claude'];
    if (currentScope && currentScope.auditConfig) profiles.push(currentScope.auditConfig);
    list(supervision.registrationCandidates).filter(function (c) { return currentScope && c.serverId === currentScope.serverId && c.root === currentScope.root; }).forEach(function (c) { if (c.identity && /^\.claude(?:-[A-Za-z0-9_.-]{1,60})?$/.test(c.identity.config)) profiles.push(c.identity.config); });
    profiles.push(accountUI.profile.value);
    var choices = JSON.stringify(Array.from(new Set(profiles)));
    if (accountUI.choices !== choices) { accountUI.choice.textContent = ''; JSON.parse(choices).forEach(function (p) { var o = el('option', '', p === '.claude' ? i18n('ops.super.default_profile') : p); o.value = p; accountUI.choice.append(o); }); accountUI.choices = choices; }
    accountUI.choice.value = accountUI.profile.value;
    if (accountProof && !accountFresh(accountProof)) invalidateAccount(i18n('ops.super.account_expired'));
    var w = accountScope(), fresh = !!w && list(supervision.servers).some(function (s) { return s.id === w.serverId && hostConnected(s); });
    accountUI.check.disabled = supervisionPending || !fresh;
    accountUI.confirm.disabled = supervisionPending || !accountConfirmable(accountProof);
    accountUI.result.textContent = (accountProof ? i18n('ops.super.account_identity', [accountProof.label, stamp(accountProof.observedAt)]) + ' ' : '') + accountMessage + ' ' + i18n('ops.super.account_quota_unknown');
  }
  function makeSupervisionForm() {
    if (!supervision || supervisionDraft) return;
    supervisionDraft = { enabled: supervision.enabled === true, autoRecovery: supervision.autoRecovery === true,
      intervalMinutes: supervision.intervalMinutes || 30, workspaces: list(supervision.workspaces).map(function (w) { return { serverId: text(w.serverId), root: text(w.root) }; }) };
    var form = el('form', 'ops-super-form');
    function field(label, input) { var l = el('label'); l.append(el('span', '', label), input); return l; }
    function check(key, label) {
      var input = el('input'); input.type = 'checkbox'; input.name = key; input.checked = supervisionDraft[key];
      input.onchange = function () { supervisionDraft[key] = input.checked; if (key === 'autoRecovery') supervisionDraft.recoveryEdited = true; renderSupervision(); };
      return field(i18n(label), input);
    }
    form.append(check('enabled', 'ops.super.enable'), check('autoRecovery', 'ops.super.recovery'));
    var interval = el('input'); interval.type = 'number'; interval.name = 'intervalMinutes'; interval.min = '1'; interval.max = '1440'; interval.required = true; interval.value = supervisionDraft.intervalMinutes;
    interval.oninput = function () { supervisionDraft.intervalMinutes = Number(interval.value); renderSupervision(); };
    form.append(field(i18n('ops.super.interval'), interval));
    var scopes = el('div', 'ops-scopes'), machine = el('select'); machine.name = 'workspaceMachine'; machine.setAttribute('aria-label', i18n('ops.super.machine'));
    list(supervision.servers).forEach(function (server) { var option = el('option', '', text(server.name)); option.value = server.id; machine.append(option); });
    var initialScopes = supervisionDraft.workspaces.map(function (w) { return JSON.stringify([w.serverId, w.root]); });
    function renderScopes() {
      scopes.textContent = '';
      supervisionDraft.workspaces.forEach(function (w) {
        var server = list(supervision.servers).find(function (v) { return v.id === w.serverId; }), row = el('div', 'ops-scope-row');
        row.append(el('span', '', text(server && server.name || i18n('ops.super.removed_machine')) + ' · ' + w.root), button(i18n('backup.remove'), '', function () {
          if (supervisionPending) return; supervisionDraft.workspaces = supervisionDraft.workspaces.filter(function (v) { return v !== w; }); renderScopes(); renderSupervision();
        })); scopes.append(row);
      });
    }
    var browse = button(i18n('ops.super.browse'), '', function () {
      var id = machine.value, server = list(supervision.servers).find(function (v) { return v.id === id; });
      if (supervisionPending || !server || server.online !== true) return;
      TW.app().browseDir(id, '', function (root) {
        if (supervisionPending || typeof root !== 'string' || root[0] !== '/') return;
        if (!supervisionDraft.workspaces.some(function (w) { return w.serverId === id && w.root === root; })) supervisionDraft.workspaces.push({ serverId: id, root: root });
        renderScopes(); renderSupervision();
      });
    }); browse.name = 'browseWorkspace';
    machine.onchange = function () { renderSupervision(); };
    form.append(el('h4', '', i18n('ops.super.workspaces')), field(i18n('ops.super.machine'), machine), browse, scopes); renderScopes();
    var candidates = list(supervision.registrationCandidates), leader = el('select'); leader.name = 'leader';
    function leaderOptions() {
      leader.textContent = ''; var none = el('option', '', i18n('ops.super.keep_leaders')); none.value = ''; leader.append(none);
      candidates.forEach(function (c, index) {
        var server = list(supervision.servers).find(function (v) { return v.id === c.serverId; });
        var option = el('option', '', text(server && server.name || i18n('ops.super.removed_machine')) + ' · ' + text(c.session) + ' · ' + text(c.root)); option.value = String(index); leader.append(option);
      });
    }
    leaderOptions();
    var tasks = el('div', 'ops-task-choices'), confirm = el('input'); confirm.type = 'checkbox'; confirm.name = 'confirmLeader'; confirm.onchange = renderSupervision;
    function availableTasks(c) {
      var host = c && list(supervision.servers).find(function (v) { return v.id === c.serverId; });
      return host && hostFresh(host) ? Array.from(new Set(list(host.teams).filter(function (t) { return t.root === c.root; }).flatMap(function (t) { return Array.isArray(t.taskIds) ? t.taskIds.filter(function (id) { return typeof id === 'string' && /^[A-Za-z0-9][\w-]{0,127}$/.test(id); }) : []; }))) : [];
    }
    function taskOptions() {
      tasks.textContent = ''; confirm.checked = false;
      var ids = availableTasks(candidates[Number(leader.value)]);
      if (leader.value === '' || !ids.length) { tasks.append(el('p', 'ops-note', i18n('ops.super.tasks_unavailable'))); return; }
      ids.forEach(function (id) { var input = el('input'); input.type = 'checkbox'; input.name = 'taskScope'; input.value = id; tasks.append(field(id, input)); });
    }
    leader.onchange = function () { taskOptions(); renderSupervision(); }; taskOptions();
    form.append(field(i18n('ops.super.register_leader'), leader), button(i18n('ops.super.refresh_candidates'), '', function () { candidates = list(supervision.registrationCandidates); leaderOptions(); taskOptions(); renderSupervision(); }),
      el('p', 'ops-note', i18n('ops.super.identity_help')), tasks, field(i18n('ops.super.confirm_leader'), confirm));
    var save = button(i18n('ops.super.save'), 'primary', function () {}); save.type = 'submit'; save.name = 'save';
    form.append(save);
    form.onsubmit = function (e) {
      e.preventDefault(); if (supervisionPending || !supervision || !form.reportValidity()) return;
      // Preserve current metadata and scopes added elsewhere; remove only scopes explicitly removed from this draft.
      var workspaces = supervisionDraft.workspaces.map(function (w) {
        var previous = list(supervision.workspaces).find(function (v) { return v.serverId === w.serverId && v.root === w.root; });
        return Object.assign({}, previous || {}, w);
      });
      list(supervision.workspaces).forEach(function (w) {
        if (initialScopes.indexOf(JSON.stringify([w.serverId, w.root])) < 0 && !workspaces.some(function (v) { return v.serverId === w.serverId && v.root === w.root; })) workspaces.push(Object.assign({}, w));
      });
      var body = { enabled: supervisionDraft.enabled, intervalMinutes: supervisionDraft.intervalMinutes, workspaces: workspaces };
      if (supervisionDraft.recoveryEdited) body.autoRecovery = supervisionDraft.autoRecovery;
      if (leader.value !== '') {
        var candidate = candidates[Number(leader.value)], ids = Array.from(tasks.querySelectorAll('input:checked')).map(function (input) { return input.value; });
        var current = list(supervision.registrationCandidates).find(function (c) { return sameLeader(candidate, c); });
        if (!confirm.checked || !current || !ids.length || ids.some(function (id) { return availableTasks(current).indexOf(id) < 0; }) || !list(supervision.servers).some(function (s) { return s.id === current.serverId && hostFresh(s); }) || !workspaces.some(function (w) { return w.serverId === current.serverId && w.root === current.root; })) {
          TW.app().say(i18n('ops.super.registration_invalid'), false, 4000); return;
        }
        function record(c) { return { serverId: c.serverId, root: c.root, session: c.session, taskIds: c.taskIds, identity: c.identity }; }
        body.leaders = list(supervision.leaders).filter(function (l) { return l.serverId !== current.serverId || l.session !== current.session; }).map(record);
        body.leaders.push(record({ serverId: current.serverId, root: current.root, session: current.session, taskIds: ids, identity: current.identity }));
      }
      if (body.enabled && supervisionDraft.autoRecovery && !recoveryReady() && !body.leaders) return;
      supervisionPending = true; supervisionRevision++; renderSupervision();
      post('/supervision', body).then(function () {
        // A POST acknowledgement is not authoritative state. Require a new successful GET.
        return loadSupervision(true).then(function () {
          if (!supervision || supervision.enabled !== body.enabled || ('autoRecovery' in body && supervision.autoRecovery !== (body.enabled && body.autoRecovery)) || supervision.intervalMinutes !== body.intervalMinutes || JSON.stringify(supervision.workspaces) !== JSON.stringify(body.workspaces) || body.leaders && !body.leaders.every(function (l) { return list(supervision.leaders).some(function (v) { return sameLeader(l, v) && JSON.stringify(l.taskIds) === JSON.stringify(v.taskIds); }); })) throw Error('policy readback mismatch');
          supervisionDraft.workspaces = workspaces.map(function (w) { return { serverId: w.serverId, root: w.root }; }); renderScopes();
          initialScopes = workspaces.map(function (w) { return JSON.stringify([w.serverId, w.root]); });
          if (body.leaders) { leader.value = ''; taskOptions(); }
        });
      }).catch(function () { supervision = null; supervisionError = true; }).finally(function () {
        supervisionPending = false; renderSupervision();
      });
    };
    supervisionForm.append(form); makeAccountForm();
  }
  function renderSupervision() {
    if (!supervisionStatus) return;
    makeSupervisionForm(); supervisionStatus.textContent = '';
    var controls = supervisionForm.querySelectorAll('input,textarea,select,button');
    controls.forEach(function (c) { c.disabled = supervisionPending || !supervision; });
    var picker = supervisionForm.querySelector('[name=browseWorkspace]'), machine = supervisionForm.querySelector('[name=workspaceMachine]');
    if (picker) picker.disabled = supervisionPending || !supervision || !list(supervision.servers).some(function (s) { return s.id === machine.value && s.online === true; });
    renderAccount();
    var save = supervisionForm.querySelector('[name=save]');
    if (save && supervisionDraft && supervisionDraft.enabled && supervisionDraft.autoRecovery && !recoveryReady() && !registrationSelected()) save.disabled = true;
    if (supervisionPending) supervisionStatus.append(el('p', 'ops-super-alert', i18n(accountChecking ? 'ops.super.account_checking' : 'ops.super.pending')));
    if (!supervision) {
      supervisionStatus.append(el('p', 'ops-super-alert', i18n(supervisionError ? 'ops.super.unavailable' : 'ops.super.loading'))); return;
    }
    supervisionStatus.append(el('p', '', i18n(supervision.enabled ? 'ops.super.enabled' : 'ops.super.disabled')));
    if (supervisionDraft && (supervisionDraft.enabled !== supervision.enabled || supervisionDraft.autoRecovery !== supervision.autoRecovery || supervisionDraft.intervalMinutes !== supervision.intervalMinutes ||
        JSON.stringify(supervisionDraft.workspaces) !== JSON.stringify(list(supervision.workspaces).map(function (w) { return { serverId: text(w.serverId), root: text(w.root) }; })))) supervisionStatus.append(el('p', 'ops-note', i18n('ops.super.draft')));
  }

  function loadSupervision(force) {
    if ((!force && supervisionFetching) || (supervisionPending && !force)) return Promise.resolve();
    var revision = ++supervisionRevision; supervisionFetching = true;
    return TW.api('GET', '/api/features/ops/supervision').then(function (r) {
      if (revision !== supervisionRevision) return;
      if (!r || typeof r.enabled !== 'boolean' || !Array.isArray(r.servers)) throw Error('invalid supervision');
      supervision = r; supervisionError = false;
    }).catch(function () { if (revision === supervisionRevision) { supervision = null; supervisionError = true; } })
      .finally(function () { supervisionFetching = false; renderSupervision(); draw(); });
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

  // Filters: by level (click a count) and by machine; remembered while the page is open.
  var filt = { sev: '', srv: '' };
  function summary(all) {
    var box = el('div', 'ops-toolbar'), seg = el('div', 'ops-seg'), n = { urgent: 0, warn: 0, info: 0 }; seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', i18n('ops.loc_muc')); box.append(seg);
    all.forEach(function (x) { n[x.f.severity]++; });
    [['', 'ops.tat_ca', all.length], ['urgent', 'ops.can_ban'], ['warn', 'ops.can_xem'], ['info', 'ops.thong_tin']].forEach(function (k) {
      var c = el('button', 'ops-seg-b ' + (k[0] || 'all')); c.type = 'button'; c.setAttribute('aria-pressed', String(filt.sev === k[0]));
      c.append(el('span', 'ops-seg-dot'), el('span', '', i18n(k[1])), el('b', 'ops-seg-n', String(k[0] ? n[k[0]] : k[2])));
      c.onclick = function () { filt.sev = k[0]; draw(); }; seg.append(c);
    });
    if (data.servers.length > 1) {
      var sel = el('select', 'ops-srv'); sel.setAttribute('aria-label', i18n('ops.loc_may'));
      var o0 = el('option', '', i18n('ops.moi_may')); o0.value = ''; sel.append(o0);
      data.servers.forEach(function (v) { var o = el('option', '', v.name); o.value = v.id; if (filt.srv === v.id) o.selected = true; sel.append(o); });
      sel.onchange = function () { filt.srv = sel.value; draw(); }; box.append(sel);
    }
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
  var plug = null;
  function when(ms) { return ms ? new Date(ms).toLocaleString(window.TW_I18N ? window.TW_I18N.lang() : undefined, { dateStyle: 'short', timeStyle: 'short' }) : '—'; }
  function pluginCard() {
    var box = el('details', 'ops-card ops-ev ops-plug'), sum = el('summary', 'ops-card-h'); keepOpen(box, 'plugins', true);
    var stale = 0; ((plug && plug.servers) || []).forEach(function (v) { stale += v.stale.length; });
    var h3 = el('h3', ''); h3.append(icon('plug'), document.createTextNode(i18n('pl.tieu_de')));
    if (stale) h3.append(el('span', 'ops-count warn', String(stale)));
    sum.append(h3, el('small', 'ops-pack', i18n('pl.nguon'))); box.append(sum);
    if (!plug) { box.append(el('p', 'ops-empty', i18n('pl.dang_doc'))); return box; }
    var bar = el('div', 'pl-bar'), auto = el('label', 'pl-auto'), cb = el('input'); cb.type = 'checkbox'; cb.checked = !!plug.autoReload;
    cb.onchange = function () { TW.api('POST', '/api/features/plugins/auto', { on: cb.checked }).then(loadPlugins).catch(function (e) { TW.app().say(e.message, false, 3000); }); };
    auto.append(cb, el('span', '', i18n('pl.tu_nap_lai'))); bar.append(auto);
    bar.append(button(i18n('pl.kiem_lai'), 'ghost', function () { Promise.all(plug.servers.map(function (v) { return TW.api('POST', '/api/features/plugins/refresh', { server: v.id }).catch(function () {}); })).then(loadPlugins); }));
    box.append(bar);
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
          if (!pg.folder) acts.append(button(i18n('pl.cap_nhat'), '', function () {
            TW.api('POST', '/api/features/plugins/update', { server: v.id, cfg: a.cfg, id: pg.id }).then(function (x) { TW.app().say(i18n('pl.dang_cap_nhat', [x.session]), true, 4000); TW.app().openSession(v.id, x.session); }).catch(function (e) { TW.app().say(e.message, false, 4000); });
          }));
          else acts.title = i18n('pl.thu_muc_goi_y');
          r.append(acts); sec.append(r);
        });
      });
      if (v.stale.length) {
        var st = el('div', 'pl-stale'), sh = el('div', 'pl-stale-h');
        sh.append(el('span', '', i18n('pl.phien_ban_cu', [v.stale.length])));
        sh.append(button(i18n('pl.nap_lai_tat_ca', [v.stale.length]), 'primary', function () {
          TW.api('POST', '/api/features/plugins/reload', { server: v.id, all: true }).then(function (x) { TW.app().say(i18n('pl.da_nap', [x.now, x.queued]), true, 4000); loadPlugins(); }).catch(function (e) { TW.app().say(e.message, false, 4000); });
        }));
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
  function loadPlugins() { return TW.api('GET', '/api/features/plugins/data').then(function (r) { plug = r; if (!(editing && page && page.contains(document.activeElement))) draw(); }).catch(function () { /* optional */ }); }

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
    if (pluginPage) { pluginPage.textContent = ''; pluginPage.append(pluginCard()); }
    var stale = plug ? plug.servers.reduce(function (n, v) { return n + v.stale.length; }, 0) : 0;
    if (pluginTab) { pluginTab.textContent = i18n('pl.tieu_de'); if (stale) pluginTab.append(el('span', 'ops-badge', String(stale))); }
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
    var bar = el('div', 'ops-bar-top'); bar.append(summary(all)); page.append(bar);
    var shown = all.filter(function (x) { return (!filt.sev || x.f.severity === filt.sev) && (!filt.srv || x.s.id === filt.srv); }), groups = el('div', 'ops-groups');
    if (!shown.length) groups.append(el('p', 'ops-empty', i18n(all.length ? 'ops.khong_co_muc_loc' : 'ops.empty_sessions')));
    ['attention', 'waiting', 'running', 'routine'].forEach(function (g) {
      var items = shown.filter(function (x) { return dailyGroup(x) === g; }); if (!items.length) return;
      var box = el('details', 'ops-card ops-group g-' + g), sum = el('summary', 'ops-card-h'); keepOpen(box, 'daily-' + g, g !== 'routine');
      var h3 = el('h3', ''); h3.append(icon(g === 'attention' ? 'ask' : g === 'waiting' ? 'idle' : 'list'), document.createTextNode(i18n('ops.daily.' + g)), el('span', 'ops-count', String(items.length)));
      sum.append(h3); box.append(sum); items.forEach(function (x) { box.append(row(x.f, x.s)); }); groups.append(box);
    });
    page.append(groups);
    if (supervisionError || supervision && supervision.enabled && list(supervision.errors).length) page.append(button(i18n('ops.super.review_settings'), 'ghost', function () { TW.app().openSettings('sessions'); }));
    if (TW.serverBackupIssue) { var issue = TW.serverBackupIssue(data.servers); if (issue) page.append(issue); }
    page.append(logList());
    var n = all.filter(function (x) { return dailyGroup(x) === 'attention' || dailyGroup(x) === 'waiting'; }).length;
    if (tab) { tab.textContent = i18n('ops.tab'); if (n) tab.append(el('span', 'ops-badge', String(n))); }
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
    var pv = TW.addView({ id: 'plugins', label: i18n('pl.tieu_de'), mount: function (box) { pluginPage = box; box.classList.add('ops-page'); }, onShow: loadPlugins });
    if (pv) pluginTab = pv.tab;
    TW.on('ready', draw); TW.on('server-backup-updated', draw); mountSettings();
    load(); loadPlugins(); loadTokens(); setInterval(function () { if (!document.hidden) { load(); loadPlugins(); } }, 10000);
    setInterval(function () { if (!document.hidden) loadTokens(); }, 60000);
  })();
})();
