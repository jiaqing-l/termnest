'use strict';
// Server health + "Dọn sạch" for merged crew worktrees. Two steps: preview (dry-run) then explicit confirm; one task at a time.
(function () {
  var TW = window.TW; if (!TW) return;
  var el = TW.el, boxes = {};
  function qs(x, fresh) { return '?server=' + encodeURIComponent(x.v.id) + '&session=' + encodeURIComponent(x.s.name) + (fresh ? '&fresh=1' : ''); }
  function metric(label, value, cls) { var m = el('div', 'hl-m' + (cls ? ' ' + cls : '')); m.append(el('small', '', label), el('b', '', value)); return m; }
  function size(mb) { return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb + ' MB'; }
  function clean(x, c, row, redraw) {
    var panel = row.querySelector('.hl-panel'); if (panel) { panel.remove(); return; }
    panel = el('div', 'hl-panel'); row.append(panel); panel.append(el('p', 'hl-note', 'Đang kiểm tra (chưa xoá gì)…'));
    function post(step) { return TW.api('POST', '/api/features/health/clean', { server: x.v.id, session: x.s.name, task: c.task, step: step }); }
    post('preview').then(function (r) {
      panel.textContent = '';
      panel.append(el('p', 'hl-note', 'Janitor sẽ chỉ xoá thứ đã merge và sạch. Kết quả xem trước:'), el('pre', 'hl-out', r.text || '(không có gì để dọn)'));
      var go = el('button', 'btn primary', 'Xác nhận dọn ' + c.task), no = el('button', 'btn', 'Huỷ'); go.type = no.type = 'button';
      no.onclick = function () { panel.remove(); };
      go.onclick = function () {
        go.disabled = no.disabled = true; go.textContent = 'Đang dọn…';
        post('run').then(function (d) { panel.textContent = ''; panel.append(el('p', 'hl-note ' + (d.ok ? 'ok' : 'bad'), d.ok ? 'Đã dọn xong.' : 'Janitor báo lỗi hoặc giữ lại một số mục (HOLD).'), el('pre', 'hl-out', d.text)); redraw(); })
          .catch(function (e) { panel.textContent = ''; panel.append(el('p', 'hl-note bad', e.message)); });
      };
      var bar = el('div', 'hl-bar'); bar.append(go, no); panel.append(bar);
    }).catch(function (e) { panel.textContent = ''; panel.append(el('p', 'hl-note bad', e.message)); });
  }
  function draw(box, x, h) {
    box.textContent = ''; if (!h) { box.hidden = true; return; } box.hidden = false;
    box.append(el('h3', '', 'Sức khoẻ máy chủ'));
    var g = el('div', 'hl-grid');
    g.append(metric('Ổ đĩa trống', h.diskFreeGb == null ? '—' : h.diskFreeGb + ' / ' + h.diskTotalGb + ' GB', h.diskFreeGb != null && h.diskFreeGb < 10 ? 'warn' : ''),
      metric('RAM trống', h.memFreePct + '%', h.memFreePct < 10 ? 'warn' : ''), metric('Tải CPU', h.load.toFixed(1) + ' / ' + h.cpus + ' nhân', h.load / h.cpus > 1.5 ? 'warn' : ''));
    box.append(g);
    (h.reasons || []).forEach(function (r) { box.append(el('p', 'hl-note warn', '⚠ ' + r)); });
    if (!h.candidates.length) return;
    box.append(el('p', 'hl-note', 'Gợi ý dọn (task đã merge hết, còn worktree):'));
    h.candidates.forEach(function (c) {
      var row = el('div', 'hl-cand'), top = el('div', 'hl-top'), b = el('button', 'btn', 'Dọn sạch'); b.type = 'button';
      top.append(el('b', '', c.task), el('small', '', c.worktrees + ' worktree · ' + size(c.mb)), b); row.append(top);
      b.onclick = function () { clean(x, c, row, function () { setTimeout(function () { load(box, x, true); }, 3000); }); }; box.append(row);
    });
  }
  function load(box, x, fresh) { TW.api('GET', '/api/features/health/data' + qs(x, fresh)).then(function (h) { if (!box.querySelector('.hl-panel') || fresh) draw(box, x, h); }).catch(function () { box.hidden = true; }); }
  TW.addDetailSection(function (x) { var box = el('section', 'hl-detail'); box.hidden = true; boxes[x.v.id + '/' + x.s.name] = { box: box, x: x }; load(box, x); return box; });
  setInterval(function () { Object.keys(boxes).forEach(function (k) { var b = boxes[k]; if (!b.box.isConnected) delete boxes[k]; else if (!document.hidden) load(b.box, b.x); }); }, 30000);
})();
