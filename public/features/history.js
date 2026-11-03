'use strict';
// "Xoá lịch sử cuộn" in the session panel: two clicks, the second one confirms.
(function () {
  var TW = window.TW; if (!TW) return;
  var el = TW.el;
  TW.addDetailSection(function (x) {
    var box = el('section', 'hist-detail'), note = el('p', 'hist-note', 'Lịch sử cuộn chứa mọi thứ từng hiện trong khung này (kể cả lệnh chạy trước khi mở AI). Xoá không ảnh hưởng phiên đang chạy và phần đang hiện trên màn.');
    var b = el('button', 'btn', 'Xoá lịch sử cuộn'), armed = false, timer = null; b.type = 'button';
    function reset() { armed = false; b.textContent = 'Xoá lịch sử cuộn'; b.classList.remove('primary'); }
    b.onclick = function () {
      if (!armed) { armed = true; b.textContent = 'Bấm lần nữa để xoá'; b.classList.add('primary'); clearTimeout(timer); timer = setTimeout(reset, 4000); return; }
      clearTimeout(timer); b.disabled = true;
      TW.api('POST', '/api/features/history/clear', { server: x.v.id, session: x.s.name })
        .then(function () { TW.app().say('Đã xoá lịch sử cuộn.', true, 3000); })
        .catch(function (e) { TW.app().say(e.message, false, 4000); })
        .then(function () { b.disabled = false; reset(); });
    };
    box.append(el('h3', '', 'Lịch sử cuộn'), note, b); return box;
  });
})();
