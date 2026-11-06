'use strict';
// "Chuyển phiên": move a Claude/Codex conversation to another connected machine and resume it there (see lib/features/move.js).
// The dialog checks first (same account, the chat file, where the same repository lives on the target), then moves.
(function () {
  var TW = window.TW; if (!TW) return;
  var el = TW.el;
  function app() { return TW.app(); }
  function agentOf(s) { return s.aiTool || (/codex/i.test(s.cmd || '') ? 'codex' : /claude|^\d+\.\d+\.\d+$/i.test(s.cmd || '') ? 'claude' : ''); }
  function mb(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }

  TW.addDetailSection(function (x) {
    var tool = agentOf(x.s); if (!tool) return null;
    var box = el('section', 'mv-detail'), others = app().servers().filter(function (v) { return v.on && v.id !== x.v.id && v.mode !== 'powershell'; });
    var b = el('button', 'btn', '⇄ ' + i18n('move.button')); b.type = 'button'; b.disabled = !others.length; b.onclick = function () { open(x); };
    box.append(b); if (!others.length) box.append(el('small', 'mv-hint', i18n('move.no_other')));
    return box;
  });

  function open(x) {
    var tool = agentOf(x.s), dlg = el('dialog', 'mv-dlg'), form = el('form', 'mv-form');
    var head = el('div', 'mv-head'), close = el('button', 'btn', i18n('fileviewer.dong')); close.type = 'button'; close.onclick = function () { dlg.close(); };
    head.append(el('h2', '', i18n('move.title')), close);
    var src = el('div', 'mv-src'), badge = el('span', 'mv-tool ' + tool, tool === 'codex' ? 'Codex' : 'Claude'), st = el('div', 'mv-src-t');
    st.append(el('b', '', x.s.name), el('small', '', x.v.name + ' · ' + x.s.path)); src.append(badge, st);
    var rows = el('div', 'mv-rows');
    function row(label, control) { var r = el('label', 'mv-row'); r.append(el('span', '', label), control); rows.append(r); return r; }
    var target = el('select'); app().servers().filter(function (v) { return v.on && v.id !== x.v.id && v.mode !== 'powershell'; }).forEach(function (v) { var o = el('option', '', v.name); o.value = v.id; target.append(o); });
    var place = el('select'), name = el('input'); name.maxLength = 32; name.autocomplete = 'off'; name.spellcheck = false;
    row(i18n('move.to'), target); row(i18n('move.folder'), place); row(i18n('move.name'), name);
    var stop = el('input'), rewrite = el('input'); stop.type = rewrite.type = 'checkbox'; rewrite.checked = true;
    var opts = el('div', 'mv-opts'), o1 = el('label', 'mv-opt'), o2 = el('label', 'mv-opt');
    o1.append(rewrite, el('span', '', i18n('move.rewrite'))); o2.append(stop, el('span', '', i18n('move.stop_old'))); opts.append(o1, o2);
    var checks = el('ul', 'mv-checks'), err = el('p', 'mv-err'), actions = el('div', 'mv-actions');
    var cancel = el('button', 'btn', i18n('tokenui.huy')), go = el('button', 'btn primary', i18n('move.go')); cancel.type = 'button'; cancel.onclick = function () { dlg.close(); }; go.type = 'submit'; go.disabled = true;
    actions.append(err, cancel, go);
    var body = el('div', 'mv-body'); body.append(src, rows, opts, checks);
    form.append(head, body, actions); dlg.append(form); document.body.append(dlg); dlg.onclose = function () { dlg.remove(); };
    var info = null, seq = 0;
    function check(text, state) { var li = el('li', 'mv-' + state); li.append(el('i', '', state === 'ok' ? '✓' : state === 'bad' ? '✕' : state === 'warn' ? '!' : '…'), el('span', '', text)); checks.append(li); }
    function fillPlaces(list, chosen) {
      place.textContent = '';
      list.forEach(function (p) { var o = el('option', '', (p.why === 'repo' ? '★ ' : '') + p.path); o.value = p.path; place.append(o); });
      if (chosen && !list.some(function (p) { return p.path === chosen; })) { var c = el('option', '', '📁 ' + chosen); c.value = chosen; place.append(c); }
      var pick = el('option', '', i18n('settings.backup_pick')); pick.value = '*'; place.append(pick);
      place.value = chosen || (list[0] ? list[0].path : '*');
      if (place.value === '*' && !list.length) place.selectedIndex = -1;
    }
    function ready() { go.disabled = !(info && info.same && !info.tooLarge && place.value && place.value !== '*' && /^[A-Za-z0-9_-]{1,32}$/.test(name.value)); }
    function survey() {
      var mine = ++seq; info = null; ready(); checks.textContent = ''; err.textContent = ''; check(i18n('move.checking'), 'wait');
      TW.api('GET', '/api/features/move/check?server=' + encodeURIComponent(x.v.id) + '&session=' + encodeURIComponent(x.s.name) + '&to=' + encodeURIComponent(target.value)).then(function (r) {
        if (mine !== seq) return; info = r; checks.textContent = '';
        var label = tool === 'codex' ? 'Codex' : 'Claude';
        if (r.same) check(i18n('move.same_account', [label, r.from]), 'ok');
        else if (!r.to) check(i18n('move.not_signed', [label]), 'bad');
        else check(i18n('move.other_account', [r.from || '?', r.to]), 'bad');
        check(i18n('move.chat_size', [mb(r.size)]), r.tooLarge ? 'bad' : 'ok');
        var repo = (r.places || []).filter(function (p) { return p.why === 'repo'; })[0], same = (r.places || []).filter(function (p) { return p.why === 'same'; })[0];
        if (repo) check(i18n('move.repo_found', [repo.path]), 'ok');
        else if (same) check(i18n('move.same_path', [same.path]), 'ok');
        else check(r.repo ? i18n('move.repo_missing', [r.repo.origin]) : i18n('move.no_repo'), 'warn');
        fillPlaces(r.places || [], (repo || same || {}).path);
        if (!name.value) name.value = r.name;
        ready();
      }).catch(function (e) { if (mine !== seq) return; checks.textContent = ''; check(e.message, 'bad'); });
    }
    place.onchange = function () {
      if (place.value !== '*') { ready(); return; }
      var keep = (info && info.places && info.places[0] && info.places[0].path) || '';
      app().browseDir(target.value, keep, function (chosen) { fillPlaces((info && info.places) || [], chosen); ready(); });
      fillPlaces((info && info.places) || [], keep); ready();
    };
    target.onchange = function () { name.value = ''; survey(); };
    name.oninput = ready;
    form.onsubmit = function (e) {
      e.preventDefault(); if (go.disabled) return; go.disabled = true; err.textContent = ''; go.textContent = i18n('move.moving');
      TW.api('POST', '/api/features/move/run', { server: x.v.id, session: x.s.name, to: target.value, dir: place.value, name: name.value, stop: stop.checked, rewrite: rewrite.checked }).then(function (r) {
        body.textContent = ''; actions.textContent = '';
        var done = el('div', 'mv-done'); done.append(el('b', '', '✓ ' + i18n('move.done', [r.name, target.options[target.selectedIndex].textContent])));
        done.append(el('small', '', r.dir + ' · ' + mb(r.bytes) + (r.rewritten ? ' · ' + i18n('move.rewritten', [r.rewritten]) : '') + (r.kept ? ' · ' + i18n('move.kept') : '') + (r.stopped ? ' · ' + i18n('move.stopped') : '')));
        body.append(done);
        var openBtn = el('button', 'btn primary', i18n('move.open')); openBtn.type = 'button'; openBtn.onclick = function () { dlg.close(); app().openSession(target.value, r.name); };
        var ok = el('button', 'btn', i18n('fileviewer.dong')); ok.type = 'button'; ok.onclick = function () { dlg.close(); };
        actions.append(ok, openBtn);
      }).catch(function (e2) { err.textContent = e2.message; go.textContent = i18n('move.go'); ready(); });
    };
    dlg.showModal(); survey();
  }
})();
