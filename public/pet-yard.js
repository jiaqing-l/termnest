'use strict';
// "Sân chơi": one pet per session on a yard that follows day and night. Pets can be fed, chat, play football in two teams,
// chase each other, share food, dance and fish. The hero banner above also shows the weather (rain / thunder on high load).
// Pure decoration: every entry point is guarded so it can never break input.
(function () {
  const PA = window.PetArt, P = window.PetState;
  const $ = (id) => document.getElementById(id);
  const root = $('pet-yard2'), hero = document.querySelector('.hero');
  if (!root || !PA || !P) return;
  const media = window.matchMedia('(prefers-reduced-motion: reduce)');
  const SHOWN = 14, DAY = 86400000;
  let ctx = { records: new Map(), servers: [], choices: {}, connected: true, overview: true, limits: {}, weather: 'sun', open() {}, kindOf: () => 'cat' };
  const walkers = new Map();
  let drag = null, suppress = 0, M = null, A = null, autoTimer = null, scoreHold = 0;
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };

  // ---------- header: score + manual football button ----------
  const head = document.querySelector('.playground > b');
  const score = el('span', 'yd-score'), kickoff = el('button', 'btn yd-kick', i18n('petyard.da_bong'));
  kickoff.type = 'button'; kickoff.title = i18n('petyard.cho_cac_ban_thu_da');
  if (head) head.append(score, kickoff);

  // ---------- helpers ----------
  const hour = () => new Date().getHours();
  const sky = () => { const h = hour(); return h < 6 || h >= 23 ? 'midnight' : h < 17 ? 'day' : h < 19 ? 'dusk' : 'night'; };
  const enabled = () => !document.documentElement.classList.contains('pets-off');
  const still = () => document.documentElement.classList.contains('pets-still') || media.matches;
  // Pets that are working stay up all night, so play is only ever between pets that are awake (free() filters the sleepers).
  function canPlay() { return enabled() && !still() && ctx.overview && !document.hidden && !drag && !document.querySelector('dialog[open]'); }
  function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
  function fedAt(info) {
    const key = 'tw-fed:' + info.r.v.id + '/' + info.r.s.name, now = Date.now();
    try { const v = Number(localStorage.getItem(key)); if (v > 0 && v <= now) return v; localStorage.setItem(key, String(now)); } catch { /* optional */ }
    return now;
  }
  function setFed(info) { try { localStorage.setItem('tw-fed:' + info.r.v.id + '/' + info.r.s.name, String(Date.now())); } catch { /* optional */ } }

  // ---------- one record -> what the pet is doing ----------
  function info(key, r) {
    const v = r.v, s = r.s, lim = ctx.limits || {}, choice = ctx.choices[v.id + '/' + s.name] || {};
    const high = (k) => v.on && v[k] != null && lim[k] != null && v[k] >= lim[k];
    const icons = [], says = [];
    if (high('cpu')) { icons.push('💦'); says.push(i18n('petyard.cpu_em_nong_qua', [Math.round(v.cpu)])); }
    if (high('ram')) { icons.push('🧠'); says.push(i18n('petyard.ram_em_hoi_nang_dau', [Math.round(v.ram)])); }
    if (high('disk')) { icons.push('📦'); says.push(i18n('petyard.dia_don_bot_nha', [Math.round(v.disk)])); }
    let mode = 'ok', say = s.state === 'run' ? i18n('petyard.dang_chay', [(s.cmd ? ' · ' + s.cmd : '')]) : i18n('petyard.dang_nghi_moi_thu_on');
    if (P.outcome(s) === 'failure') { mode = 'alarmed'; icons.unshift('❗'); say = i18n('petyard.phien_ket_thuc_co_loi'); }
    else if (!v.on || !ctx.connected) { mode = 'offline'; icons.unshift('📴'); say = i18n('petyard.mat_ket_noi_may_chu'); }
    else if (s.state === 'wait') { mode = 'wait'; icons.unshift('💬'); say = i18n('petyard.dang_cho_ban_tra_loi'); }
    else if (sky() === 'midnight' && s.state !== 'run') { mode = 'sleep'; icons.unshift('💤'); say = i18n('petyard.khuya_roi_em_ngu_nhe'); }
    else if (sky() === 'midnight') say = i18n('petyard.khuya_roi_ma_em_van', [(s.cmd ? '(' + s.cmd + ') ' : '')]);
    else if (says.length) say = says.join(' ');
    const name = choice.name || s.name;
    const kind = (PA.PETS ? PA.PETS[choice.kind] : PA.ORDER.includes(choice.kind)) ? choice.kind : ctx.kindOf(s.name);
    return { key, r, name, kind, hat: choice.hat || '', mode, icon: icons.join(''), say, hot: high('cpu'), carry: high('disk') };
  }

  // ---------- render ----------
  const HATS = { flower: '🌸', summer: '👒', pumpkin: '🎃', winter: '🎅' };
  function build() {
    if (root.dataset.built) return;
    root.dataset.built = '1';
    root.append(el('span', 'yd-more'), el('span', 'yd-sky'), el('span', 'yd-goal yd-goal-l'), el('span', 'yd-goal yd-goal-r'), el('span', 'yd-pond'), el('span', 'yd-ball', '⚽'), el('span', 'yd-empty'));
    [[18, 10], [34, 22], [56, 8], [72, 24], [88, 12]].forEach((p, i) => { const s = el('i', 'yd-st'); s.style.cssText = 'left:' + p[0] + '%;top:' + p[1] + 'px;animation-delay:-' + i * .45 + 's'; root.append(s); });
  }
  function render() {
    build();
    const list = [...ctx.records].map(([k, r]) => info(k, r));
    const rank = (p) => p.mode === 'alarmed' ? 0 : p.mode === 'wait' ? 1 : p.hot || p.carry ? 2 : 3;
    const vis = list.slice().sort((a, b) => rank(a) - rank(b) || (a.key < b.key ? -1 : 1)).slice(0, SHOWN).sort((a, b) => (a.key < b.key ? -1 : 1));
    const extra = list.length - vis.length, s = sky();
    root.classList.remove('day', 'dusk', 'night', 'midnight'); root.classList.add(s);
    root.classList.toggle('alarm', list.some((p) => p.mode === 'alarmed' || p.mode === 'offline'));
    root.style.setProperty('--s', (vis.length <= 6 ? 46 : vis.length <= 10 ? 38 : 30) + 'px');
    root.querySelector('.yd-sky').textContent = s === 'day' ? '☀️' : s === 'dusk' ? '🌇' : '🌙';
    const more = root.querySelector('.yd-more'); more.hidden = extra <= 0; more.textContent = '+' + extra; more.title = i18n('petyard.con_phien_nua', [extra]);
    const empty = root.querySelector('.yd-empty'); empty.hidden = vis.length > 0; empty.textContent = i18n('petyard.chua_co_phien_nao_bam');
    const keep = new Set(vis.map((p) => p.key)); let changed = false;
    walkers.forEach((w, k) => { if (!keep.has(k)) { w.el.remove(); walkers.delete(k); changed = true; } });
    let sleepIdx = 0;
    const lane = 100 / Math.max(1, vis.length);   // every pet strolls inside its own slice of the yard, so none pile up on another
    vis.forEach((p, i) => {
      let w = walkers.get(p.key);
      if (!w) {
        const h = hash(p.key), node = el('div', 'yw ' + (i % 2 ? 'tb' : 'ta')), pet = el('div', 'yp'), mood = el('em', 'ym'), zz = el('span', 'yz'), hat = el('span', 'yh');
        zz.append('z', el('small', '', 'z'), 'z'); node.dataset.key = p.key;
        node.style.cssText = '--t:' + (13 + (h % 5) * 3) + 's;--d:-' + ((h % 110) / 10).toFixed(1) + 's';
        node.append(pet, mood, zz, hat); root.append(node);
        w = { el: node, pet, mood, zz, hat, art: '' }; walkers.set(p.key, w); changed = true;
      }
      const stateArt = p.mode === 'sleep' ? 'idle' : p.mode === 'wait' ? 'wait' : 'run', art = p.kind + '/' + stateArt;
      if (w.art !== art) { w.art = art; w.pet.innerHTML = PA.pet(p.kind, stateArt); }
      w.el.style.setProperty('--a', (i * lane + lane * .05).toFixed(1) + '%'); w.el.style.setProperty('--b', (i * lane + lane * .85).toFixed(1) + '%');
      const was = w.el.dataset.mode, hungry = p.mode === 'ok' && Date.now() - fedAt(p) >= DAY;
      w.info = p; w.el.dataset.mode = p.mode; w.el.title = p.name;
      ['sleep', 'hot', 'carry', 'alarmed', 'wait', 'offline'].forEach((c) => w.el.classList.toggle(c, p.mode === c || (c === 'hot' && p.hot) || (c === 'carry' && p.carry)));
      w.el.classList.toggle('hungry', hungry);
      if (w.mood.textContent !== p.icon) w.mood.textContent = p.icon;
      w.zz.hidden = !(p.mode === 'sleep' && i % 3 === 0); w.hat.textContent = HATS[p.hat] || '';
      if (p.mode === 'sleep') { w.el.classList.add('huddle'); w.el.style.left = 'calc(24% + ' + (sleepIdx * 30) + 'px)'; w.el.style.setProperty('--tilt', ((sleepIdx % 2 ? -1 : 1) * (4 + sleepIdx % 3 * 2)) + 'deg'); sleepIdx++; }
      else if (w.el.classList.contains('huddle')) { w.el.classList.remove('huddle'); w.el.style.left = ''; }
      if (was && was !== p.mode && (M || A) && ['alarmed', 'wait', 'offline', 'sleep'].includes(p.mode)) changed = true;
    });
    if (changed && (M || A)) { stopMatch(true); stopAct(true); }
    writeScore();
  }
  function writeScore() {
    if (Date.now() < scoreHold) return;
    const alive = walkers.size;
    score.textContent = A ? i18n('petyard.thu', [A.label, A.items.length])
      : M ? i18n('petyard.xanh_do_thu_dang_da', [M.score[0], M.score[1], M.p.length])
      : !alive ? '' : sky() === 'midnight' ? night() : i18n('petyard.ban_dang_o_san', [alive]);
    kickoff.setAttribute('aria-pressed', String(!!M)); kickoff.textContent = M ? i18n('petyard.dung_tran') : i18n('petyard.da_bong');
  }
  function night() {
    const up = [...walkers.values()].filter((w) => w.info.mode !== 'sleep').length;
    return up ? i18n('petyard.khuya_roi_ban_van_dang', [up]) : i18n('petyard.khuya_roi_cac_ban_dang');
  }
  function note(text, ms) { score.textContent = text; scoreHold = Date.now() + (ms || 2500); setTimeout(writeScore, (ms || 2500) + 50); }

  // ---------- bubbles, feeding, particles ----------
  function bubble(w, text, actions) {
    document.querySelectorAll('.yd-bubble').forEach((e) => e.remove());
    const b = el('div', 'yd-bubble'); b.setAttribute('role', 'status'); b.textContent = text;
    if (actions && actions.length) { const row = el('div', 'yd-acts'); actions.forEach((a) => { const x = el('button', 'yd-feed', a[0]); x.type = 'button'; x.onclick = () => { b.remove(); a[1](); }; row.append(x); }); b.append(row); }
    document.body.append(b);
    const r = w.pet.getBoundingClientRect();
    b.style.left = Math.max(10, Math.min(innerWidth - b.offsetWidth - 10, r.left - 6)) + 'px'; b.style.top = Math.max(10, r.top - b.offsetHeight - 8) + 'px';
    setTimeout(() => b.remove(), actions && actions.length ? 6500 : 2800);
  }
  const say = (w, text) => { if (w) bubble(w, text); };
  // A bubble goes away the moment you click anywhere else (or press Esc); clicking another pet simply replaces it.
  const closeBubbles = () => document.querySelectorAll('.yd-bubble').forEach((e) => e.remove());
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest || e.target.closest('.yd-bubble') || e.target.closest('.yw')) return; closeBubbles(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeBubbles(); });
  window.addEventListener('scroll', closeBubbles, true);
  function particle(cls, text, x, y) { const e = el('i', 'yd-p ' + cls, text); e.style.cssText = 'left:' + x + 'px;top:' + y + 'px'; document.body.append(e); setTimeout(() => e.remove(), 1500); return e; }
  function joy(w) { w.pet.classList.remove('joy'); void w.pet.offsetWidth; w.pet.classList.add('joy'); }
  function hearts(w) { const r = w.pet.getBoundingClientRect(); for (let i = 0; i < 5; i++) particle('yd-hrt', '💜', r.left + r.width / 2 + (i - 2) * 9, r.top - 4); }
  function confetti() {
    if (!canPlay()) return; const r = root.getBoundingClientRect(); if (!r.width) return;
    for (let i = 0; i < 46; i++) { const e = particle('yd-cf', '', r.left + Math.random() * r.width, r.top + 20); e.style.background = ['#7c8cff', '#34d399', '#fbbf24', '#f87171', '#60a5fa'][i % 5]; e.style.setProperty('--x', (Math.random() - .5) * 190 + 'px'); e.style.setProperty('--y', -(40 + Math.random() * 80) + 'px'); }
  }
  function feed(w) {
    setFed(w.info); w.el.classList.remove('hungry');
    if (canPlay()) { const r = w.pet.getBoundingClientRect(); particle('yd-food', '🍖', r.left + 8, r.top - 6); }
    setTimeout(() => { joy(w); hearts(w); say(w, i18n('petyard.ngon_qua_cam_on_sep')); setTimeout(() => startAct('share', w), 900); }, 560);
  }
  root.addEventListener('click', (e) => {
    const node = e.target.closest('.yw'); if (!node || Date.now() < suppress) return; const w = walkers.get(node.dataset.key); if (!w) return;
    const i = w.info, open = () => ctx.open(i.r.v.id, i.r.s.name);
    if (i.mode === 'alarmed') { open(); return; }
    joy(w);
    const acts = [[i18n('petyard.mo_phien'), open]]; if (i.mode === 'ok') acts.unshift([i18n('petyard.cho_an'), () => feed(w)]);
    bubble(w, i.name + ': ' + i.say, acts);
  });
  // drag a pet to another spot
  root.addEventListener('pointerdown', (e) => {
    const node = e.target.closest('.yw'); if (!node || e.button !== 0) return;
    stopMatch(); stopAct(); const r = node.getBoundingClientRect(), y = root.getBoundingClientRect();
    drag = { node, y, x: e.clientX, moved: false }; node.style.animation = 'none'; node.style.left = (r.left - y.left) + 'px'; node.querySelector('.yp').style.animation = 'none';
  });
  document.addEventListener('pointermove', (e) => {
    if (!drag || (Math.abs(e.clientX - drag.x) < 4 && !drag.moved)) return; drag.moved = true; drag.node.classList.add('held');
    drag.node.style.left = Math.max(0, Math.min(drag.y.width - drag.node.offsetWidth, e.clientX - drag.y.left - drag.node.offsetWidth / 2)) + 'px';
  });
  function drop(cancelled) {
    if (!drag) return; const d = drag; drag = null; d.node.classList.remove('held');
    if (d.moved) { suppress = Date.now() + 400; if (!cancelled) say(walkers.get(d.node.dataset.key), i18n('petyard.o_day_mat_ghe')); }
    else { d.node.style.animation = ''; d.node.querySelector('.yp').style.animation = ''; d.node.style.left = ''; }
  }
  document.addEventListener('pointerup', () => drop(false)); document.addEventListener('pointercancel', () => drop(true));

  // ---------- football: any number of pets, two teams ----------
  const ballEl = () => root.querySelector('.yd-ball');
  // A session waiting for you has nothing to do either, so it plays too. Only a sleeping, failed or disconnected pet sits out.
  const free = (n) => (n.dataset.mode === 'ok' || n.dataset.mode === 'wait') && !n.classList.contains('held');
  // A waiting pet holds up its sign; while it plays it shows the running pose, and goes back to the sign when the game ends.
  function pose(w, playing) {
    const x = walkers.get(w.dataset.key); if (!x) return;
    const art = playing ? 'run' : x.info.mode === 'sleep' ? 'idle' : x.info.mode === 'wait' ? 'wait' : 'run';
    x.art = x.info.kind + '/' + art; x.pet.innerHTML = PA.pet(x.info.kind, art);
  }
  function stopMatch(silent) {
    if (!M) return; cancelAnimationFrame(M.raf);
    M.p.forEach((p) => { p.w.style.animation = ''; p.w.style.left = ''; p.w.classList.remove('running', 'kicking', 'in-match'); p.pet.style.animation = ''; p.pet.style.transform = ''; pose(p.w, false); });
    const b = ballEl(); b.style.left = b.style.bottom = b.style.transform = ''; root.classList.remove('playing'); M = null; // the score goes with the match
    if (!silent) writeScore();
  }
  function startMatch() {
    if (M || A || !canPlay()) return false;
    const ws = [...root.querySelectorAll('.yw')].filter(free).slice(0, 12), W = root.clientWidth, yr = root.getBoundingClientRect();
    if (ws.length < 2 || W < 160) return false;
    const T = [0, 0];
    M = { W, K: Math.max(1, Math.min(3, W / 360)), b: { x: W / 2 - 8, h: 0, vx: 0, vh: 0, spin: 0 }, turn: 0, kicks: 0, score: [0, 0], t: performance.now(), start: performance.now(), pause: 0, raf: 0,
      p: ws.map((w, i) => { const team = i % 2, pet = w.querySelector('.yp'); w.style.animation = 'none'; pet.style.animation = 'none'; pose(w, true); w.classList.add('in-match'); w.classList.toggle('ta', team === 0); w.classList.toggle('tb', team === 1); return { w, pet, x: w.getBoundingClientRect().left - yr.left, team, idx: T[team]++, kick: 0 }; }) };
    M.cnt = T; root.classList.add('playing'); M.raf = requestAnimationFrame(step); writeScore(); say(walkers.get(ws[0].dataset.key), i18n('petyard.da_bong_khong_ban_oi')); return true;
  }
  function kick(p) {
    const dir = p.team === 0 ? 1 : -1, K = M.K, attack = dir > 0 ? M.b.x / M.W : 1 - M.b.x / M.W, shoot = attack > .58;
    p.kick = .26; p.w.classList.add('kicking'); // 💥
    M.b.vx = dir * (shoot ? (90 + Math.random() * 60) * K : (46 + Math.random() * 52) * K); M.b.vh = shoot ? 15 + Math.random() * 30 : 45 + Math.random() * 75; M.b.spin = dir * 640; M.kicks++;
    M.turn = Math.random() < (shoot ? .35 : .55) ? p.team : 1 - M.turn; // a pass to a mate, or the other team wins the ball
  }
  function goal(team) {
    M.score[team]++; const p = M.p.find((q) => q.team === team) || M.p[0];
    say(walkers.get(p.w.dataset.key), i18n('petyard.vaooo_xanh_do', [M.score[0], M.score[1]])); joy(walkers.get(p.w.dataset.key)); confetti();
    M.pause = 1.2; M.b.x = M.W / 2 - 8; M.b.h = 0; M.b.vx = 0; M.b.vh = 0; M.turn = 1 - team; writeScore();
  }
  function finish() { const f = i18n('petyard.xanh_do', [M.score[0], M.score[1]]), w = walkers.get(M.p[0].w.dataset.key); stopMatch(); say(w, i18n('petyard.het_tran_ti_so_xoa', [f])); }
  function step(now) {
    if (!M) return; if (!canPlay()) { stopMatch(); return; }
    if (M.kicks >= 26 || M.score[0] + M.score[1] >= 3 || now - M.start >= 40000) { finish(); return; }
    const dt = Math.min(.04, (now - M.t) / 1000); M.t = now; const b = M.b, G = 330, W = M.W;
    if (M.pause > 0) M.pause -= dt;
    else {
      if (b.h > 0 || b.vh > 0) { b.h += b.vh * dt; b.vh -= G * dt; if (b.h <= 0) { b.h = 0; b.vh = b.vh < -22 ? -b.vh * .42 : 0; b.vx *= .8; } } else b.vx *= 1 - 1.9 * dt;
      b.x += b.vx * dt; b.spin *= 1 - .9 * dt;
      if (b.x < 3) { if (b.h < 26) { goal(1); return after(); } b.x = 3; b.vx = Math.abs(b.vx) * .5; }
      if (b.x > W - 18) { if (b.h < 26) { goal(0); return after(); } b.x = W - 18; b.vx = -Math.abs(b.vx) * .5; }
      const mates = M.p.filter((p) => p.team === M.turn), chaser = mates.reduce((a, p) => Math.abs(p.x - b.x) < Math.abs(a.x - b.x) ? p : a, mates[0]);
      M.p.forEach((p) => {
        const chasing = p === chaser, n = M.cnt[p.team], half = p.team === 0 ? [.06, .46] : [.54, .92], home = W * (half[0] + (half[1] - half[0]) * (n > 1 ? p.idx / (n - 1) : .5));
        const target = chasing ? b.x + (p.team === 0 ? -24 : 12) : home, d = target - p.x, sp = (chasing ? 66 : 30) * M.K;
        p.kick = Math.max(0, p.kick - dt); if (!p.kick) p.w.classList.remove('kicking');
        const moving = Math.abs(d) > 2; p.w.classList.toggle('running', moving);
        if (moving) { p.x += Math.sign(d) * Math.min(Math.abs(d), sp * dt); p.pet.style.transform = 'scaleX(' + (d < 0 ? -1 : 1) + ')'; } else p.pet.style.transform = 'scaleX(' + (p.team === 0 ? 1 : -1) + ')';
        p.x = Math.max(0, Math.min(W - p.w.offsetWidth, p.x)); p.w.style.left = p.x + 'px';
        if (chasing && !moving && b.h < 10 && Math.abs(b.vx) < 34 * M.K) kick(p);
      });
    }
    const ball = ballEl(); ball.style.left = b.x + 'px'; ball.style.bottom = (10 + b.h) + 'px'; ball.style.transform = 'rotate(' + ((now / 1000 * b.spin) % 360) + 'deg)';
    M.raf = requestAnimationFrame(step);
  }
  function after() { if (!M) return; const ball = ballEl(); ball.style.left = M.b.x + 'px'; ball.style.bottom = '10px'; if (M.score[0] + M.score[1] >= 3) { finish(); return; } M.t = performance.now(); M.raf = requestAnimationFrame(step); }
  kickoff.addEventListener('click', () => { if (A) stopAct(); if (M) stopMatch(); else if (!startMatch()) note(i18n('petyard.can_it_nhat_2_ban')); });

  // ---------- tag, share food, dance, fishing ----------
  const awake = (max) => [...root.querySelectorAll('.yw')].filter(free).slice(0, max || 12);
  function take(ws) { const yl = root.getBoundingClientRect().left; return ws.map((w) => { pose(w, true); const pet = w.querySelector('.yp'), mood = w.querySelector('.ym'); w.style.animation = 'none'; pet.style.animation = 'none'; return { w, pet, mood, m0: mood.textContent, x: w.getBoundingClientRect().left - yl }; }); }
  const face = (p, dir) => { p.pet.style.transform = 'scaleX(' + (dir < 0 ? -1 : 1) + ')'; };
  function go(p, tx, sp, dt, W) { const d = tx - p.x, moving = Math.abs(d) > 2; p.w.classList.toggle('running', moving); if (moving) { p.x += Math.sign(d) * Math.min(Math.abs(d), sp * dt); face(p, d); } p.x = Math.max(0, Math.min(W - p.w.offsetWidth, p.x)); p.w.style.left = p.x + 'px'; return !moving; }
  const wOf = (p) => walkers.get(p.w.dataset.key);
  function startAct(type, arg) {
    if (M || A || !canPlay()) return false; const W = root.clientWidth; if (W < 160) return false;
    const init = { tag: initTag, dance: initDance, fish: initFish, share: initShare }[type]; if (!init) return false;
    A = { type, W, K: Math.max(1, Math.min(3, W / 360)), t: performance.now(), t0: performance.now(), raf: 0, items: [], label: '', endMsg: null };
    if (!init(arg)) { A = null; return false; }
    root.classList.add('act-' + type); A.raf = requestAnimationFrame(actStep); writeScore(); return true;
  }
  function stopAct(silent) {
    if (!A) return; cancelAnimationFrame(A.raf);
    A.items.forEach((p) => { p.w.style.animation = ''; p.w.style.left = ''; p.w.classList.remove('running', 'dancing', 'fishing', 'eating', 'it'); p.pet.style.animation = ''; p.pet.style.transform = ''; p.pet.style.removeProperty('--dd'); p.mood.textContent = p.m0; pose(p.w, false); });
    root.classList.remove('act-' + A.type); A = null; if (!silent) writeScore();
  }
  function actStep(now) {
    if (!A) return; if (!canPlay()) { stopAct(); return; }
    const dt = Math.min(.04, (now - A.t) / 1000); A.t = now;
    if (A.step(now, dt)) { const w = wOf(A.items[0]), msg = A.endMsg; stopAct(); if (msg) say(w, msg); return; }
    A.raf = requestAnimationFrame(actStep);
  }
  function initTag() {
    const ws = awake(8); if (ws.length < 3) return false; A.items = take(ws); A.label = i18n('petyard.dang_duoi_bat'); A.endMsg = i18n('petyard.met_qua_nghi_chut_nhe'); let it = 0, immune = 0;
    const mark = (i) => { const p = A.items[i]; p.w.classList.add('it'); p.mood.textContent = '🏃'; }, unmark = (i) => { const p = A.items[i]; p.w.classList.remove('it'); p.mood.textContent = p.m0; };
    mark(0);
    A.step = (now, dt) => {
      const items = A.items, W = A.W, K = A.K, me = items[it]; let near = -1, nd = 1e9; immune = Math.max(0, immune - dt);
      items.forEach((p, i) => { if (i === it) return; const d = Math.abs(p.x - me.x); if (d < nd) { nd = d; near = i; } });
      items.forEach((p, i) => {
        if (i === it) { go(p, items[near].x, 80 * K, dt, W); return; }
        const away = p.x >= me.x ? 1 : -1; let tx = p.x + away * 140; if (tx < 8 || tx > W - 48) tx = p.x - away * 140;
        go(p, Math.max(0, Math.min(W - 48, tx)), (Math.abs(p.x - me.x) < 100 ? 62 : 26) * K, dt, W);
      });
      if (nd < 26 && immune === 0) { unmark(it); it = near; mark(it); immune = 1.3; say(wOf(items[it]), i18n('petyard.bat_duoc_roi_den_luot')); joy(wOf(items[it])); }
      return now - A.t0 > 22000;
    };
    return true;
  }
  function initDance() {
    const ws = awake(10); if (ws.length < 2) return false; A.items = take(ws); A.label = i18n('petyard.dang_nhay_mua'); A.endMsg = i18n('petyard.vui_qua_mai_nhay_tiep');
    const n = A.items.length, gap = Math.min(46, A.W * .5 / n), start = A.W / 2 - gap * (n - 1) / 2; let danced = 0, note = 0;
    A.step = (now, dt) => {
      let all = true; A.items.forEach((p, i) => { if (!go(p, start + i * gap, 72 * A.K, dt, A.W)) all = false; });
      if (all && !danced) { danced = now; A.items.forEach((p, i) => { p.w.classList.add('dancing'); p.pet.style.setProperty('--dd', (i * .12) + 's'); face(p, 1); }); }
      if (danced) { note -= dt; if (note <= 0) { note = .5; const p = A.items[Math.floor(Math.random() * A.items.length)], r = p.pet.getBoundingClientRect(); particle('yd-hrt', ['🎵', '🎶', '✨'][Math.floor(Math.random() * 3)], r.left + r.width / 2, r.top - 4); } }
      return danced ? now - danced > 7000 : now - A.t0 > 14000;
    };
    return true;
  }
  function initFish() {
    const ws = awake(12); if (!ws.length) return false; A.items = take(ws.slice(-3)); A.label = i18n('petyard.dang_cau_ca'); A.endMsg = i18n('petyard.hom_nay_cau_duoc_nhieu'); let next = 3;
    A.step = (now, dt) => {
      let all = true; A.items.forEach((p, i) => { if (go(p, A.W - 90 - i * 42, 62 * A.K, dt, A.W)) { face(p, 1); p.w.classList.add('fishing'); } else all = false; });
      if (all) { next -= dt; if (next <= 0) { next = 3 + Math.random() * 3; const p = A.items[Math.floor(Math.random() * A.items.length)], r = p.pet.getBoundingClientRect(); particle('yd-hrt', '🐟', r.left + r.width + 6, r.top); say(wOf(p), i18n('petyard.cau_duoc_ca_roi')); joy(wOf(p)); } }
      return now - A.t0 > 22000;
    };
    return true;
  }
  function initShare(host) {
    if (!host) return false; const ws = awake(12).filter((w) => w !== host.el).slice(0, 5); if (!ws.length) return false;
    const all = take([host.el].concat(ws)), h = all[0]; A.items = all; A.label = i18n('petyard.chia_thuc_an'); h.w.style.left = h.x + 'px'; let eat = 0;
    A.step = (now, dt) => {
      let arrived = true;
      A.items.forEach((p, i) => { if (!i) return; const side = i % 2 ? 1 : -1, tx = h.x + side * (32 + Math.floor((i - 1) / 2) * 30); if (go(p, Math.max(0, Math.min(A.W - 48, tx)), 72 * A.K, dt, A.W)) face(p, -side); else arrived = false; });
      if (arrived && !eat) { eat = now; A.items.forEach((p) => { p.mood.textContent = '🍖'; p.w.classList.add('eating'); }); }
      if (eat && now - eat > 3500) { A.items.forEach((p) => joy(wOf(p))); hearts(wOf(A.items[1])); say(wOf(A.items[1]), i18n('petyard.cam_on_ban_da_chia')); return true; }
      return now - A.t0 > 14000;
    };
    return true;
  }

  // ---------- automatic play and chatter ----------
  function autoplay() {
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => {
      try {
        if (!M && !A && canPlay()) {
          const pets = [...walkers.values()].filter((w) => w.info.mode === 'ok'), pick = pets[Math.floor(Math.random() * pets.length)], c = Math.floor(Math.random() * 6);
          if (c === 0 || c === 1) startMatch(); else if (c === 2) startAct('tag'); else if (c === 3) startAct('fish'); else if (c === 4) startAct('dance');
          else if (pick) {
            const i = pick.info, line = i.hot ? i18n('petyard.cpu_dang_cao_em_hoi') : i.carry ? i18n('petyard.dia_sap_day_nho_don') : i18n('petyard.moi_thu_on_nhe_dung'); say(pick, line);
          }
        }
      } catch { /* decoration must never break input */ }
      autoplay();
    }, 11000 + Math.random() * 12000);
  }

  // ---------- weather in the hero banner ----------
  let wx = null, lastWeather = '';
  function weather(kind) {
    if (!hero) return; if (!wx) {
      wx = el('div', 'wx'); wx.setAttribute('aria-hidden', 'true');
      wx.append(el('i', 'wx-sun'), el('i', 'wx-cloud c1'), el('i', 'wx-cloud c2'), el('i', 'wx-cloud c3'));
      const rain = el('div', 'wx-rain'); for (let i = 0; i < 46; i++) { const d = el('i'); d.style.cssText = 'left:' + (Math.random() * 110 - 5) + '%;animation-delay:-' + Math.random().toFixed(2) + 's;opacity:' + (.4 + Math.random() * .6).toFixed(2); rain.append(d); }
      wx.append(rain, el('i', 'wx-flash')); const bolt = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); bolt.setAttribute('viewBox', '0 0 44 120'); bolt.setAttribute('class', 'wx-bolt');
      bolt.innerHTML = '<path d="M26 0 4 62h16L10 120 40 48H24z" fill="#fff6a8"/>'; wx.append(bolt); hero.prepend(wx);
    }
    if (kind !== lastWeather) { lastWeather = kind; hero.dataset.w = kind; }
  }

  // ---------- entry points ----------
  function sync(c) {
    try {
      ctx = Object.assign(ctx, c); weather(ctx.weather || 'sun'); render();
      // a finished job: confetti and a dance
      ctx.records.forEach((r, k) => {
        if (!r.outcomeAt || r.celebrated === r.outcomeAt) return; r.celebrated = r.outcomeAt;
        if (P.outcome(r.s) === 'finish' && Date.now() - r.outcomeAt < 8000) { confetti(); setTimeout(() => startAct('dance'), 300); }
      });
    } catch { /* decoration must never break input */ }
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) { stopMatch(true); stopAct(true); } else writeScore(); });
  new MutationObserver(() => { if (!canPlay()) { stopMatch(true); stopAct(true); } }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  setInterval(() => { try { if (ctx.records.size || walkers.size) render(); } catch { /* optional */ } }, 30000);
  autoplay(); build();
  window.PetYard = { sync };
})();
