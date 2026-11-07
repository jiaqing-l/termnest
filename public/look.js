// The 2026 look: rearranges the terminal controls into one row and adds the theme choice to Settings.
// It only moves existing buttons (ids, data-k and handlers stay), so every feature keeps working.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var t = function (k) { return window.i18n ? window.i18n(k) : k; };
  function button(cls, key) {
    var b = document.createElement('button'); b.type = 'button'; b.className = 'btn ' + cls; b.dataset.i18n = key; b.textContent = t(key); return b;
  }
  var pops = [];
  function closeAll(except) { pops.forEach(function (p) { if (p.box !== except) { p.box.classList.remove('open'); p.btn.setAttribute('aria-expanded', 'false'); } }); }
  function popover(btn, box, row) {
    btn.setAttribute('aria-expanded', 'false'); pops.push({ btn: btn, box: box });
    btn.onclick = function (e) {
      e.stopPropagation(); var open = !box.classList.contains('open'); closeAll(box);
      box.classList.toggle('open', open); btn.setAttribute('aria-expanded', String(open));
      if (open && !box.classList.contains('terminal-copy-help')) {
        var r = row.getBoundingClientRect(), b = btn.getBoundingClientRect();
        box.style.left = Math.max(0, Math.min(b.left - r.left, r.width - box.offsetWidth - 8)) + 'px';
      }
    };
    // A choice in the menu runs (its own handler), then the menu closes.
    box.addEventListener('click', function (e) { if (e.target.closest('.btn')) setTimeout(function () { closeAll(); }, 0); });
  }
  function terminalRow() {
    var keybar = document.querySelector('.keybar'), cmds = $('cmds'), list = $('command-list'), help = document.querySelector('.terminal-copy-help'), bar = document.querySelector('.tmux-bar');
    if (!keybar || !cmds || !list || !bar || document.querySelector('.tool-row')) return;
    var row = document.createElement('div'); row.className = 'tool-row';
    bar.after(row); row.append(keybar, cmds);
    var more = document.createElement('span'); more.className = 'more-keys';
    ['tab', 'up', 'down', 'ctrlb', 'nl'].forEach(function (k) { var b = keybar.querySelector('[data-k="' + k + '"]'); if (b) more.append(b); });
    var keys = button('k-more', 'look.keys'); keybar.append(keys, more); popover(keys, more, row);
    var cm = button('cmd-more', 'look.commands'); list.before(cm); popover(cm, list, row);
    var controls = cmds.querySelector('.text-controls');
    if (help && controls) { var q = button('help-btn', 'look.help_short'); q.dataset.i18nAttrs = 'title:look.help;aria-label:look.help'; q.title = t('look.help'); q.setAttribute('aria-label', t('look.help')); controls.append(q); row.append(help); popover(q, help, row); }
    document.addEventListener('click', function (e) { if (!e.target.closest('.tool-row')) closeAll(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeAll(); });
  }
  // Settings → Look: Pets (animals, playground) or Clean (status dots). It is the same switch as "Thú cưng" on the overview.
  function themePicker() {
    var box = $('set-theme'), pets = $('pets-enabled'); if (!box || !pets) return;
    function draw() {
      box.textContent = '';
      [['pets', true, ['#f4f6fb', '#ff5c7a', '#26b5a6', '#8fcf74']], ['clean', false, ['#f4f6fb', '#ffffff', '#1a2130', '#8a93a6']]].forEach(function (x) {
        var c = document.createElement('button'); c.type = 'button'; c.className = 'style-card'; c.setAttribute('role', 'radio'); c.setAttribute('aria-checked', String(pets.checked === x[1]));
        var sw = document.createElement('span'); sw.className = 'sw-colors'; x[2].forEach(function (col) { var i = document.createElement('i'); i.style.background = col; sw.append(i); });
        var b = document.createElement('b'), s = document.createElement('small'); b.textContent = t('look.theme_' + x[0]); s.textContent = t('look.theme_' + x[0] + '_d');
        c.append(sw, b, s);
        c.onclick = function () { if (pets.checked !== x[1]) { pets.checked = x[1]; pets.dispatchEvent(new Event('change')); } draw(); };
        box.append(c);
      });
    }
    pets.addEventListener('change', draw); draw();
  }
  function start() { terminalRow(); themePicker(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
