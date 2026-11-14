'use strict';
// Interface language. Every visible text is a key; the words live in public/locales/<lang>.json (add a file there to add a language).
// The server joins those files into /locales.js (window.TW_LOCALES). Placeholders: {0}, {1} by position or {name} by object.
(function (root) {
  var FALLBACK = 'vi', LOCALES = root.TW_LOCALES || {};
  if (typeof module === 'object' && module.exports && !Object.keys(LOCALES).length) {   // node: tests and tools read the same JSON files
    var fs = require('fs'), path = require('path'), dir = path.join(__dirname, 'locales');
    fs.readdirSync(dir).filter(function (f) { return /\.json$/.test(f); }).forEach(function (f) { LOCALES[f.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); });
  }
  function stored() { try { return root.localStorage && root.localStorage.getItem('tw-lang'); } catch (e) { return null; } }
  var lang = (function () {
    var q = null; try { q = root.location && new URLSearchParams(root.location.search).get('lang'); } catch (e) { /* none */ }
    if (q && LOCALES[q]) { try { root.localStorage.setItem('tw-lang', q); } catch (e) { /* optional */ } return q; }   // ?lang=en also sticks
    var s = stored(); if (s && LOCALES[s]) return s;
    var sys = ((root.navigator && root.navigator.language) || '').slice(0, 2).toLowerCase();   // first run: the system language when we have it, English otherwise
    return LOCALES[sys] ? sys : (LOCALES.en ? 'en' : FALLBACK);
  })();
  // The server sends only the language in use and a name/flag stub for the others (see lib/web-assets.js). It learns the language from the
  // tw-lang cookie; when the page's choice differs (first visit after the cookie was introduced, or ?lang=xx), the table is fetched once and the cookie set.
  function remember(code) { try { if (root.document && typeof root.document.cookie === 'string') root.document.cookie = 'tw-lang=' + code + ';path=/;max-age=31536000;samesite=lax'; } catch (e) { /* optional */ } }
  function ensureTable(code) {
    if (!LOCALES[code] || !LOCALES[code].__stub || typeof root.XMLHttpRequest !== 'function') return;
    try {
      var x = new root.XMLHttpRequest(); x.open('GET', '/locales.js?format=json&lang=' + encodeURIComponent(code), false); x.send();
      if (x.status === 200) { var table = JSON.parse(x.responseText)[code]; if (table) LOCALES[code] = table; }
    } catch (e) { /* the fallback language is shown */ }
  }
  ensureTable(lang); remember(lang);
  function t(key, params) {
    var table = LOCALES[lang] || {}, msg = table[key];
    // Singular form: key + '_one' is used when the first number is exactly 1 (only languages that need it define it).
    if (params && params[0] === 1 && table[key + '_one'] !== undefined) msg = table[key + '_one'];
    if (msg === undefined) msg = (LOCALES[FALLBACK] || {})[key];
    if (msg === undefined) return key;
    if (params === undefined || params === null) return msg;
    return msg.replace(/\{(\w+)\}/g, function (m, k) { var v = params[k]; return v === undefined || v === null ? m : String(v); });
  }
  function apply(scope) {
    var doc = scope || (root.document && root.document);
    if (!doc || !doc.querySelectorAll) return;
    doc.querySelectorAll('[data-i18n]').forEach(function (n) { n.textContent = t(n.getAttribute('data-i18n')); });
    doc.querySelectorAll('[data-i18n-attrs]').forEach(function (n) {
      n.getAttribute('data-i18n-attrs').split(';').forEach(function (pair) { var i = pair.indexOf(':'); if (i > 0) n.setAttribute(pair.slice(0, i), t(pair.slice(i + 1))); });
    });
    doc.querySelectorAll('[data-lang-picker]').forEach(picker);
    if (root.document && root.document.documentElement) { root.document.documentElement.setAttribute('lang', lang); root.document.documentElement.classList && root.document.documentElement.classList.remove('i18n-wait'); }
  }
  // A row of buttons, each with its country flag (inline SVG from the language file, so it shows on every system, unlike flag emoji).
  function picker(host) {
    var d = root.document; if (!host || !d) return;
    host.textContent = ''; host.setAttribute('role', 'group');
    api.languages().forEach(function (l) {
      var b = d.createElement('button'), flag = d.createElement('span'), name = d.createElement('span');
      b.type = 'button'; b.className = 'lang-opt'; b.title = l.name; b.setAttribute('aria-pressed', String(l.code === lang));
      flag.className = 'flag'; flag.innerHTML = l.flag || '🌐'; name.className = 'nm'; name.textContent = l.code.toUpperCase(); b.setAttribute('aria-label', l.name);   // EN / VI on the button, the full name as tooltip and for screen readers
      b.append(flag, name); b.onclick = function () { if (l.code !== lang) setLang(l.code); }; host.append(b);
    });
  }
  function setLang(next) { if (!LOCALES[next]) return false; try { root.localStorage.setItem('tw-lang', next); } catch (e) { /* optional */ } remember(next); if (root.location) root.location.reload(); return true; }
  var api = { t: t, apply: apply, setLang: setLang, lang: function () { return lang; }, languages: function () { return Object.keys(LOCALES).map(function (k) { return { code: k, name: (LOCALES[k]['lang.name']) || k, flag: LOCALES[k]['lang.flag'] || '' }; }); }, picker: picker, locales: LOCALES };
  root.i18n = t; root.TW_I18N = api;   // the global is called i18n, never t: dozens of local variables are named t
  // The markup is above this script, so the texts can be filled in at once; the page stays hidden (CSS) until they are, so no empty labels flash.
  if (root.document && root.document.addEventListener) { apply(); if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', function () { apply(); }); }
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
