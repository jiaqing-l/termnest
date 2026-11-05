'use strict';
// Usage report: per-day, per-account, per-model tokens and cost from /api/usage (ccusage on each host).
// Every value is rendered with textContent, never as HTML.
window.UsageUI = function (hooks) {
  const node = (tag, cls, text) => { const n = document.createElement(tag); n.className = cls || ''; if (text != null) n.textContent = text; return n; };
  // Accounts of one tool share a colour family, so the chart reads as Claude blues / Codex oranges.
  const SHADES = { claude: ['#3270f5', '#7b61ff', '#0fb5ae', '#c2409a'], codex: ['#ec7900', '#d8344a', '#b86e00', '#0d9b63'] };
  const TOOL = { claude: { name: 'Claude', color: '#3270f5' }, codex: { name: 'Codex', color: '#ec7900' } };
  const WEEKDAY = [i18n('usageui.chu_nhat'), i18n('usageui.thu_hai'), i18n('usageui.thu_ba'), i18n('usageui.thu_tu'), i18n('usageui.thu_nam'), i18n('usageui.thu_sau'), i18n('usageui.thu_bay')];
  const full = (n) => Math.round(n).toLocaleString('en-US');
  const usd = (n) => '$' + n.toFixed(2);
  const short = (n) => n >= 1e9 ? i18n('usageui.ty', [(n / 1e9).toFixed(2)]) : n >= 1e6 ? i18n('usageui.trieu', [(n / 1e6).toFixed(1)]) : n >= 1e3 ? i18n('usageui.nghin', [(n / 1e3).toFixed(0)]) : String(Math.round(n));
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const dayKey = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const shift = (key, days) => { const d = new Date(key + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
  function ranges() {
    const today = dayKey(new Date()), month = today.slice(0, 7);
    const last = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).getUTCDate();
    return { today: [today, today], week: [shift(today, -6), today], month: [month + '-01', month + '-' + String(last).padStart(2, '0')] };
  }
  const st = { acct: 'all', range: 'month', from: '', to: '', model: true, view: 'day', metric: 'cost', closed: new Set() };
  [st.from, st.to] = ranges().month;
  let data = null, loading = false, error = '', generation = 0;

  const root = node('div', 'us');
  const tiles = node('div', 'us-tiles'), controls = node('section', 'us-panel'), chartPanel = node('section', 'us-panel'), tablePanel = node('section', 'us-panel');
  const status = node('p', 'us-status'); status.setAttribute('role', 'status');
  root.append(status, tiles, controls, chartPanel, tablePanel);

  function chips(items, current, onPick) {
    const wrap = node('div', 'us-chips');
    items.forEach(([key, label]) => { const b = node('button', '', label); b.type = 'button'; b.setAttribute('aria-pressed', String(key === current)); b.onclick = () => onPick(key); wrap.append(b); });
    return wrap;
  }
  function visible() {
    if (!data) return [];
    const tool = hooks.tool(), scope = hooks.scope();
    const used = {};
    return data.accounts.map((a) => { const list = SHADES[a.tool] || SHADES.claude, n = used[a.tool] = (used[a.tool] || 0) + 1; return { ...a, color: list[(n - 1) % list.length] }; })
      .filter((a) => (tool === 'all' || a.tool === tool) && (scope === 'all' || a.hostId === scope));
  }
  const inRange = (day) => day >= st.from && day <= st.to;
  const sumTokens = (models) => models.reduce((n, m) => n + m.total, 0);

  async function load(force) {
    const mine = ++generation;
    loading = true; error = ''; render();
    try {
      const next = await hooks.api('GET', '/api/usage?from=' + st.from + '&to=' + st.to + '&zone=' + encodeURIComponent(zone) + (force ? '&refresh=1' : ''));
      if (mine !== generation) return;
      data = next;
    } catch (e) { if (mine !== generation) return; error = e.message; }
    loading = false; render(); hooks.loaded(data && data.at);
  }

  function setRange(key, from, to) {
    st.range = key; st.from = from; st.to = to;
    if (st.from && st.to && st.from <= st.to) load(false); else render();
  }

  function renderStatus(list) {
    const bad = (data ? data.accounts : []).filter((a) => a.error && (hooks.tool() === 'all' || a.tool === hooks.tool()));
    status.textContent = '';
    if (loading) status.textContent = data ? i18n('usageui.dang_cap_nhat_bao_cao') : i18n('usageui.dang_doc_bao_cao_bang');
    else if (error) status.textContent = error;
    else if (data && !data.accounts.length) status.textContent = i18n('usageui.chua_khai_bao_tai_khoan');
    bad.forEach((a) => { const s = node('span', 'us-warn', '⚠ ' + a.label + ': ' + a.error + (a.stale ? i18n('usageui.dang_hien_so_lan_truoc') : '')); status.append(status.textContent ? document.createTextNode(' ') : '', s); });
    status.hidden = !status.textContent && !status.children.length;
  }

  function renderTiles(rows) {
    tiles.textContent = '';
    const t = rows.reduce((a, r) => { a.tok += sumTokens(r.d.models); a.cost += r.d.cost; a.cr += r.d.models.reduce((n, m) => n + m.cacheRead, 0); a.out += r.d.models.reduce((n, m) => n + m.output, 0); a.days.add(r.d.day); return a; }, { tok: 0, cost: 0, cr: 0, out: 0, days: new Set() });
    const hit = t.tok ? Math.round(t.cr / t.tok * 100) : 0;
    const tile = (em, bg, label, value, sub) => { const c = node('div', 'us-tile'), i = node('div', 'us-em', em), b = node('div'); i.style.background = bg; b.append(node('small', '', label), node('b', '', value), node('span', 'us-sub', sub)); c.append(i, b); return c; };
    const ring = node('div', 'us-ring'); ring.style.setProperty('--p', hit); ring.append(node('span', '', hit + '%'));
    const cache = node('div', 'us-tile'), cb = node('div'); cb.append(node('small', '', i18n('usageui.doc_tu_cache')), node('b', '', short(t.cr)), node('span', 'us-sub', i18n('usageui.cang_cao_cang_tiet_kiem'))); cache.append(ring, cb);
    tiles.append(tile('🔢', '#dcebff', i18n('usageui.tong_token'), full(t.tok), '≈ ' + short(t.tok)),
      tile('💰', 'var(--ok-soft)', i18n('usageui.chi_phi_uoc_tinh'), usd(t.cost), t.days.size ? i18n('usageui.ngay', [usd(t.cost / t.days.size)]) : '—'), cache,
      tile('✍️', '#ffe8cf', i18n('usageui.output_da_viet_ra'), full(t.out), short(t.out) + ' token'));
    hooks.summary(t.days.size ? short(t.tok) + ' token · ' + usd(t.cost) : '');
  }

  function renderControls(list) {
    controls.textContent = '';
    const r1 = node('div', 'us-row'), r2 = node('div', 'us-row');
    const all = node('button', 'us-acc', i18n('usageui.tat_ca')); all.type = 'button'; all.style.setProperty('--c', 'var(--hero-b)'); all.setAttribute('aria-pressed', String(st.acct === 'all')); all.onclick = () => { st.acct = 'all'; render(); };
    r1.append(all);
    list.forEach((a) => {
      const b = node('button', 'us-acc'); b.type = 'button'; b.style.setProperty('--c', a.color); b.setAttribute('aria-pressed', String(st.acct === a.id));
      b.append(node('i', '', (a.label[0] || '?').toUpperCase()), document.createTextNode(a.label + ' '), node('small', '', (TOOL[a.tool] || {}).name || a.tool));
      b.title = a.hostName ? i18n('usageui.may', [a.hostName]) : ''; b.onclick = () => { st.acct = a.id; render(); }; r1.append(b);
    });
    const R = ranges();
    r2.append(chips([['today', i18n('usageui.hom_nay')], ['week', i18n('usageui.7_ngay')], ['month', i18n('usageui.thang_nay')]], st.range, (k) => setRange(k, R[k][0], R[k][1])));
    const date = (key, label) => { const l = node('label', 'us-f', label), i = node('input'); i.type = 'date'; i.value = st[key]; i.onchange = () => { st[key] = i.value; setRange('custom', st.from, st.to); }; l.append(i); return l; };
    r2.append(date('from', i18n('usageui.tu')), date('to', i18n('usageui.den')), node('span', 'us-sp'));
    const sw = node('button', 'us-sw'); sw.type = 'button'; sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', String(st.model)); sw.setAttribute('aria-label', i18n('usageui.theo_model')); sw.onclick = () => { st.model = !st.model; render(); };
    const swl = node('label', 'us-f'); swl.append(sw, document.createTextNode(' ' + i18n('usageui.theo_model')));
    r2.append(swl, chips([['day', i18n('usageui.theo_ngay')], ['session', i18n('usageui.theo_phien')]], st.view, (k) => { st.view = k; render(); }));
    controls.append(r1, r2);
  }

  function renderChart(list, days) {
    chartPanel.textContent = '';
    const head = node('div', 'us-row');
    head.append(node('b', 'us-h', i18n('usageui.moi_ngay_dung_bao_nhieu')), node('span', 'us-tag', i18n('usageui.thang_can_bac_hai')), node('span', 'us-sp'),
      chips([['cost', i18n('usageui.chi_phi')], ['tok', '🔢 Token']], st.metric, (k) => { st.metric = k; render(); }));
    const key = (d) => st.metric === 'cost' ? d.cost : sumTokens(d.models);
    const per = days.map((day) => ({ day, seg: list.map((a) => ({ a, v: (a.days.find((d) => d.day === day) || { cost: 0, models: [] }) })).map(({ a, v }) => ({ a, v: key(v) })).filter((s) => s.v > 0) }))
      .map((p) => ({ ...p, v: p.seg.reduce((n, s) => n + s.v, 0) }));
    const mx = Math.max(1, ...per.map((p) => Math.sqrt(p.v)));
    const chart = node('div', 'us-chart'), labels = node('div', 'us-days');
    per.forEach((p) => {
      const col = node('div', 'us-col'), stack = node('div', 'us-stack'), val = st.metric === 'cost' ? usd(p.v) : short(p.v);
      col.title = p.day + ': ' + (st.metric === 'cost' ? usd(p.v) : full(p.v));
      stack.style.height = Math.max(6, Math.round(Math.sqrt(p.v) / mx * 128)) + 'px';
      p.seg.forEach((s) => { const i = node('i'); i.style.flex = String(Math.sqrt(s.v)); i.style.background = s.a.color; i.title = s.a.label + ' (' + ((TOOL[s.a.tool] || {}).name || s.a.tool) + ')'; stack.append(i); });
      col.append(node('span', 'us-val', val), stack); chart.append(col); labels.append(node('span', '', p.day.slice(5)));
    });
    const legend = node('div', 'us-legend');
    list.filter((a) => a.days.some((d) => inRange(d.day))).forEach((a) => { const l = node('span'), i = node('i'); i.style.background = a.color; l.append(i, document.createTextNode(a.label + ' · ' + ((TOOL[a.tool] || {}).name || a.tool))); legend.append(l); });
    chartPanel.append(head, per.length ? chart : node('p', 'us-empty', i18n('usageui.khong_co_du_lieu_de')), labels, legend);
  }

  function cell(text, cls) { return node('td', cls || 'n', text); }
  function numbers(tr, v, max, color) {
    ['input', 'output', 'cacheCreate', 'cacheRead'].forEach((k) => tr.append(cell(full(v[k]))));
    const tk = cell(full(v.total), 'n us-tk'); tk.style.setProperty('--c', color); tk.style.setProperty('--r', Math.max(0.02, v.total / max).toFixed(3)); tk.append(node('span', 'us-bar')); tr.append(tk);
    const c = cell('', 'n'); c.append(node('span', v.cost == null ? 'us-nocost' : 'us-cost', v.cost == null ? '—' : usd(v.cost))); tr.append(c);
  }
  const agg = (models, cost) => models.reduce((a, m) => ({ input: a.input + m.input, output: a.output + m.output, cacheCreate: a.cacheCreate + m.cacheCreate, cacheRead: a.cacheRead + m.cacheRead, total: a.total + m.total, cost: a.cost }), { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0, cost });

  function renderTable(list, days) {
    tablePanel.textContent = '';
    const head = node('div', 'us-row'); head.append(node('b', 'us-h', i18n('usageui.dung_theo_ngay')));
    const wrap = node('div', 'us-tw'), table = node('table'), thead = node('thead'), hr = node('tr');
    [i18n('usageui.ngay_2'), i18n('tokenui.cong_cu'), i18n('tokenui.tai_khoan'), 'Model', 'Input', 'Output', i18n('usageui.cache_tao'), i18n('usageui.cache_doc'), i18n('usageui.tong_token'), i18n('usageui.chi_phi_2')].forEach((h, i) => hr.append(node('th', i < 4 ? 'l' : '', h)));
    thead.append(hr); table.append(thead);
    const body = node('tbody'); const all = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0, cost: 0 };
    const rowsOf = (day) => list.map((a) => ({ a, d: a.days.find((d) => d.day === day) })).filter((x) => x.d && x.d.models.length);
    const max = Math.max(1, ...days.map((day) => rowsOf(day).reduce((n, x) => n + sumTokens(x.d.models), 0)));
    days.forEach((day) => {
      const rows = rowsOf(day); if (!rows.length) return;
      const closed = st.closed.has(day), dayAgg = rows.reduce((t, x) => { const m = agg(x.d.models, x.d.cost); Object.keys(t).forEach((k) => { t[k] += m[k]; }); return t; }, { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0, cost: 0 });
      Object.keys(all).forEach((k) => { all[k] += dayAgg[k]; });
      const tr = node('tr', 'us-day' + (closed ? ' closed' : '')), first = node('td', 'l'); first.colSpan = 4;
      const wk = WEEKDAY[new Date(day + 'T12:00:00Z').getUTCDay()];
      first.append(node('span', 'us-car', '▾'), document.createTextNode(day), node('span', 'us-wk', wk)); tr.append(first); numbers(tr, dayAgg, max, 'var(--hero-b)');
      tr.onclick = () => { st.closed.has(day) ? st.closed.delete(day) : st.closed.add(day); render(); }; body.append(tr);
      if (closed) return;
      rows.forEach(({ a, d }) => {
        const ar = node('tr', 'us-agent'), badge = node('span', 'us-badge', (TOOL[a.tool] || {}).name || a.tool), who = node('td', 'l'), av = node('span', 'us-av', (a.label[0] || '?').toUpperCase());
        badge.style.setProperty('--c', (TOOL[a.tool] || {}).color || '#888'); av.style.setProperty('--c', a.color);
        const tdTool = node('td', 'l'); tdTool.append(badge); who.append(av, document.createTextNode(a.label));
        const models = node('td', 'l us-models'); d.models.forEach((m) => models.append(node('span', 'us-mdl', m.model)));
        ar.append(node('td', 'l'), tdTool, who, models); numbers(ar, agg(d.models, d.cost), max, a.color); body.append(ar);
        if (st.model) d.models.forEach((m) => { const mr = node('tr', 'us-model'); mr.append(node('td', 'l'), node('td', 'l'), node('td', 'l'), node('td', 'l', '└ ' + m.model)); numbers(mr, m, max, a.color); body.append(mr); });
      });
    });
    const tot = node('tr', 'us-total'), tl = node('td', 'l', i18n('usageui.tong_cong')); tl.colSpan = 4; tot.append(tl); numbers(tot, all, all.total || 1, 'var(--hero-a)');
    if (!body.children.length) { const e = node('tr'), c = node('td', 'us-empty', loading ? i18n('tokenui.dang_doc') : i18n('usageui.khong_co_du_lieu_trong')); c.colSpan = 10; e.append(c); body.append(e); } else body.append(tot);
    table.append(body); wrap.append(table);
    tablePanel.append(head, wrap, node('p', 'us-note', i18n('usageui.chi_phi_la_uoc_tinh')));
  }

  function render() {
    const list = visible();
    if (st.acct !== 'all' && !list.some((a) => a.id === st.acct)) st.acct = 'all';
    const shown = list.filter((a) => st.acct === 'all' || a.id === st.acct);
    const days = [...new Set(shown.flatMap((a) => a.days.map((d) => d.day)).filter(inRange))].sort();
    root.hidden = false;
    renderStatus(list); renderControls(list);
    renderTiles(shown.flatMap((a) => a.days.filter((d) => inRange(d.day)).map((d) => ({ a, d }))));
    renderChart(shown, days); renderTable(shown, days);
    const onDay = st.view === 'day';
    tiles.hidden = chartPanel.hidden = tablePanel.hidden = !onDay;
    hooks.view(st.view);
  }

  return { root, render, reload: (force) => load(!!force), ensure: () => { if (!data && !loading) load(false); } };
};
