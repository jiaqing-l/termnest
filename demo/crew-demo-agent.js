#!/usr/bin/env node
'use strict';
// Demo agents for the Crew prototype: they behave like a Claude orchestrator and Codex workers (plan -> OK -> dispatch ->
// work -> report) so the Crew UI can be tried without spending any tokens. Not used in production.
//   node crew-demo-agent.js orch   --crew NAME --dir DIR --workers N [--sock SOCKET]
//   node crew-demo-agent.js worker --crew NAME --n 1 --dir DIR [--sock SOCKET]
const fs = require('fs'), path = require('path'), cp = require('child_process'), readline = require('readline');
const [, , role, ...rest] = process.argv, arg = (k, d) => { const i = rest.indexOf('--' + k); return i >= 0 ? rest[i + 1] : d; };
const crew = arg('crew', 'crew'), dir = arg('dir', process.cwd()), sock = arg('sock', process.env.TW_TMUX_SOCKET || '');
const C = { d: '\x1b[90m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[34m', p: '\x1b[35m', r: '\x1b[0m', B: '\x1b[1m' };
const say = (s = '') => process.stdout.write(s + '\n');
const tmux = (...a) => cp.spawnSync('tmux', [...(sock ? ['-L', sock] : []), ...a], { encoding: 'utf8' });
const type = (session, text) => { tmux('send-keys', '-t', '=' + session + ':', '-l', text); tmux('send-keys', '-t', '=' + session + ':', 'Enter'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.stdout.write('\x1b[2J\x1b[3J\x1b[H'); // clear the typed launch command off the screen
const dataDir = path.join(dir, '.crew-demo', crew);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true, prompt: '' });
rl.on('SIGINT', () => { say(C.p + '^C' + C.r); });

if (role === 'worker') worker(); else orch();

function worker() {
  const n = arg('n', '1'), me = `${crew}-codex-${n}`;
  let hang = false, job = null;
  say(`${C.d}● Codex · ${me}${C.r}`); say(`${C.d}Rảnh. Điều phối sẽ giao việc khi cần.${C.r}`);
  const STEPS = ['đọc brief + grep file liên quan …', `${C.g}+${C.r} sửa public/app.js, public/app.css`, `${C.d}$ node --test${C.r}`, `${C.g}✔ pass 12/12${C.r}`, `${C.g}+${C.r} ghi out.md`];
  rl.on('line', async (line) => {
    const m = /^TASK (W\d+) (.*)$/.exec(line.trim());
    if (/^__hang__$/.test(line.trim())) { hang = true; return; }
    if (!m) return;
    if (job) { say(`${C.y}Đang bận ${job}, bỏ qua ${m[1]}${C.r}`); return; }
    job = m[1]; hang = false; say(''); say(`${C.B}Nhận packet ${m[1]}${C.r}: ${m[2]}`);
    for (const st of STEPS) {
      await sleep(1500 + Math.random() * 1500);
      while (hang) await sleep(1000); // simulated hang: no output, process still alive
      say(st);
    }
    say(`${C.g}STATUS: DONE ${m[1]}${C.r}`); job = null;
    type(crew, `DONE ${m[1]} ${me}`);
  });
}

function orch() {
  const W = Number(arg('workers', '2'));
  let workers = Array.from({ length: W }, (_, i) => ({ n: i + 1, busy: null })), tracks = [], phase = 'idle', task = '';
  fs.mkdirSync(dataDir, { recursive: true });
  const save = () => fs.writeFileSync(path.join(dataDir, 'tracks.json'), JSON.stringify({ task, phase, tracks, at: Date.now() }));
  say(`${C.d}● Claude · điều phối ${crew}${C.r}`); say(`Gõ task bên dưới; tôi lập plan, chờ bạn OK rồi giao cho thợ.`); save();
  const free = () => workers.find((w) => !w.busy);
  function dispatch() {
    for (const t of tracks) {
      if (t.state !== 'queued' || t.dep.some((d) => tracks.find((x) => x.id === d).state !== 'done')) continue;
      const w = free(); if (!w) { say(`${C.y}Không còn thợ rảnh cho ${t.id}. Thêm thợ để tiếp tục.${C.r}`); break; }
      w.busy = t.id; t.state = 'dispatched'; t.worker = `codex-${w.n}`;
      say(`${C.d}$ crew-panes send ${w.n} ${t.id}${C.r}`); type(`${crew}-codex-${w.n}`, `TASK ${t.id} ${t.title}`);
    }
    save();
  }
  function finish() {
    phase = 'done'; save();
    say(`${C.g}✔${C.r} Tất cả track xong. Báo cáo:`); say(`  ${C.B}Status${C.r}: ${tracks.length}/${tracks.length} track xong, test xanh`);
    say(`  ${C.B}Artifacts${C.r}: 3 file đã sửa, nhánh crew/${crew.toLowerCase()}`); say(`  ${C.B}Next${C.r}: gộp nhánh + mở MR? ${C.y}(chờ bạn)${C.r}`);
  }
  rl.on('line', async (raw) => {
    const line = raw.trim(); if (!line) return;
    const done = /^DONE (W\d+) (\S+)$/.exec(line);
    if (done) {
      const t = tracks.find((x) => x.id === done[1]); if (!t) return;
      t.state = 'done'; const w = workers.find((x) => `codex-${x.n}` === t.worker); if (w) w.busy = null;
      say(`${C.g}✔${C.r} ${done[2]} báo xong ${C.b}${t.id}${C.r}`); save();
      return tracks.every((x) => x.state === 'done') ? finish() : dispatch();
    }
    if (/^__workers__ \+1$/.test(line)) { workers.push({ n: workers.length + 1, busy: null }); say(`${C.d}+ thêm thợ codex-${workers.length}${C.r}`); if (phase === 'running') dispatch(); return; }
    if (phase === 'await_ok' && /^(ok|oke|đồng ý|duyệt|y|yes)\b/i.test(line)) {
      phase = 'running'; say(`${C.g}✔${C.r} Đã duyệt. Giao việc…`); return dispatch();
    }
    if (phase === 'await_ok' && /^(sửa|huỷ|hủy|no)\b/i.test(line)) { phase = 'idle'; tracks = []; save(); say(`${C.y}Plan bị hủy. Nhập lại yêu cầu.${C.r}`); return; }
    if (phase === 'running') { say(`${C.y}…${C.r} Đang chạy plan đã duyệt. Tôi ghi nhận ý bạn cho track kế tiếp.`); return; }
    task = line; phase = 'planning'; save(); say(`${C.y}… đang phân tích yêu cầu${C.r}`); await sleep(1200);
    const n = workers.length, par = n >= 4 ? 3 : n === 3 ? 2 : n === 2 ? 1 : 0, T = ['Mockup + giao diện', 'Logic / API phía server', 'Tài liệu + changelog'];
    tracks = []; for (let i = 0; i < par; i++) tracks.push({ id: 'W' + (i + 1), title: T[i], state: 'queued', dep: [] });
    tracks.push({ id: 'W' + (par + 1), title: 'Test + build + review', state: 'queued', dep: tracks.map((t) => t.id) });
    phase = 'await_ok'; save();
    say(`${C.g}✔${C.r} Plan cho “${task.slice(0, 48)}”:`);
    tracks.forEach((t) => say(`  ${C.b}${t.id}${C.r} ${t.title}${t.dep.length ? ` ${C.y}(chờ ${t.dep.join(', ')})${C.r}` : ''}`));
    say(`${C.y}Trả lời OK để giao việc.${C.r}`);
  });
}
