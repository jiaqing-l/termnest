// Fills the splash in the language of the system (Vietnamese or English; English when the system language is neither); the words come from locales.js.
(function () {
  var all = window.TW_SPLASH || {}, pick = (navigator.language || 'en').slice(0, 2).toLowerCase(), t = all[all[pick] ? pick : 'en'] || {};
  document.documentElement.setAttribute('lang', all[pick] ? pick : 'en');
  document.querySelectorAll('[data-i18n]').forEach(function (n) { var v = t[n.getAttribute('data-i18n')]; if (v) n.textContent = v; });
})();
