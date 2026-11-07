'use strict';
// "Vận hành" (Agent Ops): what needs attention across every machine, one suggested message per finding, and the log of
// what was sent and whether it landed. Rules and message templates form a JSON pack a team can export and share.
// A question or permission prompt is only shown here; it is answered by the person in the terminal.
(function () {
  var TW = window.TW; if (!TW) return;
  var el = TW.el, page = null, tab = null, data = null, busy = {}, editing = false;
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

  // Optional "Xspire Crew" pack: shown only for machines where a session works under a _crew workspace.
  var crew = null, crewMore = {};
  var CAT = { BLOCKER: 'urgent', WASTE: 'warn', DRIFT: 'warn', INFO: 'info' };
  function auditSkillFor(srv, root) {
    var p = plug && (plug.servers || []).filter(function (v) { return v.id === srv.id; })[0];
    return !!p && (p.enabledSkills || []).some(function (e) { return (e.cwd === root || e.cwd.indexOf(root + '/') === 0) && e.skills.some(function (k) { return /:xspire-crew-ops-audit$/.test(k); }); });
  }
  function crewCard() {
    if (!crew || !crew.servers || !crew.servers.length) return null;
    var box = el('details', 'ops-card ops-ev ops-crew'), sum = el('summary', 'ops-card-h'); keepOpen(box, 'crew', true);
    var n = 0; crew.servers.forEach(function (v) { n += v.findings.filter(function (f) { return f.cat === 'BLOCKER'; }).length; });
    var h3 = el('h3', ''); h3.append(icon('crew'), document.createTextNode(i18n('cp.tieu_de'))); if (n) h3.append(el('span', 'ops-count', String(n)));
    sum.append(h3, el('small', 'ops-pack', i18n('cp.mo_ta'))); box.append(sum);
    var bar = el('div', 'pl-bar'), lab = el('label', 'pl-auto'), sel = el('select', 'ops-srv cp-sched');
    [0, 2, 4, 8, 24].forEach(function (h) { var o = el('option', '', h ? i18n('cp.moi_gio', [h]) : i18n('cp.lich_tat')); o.value = String(h); if (crew.auditHours === h) o.selected = true; sel.append(o); });
    sel.onchange = function () { TW.api('POST', '/api/features/crewpack/schedule', { hours: Number(sel.value) }).then(loadCrew); };
    lab.append(el('span', '', i18n('cp.lich_ong_trum')), sel); bar.append(lab);
    var dl = el('label', 'pl-auto'), ds = el('select', 'ops-srv cp-sched');
    [1, 3, 7, 14].forEach(function (d) { var o = el('option', '', i18n('cp.ngay', [d])); o.value = String(d); if (crew.days === d) o.selected = true; ds.append(o); });
    ds.onchange = function () { TW.api('POST', '/api/features/crewpack/days', { days: Number(ds.value) }).then(function () { setTimeout(loadCrew, 1500); }); };
    dl.append(el('span', '', i18n('cp.xet_task')), ds); bar.append(dl); box.append(bar);
    crew.servers.forEach(function (v) {
      var sec = el('div', 'pl-srv'), head = el('div', 'pl-srv-h');
      var hl = el('div', 'cp-hl'), pills = el('div', 'cp-pills');
      hl.append(el('b', '', v.local ? i18n('app.local_name') : v.name));
      v.roots.forEach(function (r) { var m = el('small', 'cp-root', r.root.split('/').filter(Boolean).pop() + ' · ' + i18n('cp.so_task', [r.tasks, r.enrolled])); m.title = r.root; hl.append(m); });
      head.append(hl, pills);
      // Crew kit version (commit of scripts/crew); marked when machines run different versions.
      (v.kit || []).forEach(function (k) {
        var others = []; crew.servers.forEach(function (o) { (o.kit || []).forEach(function (x) { if (x.commit) others.push(x.commit); }); });
        var differs = k.commit && others.some(function (c) { return c !== k.commit; });
        pills.append(el('span', 'ops-src' + (differs ? ' cp-kit-diff' : ''), k.commit ? i18n(differs ? 'cp.kit_khac' : 'cp.kit', [k.commit, when(k.at)]) : i18n('cp.kit_khong_ro')));
      });
      v.roots.forEach(function (r) {
        if (!auditSkillFor(v, r.root)) { pills.append(el('span', 'ops-src', i18n('cp.chua_co_skill'))); return; }
        var b = button(v.auditOpen || v.auditPending ? i18n('cp.dang_chay_trum') : i18n('cp.chay_trum'), 'primary', function () {
          TW.api('POST', '/api/features/crewpack/audit', { server: v.id, root: r.root }).then(function (x) { TW.app().say(i18n('cp.da_mo_trum', [x.session]), true, 4000); TW.app().openSession(v.id, x.session); }).catch(function (e) { TW.app().say(e.message, false, 4000); });
        });
        if (v.auditPending) b.disabled = true; b.classList.add('cp-audit'); head.append(b);
      });
      sec.append(head);
      // Board per orchestrator: each session enrolled in nudge.conf, its open tasks, their tracks, and the workers running them.
      var bySession = {}; (v.tasks || []).forEach(function (t) { if (t.session && ['done', 'closed', 'abandoned', 'archived', 'merged'].indexOf(t.status) < 0) (bySession[t.session] = bySession[t.session] || []).push(t); });
      var orch = Object.keys(bySession);
      if (orch.length) {
        sec.append(el('div', 'cp-sub', i18n('cp.theo_orch', [orch.length])));
        orch.forEach(function (name) {
          var o = el('div', 'cp-orch'), oh = el('div', 'cp-orch-h');
          var on = el('div', 'cp-on'); on.append(icon('user'), el('b', '', name), el('small', '', i18n('cp.so_task_mo', [bySession[name].length])));
          oh.append(on, button(i18n('ops.mo'), 'ghost cp-open', function () { TW.app().openSession(v.id, name); })); o.append(oh);
          bySession[name].forEach(function (t) {
            var tr = el('div', 'cp-task'), tt = el('div', 'ops-t'), tk = el('div', 'cp-tracks');
            var tl = el('div', 'cp-tl'); tl.append(el('span', 'cp-dot ' + t.status), el('b', 'ops-name', t.title || t.id));
            tt.append(tl, el('small', 'ops-meta', [t.status, t.id, when(t.updated)].join(' · ')));
            t.tracks.forEach(function (k) {
              var w = (v.workers || []).filter(function (x) { return x.task === t.id && x.track === k.id; })[0];
              var chipT = el('span', 'cp-tr ' + (w ? 'running' : k.state), k.id + ' · ' + (w ? i18n('cp.worker_chay', [w.kind || 'agent', span(w.elapsed / 60)]) : k.state) + (k.fixRounds ? ' · ' + i18n('cp.vong_sua', [k.fixRounds]) : ''));
              var fg = forgeOf[k.remote + '|' + k.branch];
              if (fg && fg.linked && !fg.error) {
                if (fg.mr) chipT.append(el('span', 'cp-mr ' + fg.mr.state, ' · ' + (fg.kind === 'github' ? 'PR #' : 'MR !') + fg.mr.number + ' ' + i18n('fg.mr_' + fg.mr.state)));
                if (fg.ci) chipT.append(el('span', 'cp-ci ' + fg.ci.state, ' · ' + i18n('fg.ci_' + fg.ci.state)));
              }
              if (k.branch) chipT.title = k.branch;
              tk.append(chipT);
            });
            tr.classList.add('cp-otask'); tr.append(tt, tk); o.append(tr);
          });
          sec.append(o);
        });
      } else sec.append(el('p', 'ops-note', i18n('cp.khong_orch')));
      if (v.findings.length) sec.append(el('div', 'cp-sub', i18n('cp.bat_thuong', [v.findings.length])));
      else sec.append(el('p', 'ops-empty ok', i18n('cp.on')));
      var more = !!(crewMore[v.id]), list = more ? v.findings : v.findings.slice(0, 10);
      list.forEach(function (f) {
        var r = el('div', 'ops-row ' + CAT[f.cat]), t = el('div', 'ops-t'), line = el('div', 'ops-line');
        line.append(el('span', 'cp-cat ' + f.cat, f.cat), el('b', 'ops-name', f.title || f.task), el('span', 'ops-status', i18n('cp.c.' + f.code, f.params)));
        var meta = el('small', 'ops-meta'); meta.append(document.createTextNode([f.task, f.session ? i18n('cp.phien', [f.session]) : ''].filter(Boolean).join(' · ')));
        t.append(line, meta); r.append(el('span', 'ops-dot'), t);
        var acts = el('div', 'ops-acts'); if (f.session) acts.append(button(i18n('ops.mo'), '', function () { TW.app().openSession(v.id, f.session); }));
        r.append(acts); sec.append(r);
      });
      if (v.findings.length > 10) sec.append(button(more ? i18n('cp.thu_gon') : i18n('cp.xem_them', [v.findings.length - 10]), 'ghost cp-more', function () { crewMore[v.id] = !more; draw(); }));
      // Every recent task: status and tracks by state, as the MANIFEST says.
      if ((v.tasks || []).length) {
        var all = el('details', 'cp-all'), s2 = el('summary', 'cp-sub'); keepOpen(all, 'crew-all-' + v.id, false);
        s2.textContent = i18n('cp.tat_ca_task', [v.tasks.length, crew.days]); all.append(s2);
        v.tasks.forEach(function (t) {
          var row = el('div', 'cp-task'), tr = el('div', 'cp-tracks');
          t.tracks.forEach(function (k) { var c = el('span', 'cp-tr ' + k.state, k.id + ' · ' + k.state + (k.fixRounds ? ' · ' + i18n('cp.vong_sua', [k.fixRounds]) : '')); tr.append(c); });
          var tt = el('div', 'ops-t'); tt.append(el('b', 'ops-name', t.title || t.id), el('small', 'ops-meta', [t.id, when(t.updated), t.session ? i18n('cp.phien', [t.session]) : ''].filter(Boolean).join(' · ')));
          row.append(el('span', 'cp-st ' + t.status, t.status || '—'), tt, tr); all.append(row);
        });
        sec.append(all);
      }
      box.append(sec);
    });
    if (crew.audits && crew.audits.length) {
      var lg = el('div', 'pl-log'); lg.append(el('small', 'ops-pack', i18n('cp.lan_chay')));
      crew.audits.slice(0, 5).forEach(function (a) { lg.append(el('div', 'pl-log-r', when(a.at) + ' · ' + a.root + ' · ' + i18n('cp.vi_' + a.why))); });
      box.append(lg);
    }
    return box;
  }
  // MR / pipeline of open tracks' branches, through the "Kết nối" feature (nothing shown without a connection).
  var forgeOf = {};
  function loadForge() {
    if (!crew || !window.TW_FORGE) return;
    var items = [];
    crew.servers.forEach(function (v) { (v.tasks || []).forEach(function (t) { if (!t.session || ['done', 'closed', 'abandoned', 'archived', 'merged'].indexOf(t.status) >= 0) return; t.tracks.forEach(function (k) { if (k.remote && k.branch) items.push({ remote: k.remote, branch: k.branch }); }); }); });
    if (!items.length) return;
    window.TW_FORGE.branches(items.slice(0, 40)).then(function (r) { (r.items || []).forEach(function (x, i) { forgeOf[items[i].remote + '|' + items[i].branch] = x; }); draw(); }).catch(function () { /* optional */ });
  }
  function loadCrew() { return TW.api('GET', '/api/features/crewpack/data').then(function (r) { crew = r; loadForge(); if (!(editing && page && page.contains(document.activeElement))) draw(); }).catch(function () { crew = null; }); }

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
    if (!page || !data) return;
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
    // Jump to the plugin card (it sits below the groups); its count shows how many sessions run an older plugin.
    var staleN = 0; ((plug && plug.servers) || []).forEach(function (v) { staleN += v.stale.length; });
    var jump = button(i18n('pl.tieu_de'), 'ghost ops-jump', function () { var c = page.querySelector('.ops-plug'); if (c) { c.open = true; c.scrollIntoView({ behavior: 'smooth', block: 'start' }); } });
    jump.prepend(icon('plug')); if (staleN) jump.append(el('span', 'ops-count warn', String(staleN)));
    tools.append(jump);
    // Open or close every section at once (each section remembers its state on this device).
    function setAll(open) { page.querySelectorAll('details.ops-card').forEach(function (d) { if (d.open !== open) d.open = open; }); }
    var exp = el('div', 'ops-expand'); exp.append(button(i18n('ops.mo_het'), 'ghost', function () { setAll(true); }), button(i18n('ops.thu_het'), 'ghost', function () { setAll(false); }));
    tools.append(exp);
    tools.append(button(i18n('ops.chinh_luat'), '', function () { editing = !editing; draw(); }));
    head.append(h, tools); page.append(head);
    var bar = el('div', 'ops-bar-top'); bar.append(summary(all)); page.append(bar);
    if (editing) page.append(rulesForm());
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
    var cc = crewCard();
    page.append(el('div', 'ops-part', i18n('ops.phan_chu_y')), groups, el('div', 'ops-part', i18n('ops.phan_chi_tiet')));
    if (cc) page.append(cc); page.append(pluginCard(), jobList(), evidence(), logList());
    var n = all.filter(function (x) { return x.f.severity !== 'info'; }).length;
    if (tab) { tab.textContent = i18n('ops.tab'); if (n) tab.append(el('span', 'ops-badge', String(n))); }
  }

  function load() {
    return TW.api('GET', '/api/features/ops/board').then(function (r) {
      data = r;
      // Typing in the rules form must not be wiped by the refresh.
      var active = document.activeElement; if (editing && page && page.contains(active)) return;
      draw();
    }).catch(function () { /* locked or offline: try again on the next tick */ });
  }

  (function () {
    var v = TW.addView({ id: 'ops', label: i18n('ops.tab'), mount: function (box) { page = box; box.classList.add('ops-page'); }, onShow: load });
    if (v) tab = v.tab;
    load(); loadPlugins(); loadTokens(); loadCrew(); setInterval(function () { if (!document.hidden) { load(); loadPlugins(); loadCrew(); } }, 10000);
    setInterval(function () { if (!document.hidden) loadTokens(); }, 60000);
  })();
})();
