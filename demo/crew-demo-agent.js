#!/usr/bin/env node
'use strict';
// Demo agents for the Crew prototype: they behave like a Claude orchestrator and Codex workers (plan -> OK -> dispatch ->
// work -> report) so the Crew UI can be tried without spending any tokens. Not used in production.
//   node crew-demo-agent.js orch   --crew NAME --dir DIR [--sock SOCKET]
//   node crew-demo-agent.js worker --crew NAME --name NAME-W1 --kind codex|claude --dir DIR [--sock SOCKET]
// The orchestrator decides how many workers it needs and of which kind (its plan lists them); TermNest creates them.
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
  const me = arg('name', `${crew}-W1`), kind = arg('kind', 'codex'), label = kind === 'claude' ? 'Claude' : 'Codex';
  let hang = false, job = null;
  say(`${C.d}● ${label} · ${me}${C.r}`); say(`${C.d}Rảnh. Điều phối sẽ giao việc khi cần.${C.r}`);
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
  let tracks = [], phase = 'idle', task = '';
  fs.mkdirSync(dataDir, { recursive: true });
  const save = () => fs.writeFileSync(path.join(dataDir, 'tracks.json'), JSON.stringify({ task, phase, tracks, at: Date.now() }));
  say(`${C.d}● Claude · điều phối ${crew}${C.r}`); say(`Gõ task bên dưới; tôi lập plan, chờ bạn OK rồi giao cho thợ.`); save();
  let retry = null;
  const hasSession = (name) => tmux('has-session', '-t', '=' + name).status === 0;
  // A track starts when its dependencies are done and its worker (created by TermNest from the plan) is on the machine.
  function dispatch() {
    for (const t of tracks) {
      if (t.state !== 'queued' || t.dep.some((d) => tracks.find((x) => x.id === d).state !== 'done')) continue;
      const name = `${crew}-${t.id}`;
      if (!hasSession(name)) { if (!retry) retry = setTimeout(() => { retry = null; dispatch(); }, 1000); continue; }
      t.state = 'dispatched'; t.worker = t.id;
      say(`${C.d}$ crew-panes send ${t.id} (${t.agent})${C.r}`); setTimeout(() => type(name, `TASK ${t.id} ${t.title}`), 1500);
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
      t.state = 'done';
      say(`${C.g}✔${C.r} ${done[2]} báo xong ${C.b}${t.id}${C.r}`); save();
      return tracks.every((x) => x.state === 'done') ? finish() : dispatch();
    }
    // A nudge from the Crew bar is not a new task.
    if (/^Tiếp tục kế hoạch/i.test(line)) { say(`${C.d}Đã nhận nhắc: ${phase === 'running' ? 'đang chạy, sẽ báo tiến độ' : phase === 'await_ok' ? 'đang chờ bạn OK plan' : 'chưa có việc đang chạy'}.${C.r}`); return; }
    if (phase === 'await_ok' && /^(ok|oke|đồng ý|duyệt|y|yes)\b/i.test(line)) {
      phase = 'running'; say(`${C.g}✔${C.r} Đã duyệt. Tạo thợ theo plan rồi giao việc…`); save(); return dispatch();
    }
    if (phase === 'await_ok' && /^(sửa|huỷ|hủy|no)\b/i.test(line)) { phase = 'idle'; tracks = []; save(); say(`${C.y}Plan bị hủy. Nhập lại yêu cầu.${C.r}`); return; }
    if (phase === 'running') { say(`${C.y}…${C.r} Đang chạy plan đã duyệt. Tôi ghi nhận ý bạn cho track kế tiếp.`); return; }
    task = line; phase = 'planning'; save(); say(`${C.y}… đang phân tích yêu cầu${C.r}`); await sleep(1200);
    // "... 8 worker" / "6 thợ" in the task asks for that many workers (2-8); the last one is always the Claude reviewer.
    const asked = /(\d+)\s*(worker|thợ|tho)/i.exec(task), total = Math.max(2, Math.min(8, asked ? Number(asked[1]) : 3));
    const POOL = ['Mockup + giao diện', 'Logic / API phía server', 'Tài liệu + changelog', 'Migration + seed', 'Localization en/vi', 'Báo cáo + export', 'Phân quyền + màn hình'];
    tracks = Array.from({ length: total - 1 }, (_, i) => ({ id: 'W' + (i + 1), title: POOL[i % POOL.length], agent: i % 3 === 2 ? 'claude' : 'codex', state: 'queued', dep: [] }));
    tracks.push({ id: 'W' + total, title: 'Test + build + review', agent: 'claude', state: 'queued', dep: tracks.map((t) => t.id) });
    phase = 'await_ok'; save();
    say(`${C.g}✔${C.r} Plan cho “${task.slice(0, 48)}”:`);
    tracks.forEach((t) => say(`  ${C.b}${t.id}${C.r} ${t.title} ${C.d}[${t.agent}]${C.r}${t.dep.length ? ` ${C.y}(chờ ${t.dep.join(', ')})${C.r}` : ''}`));
    say(`${C.y}Trả lời OK để giao việc.${C.r}`);
  });
}
