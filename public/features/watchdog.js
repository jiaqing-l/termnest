'use strict';
// Rule watchdog UI: a chip on each server heading listing flagged processes, and a banner for urgent ones.
// Freeze / resume / stop are explicit clicks; stop asks for a second click.
(function () {
  var TW = window.TW; if (!TW) return;
  var el = TW.el, data = {}, chips = {}, SEV = { urgent: 3, warn: 2, info: 1 };
  function found(id) { return (data[id] && data[id].found) || []; }
  function worst(list) { return list.reduce(function (m, f) { return Math.max(m, SEV[f.severity] || 1); }, 0); }
  function act(id, f, action, done) {
    TW.api('POST', '/api/features/watchdog/act', { server: id, pid: f.pid, args: f.args, action: action })
      .then(function (r) { TW.app().say(r.sent ? i18n('watchdog.da_gui_lenh_cho_tien', [action, f.pid]) : i18n('watchdog.tien_trinh_da_thay_doi'), !!r.sent, 3500); done(); })
      .catch(function (e) { TW.app().say(e.message, false, 4000); done(); });
  }
  function row(id, f, redraw) {
    var r = el('div', 'wd-row ' + f.severity), t = el('div', 'wd-t'), bar = el('div', 'wd-bar');
    t.append(el('b', '', f.title), el('small', '', 'pid ' + f.pid + ' · ' + f.cpu + '% CPU · ' + f.rssMb + ' MB'), el('code', '', f.args));
    [['freeze', i18n('watchdog.dong_bang')], ['resume', i18n('watchdog.chay_tiep')]].forEach(function (a) {
      var b = el('button', 'btn', a[1]); b.type = 'button'; b.onclick = function () { act(id, f, a[0], redraw); }; bar.append(b);
    });
    var stop = el('button', 'btn', i18n('app.dung')), armed = false; stop.type = 'button';
    stop.onclick = function () {
      if (!armed) { armed = true; stop.textContent = i18n('watchdog.bam_lan_nua_de_dung'); stop.classList.add('primary'); setTimeout(function () { armed = false; stop.textContent = i18n('app.dung'); stop.classList.remove('primary'); }, 4000); return; }
      act(id, f, 'stop', redraw);
    };
    bar.append(stop); r.append(t, bar); return r;
  }
  function fill(box, id) {
    var list = found(id); box.textContent = ''; box.hidden = !list.length; if (!list.length) return;
    var w = worst(list), btn = el('button', 'wd-chip ' + (w >= 3 ? 'urgent' : 'warn'), i18n('watchdog.vi_pham_luat', [list.length])), panel = el('div', 'wd-panel'); btn.type = 'button'; panel.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    btn.onclick = function () { panel.hidden = !panel.hidden; btn.setAttribute('aria-expanded', String(!panel.hidden)); };
    list.slice(0, 12).forEach(function (f) { panel.append(row(id, f, refresh)); }); box.append(btn, panel);
  }
  TW.addServerDecorator(function (node, v) {
    var box = el('div', 'wd-box'); box.hidden = true; chips[v.id] = box; fill(box, v.id); node.append(box);
  });
  function banner() {
    var urgent = [];
    Object.keys(data).forEach(function (id) { found(id).forEach(function (f) { if (f.severity === 'urgent') urgent.push(f); }); });
    if (!urgent.length) { TW.banner.hide('watchdog'); return; }
    TW.banner.show({ id: 'watchdog', level: 'urgent', title: i18n('watchdog.tram_gac_luat', [urgent[0].title]), detail: urgent.length > 1 ? i18n('watchdog.va_vi_pham_nua_mo', [(urgent.length - 1)]) : i18n('watchdog.mo_chip_o_ten_may') });
  }
  function refresh() {
    TW.api('GET', '/api/features/watchdog/data').then(function (r) {
      data = r.servers || {};
      Object.keys(chips).forEach(function (id) { if (chips[id].isConnected) { var open = chips[id].querySelector('.wd-panel:not([hidden])'); if (!open) fill(chips[id], id); } else delete chips[id]; });
      banner();
    }).catch(function () { /* optional */ });
  }
  refresh(); setInterval(function () { if (!document.hidden) refresh(); }, 20000);
})();
