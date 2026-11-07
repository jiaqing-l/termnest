'use strict';
// "Kết nối": GitLab / GitHub links (personal access token, read-only use), and on every session the branch it is on with its
// merge / pull request and pipeline. The token is typed here once, checked against the forge, stored encrypted; never shown again.
(function () {
  var TW = window.TW; if (!TW) return;
  var el = TW.el, links = [];
  function btn(label, cls, fn) { var b = el('button', 'btn ' + (cls || ''), label); b.type = 'button'; b.onclick = fn; return b; }
  function say(m, ok) { TW.app().say(m, ok, ok ? 2500 : 4500); }

  function pane() {
    var box = document.getElementById('forge-pane'); if (!box) return;
    box.textContent = '';
    var st = el('section', 'st'); st.append(el('h3', '', i18n('fg.tieu_de')), el('p', 'hint', i18n('fg.mo_ta')));
    if (!links.length) st.append(el('p', 'fg-empty', i18n('fg.chua_co')));
    links.forEach(function (l) {
      var r = el('div', 'fg-link'), t = el('div', 'fg-t');
      t.append(el('b', '', (l.kind === 'github' ? 'GitHub' : 'GitLab') + ' · ' + l.url.replace(/^https?:\/\//, '')), el('small', '', i18n('fg.dang_nhap_la', [l.user || '—', l.tail])));
      r.append(el('span', 'fg-dot'), t,
        btn(i18n('fg.kiem_tra'), 'ghost', function () { TW.api('POST', '/api/features/forge/links/test', { id: l.id }).then(function (x) { say(i18n('fg.ket_noi_ok', [x.user]), true); }).catch(function (e) { say(e.message, false); }); }),
        btn(i18n('fg.go'), 'ghost', function () { TW.api('POST', '/api/features/forge/links/remove', { id: l.id }).then(load); }));
      st.append(r);
    });
    var f = el('div', 'fg-form'), kind = el('select'), url = el('input'), tok = el('input'), add = btn(i18n('fg.ket_noi'), 'primary', null);
    [['gitlab', 'GitLab'], ['github', 'GitHub']].forEach(function (k) { var o = el('option', '', k[1]); o.value = k[0]; kind.append(o); });
    url.placeholder = 'https://gitlab.example.com'; url.autocomplete = 'off'; tok.type = 'password'; tok.autocomplete = 'off'; tok.placeholder = i18n('fg.token_ph');
    kind.onchange = function () { url.disabled = kind.value === 'github'; url.value = kind.value === 'github' ? 'https://github.com' : ''; hint.textContent = i18n(kind.value === 'github' ? 'fg.huong_dan_github' : 'fg.huong_dan_gitlab'); };
    var hint = el('p', 'hint', i18n('fg.huong_dan_gitlab'));
    add.onclick = function () {
      if (/^http:/.test(url.value) && !confirmHttp.checked) { say(i18n('fg.canh_bao_http'), false); return; }
      add.disabled = true;
      TW.api('POST', '/api/features/forge/links', { kind: kind.value, url: url.value, token: tok.value }).then(function (x) { tok.value = ''; say(i18n('fg.ket_noi_ok', [x.link.user]), true); load(); })
        .catch(function (e) { say(e.message, false); }).then(function () { add.disabled = false; });
    };
    var confirmHttp = el('input'); confirmHttp.type = 'checkbox';
    var lh = el('label', 'sw fg-http'); lh.append(el('span', '', i18n('fg.cho_phep_http')), confirmHttp);
    function field(label, input) { var l = el('label', 'fg-f'); l.append(el('span', '', label), input); return l; }
    f.append(field(i18n('fg.loai'), kind), field(i18n('fg.dia_chi'), url), field(i18n('fg.token'), tok), add);
    st.append(el('h4', '', i18n('fg.them')), f, hint, lh, el('p', 'hint', i18n('fg.bao_mat')));
    box.append(st);
  }
  function load() { return TW.api('GET', '/api/features/forge/links').then(function (r) { links = r.links || []; pane(); }).catch(function () { pane(); }); }

  // Session detail: branch, MR / PR, pipeline.
  var CI = { success: 'ok', failed: 'bad', running: 'run', canceled: 'idle', skipped: 'idle', manual: 'idle' };
  function chip(cls, text, href) { var c = el(href ? 'a' : 'span', 'fg-chip ' + cls, text); if (href) { c.href = href; c.target = '_blank'; c.rel = 'noopener'; } return c; }
  TW.addDetailSection(function (x) {
    var box = el('section', 'fg-detail'); box.hidden = true;
    TW.api('GET', '/api/features/forge/session?server=' + encodeURIComponent(x.v.id) + '&session=' + encodeURIComponent(x.s.name)).then(function (r) {
      if (!r.repo) return;
      box.hidden = false; box.append(el('h3', '', i18n('fg.nhanh_ma')));
      var row = el('div', 'fg-row'); row.append(chip('br', '⑂ ' + r.branch));
      if (!r.linked) row.append(chip('idle', i18n('fg.chua_lien_ket')));
      else if (r.error) row.append(chip('bad', r.error));
      else {
        row.append(r.mr ? chip('mr ' + r.mr.state, (r.kind === 'github' ? 'PR #' : 'MR !') + r.mr.number + ' · ' + i18n('fg.mr_' + r.mr.state) + (r.mr.draft ? ' · ' + i18n('fg.nhap') : ''), r.mr.url) : chip('idle', i18n('fg.chua_co_mr')));
        if (r.ci) row.append(chip(CI[r.ci.state] || 'idle', '⚙ ' + i18n('fg.ci_' + r.ci.state), r.ci.url));
      }
      box.append(row);
      if (r.mr && r.mr.title) box.append(el('p', 'fg-title', r.mr.title));
    }).catch(function () { /* optional */ });
    return box;
  });
  document.addEventListener('click', function (e) { if (e.target && e.target.closest && e.target.closest('.set-tab[data-tab="connect"]')) load(); });
  load();
  window.TW_FORGE = {
    // For the crew pack: MR / pipeline of several (remote, branch) pairs.
    branches: function (items) { return TW.api('POST', '/api/features/forge/branches', { items: items }); },
  };
})();
