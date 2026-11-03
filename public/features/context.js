'use strict';
// Context-window meter per AI session (data from /api/features/context). Ring on session cards, detail section on the panel.
(function () {
  var TW = window.TW; if (!TW) return;
  var el = TW.el, data = {}, chips = {}, details = {};
  function fmt(n) { return n >= 1e6 ? (n / 1e6).toFixed(1).replace('.0', '') + 'M' : Math.round(n / 1000) + 'k'; }
  function info(hostId, name) { var s = data[hostId]; return s && s[name]; }
  function level(p) { return p >= 90 ? 'bad' : p >= 70 ? 'warn' : 'ok'; }
  function pct(i) { return Math.min(100, Math.round(i.ctx / i.window * 100)); }
  function fill(node, i) {
    node.textContent = ''; node.hidden = !i; if (!i) return;
    var p = pct(i); node.className = 'ctx-chip ' + level(p); node.title = 'Ngữ cảnh ' + fmt(i.ctx) + ' / ' + fmt(i.window) + ' token' + (i.model ? ' · ' + i.model : '');
    var ring = el('span', 'ctx-ring'); ring.style.setProperty('--p', p); ring.append(el('b', '', p + '%')); node.append(ring, el('span', 'ctx-t', 'ngữ cảnh'));
  }
  TW.addCardDecorator(function (card, v, s) {
    var chip = el('div', 'ctx-row'), key = v.id + '/' + s.name; chips[key] = chip; fill(chip, info(v.id, s.name));
    var foot = card.querySelector('.card-foot'); if (foot) foot.before(chip); else card.append(chip);
  });
  TW.addDetailSection(function (x) {
    var key = x.v.id + '/' + x.s.name, box = el('section', 'ctx-detail'); details[key] = box; draw(box, info(x.v.id, x.s.name)); return box;
  });
  function draw(box, i) {
    box.textContent = ''; box.hidden = !i; if (!i) return; var p = pct(i);
    box.append(el('h3', '', 'Ngữ cảnh phiên'));
    var row = el('div', 'ctx-line ' + level(p)), ring = el('span', 'ctx-ring big'); ring.style.setProperty('--p', p); ring.append(el('b', '', p + '%'));
    var t = el('div', 'ctx-txt'); t.append(el('b', '', fmt(i.ctx) + ' / ' + fmt(i.window) + ' token'), el('small', '', p >= 90 ? 'Gần đầy: nên mở phiên mới từ file trạng thái.' : p >= 70 ? 'Nên mở phiên mới sớm để đỡ tốn token mỗi lượt.' : 'Còn rộng.'));
    row.append(ring, t); box.append(row);
  }
  function refresh() {
    TW.api('GET', '/api/features/context/data').then(function (r) {
      data = r.servers || {};
      Object.keys(chips).forEach(function (k) { var p = k.split('/'); if (chips[k].isConnected) fill(chips[k], info(p[0], p.slice(1).join('/'))); else delete chips[k]; });
      Object.keys(details).forEach(function (k) { var p = k.split('/'); if (details[k].isConnected) draw(details[k], info(p[0], p.slice(1).join('/'))); else delete details[k]; });
    }).catch(function () { /* optional */ });
  }
  refresh(); setInterval(refresh, 20000); TW.on('state', function () { /* chips are refilled on the next poll */ });
})();
