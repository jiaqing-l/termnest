'use strict';
// "Vận hành" (Agent Ops): what needs attention across every machine, one suggested message per finding, and the log of
// what was sent and whether it landed. Rules and message templates form a JSON pack a team can export and share.
// A question or permission prompt is only shown here; it is answered by the person in the terminal.
(function () {
  var TW = window.TW; if (!TW) return;
  var el = TW.el, page = null, tab = null, data = null, busy = {}, editing = false;
  var SEV = { urgent: 0, warn: 1, info: 2 };
  var RULES = ['asking', 'finished', 'dormant', 'aborted', 'unknown', 'exited', 'overload', 'lost', 'offline', 'unheard'];

  function title(f) { return f.rule === 'custom' ? f.params[0] : i18n('ops.r.' + f.rule, f.params); }
  function who(f) { return f.session.indexOf('bg:') === 0 ? i18n('ops.phien_nen', [f.session.slice(3)]) : f.session; }
  function since(sec) { return sec < 60 ? i18n('ops.vua_moi') : sec < 3600 ? i18n('ops.phut', [Math.floor(sec / 60)]) : i18n('ops.gio', [Math.floor(sec / 3600)]); }
  function button(label, cls, fn) { var b = el('button', 'btn ' + (cls || ''), label); b.type = 'button'; b.onclick = fn; return b; }
  function post(path, body) { return TW.api('POST', '/api/features/ops' + path, body || {}); }

  function row(f, srv) {
    var r = el('div', 'ops-row ' + f.severity), t = el('div', 'ops-t'), acts = el('div', 'ops-acts');
    r.append(el('span', 'ops-dot'));
    var meta = el('small', ''); meta.append(el('span', 'ops-src ' + f.source, i18n('ops.src_' + f.source)), document.createTextNode(' ' + [who(f), srv.name, since(f.since)].filter(Boolean).join(' · ')));
    t.append(el('b', '', title(f)), meta);
    if (f.template && data.pack.templates[f.template]) t.append(el('code', 'ops-msg', data.pack.templates[f.template]));
    r.append(t);
    if (f.session && f.session.indexOf('bg:') !== 0) acts.append(button(i18n('ops.mo'), '', function () { TW.app().openSession(srv.id, f.session); }));
    if (f.template) {
      var send = button(i18n('ops.gui_nhac'), 'primary', function () {
        if (busy[f.key]) return; busy[f.key] = true; send.disabled = true;
        post('/nudge', { server: srv.id, key: f.key }).then(function () { TW.app().say(i18n('ops.da_gui_nhac', [f.session]), true, 2500); load(); })
          .catch(function (e) { TW.app().say(e.message, false, 4000); }).then(function () { busy[f.key] = false; send.disabled = false; });
      });
      acts.append(send);
    }
    acts.append(button(i18n('ops.bo_qua'), 'ghost', function () { post('/dismiss', { key: f.key }).then(load); }));
    r.append(acts); return r;
  }

  function summary(all) {
    var box = el('div', 'ops-sum'), n = { urgent: 0, warn: 0, info: 0 };
    all.forEach(function (x) { n[x.f.severity]++; });
    [['urgent', 'ops.can_ban'], ['warn', 'ops.can_xem'], ['info', 'ops.thong_tin']].forEach(function (k) {
      var c = el('span', 'ops-chip ' + k[0]); c.append(el('b', '', String(n[k[0]])), el('span', '', i18n(k[1]))); box.append(c);
    });
    return box;
  }

  function logList() {
    var box = el('section', 'ops-card'), head = el('div', 'ops-card-h');
    head.append(el('h3', '', i18n('ops.so_ghi')));
    if (data.log.length) head.append(button(i18n('ops.xoa_so'), 'ghost', function () { post('/log/clear').then(load); }));
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
      var lv = el('select'); ['off', 'notify', 'suggest'].forEach(function (v) {
        if (v === 'suggest' && !r.template) return;
        var o = el('option', '', i18n('ops.lv_' + v)); o.value = v; if (r.level === v) o.selected = true; lv.append(o);
      });
      lv.onchange = function () { r.level = lv.value; };
      var after = el('input'); after.type = 'number'; after.min = '0'; after.max = '1440'; after.value = r.after; after.setAttribute('aria-label', i18n('ops.sau_phut'));
      after.oninput = function () { r.after = Number(after.value); };
      var a = el('label', 'ops-after'); a.append(after, el('span', '', i18n('ops.phut_ngan')));
      grid.append(name, lv, a);
    });
    box.append(grid);
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
    all.sort(function (a, b) { return (SEV[a.f.severity] - SEV[b.f.severity]) || (b.f.since - a.f.since); });
    var head = el('div', 'ops-head'), h = el('div', 'ops-title');
    h.append(el('h2', '', i18n('ops.tieu_de')), el('p', '', i18n('ops.mo_ta', [data.servers.length, data.servers.reduce(function (n, s) { return n + s.sessions.length; }, 0)])));
    var tools = el('div', 'ops-tools');
    if (data.dismissed) tools.append(button(i18n('ops.hien_lai', [data.dismissed]), 'ghost', function () { post('/dismiss', { all: true }).then(load); }));
    tools.append(button(i18n('ops.chinh_luat'), '', function () { editing = !editing; draw(); }));
    head.append(h, summary(all), tools); page.append(head);
    if (editing) page.append(rulesForm());
    var list = el('section', 'ops-card ops-list');
    if (!all.length) list.append(el('p', 'ops-empty ok', i18n('ops.on_ca')));
    all.forEach(function (x) { list.append(row(x.f, x.s)); });
    page.append(list, logList());
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
    load(); setInterval(function () { if (!document.hidden) load(); }, 10000);
  })();
})();
