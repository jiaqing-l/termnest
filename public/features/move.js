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
    var place = el('select'), profile = el('select'), browse = el('button', 'btn', i18n('settings.backup_pick')), folder = el('div'), name = el('input');
    browse.type = 'button'; folder.style.cssText = 'display:flex;gap:6px;flex:1;min-width:0;max-width:100%;flex-wrap:wrap'; folder.append(place, browse); name.maxLength = 32; name.autocomplete = 'off'; name.spellcheck = false;
    var chat = el('select'), chatRow = row(i18n('move.chat'), chat); chatRow.hidden = true; var chosen = '', chosenProfile = '', folders = {}, picking = false;
    row(i18n('move.to'), target); var profileRow = row(tool === 'codex' ? 'Codex' : 'Claude', profile); profileRow.hidden = true; row(i18n('move.folder'), folder); row(i18n('move.name'), name);
    rows.prepend(chatRow);
    chat.onchange = function () { var c = chat.options[chat.selectedIndex]; chosen = c ? c.dataset.id || '' : ''; chosenProfile = c ? c.dataset.profile || '' : ''; survey(); };
    var stop = el('input'), rewrite = el('input'), carry = el('input'); stop.type = rewrite.type = carry.type = 'checkbox'; rewrite.checked = true; carry.checked = true;
    var opts = el('div', 'mv-opts'), o1 = el('label', 'mv-opt'), o2 = el('label', 'mv-opt'), o3 = el('label', 'mv-opt'), carryText = el('span', '', i18n('move.carry'));
    o1.append(rewrite, el('span', '', i18n('move.rewrite'))); o3.append(carry, carryText); o2.append(stop, el('span', '', i18n('move.stop_old'))); opts.append(o1, o3, o2);
    var carryTouched = false; carry.onchange = function () { carryTouched = true; };
    var checks = el('ul', 'mv-checks'), err = el('p', 'mv-err'), actions = el('div', 'mv-actions');
    var cancel = el('button', 'btn', i18n('tokenui.huy')), go = el('button', 'btn primary', i18n('move.go')); cancel.type = 'button'; cancel.onclick = function () { dlg.close(); }; go.type = 'submit'; go.disabled = true;
    actions.append(err, cancel, go);
    var body = el('div', 'mv-body'); body.append(src, rows, opts, checks);
    form.append(head, body, actions); dlg.append(form); document.body.append(dlg); dlg.onclose = function () { dlg.remove(); };
    var info = null, seq = 0, moving = false;
    function lock(value) { [target, profile, place, browse, name, chat, stop, rewrite, carry].forEach(function (control) { control.disabled = value; }); }
    function check(text, state) { var li = el('li', 'mv-' + state); li.append(el('i', '', state === 'ok' ? '✓' : state === 'bad' ? '✕' : state === 'warn' ? '!' : '…'), el('span', '', text)); checks.append(li); }
    function fillPlaces(list, chosen) {
      place.textContent = '';
      list.forEach(function (p) { var o = el('option', '', (p.why === 'repo' ? '★ ' : '') + p.path); o.value = p.path; place.append(o); });
      if (chosen && !list.some(function (p) { return p.path === chosen; })) { var c = el('option', '', '📁 ' + chosen); c.value = chosen; place.append(c); }
      var pick = el('option', '', i18n('settings.backup_pick')); pick.value = '*'; place.append(pick);
      place.value = chosen || (list[0] ? list[0].path : '*');
      if (place.value === '*' && !list.length) place.selectedIndex = -1;
    }
    function labelProfile(from, to) { return (tool === 'codex' ? 'Codex' : 'Claude') + ' · ' + (from || '') + ' → ' + (to || ''); }
    function ready() { go.disabled = !(info && !picking && !moving && info.same && !info.tooLarge && place.value && place.value !== '*' && /^[A-Za-z0-9_-]{1,32}$/.test(name.value)); }
    function survey(message) {
      var mine = ++seq; info = null; ready(); checks.textContent = ''; err.textContent = typeof message === 'string' ? message : ''; check(i18n('move.checking'), 'wait');
      TW.api('GET', '/api/features/move/check?server=' + encodeURIComponent(x.v.id) + '&session=' + encodeURIComponent(x.s.name) + '&to=' + encodeURIComponent(target.value) + (folders[target.value] ? '&dir=' + encodeURIComponent(folders[target.value]) : '') + (chosen ? '&id=' + encodeURIComponent(chosen) : '') + (chosenProfile ? '&profile=' + encodeURIComponent(chosenProfile) : '') + (profile.value ? '&targetProfile=' + encodeURIComponent(profile.value) : '')).then(function (r) {
        if (mine !== seq) return; checks.textContent = '';
        // The running agent's id is not known: choose the chat from the folder's recent conversations.
        if (r.pick) {
          info = null; chatRow.hidden = false; chat.textContent = '';
          var ph = el('option', '', i18n('move.chat_pick')); ph.value = ''; chat.append(ph);
          r.pick.forEach(function (c) { var o = el('option', '', new Date(c.at).toLocaleString(i18n('lang.locale'), { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }) + ' · ' + (c.ask || '—').slice(0, 70) + ' · ' + mb(c.size)); o.value = c.id + '|' + c.profile; o.dataset.id = c.id; o.dataset.profile = c.profile || ''; o.textContent += ' · ' + (c.profile || ''); chat.append(o); });
          check(r.pick.length ? i18n('move.chat_unknown') : i18n('move.chat_none'), r.pick.length ? 'warn' : 'bad'); ready(); return;
        }
        info = r;
        profile.textContent = ''; (r.targetProfiles || [r.targetProfile]).filter(Boolean).forEach(function (p) { var o = el('option', '', p); o.value = p; profile.append(o); }); profile.value = r.targetProfile || ''; profileRow.hidden = profile.options.length < 2;
        check(labelProfile(r.profile, r.targetProfile), 'ok');
        var label = tool === 'codex' ? 'Codex' : 'Claude';
        if (r.same) check(i18n('move.same_account', [label, r.from]), 'ok');
        else if (!r.to) check(i18n('move.not_signed', [label]), 'bad');
        else check(i18n('move.other_account', [r.from || '?', r.to]), 'bad');
        check(i18n('move.chat_size', [mb(r.size)]), r.tooLarge ? 'bad' : 'ok');
        var repo = (r.places || []).filter(function (p) { return p.why === 'repo'; })[0], same = (r.places || []).filter(function (p) { return p.why === 'same'; })[0];
        var named = (r.places || []).filter(function (p) { return p.why === 'name'; })[0];
        if (repo) check(i18n('move.repo_found', [repo.path]), 'ok');
        else if (same) check(i18n('move.same_path', [same.path]), 'ok');
        else if (named) check(i18n('move.same_name', [named.path]), 'ok');
        else check(r.repo ? i18n('move.repo_missing', [r.repo.origin]) : i18n('move.no_repo'), 'warn');
        // Files of this chat: how many, how many the target lacks or has different (those are kept as a backup).
        var f = r.files;
        if (f && !f.code) {
          if (!f.count) check(i18n('move.files_none'), 'ok');
          else if (!f.copy) check(i18n('move.files_same', [f.count]), 'ok');
          else check(i18n('move.files_copy', [f.count, f.copy, mb(f.bytes)]) + (f.differs ? ' ' + i18n('move.files_differs', [f.differs]) : '') + (f.truncated ? ' ' + i18n('move.files_more') : ''), f.differs ? 'warn' : 'ok');
          if (!carryTouched) carry.checked = !f.differs;
          o3.hidden = !f.copy;
        } else { o3.hidden = true; if (f && f.code) check(i18n('move.files_unknown'), 'warn'); }
        fillPlaces(r.places || [], folders[target.value] || (repo || same || named || {}).path);
        folders[target.value] = place.value !== '*' ? place.value : '';
        if (!name.value) name.value = r.name;
        ready();
      }).catch(function (e) { if (mine !== seq) return; checks.textContent = ''; check(e.message, 'bad'); });
    }
    function pickFolder() {
      var machine = target.value, mine = seq, keep = folders[machine] || (info && info.home) || '';
      picking = true; ready();
      var browserDialog = document.getElementById('dlg-dir');
      if (browserDialog) browserDialog.addEventListener('close', function () { setTimeout(function () { if (picking && machine === target.value && mine === seq) { picking = false; survey(); } }, 0); }, { once: true });
      app().browseDir(machine, keep, function (selected) {
        if (!dlg.isConnected || machine !== target.value || mine !== seq) return;
        picking = false; folders[machine] = selected;
        fillPlaces((info && info.places) || [], selected); survey();
      });
      fillPlaces((info && info.places) || [], folders[machine]);
    }
    browse.onclick = pickFolder;
    place.onchange = function () {
      if (place.value === '*') { pickFolder(); return; }
      folders[target.value] = place.value; ready(); survey();
    };
    target.onchange = function () { picking = false; profile.textContent = ''; survey(); };
    profile.onchange = survey;
    chatRow.hidden = true;
    name.oninput = ready;
    form.onsubmit = function (e) {
      e.preventDefault(); if (go.disabled) return; moving = true; lock(true); go.disabled = true; err.textContent = ''; go.textContent = i18n('move.moving');
      TW.api('POST', '/api/features/move/run', { server: x.v.id, session: x.s.name, to: target.value, dir: place.value, name: name.value, stop: stop.checked, rewrite: rewrite.checked, files: carry.checked && !o3.hidden, id: chosen || undefined, profile: info.profile, targetProfile: info.targetProfile, receipt: info.receipt }).then(function (r) {
        body.textContent = ''; actions.textContent = '';
        var done = el('div', 'mv-done'); done.append(el('b', '', '✓ ' + i18n('move.done', [r.name, target.options[target.selectedIndex].textContent])));
        done.append(el('small', '', r.dir + ' · ' + mb(r.bytes) + (r.rewritten ? ' · ' + i18n('move.rewritten', [r.rewritten]) : '') + (r.kept ? ' · ' + i18n('move.kept') : '') + (r.stopped ? ' · ' + i18n('move.stopped') : '') + (r.files ? ' · ' + (r.files.code ? i18n('move.files_failed') : i18n('move.files_done', [r.files.done]) + (r.files.kept && r.files.kept.length ? ' ' + i18n('move.files_kept', [r.files.kept.length]) : '')) : '')));
        body.append(done);
        var openBtn = el('button', 'btn primary', i18n('move.open')); openBtn.type = 'button'; openBtn.onclick = function () { dlg.close(); app().openSession(target.value, r.name); };
        var ok = el('button', 'btn', i18n('fileviewer.dong')); ok.type = 'button'; ok.onclick = function () { dlg.close(); };
        actions.append(ok, openBtn);
      }).catch(function (e2) { moving = false; lock(false); go.textContent = i18n('move.go'); survey(e2.message); });
    };
    dlg.showModal(); survey();
  }
})();
