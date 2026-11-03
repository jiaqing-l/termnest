'use strict';
// "Crew của phiên này": tracks of the workspace the session lives in; a click opens the bottom-right log popup.
(function () {
  var TW = window.TW; if (!TW) return;
  var el = TW.el, boxes = {};
  var LABEL = { merged: 'đã gộp', done: 'xong', dispatched: 'đang chạy', queued: 'xếp hàng', pending: 'chờ', failed: 'lỗi' };
  function qs(x) { return '?server=' + encodeURIComponent(x.v.id) + '&session=' + encodeURIComponent(x.s.name); }
  function open(x, task, t) {
    var app = TW.app(); if (!app || !app.crewPopup) return;
    if (t.state === 'pending' || t.state === 'queued') {
      var why = t.state === 'queued' ? 'Đang xếp hàng chờ tài nguyên' + (t.reason ? ': ' + t.reason : '.') : 'Chưa tới lượt chạy, đang chờ track trước hoàn thành.';
      app.crewPopup(x.v.id, task, t.id, function () { return Promise.resolve({ text: why + '\n\nChưa có worker nên chưa có log. Khi track bắt đầu chạy, log sẽ hiện ở đây.', status: t.state === 'queued' ? 'Xếp hàng' : 'Chờ' }); });
      return;
    }
    app.crewPopup(x.v.id, task, t.id, function () {
      return TW.api('GET', '/api/features/crew/log' + qs(x) + '&task=' + encodeURIComponent(task) + '&track=' + encodeURIComponent(t.id)).then(function (r) {
        return { text: r.text, status: r.result === 'DONE' ? 'Đã xong' : r.result === 'FAILED' ? 'Đã lỗi' : 'Đang chạy' };
      });
    });
  }
  // The manifest does not say which session started a task; the app attributes running workers to their tmux session,
  // so a task belongs to this session only when one of its workers is owned by it.
  function mine(x) {
    var ids = {}, v = TW.app().servers().filter(function (h) { return h.id === x.v.id; })[0];
    ((v && v.workers) || []).forEach(function (w) { if (w.task && w.owner && w.owner.name === x.s.name && w.owner.created === x.s.created) ids[w.task] = true; });
    return ids;
  }
  function draw(box, x, data) {
    var own = mine(x);
    box.textContent = ''; var tasks = ((data && data.tasks) || []).filter(function (t) { return own[t.task] || t.mentioned; }); box.hidden = !tasks.length; if (!tasks.length) return;
    box.append(el('h3', '', 'Crew đã làm trong phiên'));
    if (data.linked === 'guess') box.append(el('p', 'crew-note', 'Nối theo hội thoại gần nhất của thư mục, có thể lẫn với phiên khác cùng thư mục.'));
    tasks.forEach(function (task) {
      var done = task.tracks.filter(function (t) { return t.state === 'merged' || t.state === 'done'; }).length, total = task.tracks.length;
      var head = el('div', 'crew-task'), bar = el('span', 'crew-bar'), fill = el('i'); fill.style.width = (total ? Math.round(done / total * 100) : 0) + '%'; bar.append(fill);
      head.append(el('b', '', task.title), el('small', '', done + '/' + total), bar); box.append(head);
      var list = el('div', 'crew-tracks');
      task.tracks.forEach(function (t) {
        var b = el('button', 'crew-track ' + t.state); b.type = 'button'; b.title = t.reason || (t.executor ? 'Executor: ' + t.executor : '');
        b.append(el('b', '', t.id), el('span', '', LABEL[t.state] || t.state));
        b.onclick = function () { open(x, task.task, t); }; list.append(b);
      });
      box.append(list);
    });
  }
  function load(box, x) {
    TW.api('GET', '/api/features/crew/data' + qs(x)).then(function (r) { draw(box, x, r); }).catch(function () { box.hidden = true; });
  }
  TW.addDetailSection(function (x) {
    var key = x.v.id + '/' + x.s.name, box = el('section', 'crew-detail'); box.hidden = true; boxes[key] = { box: box, x: x }; load(box, x); return box;
  });
  setInterval(function () { Object.keys(boxes).forEach(function (k) { var b = boxes[k]; if (b.box.isConnected && !document.hidden) load(b.box, b.x); else if (!b.box.isConnected) delete boxes[k]; }); }, 15000);
})();
