'use strict';
// "Xoá lịch sử cuộn" in the session panel: two clicks, the second one confirms.
(function () {
  var TW = window.TW; if (!TW) return;
  var el = TW.el;
  TW.addDetailSection(function (x) {
    var box = el('section', 'hist-detail'), note = el('p', 'hist-note', i18n('history.lich_su_cuon_chua_moi'));
    var b = el('button', 'btn', i18n('history.xoa_lich_su_cuon')), armed = false, timer = null; b.type = 'button';
    function reset() { armed = false; b.textContent = i18n('history.xoa_lich_su_cuon'); b.classList.remove('primary'); }
    b.onclick = function () {
      if (!armed) { armed = true; b.textContent = i18n('history.bam_lan_nua_de_xoa'); b.classList.add('primary'); clearTimeout(timer); timer = setTimeout(reset, 4000); return; }
      clearTimeout(timer); b.disabled = true;
      TW.api('POST', '/api/features/history/clear', { server: x.v.id, session: x.s.name })
        .then(function () { TW.app().say(i18n('history.da_xoa_lich_su_cuon'), true, 3000); })
        .catch(function (e) { TW.app().say(e.message, false, 4000); })
        .then(function () { b.disabled = false; reset(); });
    };
    box.append(el('h3', '', i18n('history.lich_su_cuon')), note, b); return box;
  });
})();
