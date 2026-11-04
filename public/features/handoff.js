'use strict';
// Opening a fresh session (or refreshing in place) when the context is nearly full. Everything is plain code: it checks the
// state files, git and the screen, builds a one-line hand-over prompt and types it into the new session without pressing Enter.
(function () {
  var TW = window.TW; if (!TW) return;
  var el = TW.el, menu = null, dlg = null, MAX = 1000;
  var READY = /\? for shortcuts|auto mode on|Ask Codex|bypass permissions|shift\+tab to cycle|^\s*[❯›>]\s/m;
  function app() { return TW.app(); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function sessionOf(host, name) { var v = app().servers().filter(function (h) { return h.id === host; })[0]; return { v: v, s: v && v.sessions.filter(function (x) { return x.name === name; })[0] }; }
  function keys(host, name, text, enter) { return TW.api('POST', '/api/servers/' + host + '/sessions/' + encodeURIComponent(name) + '/keys', { text: text, enter: enter }); }
  function fmt(n) { return n >= 1e6 ? (n / 1e6).toFixed(1).replace('.0', '') + 'M' : Math.round(n / 1000) + 'k'; }

  // ---- "⋯" menu: drawn on the page (not inside the card), closed by outside click, Esc, scroll or resize.
  function closeMenu() { if (menu) { menu.remove(); menu = null; document.removeEventListener('click', outside, true); document.removeEventListener('keydown', esc, true); window.removeEventListener('resize', closeMenu); window.removeEventListener('scroll', closeMenu, true); } }
  function outside(e) { if (menu && !menu.contains(e.target)) closeMenu(); }
  function esc(e) { if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); } }
  TW.handoffMenu = function (btn, host, name) {
    var again = menu && menu.dataset.for === host + '/' + name; closeMenu(); if (again) return;
    menu = el('div', 'ho-menu'); menu.setAttribute('role', 'menu'); menu.dataset.for = host + '/' + name;
    function item(title, hint, fn) { var b = el('button', 'ho-item'); b.type = 'button'; b.setAttribute('role', 'menuitem'); b.append(el('b', '', title)); if (hint) b.append(el('small', '', hint)); b.onclick = function (e) { e.stopPropagation(); closeMenu(); fn(); }; menu.append(b); }
    item('Làm mới tại chỗ (/clear)', 'Giữ tên, tab, thú. Không hoàn tác được; cần snapshot.', function () { TW.handoffOpen(host, name, 'clear'); });
    item('Nén (/compact)', 'Tóm tắt do model viết, có thể mất chi tiết.', function () { TW.handoffOpen(host, name, 'compact'); });
    item('Nhắc sau 4 giờ', '', function () { TW.ctxSnooze(host, name); });
    document.body.append(menu);
    var r = btn.getBoundingClientRect(), w = menu.offsetWidth, left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w));
    menu.style.left = left + 'px'; menu.style.top = Math.min(window.innerHeight - menu.offsetHeight - 8, r.bottom + 6) + 'px';
    document.addEventListener('click', outside, true); document.addEventListener('keydown', esc, true); window.addEventListener('resize', closeMenu); window.addEventListener('scroll', closeMenu, true);
    var first = menu.querySelector('.ho-item'); if (first) first.focus();
  };

  // ---- dialog
  function build() {
    if (dlg) dlg.remove();
    var me = el('dialog', 'ho-dlg'); dlg = me; document.body.append(me);
    // Only this dialog's own close removes it: a late close event must never take down a newer dialog.
    me.addEventListener('close', function () { me.remove(); if (dlg === me) dlg = null; });
    return me;
  }
  function row(level, title, detail) { var r = el('div', 'ho-chk'), d = el('i', 'ho-dot ' + level), b = el('div'); b.append(el('b', '', title)); if (detail) b.append(el('small', '', detail)); r.append(d, b); return r; }
  function btn(text, cls, fn) { var b = el('button', 'btn ' + (cls || ''), text); b.type = 'button'; b.onclick = fn; return b; }
  function tokens(host, name, baseline) {
    var i = TW.ctxInfo && TW.ctxInfo(host, name); if (!i || !(i.ctx > 0)) return null;
    var box = el('div', 'ho-cost'), a = el('div'), b = el('div');
    a.append(el('small', '', 'Phiên cũ đọc lại mỗi lượt'), el('b', '', '≈ ' + fmt(i.ctx) + ' token'));
    b.append(el('small', '', 'Phiên mới bắt đầu ở'), el('b', '', baseline ? '≈ ' + fmt(baseline) + ' token' : 'chưa đo được'), el('small', '', baseline ? 'đo từ các phiên gần đây của thư mục này' : ''));
    box.append(a, b); return box;
  }

  TW.handoffOpen = function (host, name, mode) {
    closeMenu();
    var d = build(), st = { host: host, name: name, mode: mode || 'new', check: null, override: false };
    d.setAttribute('aria-label', 'Mở phiên mới');
    function shell(title, lead) { d.textContent = ''; var f = el('div', 'ho-body'); f.append(el('h2', '', title)); if (lead) f.append(el('p', 'ho-lead', lead)); d.append(f); return f; }
    function steps(f, n) { var s = el('div', 'ho-steps'); ['1 Kiểm tra', '2 Gói bàn giao', '3 Mở'].forEach(function (t, k) { s.append(el('span', k === n ? 'on' : '', t)); }); f.append(s); }
    function fail(f, e) { f.append(el('p', 'ho-err', e && e.message ? e.message : String(e))); }
    var title = { new: 'Mở phiên mới từ ', clear: 'Làm mới tại chỗ: ', compact: 'Nén phiên: ' }[st.mode] + name;

    // /compact needs no hand-over: one confirmed command.
    if (st.mode === 'compact') {
      var f0 = shell(title, 'Gửi /compact vào phiên. Model tự viết bản tóm tắt cho cả ngữ cảnh hiện tại, nên chi tiết có thể mất và tốn một lượt trên toàn bộ ngữ cảnh. Cách này không đáng tin bằng mở phiên mới từ snapshot.');
      var a0 = el('div', 'ho-actions'); a0.append(btn('Huỷ', 'ghost', function () { d.close(); }), btn('Gửi /compact', 'primary', function () { keys(host, name, '/compact', true).then(function () { TW.app().say('Đã gửi /compact.', true, 3000); d.close(); }).catch(function (e) { fail(f0, e); }); }));
      f0.append(a0); d.showModal(); return;
    }

    function load() {
      var f = shell(title, 'Phiên cũ giữ nguyên để đối chiếu. Phiên mới đọc file trạng thái, không nạp lại cả ngữ cảnh.'); steps(f, 0); f.append(el('p', 'ho-lead', 'Đang kiểm tra file trạng thái, git và crew…'));
      TW.api('GET', '/api/features/handoff/check?server=' + encodeURIComponent(host) + '&session=' + encodeURIComponent(name)).then(function (c) { st.check = c; review(); }).catch(function (e) { shell(title); fail(d.firstChild, e); var a = el('div', 'ho-actions'); a.append(btn('Đóng', 'ghost', function () { d.close(); })); d.firstChild.append(a); });
    }
    function review() {
      var c = st.check, f = shell(title, 'Kiểm tra bằng code, không dùng AI. Chỉ mở khi snapshot còn mới.'); steps(f, 0);
      c.checks.forEach(function (k) { f.append(row(k.level, k.title, k.detail)); });
      var cost = tokens(host, name, c.baseline); if (cost) f.append(cost);
      var acts = el('div', 'ho-actions'), note = el('p', 'ho-lead'); f.append(note);
      acts.append(btn('Huỷ', 'ghost', function () { d.close(); }));
      if (c.needsSnapshot) {
        var ask = btn('Nhờ phiên cũ ghi snapshot', '', function () { snapshotStep(f); }), recheck = btn('Kiểm tra lại', '', load);
        var lab = el('label', 'ho-override'), cb = el('input'); cb.type = 'checkbox'; lab.append(cb, document.createTextNode(' Vẫn mở dù snapshot chưa mới (không khuyến nghị)'));
        var next = btn('Tiếp: gói bàn giao', 'primary', handoff); next.disabled = true; cb.onchange = function () { st.override = cb.checked; next.disabled = !cb.checked; };
        f.append(lab); acts.append(recheck, ask, next);
      } else acts.append(btn('Tiếp: gói bàn giao', 'primary', handoff));
      f.append(acts);
    }
    function snapshotStep(f) {
      var c = st.check; f.textContent = ''; f.append(el('h2', '', 'Nhờ phiên cũ ghi snapshot'), el('p', 'ho-lead', 'Gửi đúng một câu lệnh cố định vào phiên cũ (một lượt, tốn token ở ngữ cảnh hiện tại). Bạn xem được trước:'));
      var pre = el('pre', 'ho-pre', c.snapshotPrompt); f.append(pre);
      var a = el('div', 'ho-actions'), msg = el('p', 'ho-lead');
      a.append(btn('Quay lại', 'ghost', review), btn('Gửi vào phiên cũ', 'primary', function () {
        keys(host, name, c.snapshotPrompt, true).then(function () { msg.textContent = 'Đã gửi. Chờ phiên cũ ghi xong rồi bấm "Kiểm tra lại".'; a.textContent = ''; a.append(btn('Đóng', 'ghost', function () { d.close(); }), btn('Kiểm tra lại', 'primary', load)); }).catch(function (e) { fail(f, e); });
      }));
      f.append(msg, a);
    }
    function uniqueName() {
      var taken = {}; ((sessionOf(host, name).v || {}).sessions || []).forEach(function (s) { taken[s.name] = 1; });
      for (var n = 2; n < 50; n++) { var c = name + '-' + n; if (!taken[c]) return c; } return name + '-new';
    }
    function handoff() {
      var c = st.check, inPlace = st.mode === 'clear', f = shell(inPlace ? 'Làm mới tại chỗ' : 'Gói bàn giao', 'Dựng bằng code từ file và git. Sửa được trước khi mở. Lời nhắc gõ sẵn, không tự Enter.'); steps(f, 1);
      var ta = el('textarea', 'ho-ta'); ta.value = c.prompt; ta.rows = 7; ta.setAttribute('aria-label', 'Lời nhắc bàn giao'); var count = el('small', 'ho-count');
      function recount() { count.textContent = ta.value.replace(/\s+/g, ' ').trim().length + ' / ' + MAX + ' ký tự'; count.classList.toggle('bad', ta.value.replace(/\s+/g, ' ').trim().length > MAX); } ta.oninput = recount; recount();
      f.append(ta, count);
      var tool = el('select'), nm = el('input'); [['claude', 'Claude'], ['codex', 'Codex']].forEach(function (o) { var op = el('option', '', o[1]); op.value = o[0]; tool.append(op); }); tool.value = c.tool; nm.value = uniqueName(); nm.maxLength = 64; nm.setAttribute('aria-label', 'Tên phiên mới');
      if (!inPlace) { var g = el('div', 'ho-grid'), l1 = el('label'), l2 = el('label'); l1.append(el('span', '', 'Loại phiên'), tool); l2.append(el('span', '', 'Tên phiên mới'), nm); g.append(l1, l2); f.append(g); }
      else f.append(el('p', 'ho-lead', (c.shells ? '⚠ Phiên có ' + c.shells + ' shell nền; /clear có thể ảnh hưởng chúng. ' : '') + '/clear không hoàn tác được: lịch sử hội thoại hiện tại sẽ mất (file và git không đổi).'));
      var err = el('p', 'ho-err'), a = el('div', 'ho-actions'); f.append(err);
      var go = btn(inPlace ? 'Làm mới tại chỗ và gõ sẵn lời nhắc' : 'Mở phiên mới và gõ sẵn lời nhắc', 'primary', function () {
        var prompt = ta.value.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').replace(/\s+/g, ' ').trim();
        if (!prompt || prompt.length > MAX) { err.textContent = 'Lời nhắc phải có nội dung và không quá ' + MAX + ' ký tự.'; return; }
        if (!inPlace && !/^[A-Za-z0-9_-]{1,64}$/.test(nm.value)) { err.textContent = 'Tên chỉ dùng chữ không dấu, số, - hoặc _.'; return; }
        if (!inPlace && ((sessionOf(host, name).v || {}).sessions || []).some(function (s) { return s.name === nm.value; })) { err.textContent = 'Tên này đã có phiên.'; return; }
        go.disabled = true; run(prompt, tool.value, nm.value, inPlace);
      });
      a.append(btn('Quay lại', 'ghost', review), go); f.append(a);
    }
    function run(prompt, toolName, newName, inPlace) {
      var f = shell(inPlace ? 'Đang làm mới…' : 'Đang mở phiên mới…'); steps(f, 2); var status = el('p', 'ho-lead', ''); f.append(status);
      function say(t) { status.textContent = t; }
      (inPlace ? Promise.resolve() : TW.api('POST', '/api/servers/' + host + '/sessions', { name: newName, dir: st.check.cwd, run: toolName }))
        .then(function () { var target = inPlace ? name : newName; return inPlace ? keys(host, name, '/clear', true).then(function () { return sleep(2500); }).then(function () { return target; }) : target; })
        .then(function (target) {
          say(inPlace ? 'Đã gửi /clear, chờ phiên sẵn sàng…' : 'Phiên đã tạo, chờ ' + (toolName === 'codex' ? 'Codex' : 'Claude') + ' sẵn sàng…');
          var tries = 0;
          return (function wait() {
            var s = sessionOf(host, target).s; if (s && READY.test((s.lines || []).join('\n'))) return target;
            if (++tries > 60) return null; return sleep(1000).then(wait);
          })();
        })
        .then(function (target) {
          if (!target) { done(f, inPlace ? name : newName, prompt, false, inPlace); return; }
          return keys(host, target, prompt, false).then(function () { done(f, target, prompt, true, inPlace); });
        })
        .catch(function (e) { fail(f, e); var a = el('div', 'ho-actions'); a.append(btn('Quay lại', 'ghost', handoff), btn('Đóng', '', function () { d.close(); })); f.append(a); });
    }
    function done(f, target, prompt, typed, inPlace) {
      f.textContent = ''; f.append(el('h2', '', inPlace ? 'Đã làm mới phiên' : 'Đã mở phiên mới'));
      f.append(el('p', 'ho-lead', typed ? 'Lời nhắc đã được gõ sẵn trong phiên (chưa Enter). Đọc lại rồi bấm Enter ở phiên đó.' : 'Phiên đã mở nhưng chưa thấy dấu hiệu sẵn sàng nên chưa gõ lời nhắc. Sao chép lời nhắc dưới đây dán vào phiên.'));
      if (!typed) { var pre = el('pre', 'ho-pre', prompt); f.append(pre); }
      try { app().openSession(host, target); } catch (e) { /* the user can open it from the list */ }
      var a = el('div', 'ho-actions');
      if (!typed) a.append(btn('Sao chép lời nhắc', '', function () { (window.TW_DESKTOP && window.TW_DESKTOP.copy ? window.TW_DESKTOP.copy(prompt) : navigator.clipboard.writeText(prompt)).then(function () { TW.app().say('Đã sao chép.', true, 2000); }).catch(function () { TW.app().say('Không sao chép được.', false, 3000); }); }));
      if (!inPlace) {
        f.append(el('p', 'ho-lead', 'Phiên cũ ' + name + ' vẫn chạy để đối chiếu. Khi phiên mới trả lời đúng trạng thái, dừng phiên cũ.'));
        var stop = btn('Phiên mới đúng, dừng phiên cũ…', '', function () {
          if (!stop.dataset.armed) { stop.dataset.armed = '1'; stop.textContent = 'Bấm lần nữa để dừng ' + name; stop.classList.add('primary'); setTimeout(function () { delete stop.dataset.armed; stop.textContent = 'Phiên mới đúng, dừng phiên cũ…'; stop.classList.remove('primary'); }, 4000); return; }
          TW.api('DELETE', '/api/servers/' + host + '/sessions/' + encodeURIComponent(name)).then(function () { TW.app().say('Đã dừng phiên ' + name + '.', true, 3000); d.close(); }).catch(function (e) { TW.app().say(e.message, false, 4000); });
        });
        a.append(btn('Giữ cả hai', 'ghost', function () { d.close(); }), stop);
      } else a.append(btn('Đóng', 'primary', function () { d.close(); }));
      f.append(a);
    }
    d.showModal(); load();
  };
})();
