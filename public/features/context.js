'use strict';
// Context-window meter per AI session (data from /api/features/context). Ring on session cards, detail section on the panel.
(function () {
  var TW = window.TW; if (!TW) return;
  var el = TW.el, data = {}, chips = {}, details = {};
  function fmt(n) { return n >= 1e6 ? (n / 1e6).toFixed(1).replace('.0', '') + 'M' : Math.round(n / 1000) + 'k'; }
  function info(hostId, name) { var s = data[hostId]; return s && s[name]; }
  function level(p) { return p >= 90 ? 'bad' : p >= 70 ? 'warn' : 'ok'; }
  // A window comes from Claude Code's own model catalog (or the Codex log); when the model is not in it there is no percentage.
  function known(i) { return i && i.window > 0; }
  function pct(i) { return Math.min(100, Math.round(i.ctx / i.window * 100)); }
  var WHY = { catalog: 'theo danh mục model của Claude Code', log: 'theo log Codex' };
  // "Nhắc sau": hide the nudge for this session for 4 hours (the ring stays). Per browser, best effort.
  var SNOOZE_KEY = 'termnest.ctxSnooze', SNOOZE_MS = 4 * 3600 * 1000;
  function snoozed(key) { try { var m = JSON.parse(localStorage.getItem(SNOOZE_KEY) || '{}'); return (m[key] || 0) > Date.now(); } catch (e) { return false; } }
  function snooze(key) { try { var m = JSON.parse(localStorage.getItem(SNOOZE_KEY) || '{}'), now = Date.now(); Object.keys(m).forEach(function (k) { if (m[k] < now) delete m[k]; }); m[key] = now + SNOOZE_MS; localStorage.setItem(SNOOZE_KEY, JSON.stringify(m)); } catch (e) { /* optional */ } }
  function fill(node, i, key) {
    node.textContent = ''; node.hidden = !i; if (!i) return;
    if (!known(i)) {
      node.className = (node.classList.contains('ctx-row') ? 'ctx-row ' : '') + 'ctx-chip';
      node.title = 'Đang dùng ' + fmt(i.ctx) + ' token · model ' + (i.model || '?') + ' chưa có trong danh mục của Claude Code nên chưa biết cửa sổ';
      node.append(el('span', 'ctx-t', fmt(i.ctx) + ' token · chưa rõ cửa sổ')); return;
    }
    var p = pct(i); node.className = (node.classList.contains('ctx-row') ? 'ctx-row ' : '') + 'ctx-chip ' + level(p); node.title = 'Ngữ cảnh ' + fmt(i.ctx) + ' / ' + fmt(i.window) + ' token' + (i.model ? ' · ' + i.model : '') + (WHY[i.by] ? ' · cửa sổ ' + WHY[i.by] : '');
    var ring = el('span', 'ctx-ring'); ring.style.setProperty('--p', p); ring.append(el('b', '', p + '%')); node.append(ring);
    // Mockup 14: from 70% the card says it is time for a fresh session, with a way to dismiss it.
    if (p >= 70 && !snoozed(key)) {
      var t = el('span', 'ctx-t ctx-nudge'), btn = el('button', 'ctx-later', 'Nhắc sau'); btn.type = 'button';
      t.append(el('b', '', p >= 90 ? 'Gần đầy · nên mở phiên mới' : 'Nên mở phiên mới'), el('small', '', '≈ ' + fmt(i.ctx) + ' / ' + fmt(i.window) + ' token'));
      btn.onclick = function (e) { e.stopPropagation(); snooze(key); fill(node, i, key); };
      node.append(t, btn);
    } else node.append(el('span', 'ctx-t', 'ngữ cảnh'));
  }
  TW.addCardDecorator(function (card, v, s) {
    var chip = el('div', 'ctx-row'), key = v.id + '/' + s.name; chips[key] = chip; fill(chip, info(v.id, s.name), key);
    var foot = card.querySelector('.card-foot'); if (foot) foot.before(chip); else card.append(chip);
  });
  TW.addDetailSection(function (x) {
    var key = x.v.id + '/' + x.s.name, box = el('section', 'ctx-detail'); details[key] = box; draw(box, info(x.v.id, x.s.name)); return box;
  });
  function draw(box, i) {
    box.textContent = ''; box.hidden = !i; if (!i) return;
    box.append(el('h3', '', 'Ngữ cảnh phiên'));
    if (!known(i)) { box.append(el('p', 'ctx-unknown', 'Đang dùng ' + fmt(i.ctx) + ' token. Model ' + (i.model || '?') + ' chưa có trong danh mục của Claude Code trên máy này nên chưa biết cửa sổ, chưa tính được %.')); return; }
    var p = pct(i);
    var row = el('div', 'ctx-line ' + level(p)), ring = el('span', 'ctx-ring big'); ring.style.setProperty('--p', p); ring.append(el('b', '', p + '%'));
    var t = el('div', 'ctx-txt'); t.append(el('b', '', fmt(i.ctx) + ' / ' + fmt(i.window) + ' token'), el('small', '', p >= 90 ? 'Gần đầy: nên mở phiên mới từ file trạng thái.' : p >= 70 ? 'Nên mở phiên mới sớm để đỡ tốn token mỗi lượt.' : 'Còn rộng.'));
    row.append(ring, t); box.append(row);
  }
  function refresh() {
    TW.api('GET', '/api/features/context/data').then(function (r) {
      data = r.servers || {};
      Object.keys(chips).forEach(function (k) { var p = k.split('/'); if (chips[k].isConnected) fill(chips[k], info(p[0], p.slice(1).join('/')), k); else delete chips[k]; });
      Object.keys(details).forEach(function (k) { var p = k.split('/'); if (details[k].isConnected) draw(details[k], info(p[0], p.slice(1).join('/'))); else delete details[k]; });
    }).catch(function () { /* optional */ });
  }
  refresh(); setInterval(refresh, 20000); TW.on('state', function () { /* chips are refilled on the next poll */ });
})();
