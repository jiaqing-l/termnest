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
      .then(function (r) { TW.app().say(r.sent ? 'Đã gửi lệnh ' + action + ' cho tiến trình ' + f.pid + '.' : 'Tiến trình đã thay đổi hoặc đã thoát, chưa làm gì.', !!r.sent, 3500); done(); })
      .catch(function (e) { TW.app().say(e.message, false, 4000); done(); });
  }
  function row(id, f, redraw) {
    var r = el('div', 'wd-row ' + f.severity), t = el('div', 'wd-t'), bar = el('div', 'wd-bar');
    t.append(el('b', '', f.title), el('small', '', 'pid ' + f.pid + ' · ' + f.cpu + '% CPU · ' + f.rssMb + ' MB'), el('code', '', f.args));
    [['freeze', 'Đóng băng'], ['resume', 'Chạy tiếp']].forEach(function (a) {
      var b = el('button', 'btn', a[1]); b.type = 'button'; b.onclick = function () { act(id, f, a[0], redraw); }; bar.append(b);
    });
    var stop = el('button', 'btn', 'Dừng'), armed = false; stop.type = 'button';
    stop.onclick = function () {
      if (!armed) { armed = true; stop.textContent = 'Bấm lần nữa để dừng'; stop.classList.add('primary'); setTimeout(function () { armed = false; stop.textContent = 'Dừng'; stop.classList.remove('primary'); }, 4000); return; }
      act(id, f, 'stop', redraw);
    };
    bar.append(stop); r.append(t, bar); return r;
  }
  function fill(box, id) {
    var list = found(id); box.textContent = ''; box.hidden = !list.length; if (!list.length) return;
    var w = worst(list), btn = el('button', 'wd-chip ' + (w >= 3 ? 'urgent' : 'warn'), '🛡 ' + list.length + ' vi phạm luật'), panel = el('div', 'wd-panel'); btn.type = 'button'; panel.hidden = true;
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
    TW.banner.show({ id: 'watchdog', level: 'urgent', title: 'Trạm gác luật: ' + urgent[0].title, detail: urgent.length > 1 ? 'và ' + (urgent.length - 1) + ' vi phạm nữa — mở chip 🛡 ở tên máy chủ để xử lý.' : 'Mở chip 🛡 ở tên máy chủ để đóng băng hoặc dừng.' });
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
