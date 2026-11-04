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
  var WHY = { catalog: i18n('context.theo_danh_muc_model_cua'), log: 'theo log Codex' };
  // "Nhắc sau": hide the nudge for this session for 4 hours (the ring stays). Per browser, best effort.
  var SNOOZE_KEY = 'termnest.ctxSnooze', SNOOZE_MS = 4 * 3600 * 1000;
  function snoozed(key) { try { var m = JSON.parse(localStorage.getItem(SNOOZE_KEY) || '{}'); return (m[key] || 0) > Date.now(); } catch (e) { return false; } }
  function snooze(key) { try { var m = JSON.parse(localStorage.getItem(SNOOZE_KEY) || '{}'), now = Date.now(); Object.keys(m).forEach(function (k) { if (m[k] < now) delete m[k]; }); m[key] = now + SNOOZE_MS; localStorage.setItem(SNOOZE_KEY, JSON.stringify(m)); } catch (e) { /* optional */ } }
  // "Mở phiên mới…" (feature handoff) and the "⋯" menu: /clear in place, /compact, snooze. The handoff module may be absent.
  function actions(key) {
    var at = key.indexOf('/'), host = key.slice(0, at), name = key.slice(at + 1), box = el('span', 'ctx-actions');
    var open = el('button', 'ctx-open', i18n('context.mo_phien_moi')), more = el('button', 'ctx-more', '⋯'); open.type = more.type = 'button'; more.title = i18n('context.them_lua_chon'); more.setAttribute('aria-haspopup', 'menu');
    open.onclick = function (e) { e.stopPropagation(); if (TW.handoffOpen) TW.handoffOpen(host, name, 'new'); };
    more.onclick = function (e) { e.stopPropagation(); if (TW.handoffMenu) TW.handoffMenu(more, host, name); };
    box.append(open, more); return box;
  }
  TW.ctxInfo = function (host, name) { return info(host, name); };
  TW.ctxSnooze = function (host, name) { var key = host + '/' + name; snooze(key); if (chips[key] && chips[key].isConnected) fill(chips[key], info(host, name), key); };
  function fill(node, i, key) {
    node.textContent = ''; node.hidden = !i; if (!i) return;
    if (!known(i)) {
      node.className = (node.classList.contains('ctx-row') ? 'ctx-row ' : '') + 'ctx-chip';
      node.title = i18n('context.dang_dung_token_model_chua', [fmt(i.ctx), (i.model || '?')]);
      node.append(el('span', 'ctx-t', i18n('context.token_chua_ro_cua_so', [fmt(i.ctx)]))); return;
    }
    var p = pct(i); node.className = (node.classList.contains('ctx-row') ? 'ctx-row ' : '') + 'ctx-chip ' + level(p); node.title = i18n('context.ngu_canh_token', [fmt(i.ctx), fmt(i.window), (i.model ? ' · ' + i.model : ''), (WHY[i.by] ? i18n('context.cua_so', [WHY[i.by]]) : '')]);
    var ring = el('span', 'ctx-ring'); ring.style.setProperty('--p', p); ring.append(el('b', '', p + '%')); node.append(ring);
    // Mockup 14: from 70% the card says it is time for a fresh session, with a way to dismiss it.
    if (p >= 70 && !snoozed(key)) {
      var t = el('span', 'ctx-t ctx-nudge');
      t.append(el('b', '', p >= 90 ? i18n('context.gan_day_nen_mo_phien') : i18n('context.nen_mo_phien_moi')), el('small', '', '≈ ' + fmt(i.ctx) + ' / ' + fmt(i.window) + ' token'));
      node.append(t, actions(key));
    } else node.append(el('span', 'ctx-t', i18n('context.ngu_canh')));
  }
  TW.addCardDecorator(function (card, v, s) {
    var chip = el('div', 'ctx-row'), key = v.id + '/' + s.name; chips[key] = chip; fill(chip, info(v.id, s.name), key);
    var foot = card.querySelector('.card-foot'); if (foot) foot.before(chip); else card.append(chip);
  });
  TW.addDetailSection(function (x) {
    var key = x.v.id + '/' + x.s.name, box = el('section', 'ctx-detail'); details[key] = box; draw(box, info(x.v.id, x.s.name), key); return box;
  });
  function draw(box, i, key) {
    box.textContent = ''; box.hidden = !i; if (!i) return;
    box.append(el('h3', '', i18n('context.ngu_canh_phien')));
    if (!known(i)) { box.append(el('p', 'ctx-unknown', i18n('context.dang_dung_token_model_chua_2', [fmt(i.ctx), (i.model || '?')]))); return; }
    var p = pct(i);
    var row = el('div', 'ctx-line ' + level(p)), ring = el('span', 'ctx-ring big'); ring.style.setProperty('--p', p); ring.append(el('b', '', p + '%'));
    var t = el('div', 'ctx-txt'); t.append(el('b', '', fmt(i.ctx) + ' / ' + fmt(i.window) + ' token'), el('small', '', p >= 90 ? i18n('context.gan_day_nen_mo_phien_2') : p >= 70 ? i18n('context.nen_mo_phien_moi_som') : i18n('context.con_rong')));
    row.append(ring, t); box.append(row); if (p >= 70 && key) box.append(actions(key));
  }
  function refresh() {
    TW.api('GET', '/api/features/context/data').then(function (r) {
      data = r.servers || {};
      Object.keys(chips).forEach(function (k) { var p = k.split('/'); if (chips[k].isConnected) fill(chips[k], info(p[0], p.slice(1).join('/')), k); else delete chips[k]; });
      Object.keys(details).forEach(function (k) { var p = k.split('/'); if (details[k].isConnected) draw(details[k], info(p[0], p.slice(1).join('/')), k); else delete details[k]; });
    }).catch(function () { /* optional */ });
  }
  refresh(); setInterval(refresh, 20000); TW.on('state', function () { /* chips are refilled on the next poll */ });
})();
