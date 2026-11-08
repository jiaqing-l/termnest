'use strict';
// "Vận hành" (Agent Ops): what needs attention across every machine, one suggested message per finding, and the log of
// what was sent and whether it landed. Rules and message templates form a JSON pack a team can export and share.
// A question or permission prompt is only shown here; it is answered by the person in the terminal.
(function () {
  var TW = window.TW; if (!TW) return;
  var el = TW.el, page = null, tab = null, data = null, busy = {}, editing = false;
  var pluginPage = null, pluginTab = null;
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
  function hostFresh(s) {
    var at = new Date(s.observedAt || 0).getTime(), max = s.freshness && s.freshness.maxAgeMs;
    return s.online === true && Number.isFinite(at) && at > 0 && at <= Date.now() + 5000 && Date.now() - at <= (Number.isFinite(max) && max > 0 ? max : 120000) && !(s.freshness && (s.freshness.snapshotFresh === false || s.freshness.taskEvidenceFresh === false));
  }
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
    supervisionBox.append(el('h3', '', i18n('ops.super.title')));
    supervisionStatus = el('div', 'ops-super-status'); supervisionStatus.setAttribute('aria-live', 'polite');
    supervisionForm = el('details', 'ops-super-settings'); keepOpen(supervisionForm, 'super-settings', false);
    supervisionForm.append(el('summary', '', i18n('ops.super.settings')));
    supervisionBox.append(supervisionForm, supervisionStatus);
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
      list(supervision.servers).some(function (s) { return s.id === w.serverId && hostFresh(s); });
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
      if (!w || !/^\.claude(?:-[A-Za-z0-9_-]+)?$/.test(config) || !list(supervision.servers).some(function (s) { return s.id === w.serverId && hostFresh(s); })) {
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
      // Use saved settings, never unsaved policy edits. Omit leaders so registrations remain untouched.
      var body = { enabled: supervision.enabled, autoRecovery: supervision.autoRecovery, intervalMinutes: supervision.intervalMinutes,
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
    box.append(el('h4', '', i18n('ops.super.account_title')), field('ops.super.account_workspace', scope), field('ops.super.account_profile', profile),
      el('p', 'ops-note', i18n('ops.super.account_help')), check, result, confirm);
    accountUI = { box: box, scope: scope, profile: profile, result: result, check: check, confirm: confirm, options: null };
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
    if (accountProof && !accountFresh(accountProof)) invalidateAccount(i18n('ops.super.account_expired'));
    var w = accountScope(), fresh = !!w && list(supervision.servers).some(function (s) { return s.id === w.serverId && hostFresh(s); });
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
      input.onchange = function () { supervisionDraft[key] = input.checked; renderSupervision(); };
      return field(i18n(label), input);
    }
    form.append(check('enabled', 'ops.super.enable'), check('autoRecovery', 'ops.super.recovery'), el('p', 'ops-note', i18n('ops.super.scope')));
    var interval = el('input'); interval.type = 'number'; interval.name = 'intervalMinutes'; interval.min = '1'; interval.max = '1440'; interval.required = true; interval.value = supervisionDraft.intervalMinutes;
    interval.oninput = function () { supervisionDraft.intervalMinutes = Number(interval.value); };
    form.append(field(i18n('ops.super.interval'), interval));
    var roots = el('textarea'); roots.name = 'workspaces'; roots.rows = 3;
    roots.value = supervisionDraft.workspaces.map(function (w) { return w.serverId + ' | ' + w.root; }).join('\n');
    // IDs identify configured servers, never panes/boot identities. No leader is implicitly registered here.
    roots.oninput = function () { supervisionDraft.workspaceText = roots.value; };
    form.append(field(i18n('ops.super.workspaces'), roots), el('p', 'ops-note', i18n('ops.super.workspace_help')));
    var names = list(supervision.servers).map(function (s) { return text(s.name || s.id) + ' = ' + text(s.id); }).join(' · ');
    form.append(el('p', 'ops-note', names));
    var candidates = list(supervision.registrationCandidates), leader = el('select'); leader.name = 'leader';
    var none = el('option', '', i18n('ops.super.keep_leaders')); none.value = ''; leader.append(none);
    candidates.forEach(function (c, index) {
      var server = list(supervision.servers).find(function (v) { return v.id === c.serverId; });
      var option = el('option', '', text(server && server.name || c.serverId) + ' · ' + text(c.session) + ' · ' + text(c.root)); option.value = String(index); leader.append(option);
    });
    leader.onchange = renderSupervision;
    var tasks = el('input'); tasks.name = 'taskIds'; tasks.type = 'text';
    var confirm = el('input'); confirm.type = 'checkbox'; confirm.name = 'confirmLeader'; confirm.onchange = renderSupervision;
    form.append(field(i18n('ops.super.register_leader'), leader), field(i18n('ops.super.task_ids'), tasks), field(i18n('ops.super.confirm_leader'), confirm), el('p', 'ops-note', i18n('ops.super.identity_help')));
    var save = button(i18n('ops.super.save'), 'primary', function () {}); save.type = 'submit'; save.name = 'save';
    form.append(save);
    form.onsubmit = function (e) {
      e.preventDefault(); if (supervisionPending || !supervision || !form.reportValidity()) return;
      var workspaces = [], valid = true;
      roots.value.split('\n').forEach(function (line) {
        if (!line.trim()) return;
        var split = line.indexOf('|'), serverId = line.slice(0, split).trim(), root = line.slice(split + 1).trim();
        if (split < 1 || !serverId || !root.startsWith('/') || !list(supervision.servers).some(function (s) { return s.id === serverId; })) valid = false;
        var previous = list(supervision.workspaces).find(function (w) { return w.serverId === serverId && w.root === root; });
        var workspace = Object.assign({}, previous || {}, { serverId: serverId, root: root });
        workspaces.push(workspace);
      });
      if (!valid) { TW.app().say(i18n('ops.super.workspace_invalid'), false, 4000); return; }
      var body = { enabled: supervisionDraft.enabled, autoRecovery: supervisionDraft.autoRecovery, intervalMinutes: supervisionDraft.intervalMinutes, workspaces: workspaces };
      if (leader.value !== '') {
        var candidate = candidates[Number(leader.value)], ids = tasks.value.split(/[\s,]+/).filter(Boolean);
        var current = list(supervision.registrationCandidates).find(function (c) { return sameLeader(candidate, c); });
        if (!confirm.checked || !current || !ids.length || ids.some(function (id) { return !/^[A-Za-z0-9][\w-]{0,127}$/.test(id); }) || !list(supervision.servers).some(function (s) { return s.id === current.serverId && hostFresh(s); }) || !workspaces.some(function (w) { return w.serverId === current.serverId && w.root === current.root; })) {
          TW.app().say(i18n('ops.super.registration_invalid'), false, 4000); return;
        }
        function record(c) { return { serverId: c.serverId, root: c.root, session: c.session, taskIds: c.taskIds, identity: c.identity }; }
        body.leaders = list(supervision.leaders).filter(function (l) { return l.serverId !== current.serverId || l.session !== current.session; }).map(record);
        body.leaders.push(record({ serverId: current.serverId, root: current.root, session: current.session, taskIds: ids, identity: current.identity }));
      }
      if (body.enabled && body.autoRecovery && !recoveryReady() && !body.leaders) return;
      supervisionPending = true; supervisionRevision++; renderSupervision();
      post('/supervision', body).then(function () {
        // A POST acknowledgement is not authoritative state. Require a new successful GET.
        return loadSupervision(true).then(function () { if (supervision && body.leaders) { leader.value = ''; confirm.checked = false; } });
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
    renderAccount();
    var save = supervisionForm.querySelector('[name=save]');
    if (save && supervisionDraft && supervisionDraft.enabled && supervisionDraft.autoRecovery && !recoveryReady() && !registrationSelected()) save.disabled = true;
    if (supervisionPending) supervisionStatus.append(el('p', 'ops-super-alert', i18n(accountChecking ? 'ops.super.account_checking' : 'ops.super.pending')));
    if (!supervision) {
      supervisionStatus.append(el('p', 'ops-super-alert', i18n(supervisionError ? 'ops.super.unavailable' : 'ops.super.loading'))); return;
    }
    var servers = list(supervision.servers), teams = [];
    servers.forEach(function (s) { list(s.teams).forEach(function (t) { teams.push({ server: s, team: t }); }); });
    supervisionStatus.append(el('p', '', i18n(supervision.enabled ? 'ops.super.enabled' : 'ops.super.disabled') + ' · ' + i18n('ops.super.observed', [teams.length])));
    var runtime = supervision.runtime || {}, ready = runtime.ready === true && !Object.keys(runtime).some(function (k) { return runtime[k] === false; });
    supervisionStatus.append(el('p', 'ops-note', i18n(ready ? 'ops.super.ready' : 'ops.super.readiness_unknown')));
    ['unlocked', 'monitoring', 'observationsFresh', 'validatedAuditCompletion', 'sshReady', 'auditReady', 'linger', 'registrationReady', 'recoveryReady'].forEach(function (k) {
      if (typeof runtime[k] === 'boolean') supervisionStatus.append(el('p', 'ops-note', i18n('ops.super.runtime_' + k) + ': ' + i18n(runtime[k] ? 'ops.super.confirmed' : 'ops.super.needs_setup')));
    });
    list(runtime.reasons).concat(list(supervision.errors)).forEach(function (r) { supervisionStatus.append(el('p', 'ops-super-alert', explanation(r))); });
    list(runtime.passwordOnlyAccounts).concat(list(supervision.auditReadiness)).forEach(function (r) { supervisionStatus.append(el('p', 'ops-super-alert', text(r.serverId) + ' · ' + text(r.root) + ': ' + explanation(r))); });
    if (runtime.platform) supervisionStatus.append(el('p', 'ops-note', i18n('ops.super.platform') + ': ' + explanation(runtime.platform.code || runtime.platform.startupCode)));
    if (runtime.code) supervisionStatus.append(el('p', 'ops-note', explanation(runtime.code)));
    if (!recoveryReady()) supervisionStatus.append(el('p', 'ops-super-alert', i18n('ops.super.registration')));
    supervisionStatus.append(el('p', 'ops-note', i18n('ops.super.wait_valid')));
    var all = el('details', 'ops-super-teams'); keepOpen(all, 'super-teams', false); all.append(el('summary', '', i18n('ops.super.teams', [teams.length])));
    function teamRow(x) {
      var s = x.server, t = x.team, row = el('div', 'ops-super-row');
      var stale = !hostFresh(s);
      var state = teamState(s, t);
      row.append(el('b', '', text(s.name || s.id) + ' · ' + text(t.session || t.id)), el('span', 'ops-super-state', i18n('ops.super.state_' + state)));
      row.append(el('p', '', stale ? i18n('ops.super.stale') : state === 'unknown' && t.status === 'progressing' ? i18n('ops.super.no_evidence') : explanation(t.reason)));
      if (t.requiresOwner) row.append(el('p', 'ops-super-alert', i18n('ops.super.owner_action')));
      row.append(el('small', '', i18n('ops.super.evidence', [stamp(t.lastProgressAt)])));
      if (t.lastAction) row.append(el('p', 'ops-note', i18n('ops.super.last_action') + ': ' + explanation(t.lastAction) + ' · ' + stamp(t.lastAction.at)));
      if (typeof t.session === 'string' && t.session && s.online === true) row.append(button(i18n('ops.super.open'), 'ghost', function () { TW.app().openSession(s.id, t.session); }));
      return row;
    }
    var attention = teams.filter(function (x) { return x.team.requiresOwner || !['progressing', 'completed'].includes(teamState(x.server, x.team)); });
    supervisionStatus.append(el('h4', '', i18n('ops.super.attention', [attention.length])));
    attention.forEach(function (x) { supervisionStatus.append(teamRow(x)); });
    teams.forEach(function (x) { all.append(teamRow(x)); }); supervisionStatus.append(all);
    servers.forEach(function (s) {
      supervisionStatus.append(el('p', 'ops-note', text(s.name || s.id) + ' · ' + i18n(s.online === true ? 'ops.super.observed_at' : 'ops.super.offline', [stamp(s.observedAt)])));
      list(s.errors).forEach(function (r) { supervisionStatus.append(el('p', 'ops-super-alert', explanation(r))); });
      list(s.audits).slice(-3).forEach(function (a) {
        var reported = a.phase === 'completed' && a.verification === 'reported';
        supervisionStatus.append(el('p', reported ? 'ops-note' : 'ops-super-alert', text(s.name || s.id) + ' · ' + i18n(reported ? 'ops.super.audit_reported' : 'ops.super.audit_unverified') + ': ' + explanation(a.reason)));
      });
    });
  }
  function loadSupervision(force) {
    if ((!force && supervisionFetching) || (supervisionPending && !force)) return Promise.resolve();
    var revision = ++supervisionRevision; supervisionFetching = true;
    return TW.api('GET', '/api/features/ops/supervision').then(function (r) {
      if (revision !== supervisionRevision) return;
      if (!r || typeof r.enabled !== 'boolean' || !Array.isArray(r.servers)) throw Error('invalid supervision');
      supervision = r; supervisionError = false;
    }).catch(function () { if (revision === supervisionRevision) { supervision = null; supervisionError = true; } })
      .finally(function () { supervisionFetching = false; renderSupervision(); });
  }

  // Short status for the second half of a row ("<session> — <status>"); the session or job name is the first half.
  function status(f) {
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
      [['session', 'ops.han_5_gio'], ['weekly', 'ops.han_tuan']].forEach(function (w) {
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
    r.append(el('span', 'ops-dot'));
    var name = label(f) || srv.name;
    line.append(el('b', 'ops-name', name), el('span', 'ops-status', status(f)));
    var meta = el('small', 'ops-meta');
    meta.append(document.createTextNode([f.session ? srv.name : '', since(f.since)].filter(Boolean).join(' · ')));
    var src = el('span', 'ops-src ' + f.source, i18n('ops.src_' + f.source)); meta.append(src);
    t.append(line, meta); r.append(t);
    if (inTerminal(f)) acts.append(button(i18n('ops.mo'), '', function () { TW.app().openSession(srv.id, f.session); }));
    if (f.template) {
      var send = button(i18n('ops.gui_nhac'), 'primary', function () {
        if (busy[f.key]) return; busy[f.key] = true; send.disabled = true;
        post('/nudge', { server: srv.id, key: f.key }).then(function () { TW.app().say(i18n('ops.da_gui_nhac', [f.session]), true, 2500); load(); })
          .catch(function (e) { TW.app().say(e.message, false, 4000); }).then(function () { busy[f.key] = false; send.disabled = false; });
      });
      // The message it would type, on hover and for screen readers, instead of a code block on every row.
      send.title = i18n('ops.se_gui', [data.pack.templates[f.template] || '']); send.setAttribute('aria-label', send.title);
      acts.append(send);
    }
    acts.append(button(i18n('ops.bo_qua'), 'ghost', function () { post('/dismiss', { key: f.key }).then(load); }));
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
    var box = el('details', 'ops-card ops-ev ops-log-sec'), head = el('summary', 'ops-card-h'), lh = el('h3', ''); keepOpen(box, 'log', data.log.length > 0);
    lh.append(icon('log'), document.createTextNode(i18n('ops.so_ghi')), el('span', 'ops-count', String(data.log.length)));
    head.append(lh);
    if (data.log.length) { var clr = button(i18n('ops.xoa_so'), 'ghost', function (e) { e.preventDefault(); post('/log/clear').then(load); }); head.append(clr); }
    box.append(head);
    if (!data.log.length) { box.append(el('p', 'ops-empty', i18n('ops.so_trong'))); return box; }
    data.log.slice(0, 20).forEach(function (n) {
      var r = el('div', 'ops-log'), st = n.verified === true ? 'ok' : n.verified === false ? 'bad' : 'wait';
      r.append(el('span', 'ops-st ' + st, i18n('ops.st_' + st)), el('span', 'ops-log-t', i18n('ops.n.' + n.rule) + ' → ' + n.session + ' · ' + (n.serverName || '')),
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
    var bar = el('div', 'ops-bar');
    bar.append(button(i18n('ops.luu'), 'primary', function () { post('/pack', { pack: p }).then(function () { editing = false; TW.app().say(i18n('ops.da_luu'), true, 2000); load(); }).catch(function (e) { TW.app().say(e.message, false, 4000); }); }),
      button(i18n('ops.xuat_goi'), '', function () {
        var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' })); a.download = 'termnest-ops-' + (p.name || 'core') + '.json'; a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
      }),
      button(i18n('ops.nhap_goi'), '', function () {
        var f = document.createElement('input'); f.type = 'file'; f.accept = '.json,application/json';
        f.onchange = function () {
          var file = f.files && f.files[0]; if (!file) return;
          file.text().then(function (t) { return post('/pack', { pack: JSON.parse(t) }); })
            .then(function () { TW.app().say(i18n('ops.da_nhap'), true, 2500); editing = false; load(); })
            .catch(function () { TW.app().say(i18n('ops.goi_loi'), false, 4000); });
        };
        f.click();
      }),
      button(i18n('ops.mac_dinh'), 'ghost', function () { post('/pack', { reset: true }).then(function () { editing = false; load(); }); }),
      button(i18n('ops.dong'), 'ghost', function () { editing = false; draw(); }));
    box.append(bar); return box;
  }

  function draw() {
    if (pluginPage) { pluginPage.textContent = ''; pluginPage.append(pluginCard()); }
    var stale = plug ? plug.servers.reduce(function (n, v) { return n + v.stale.length; }, 0) : 0;
    if (pluginTab) { pluginTab.textContent = i18n('pl.tieu_de'); if (stale) pluginTab.append(el('span', 'ops-badge', String(stale))); }
    if (!page || !data) return;
    var previousRules = editing && page.querySelector('.ops-rules');
    if (supervisionBox) supervisionBox.remove();
    page.textContent = '';
    var all = [];
    data.servers.forEach(function (s) { s.findings.forEach(function (f) { all.push({ f: f, s: s }); }); });
    var accts = { id: '', name: i18n('ops.tai_khoan_ai'), sessions: [] };
    quotaFindings().forEach(function (f) { if (!data.dismissedKeys || data.dismissedKeys.indexOf(f.key) < 0) all.push({ f: f, s: accts }); });
    all.sort(function (a, b) { return (SEV[a.f.severity] - SEV[b.f.severity]) || (b.f.since - a.f.since); });
    var head = el('div', 'ops-head'), h = el('div', 'ops-title');
    h.append(el('h2', '', i18n('ops.tieu_de')), el('p', '', i18n('ops.mo_ta', [data.servers.length, data.servers.reduce(function (n, s) { return n + s.sessions.length; }, 0)])));
    var tools = el('div', 'ops-tools');
    if (data.dismissed) tools.append(button(i18n('ops.hien_lai', [data.dismissed]), 'ghost', function () { post('/dismiss', { all: true }).then(load); }));
    // Open the separate plugin view; count sessions running an older plugin.
    var staleN = 0; ((plug && plug.servers) || []).forEach(function (v) { staleN += v.stale.length; });
    var jump = button(i18n('pl.tieu_de'), 'ghost ops-jump', function () { TW.app().setView('plugins'); });
    jump.prepend(icon('plug')); if (staleN) jump.append(el('span', 'ops-count warn', String(staleN)));
    tools.append(jump);
    // Open or close every section at once (each section remembers its state on this device).
    function setAll(open) { page.querySelectorAll('details.ops-card').forEach(function (d) { if (d.open !== open) d.open = open; }); }
    var exp = el('div', 'ops-expand'); exp.append(button(i18n('ops.mo_het'), 'ghost', function () { setAll(true); }), button(i18n('ops.thu_het'), 'ghost', function () { setAll(false); }));
    tools.append(exp);
    tools.append(button(i18n('ops.chinh_luat'), '', function () { editing = !editing; draw(); }));
    head.append(h, tools); page.append(head, supervisionCard());
    var bar = el('div', 'ops-bar-top'); bar.append(summary(all)); page.append(bar);
    if (editing) page.append(previousRules || rulesForm());
    var shown = all.filter(function (x) { return (!filt.sev || x.f.severity === filt.sev) && (!filt.srv || x.s.id === filt.srv); });
    var groups = el('div', 'ops-groups');
    if (!shown.length) { var e = el('section', 'ops-card'); e.append(el('p', 'ops-empty ok', i18n(all.length ? 'ops.khong_co_muc_loc' : 'ops.on_ca'))); groups.append(e); }
    ['ask', 'idle', 'job', 'quota', 'issue', 'machine'].forEach(function (g) {
      var items = shown.filter(function (x) { return group(x.f) === g; }); if (!items.length) return;
      var box = el('details', 'ops-card ops-group g-' + g), sum = el('summary', 'ops-card-h'); keepOpen(box, 'g-' + g, true);
      var h3 = el('h3', ''); h3.append(icon(g), document.createTextNode(i18n('ops.g.' + g)), el('span', 'ops-count', String(items.length)));
      sum.append(h3, el('small', 'ops-pack', i18n('ops.gd.' + g))); box.append(sum);
      items.forEach(function (x) { box.append(row(x.f, x.s)); }); groups.append(box);
    });
    page.append(el('div', 'ops-part', i18n('ops.phan_chu_y')), groups, el('div', 'ops-part', i18n('ops.phan_chi_tiet')));
    page.append(jobList(), evidence(), logList());
    var n = all.filter(function (x) { return x.f.severity !== 'info'; }).length;
    if (tab) { tab.textContent = i18n('ops.tab'); if (n) tab.append(el('span', 'ops-badge', String(n))); }
  }

  function load() {
    loadSupervision();
    return TW.api('GET', '/api/features/ops/board').then(function (r) {
      data = r;
      // Typing in the rules form must not be wiped by the refresh.
      var active = document.activeElement; if (editing && page && page.contains(active)) return;
      draw();
    }).catch(function () { /* locked or offline: try again on the next tick */ });
  }

  (function () {
    var v = TW.addView({ id: 'ops', label: i18n('ops.tab'), mount: function (box) { page = box; box.classList.add('ops-page'); box.append(supervisionCard()); }, onShow: load });
    if (v) tab = v.tab;
    var pv = TW.addView({ id: 'plugins', label: i18n('pl.tieu_de'), mount: function (box) { pluginPage = box; box.classList.add('ops-page'); }, onShow: loadPlugins });
    if (pv) pluginTab = pv.tab;
    load(); loadPlugins(); loadTokens(); setInterval(function () { if (!document.hidden) { load(); loadPlugins(); } }, 10000);
    setInterval(function () { if (!document.hidden) loadTokens(); }, 60000);
  })();
})();
