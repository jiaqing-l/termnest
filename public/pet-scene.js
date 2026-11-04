'use strict';
// Decoration is isolated from terminal and data plumbing. Callers also guard this API.
(function () {
  const P = window.PetState, L = P.LIMITS;
  const $ = (id) => document.getElementById(id);
  const media = window.matchMedia('(prefers-reduced-motion: reduce)');
  let enabled = true, servers = [], connected = true, overview = true, open = () => {}, choices = {};
  let nextPlay = Date.now() + L.idleMin + Math.random() * (L.idleMax - L.idleMin), playUntil = 0, play = 'sleep', players = [], clock = Date.now();
  const records = new Map(), events = new Map();
  let matchTime = 0, frameTime = 0, scores = [0, 0];
  const matchLength = L.match;
  const field = element('div', 'soccer-field');
  field.append(element('span', 'goal left'), element('span', 'goal right'));
  const ball = element('span', 'yard-ball', '⚽'), pond = element('span', 'yard-pond', '🌊');
  field.append(ball); $('pet-yard').append(field, pond);
  const score = element('span', 'yard-score', '⚽ 0 – 0 · trò chơi thú cưng');
  document.querySelector('.playground > b').append(score);
  try { enabled = localStorage.getItem('tw-pets') !== 'off'; } catch { /* optional storage */ }
  function element(tag, cls, text) {
    const n = document.createElement(tag); n.className = cls || '';
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function kind(name) {
    let hash = 0; for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    return /claude/i.test(name) ? 'cat' : window.PetArt.ORDER[hash % window.PetArt.ORDER.length];
  }
  function key(v, s) { return v.id + '/' + s.name + '/' + s.created; }
  function allowed() { return P.motion(enabled, media.matches, document.hidden); }
  function settings() {
    document.documentElement.classList.toggle('pets-off', !enabled);
    document.documentElement.classList.toggle('pets-still', !allowed());
    $('pets-enabled').checked = enabled;
  }
  function event(id, name, type) {
    const v = servers.find((v) => v.id === id), s = v?.sessions.find((s) => s.name === name);
    if (s) { if (type) events.set(key(v, s), { type, until: Date.now() + L.effect }); else events.delete(key(v, s)); }
  }
  function sync(data, on, over, callback, limits, pets) {
    choices = pets || {}; clock = Date.now(); servers = data; connected = on; overview = over; open = callback;
    const seen = new Set();
    servers.forEach((v) => (v.houseSessions || v.sessions).forEach((s) => {
      const k = key(v, s); seen.add(k);
      const prior = records.get(k);
      if (!prior) records.set(k, { v, s, since: s.stateSince || clock, outcomeAt: P.outcome(s) ? clock : 0, hatch: s.created > 0 && Date.now() / 1000 - s.created < L.effect / 1000 });
      else { if (P.outcome(s) && P.outcome(s) !== P.outcome(prior.s)) prior.outcomeAt = clock; if (prior.s.state !== s.state) prior.since = s.stateSince || clock; prior.v = v; prior.s = s; }
    }));
    records.forEach((r, k) => {
      if (!seen.has(k)) {
        const v = servers.find((v) => v.id === r.v.id);
        // Only an explicit stop request followed by an online absence gets a suitcase.
        if (!v) { records.delete(k); events.delete(k); return; }
        const e = events.get(k);
        if (v?.on && e?.type === 'stop') { e.type = 'leave'; e.until = clock + L.effect; }
        else if (e?.type !== 'leave' || e.until <= clock) { records.delete(k); events.delete(k); }
      }
    });
    const selected = servers.filter((v) => v.on);
    const scene = document.querySelector('.scene');
    scene.classList.toggle('wire-broken', !connected || servers.some((v) => !v.on));
    const house = document.querySelector('.house');
    ['cpu', 'ram', 'disk'].forEach((k) => house.classList.toggle('high-' + k, selected.some((v) => v[k] != null && v[k] >= limits[k])));
    const problems = selected.reduce((n, v) => n + ['cpu', 'ram', 'disk'].filter((k) => v[k] != null && v[k] >= limits[k]).length + (v.sys?.failed?.length || 0), servers.filter((v) => !v.on).length);
    const weather = $('pet-weather');
    if (weather) weather.textContent = problems >= L.problemsThunder ? '⛈️ Nhiều cảnh báo' : problems ? '🌧️ Tải cao' : '☀️ Nhẹ nhàng';
    draw();
  }
  function draw() {
    settings();
    if (!enabled || document.hidden) return;
    const yard = $('pet-yard'), existing = new Map([...yard.querySelectorAll('.yard-pet')].map((n) => [n.dataset.key, n]));
    const all=new Map(records), idle=[...records.values()].filter(r=>r.v.on&&(r.s.state==='idle'||r.s.state==='wait')).length;
    if(idle<2)for(let i=0;i<3;i++)all.set('house/'+i,{house:true,v:{id:'house',on:true},s:{name:['Mèo nhà','Cáo nhà','Thỏ nhà'][i],state:'idle',created:0}});
    const night=new Date(clock).getHours()>=23 || new Date(clock).getHours()<6;
    all.forEach((r, k) => {
      const s = r.s, e = events.get(k), choice = choices[r.v.id + '/' + s.name] || {};
      let action = e && e.until > clock && e.type !== 'stop' ? e.type : '';
      if (!action && r.hatch && clock - r.since < L.effect) action = 'hatch';
      if (!action && clock - r.outcomeAt < L.effect) action = P.outcome(s);
      if (!action && (s.state === 'idle' || (s.state === 'wait' && players.includes(k) && play === 'soccer' && clock < playUntil))) action = players.includes(k) && clock < playUntil ? play : (clock < playUntil && play === 'soccer' ? 'fish' : 'sleep');
      if(r.house && !players.includes(k))action=clock<playUntil?'fish':'walk';
      if(s.state==='idle' && night)action='sleep';
      if (!action) action = P.phase(s.state, r.since, clock);
      const prop = { box: '📦', test: '🔎', hat: '⛑️', laptop: '💻' }[s.petActivity] || '';
      const label = { jump: 'Chờ bạn!', knock: 'Chờ bạn! Cốc cốc…', chin: 'Chờ bạn! Nghỉ cằm…',
        wave: 'Tạm biệt! 👋', leave: 'Đã dừng · 🧳', hatch: '🥚 Chào đời!', finish: '🏆 Đã kết thúc · exit 0',
        failure: '💨 Thất bại · mở phiên', soccer: '', fish: '🎣', sleep: '💤' }[action] || prop;
      let node = existing.get(k);
      if (!node) {
        node = element('button', 'yard-pet'); node.type = 'button'; node.dataset.key = k;
        node.append(element('span', 'pet-body'), element('span', 'pet-label'), element('span', 'pet-name'));
        yard.append(node);
      }
      existing.delete(k);
      const offline = !connected || !r.v.on;
      node.className = 'yard-pet act-' + action + (offline ? ' house-wave' : '') + (prop ? ' prop-' + s.petActivity : '');
      const art = s.state + '/' + action + '/' + prop + '/' + offline + '/' + choice.kind + '/' + choice.hat;
      if (node.dataset.art !== art) {
        node.dataset.art = art;
        node.firstChild.innerHTML = window.PetArt.pet((window.PetArt.PETS ? window.PetArt.PETS[choice.kind] : window.PetArt.ORDER.includes(choice.kind)) ? choice.kind : kind(s.name), ['soccer', 'fish', 'walk'].includes(action) ? 'run' : s.state);
        node.firstChild.append(element('span', 'pet-prop', action === 'hatch' ? '🥚' : prop));
        if (choice.hat) node.firstChild.append(element('span', 'seasonal-hat', { flower: '🌸', summer: '👒', pumpkin: '🎃', winter: '🎅' }[choice.hat] || ''));
        if (action === 'finish') node.firstChild.append(element('span', 'confetti', '✦ · ✧ · ✦'));
        if (offline) node.firstChild.append(element('span', 'wave-hand', '👋'));
      }
      node.children[1].textContent = label;
      node.children[2].textContent = (choice.name || s.name) + ' ' + P.badge(s.created, Date.now() / 1000);
      // The yard shows idle pets, plus a waiting pet only while it is playing in the match.
      node.hidden = s.state !== 'idle' && !['wave', 'leave', 'hatch', 'soccer'].includes(action);
      node.dataset.player = action === 'soccer' ? players.indexOf(k) : '';
      node.title = offline ? 'Mất kết nối · trạng thái cuối đã nhận' : (r.house?'Thú nhà · '+s.name:s.name);
      node.onclick = () => { if (!r.house && r.v.on && action !== 'leave') open(r.v.id, s.name); };
    });
    existing.forEach((n) => n.remove());
    if (document.querySelectorAll) document.querySelectorAll('.pet-slot').forEach((slot) => {
      const source = [...yard.children].find((n) => n.dataset.key === slot.dataset.key);
      if (!source) return;
      slot.className = 'pet-slot ' + source.className.replace('yard-pet', '');
      slot.title = source.children[2].textContent;
      const body = source.firstChild.cloneNode(true), label = source.children[1].cloneNode(true);
      body.style.transform = '';
      // Props already live on the pet: never repeat them as a second label.
      if (['📦', '🔎', '⛑️', '💻', '💤', '🎣'].includes(label.textContent)) label.textContent = '';
      slot.replaceChildren(body, label);
      const r = records.get(slot.dataset.key), badge = r && P.badge(r.s.created, Date.now() / 1000);
      if (badge) slot.append(element('span', 'pet-badge', badge));
    });
  }
  function tick() {
    settings();
    clock = Date.now();
    if (!allowed() || !overview) { nextPlay = clock + L.idleMin; draw(); return; }
    const hour=new Date(clock).getHours();
    if(hour>=23 || hour<6){playUntil=0;draw();return;}
    if (clock >= nextPlay) {
      // Sessions waiting for the user have nothing to do either: they join the match (and wait pets are preferred as players).
      const waiting = [...records].filter(([, r]) => r.v.on && r.s.state === 'wait').map(([k]) => k);
      const idle = [...waiting, ...[...records].filter(([, r]) => r.v.on && r.s.state === 'idle').map(([k]) => k)];
      if(idle.length<2)idle.push('house/0','house/1','house/2');
      play = waiting.length >= 2 ? 'soccer' : ['soccer','fish','walk'][Math.floor(Math.random()*3)];
      matchTime = 0;
      players = play === 'soccer' ? idle.slice(0, 2) : idle;
      playUntil = clock + L.effect;
      nextPlay = clock + L.idleMin + Math.random() * (L.idleMax - L.idleMin);
    }
    draw();
  }
  function animate(now) {
    const dt = frameTime ? Math.min(now - frameTime, 50) : 0; frameTime = now;
    const active = allowed() && overview && clock < playUntil && play === 'soccer';
    const pets = [...$('pet-yard').querySelectorAll('.yard-pet.act-soccer')];
    field.hidden = !active || pets.length !== 2;
    if (!field.hidden) {
      matchTime += dt;
      if (matchTime >= matchLength) { scores[(scores[0] + scores[1]) % 2]++; matchTime %= matchLength; score.textContent = '⚽ ' + scores.join(' – ') + ' · trò chơi thú cưng'; }
      const t = matchTime / matchLength, width = field.clientWidth;
      // Approach, kick, return pass, then a shot crossing the right goal.
      const stops = [[0,.18],[.2,.34],[.45,.68],[.6,.56],[.8,.92],[1,1]];
      let i = stops.findIndex((p) => p[0] >= t); i = Math.max(1, i);
      const a = stops[i-1], b = stops[i], u = (t-a[0])/(b[0]-a[0]);
      const direction = (scores[0] + scores[1]) % 2;
      const progress = a[1]+(b[1]-a[1])*u, x = direction ? 1-progress : progress;
      ball.style.left = (x * (width-18)) + 'px';
      ball.style.bottom = (14 + Math.sin(u*Math.PI) * (i === 1 ? 0 : 34)) + 'px';
      pets.forEach((p, index) => {
        const chase = index === direction ? Math.max(0, x-.07) : Math.min(.92, x+.12);
        p.style.left = Math.max(0, chase*(width-52)) + 'px';
        p.style.bottom = (12 + Math.abs(Math.sin(now/85))*4) + 'px';
        p.firstChild.style.transform = 'rotate(' + (u > .85 ? (index ? 18 : -18) : 0) + 'deg)';
      });
    } else {
      $('pet-yard').querySelectorAll('.yard-pet').forEach((p) => { p.style.left = ''; p.style.bottom = ''; p.firstChild.style.transform = ''; });
    }
  }
  function frame(now) { try { animate(now); } catch { /* optional decoration */ } requestAnimationFrame(frame); }
  requestAnimationFrame(frame);
  $('pets-enabled').onchange = function () {
    enabled = this.checked;
    try { localStorage.setItem('tw-pets', enabled ? 'on' : 'off'); } catch { /* optional */ }
    settings(); draw();
  };
  media.addEventListener('change', settings);
  document.addEventListener('visibilitychange', () => { nextPlay = Date.now() + L.idleMin; settings(); });
  setInterval(() => { try { tick(); } catch { /* decoration must never break input */ } }, 1000);
  settings();
  window.PetScene = { sync, event };
})();
