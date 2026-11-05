'use strict';
// Phone setup guide, shown in a dialog inside the app (window.PhoneGuide.mount) or on its own page (/guide). Every word is a key in public/locales/*.json (guide.<method>.<step>.t / .d / .n); only commands and values live here.
(function () {
  var URL_LOCAL = 'http://localhost:7681';
  var TUNNEL = 'ssh -N -L 7681:127.0.0.1:7681 user@machine-address';
  var FIELDS = [['guide.f.type', 'guide.f.local', true], ['guide.f.bind', '127.0.0.1'], ['guide.f.lport', '7681'], ['guide.f.dest', '127.0.0.1'], ['guide.f.dport', '7681']];
  var withHost = FIELDS.concat([['guide.f.host', 'guide.f.host_val', true]]);
  var METHODS = [
    { id: 'tailscale', tag: 'guide.tag.recommended', accent: '#2a6fdb', steps: [
      { code: ['curl -fsSL https://tailscale.com/install.sh | sh', 'sudo tailscale up'] },
      { code: ['tailscale serve --bg 7681', 'tailscale serve status'] },
      { code: ['TW_ALLOWED_HOSTS=my-machine.my-tailnet.ts.net'] }, {}, {}, {}], tip: true },
    { id: 'termius', tag: 'guide.tag.both', accent: '#1f9d6b', ssh: true, steps: [{}, { fields: withHost }, {}, { url: URL_LOCAL, note: true }] },
    { id: 'termux', tag: 'guide.tag.android', accent: '#d9822b', ssh: true, steps: [{}, { code: ['pkg update', 'pkg install openssh'] }, { code: [TUNNEL] }, {}, { url: URL_LOCAL }] },
    { id: 'connectbot', tag: 'guide.tag.android', accent: '#7a5bd6', ssh: true, steps: [{}, { fields: [['guide.f.type', 'guide.f.local', true], ['guide.f.lport', '7681'], ['guide.f.dest', '127.0.0.1:7681']] }, {}, { url: URL_LOCAL }] },
    { id: 'openvpn', tag: 'guide.tag.vpn', accent: '#e8712b', ssh: true, tip: true, steps: [{}, { fields: [['guide.f.type', 'guide.f.local', true], ['guide.f.lport', '7681'], ['guide.f.dest', '127.0.0.1'], ['guide.f.dport', '7681'], ['guide.f.sshhost', '10.8.0.5']], code: ['ssh -N -L 7681:127.0.0.1:7681 user@10.8.0.5'], note: true }, { url: URL_LOCAL, note: true }] },
    { id: 'other', tag: 'guide.tag.any', accent: '#5d6a7e', ssh: true, tip: true, steps: [{}, { fields: FIELDS.slice(0, 5), code: [TUNNEL] }, { url: URL_LOCAL }] }
  ];
  var tr = function (k) { return i18n(k); };
  var has = function (k) { return tr(k) !== k; };
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function val(v, key) { return key ? tr(v) : v; }

  function code(lines) {
    var box = el('div', 'code'), pre = el('pre'), btn = el('button', 'copy', tr('guide.copy'));
    pre.textContent = lines.join('\n'); btn.type = 'button';
    btn.onclick = function () {
      var done = function () { btn.textContent = tr('guide.copied'); setTimeout(function () { btn.textContent = tr('guide.copy'); }, 1400); };
      try { navigator.clipboard.writeText(lines.join('\n')).then(done, fallback); } catch (e) { fallback(); }
      function fallback() { var r = document.createRange(); r.selectNodeContents(pre); var s = getSelection(); s.removeAllRanges(); s.addRange(r); try { document.execCommand('copy'); done(); } catch (e) { /* selection stays visible */ } }
    };
    box.append(pre, btn); return box;
  }
  function fields(rows) {
    var g = el('dl', 'fields');
    rows.forEach(function (r) { g.append(el('dt', null, tr(r[0])), el('dd', null, val(r[1], r[2]))); });
    return g;
  }
  function step(m, s, i) {
    var base = 'guide.' + m.id + '.' + (i + 1), li = el('li', 'step'), body = el('div', 'body');
    li.append(el('span', 'num', String(i + 1)));
    body.append(el('h3', null, tr(base + '.t')));
    if (has(base + '.d')) body.append(el('p', null, tr(base + '.d')));
    if (s.fields) body.append(fields(s.fields));
    if (s.code) body.append(code(s.code));
    if (s.url) { body.append(el('p', 'then', tr('guide.open_url')), code([s.url])); }
    if (has(base + '.n')) body.append(el('p', 'note', tr(base + '.n')));
    li.append(body); return li;
  }
  function mount(root, first) {
  root.textContent = '';
  var pickEl = el('h2', 'pick', tr('guide.pick')), barEl = el('div', 'methods'), panelEl = el('section', 'panel'), helpEl = el('div', 'help');
  barEl.setAttribute('role', 'tablist'); panelEl.setAttribute('role', 'tabpanel');
  // The list of methods stays on top; the steps of the selected one (Tailscale at first) show right below it.
  function render(id) {
    var m = METHODS.filter(function (x) { return x.id === id; })[0] || METHODS[0], panel = panelEl;
    barEl.querySelectorAll('.method').forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.id === m.id)); });
    panel.style.setProperty('--accent', m.accent); panel.textContent = '';
    if (root.dataset.hash) { try { history.replaceState(null, '', '#' + m.id); } catch (e) { /* optional */ } }
    panel.append(el('h2', null, tr('guide.' + m.id + '.name') + ' · ' + tr('guide.steps_for')));
    if (m.ssh) { var pre = el('div', 'callout'); pre.append(el('b', null, tr('guide.ssh.title')), el('p', null, tr('guide.ssh.body')), el('p', null, tr('guide.ssh.mac')), el('p', null, tr('guide.ssh.linux')), el('p', null, tr('guide.ssh.server'))); panel.append(pre); }
    var list = el('ol', 'steps'); m.steps.forEach(function (s, i) { list.append(step(m, s, i)); }); panel.append(list);
    if (m.tip) panel.append(el('p', 'tip', tr('guide.' + m.id + '.tip')));
  }
  var bar = barEl;
  METHODS.forEach(function (m) {
    var b = el('button', 'method'); b.type = 'button'; b.dataset.id = m.id; b.setAttribute('role', 'tab'); b.style.setProperty('--accent', m.accent);
    var mono = el('span', 'mono', tr('guide.' + m.id + '.name').charAt(0)), name = el('b', null, tr('guide.' + m.id + '.name')), tag = el('em', null, tr(m.tag)), blurb = el('small', null, tr('guide.' + m.id + '.blurb'));
    var head = el('span', 'mh'); head.append(mono, name); b.append(head, tag, blurb);
    b.onclick = function () { render(m.id); }; bar.append(b);
  });
  var help = helpEl; help.append(el('h2', null, tr('guide.help.title')));
  ['403', 'conn', 'port', 'sleep'].forEach(function (k) {
    var d = el('details'), s = el('summary', null, tr('guide.help.' + k + '.t')); d.append(s, el('p', null, tr('guide.help.' + k + '.d'))); help.append(d);
  });
  root.append(pickEl, barEl, panelEl, helpEl);
  render(first);
  }
  window.PhoneGuide = { mount: mount };
  var page = document.getElementById('guide-page');
  if (page) { page.dataset.hash = '1'; document.title = tr('guide.page_title'); mount(page, (location.hash || '').slice(1)); }
})();
