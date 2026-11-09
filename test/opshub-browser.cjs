'use strict';
// Ops hub in actual Chrome: hero, search → progress card → track popup, rule report and AI report, questions, settings,
// no-AI (quota) mode, and layout at 1440 and 390 with no horizontal overflow. REAL_LOCAL=1 builds the fleet from this
// machine's own tmux sessions and _crew folders (read-only) instead of the synthetic fleet.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), os = require('node:os'), assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const WebSocket = require('ws');
const hub = require('../lib/features/opshub');
const publicDir = path.join(__dirname, '../public');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'termnest-opshub-'));
const shots = process.env.SHOT_DIR || output;
const now = Date.now();

async function fleetData() {
  if (process.env.REAL_LOCAL === '1') {
    const { POLL_SCRIPT, parsePoll } = require('../lib/parse'), { crewRuntime } = require('../lib/features/crewpack');
    const out = execFileSync('sh', ['-c', POLL_SCRIPT + ' 2>/dev/null'], { encoding: 'utf8', maxBuffer: 64e6, stdio: ['ignore', 'pipe', 'ignore'] });
    const snap = parsePoll(out, Math.floor(Date.now() / 1000));
    const crew = await crewRuntime()({ cwds: snap.sessions.map((s) => s.aiCwd || s.path).filter(Boolean), roots: [], days: 3 });
    const r = { cfg: { id: 'mac', name: os.hostname(), local: true }, ready: true, lastPoll: Date.now(), snapshot: { ...snap, hostname: os.hostname().replace(/\.local$/, '') } };
    return { remotes: [r], crewOf: () => crew.roots };
  }
  const iso = (ms) => now - ms;
  const crew = [{ root: '/Users/admin/ws', nudge: [['%6', '20261109-sv2-r7-robustness']], tasks: [{ id: '20261109-sv2-r7-robustness', title: 'SV2 R7 độ bền: chính sách theo phạm vi, biến thể, phủ thẻ/dòng mở, chất lượng ảnh', status: 'running', activeAt: iso(60000),
    tracks: [{ id: 'W0', state: 'failed', rounds: 1, fixRounds: 0, lastRound: { result: '7', kind: 'new' }, lastEnd: iso(3600000) }, { id: 'W1', state: 'running', rounds: 2, fixRounds: 1, lastRound: { result: '7', kind: 'fix' }, lastEnd: iso(600000) },
      { id: 'W2', state: 'queued', rounds: 1, lastRound: { result: '8', kind: 'new' }, lastEnd: iso(1200000) }, { id: 'W5', state: 'done', rounds: 1, lastRound: { result: '0' }, lastEnd: iso(5400000) }], heartbeat: { armed: true, alive: true } }] }];
  const st = (status, ago, o = {}) => ({ tool: 'claude', status, at: now - ago, waitingFor: '', cfg: '.claude-tech2', ...o });
  const sessions = [
    { name: 'Smart-Visibility-v2', created: 1, cmd: 'claude', paneIds: ['%6'], aiTool: 'claude', lines: [], aiStatus: st('busy', 60000) },
    { name: 'Display-Program', created: 2, cmd: 'claude', aiTool: 'claude', asking: true, lines: ['Bạn duyệt hướng [IntegrationService] hay chọn permission riêng?', '❯ 1. Yes'], aiStatus: st('waiting', 720000, { waitingFor: 'permission' }) },
    { name: 'PG-App', created: 3, cmd: 'claude', aiTool: 'claude', lines: [], aiStatus: st('idle', 7200000) },
    { name: 'termnest-new', created: 4, cmd: 'claude', aiTool: 'claude', lines: [], aiStatus: st('idle', 30000, { fresh: true }) },
    { name: 'tn-ops', created: 5, cmd: 'claude', aiTool: 'claude', lines: [], aiStatus: st('idle', 90000) }];
  const r1 = { cfg: { id: 'mac', name: 'MacBook-Air' }, ready: true, lastPoll: now, snapshot: { hostname: 'MacBook-Air', cpu: 78, ram: 61, sessions, workers: [{ kind: 'codex', task: '20261109-sv2-r7-robustness', track: 'W1', owner: { name: 'Smart-Visibility-v2' }, elapsed: 300 }] } };
  const r2 = { cfg: { id: 'vm2', name: 'dev-ubuntu-02' }, ready: true, lastPoll: now, snapshot: { hostname: 'dev-ubuntu-02', cpu: 20, ram: 40, sessions: [{ name: 'AAV-Xspire', created: 7, cmd: 'claude', aiTool: 'claude', lines: [], aiStatus: st('busy', 30000) }] } };
  return { remotes: [r1, r2], crewOf: (id) => id === 'mac' ? crew : [] };
}

const quota = process.env.NOAI === '1';
const asks = [];
async function state() {
  const { remotes, crewOf } = await fleetData(), fleet = hub.buildFleet(remotes, crewOf, Date.now()), findings = hub.ruleFindings(remotes, crewOf, fleet, Date.now());
  const counts = { BLOCKER: 0, WASTE: 0, DRIFT: 0, INFO: 0 }; findings.forEach((f) => counts[f.cat]++);
  const report = { id: 'r1', at: now - 300000, trigger: 'schedule', counts, findings, stats: { machines: fleet.machines.length, online: fleet.machines.length, sessions: fleet.sessions.length, tasks: fleet.tasks.length, waiting: fleet.waiting.length },
    ai: quota ? { status: 'failed', code: 'ops_quota' } : { status: 'done', at: now - 200000, model: 'sonnet', account: '.claude-tech2', summary: 'sv2-r7: 2/4 track đã code; W1 kẹt vì test gọi constructor cũ (CS7036). Display-Program chờ anh 12 phút.',
      findings: [{ cat: 'BLOCKER', session: 'Smart-Visibility-v2', machine: 'MacBook-Air', task: '20261109-sv2-r7-robustness', problem: 'W1 thoát 7 hai vòng', cause: 'Test gọi constructor cũ sau khi W0 đổi hợp đồng', next: 'fix-2 chỉ sửa test', owner: 'leader', evidence: 'Sv2KnowledgeCurationAppServiceTests.cs:561' }] } };
  return { fleet, findings, report, asks,
    ops: { cfg: { enabled: true, server: 'mac', root: '/Users/admin/ws', accounts: ['.claude-tech2', '.claude'], model: 'sonnet', perm: 'acceptEdits', interval: 30 }, phase: quota ? 'paused' : 'ready', code: quota ? 'ops_quota' : 'ops_ready',
      account: '.claude-tech2', session: 'tn-ops', lastReportAt: now - 300000, nextReportAt: now + 1500000, job: null },
    notify: { telegram: null, webhook: null, events: { owner_question: true, quota: true, blocker: true, ops_down: true, daily: true }, dailyHour: 18 } };
}
const tokens = { accounts: [{ tool: 'claude', email: 'hqsoft.technology@example.com', directory: '/Users/admin/.claude-tech2', limits: { session: { percent: 76, resetAt: Math.floor(now / 1000) + 3600 } } },
  { tool: 'claude', email: 'agent03@example.com', directory: '/Users/admin/.claude', limits: { weekly: { percent: 100, resetAt: Math.floor(now / 1000) + 86400 } } }] };
const posts = [];
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/features/ops.css"><link rel="stylesheet" href="/features/opshub.css"><style>body{overflow:auto}.view.on{display:block}.main-top{position:static}</style></head><body><div class="main-top"><div class="seg"><button>Tổng quan</button><button>Terminal</button></div></div><section id="v-token"></section><dialog id="dlg-fixture-settings"><div id="ops-settings-mount"></div><div id="plugins-settings-mount"></div></dialog><script src="/vendor/markdown-it.js"></script><script src="/features-host.js"></script><script>
const locale=${fs.readFileSync(path.join(publicDir, 'locales/vi.json'), 'utf8')};
window.i18n=(key,args=[])=>locale[key]===undefined?key:String(locale[key]).replace(/\\{(\\d+)\\}/g,(_,n)=>args[n]);
window.__popups=[];window.__opened=[];
TW.attach({api:async(method,url,body)=>{const r=await fetch(url,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const j=await r.json();if(!r.ok){const e=Error(j.error||'x');e.code=j.code;throw e}return j},setView:()=>{},openSettings:()=>{},openSession:(id,n)=>__opened.push(id+'/'+n),say:(t)=>{window.__said=t},servers:()=>[]});
TW.addView=((orig)=>function(def){const v=orig(def);if(v)v.section.classList.add('on');return v})(TW.addView);
</script><script src="/features/ops.js"></script><script>TW.opsTrackPopup=(...a)=>__popups.push(a)</script><script src="/features/opshub.js"></script></body></html>`;
const server = http.createServer(async (req, res) => {
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); return res.end(html); }
  if (req.url === '/vendor/markdown-it.js') { res.setHeader('Content-Type', 'text/javascript'); return fs.createReadStream(path.join(__dirname, '../node_modules/markdown-it/dist/markdown-it.min.js')).pipe(res); }
  if (!req.url.startsWith('/api/')) {
    const file = path.join(publicDir, decodeURIComponent(req.url.split('?')[0]));
    if (!file.startsWith(publicDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
    res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : 'text/javascript'); return fs.createReadStream(file).pipe(res);
  }
  res.setHeader('Content-Type', 'application/json');
  let body = ''; for await (const c of req) body += c;
  if (req.method === 'POST') posts.push({ url: req.url, body: body ? JSON.parse(body) : null });
  if (req.url === '/api/features/opshub/state') return res.end(JSON.stringify(await state()));
  if (req.url === '/api/features/opshub/reports') { const s = await state(); return res.end(JSON.stringify({ reports: [s.report, { ...s.report, id: 'r0', at: now - 2100000, ai: null }] })); }
  if (req.url === '/api/features/opshub/config') return res.end(JSON.stringify({ cfg: (await state()).ops.cfg, notify: (await state()).notify, choices: [{ id: 'mac', name: 'MacBook-Air', online: true, roots: ['/Users/admin/ws'], accounts: ['.claude', '.claude-tech2'] }] }));
  if (req.url === '/api/features/opshub/ask') { const q = JSON.parse(body).q; asks.unshift({ id: 'a' + asks.length, q, at: Date.now(), state: 'done', answer: '**W1** thiếu tham số `policies` — xem `x.cs:561`.', doneAt: Date.now() }); return res.end(JSON.stringify({ ask: asks[0] })); }
  if (req.url.startsWith('/api/features/opshub/')) return res.end('{}');
  if (req.url.startsWith('/api/tokens')) return res.end(JSON.stringify(tokens));
  if (req.url === '/api/features/ops/board') return res.end(JSON.stringify({ servers: [], log: [], pack: { name: 'core', custom: [], rules: {}, auto: { perHour: 2 }, templates: {} } }));
  if (req.url === '/api/features/ops/supervision') return res.end(JSON.stringify({ enabled: false, servers: [], errors: [], workspaces: [], leaders: [], excluded: [], auditReadiness: [] }));
  if (req.url === '/api/features/plugins/data') return res.end(JSON.stringify({ servers: [] }));
  res.statusCode = 404; res.end('{}');
});
let chrome, ws;
(async () => {
  const executable = [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean).find((p) => fs.existsSync(p));
  assert.ok(executable, 'Chrome required: set CHROME_BIN');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  chrome = spawn(executable, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--remote-debugging-port=0', '--user-data-dir=' + path.join(output, 'profile'), 'about:blank'], { stdio: 'ignore' });
  const delay = (ms) => new Promise((r) => setTimeout(r, ms)), portFile = path.join(output, 'profile/DevToolsActivePort');
  for (let i = 0; i < 150 && !fs.existsSync(portFile); i++) await delay(100);
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  const target = (await (await fetch('http://127.0.0.1:' + port + '/json')).json()).find((x) => x.type === 'page');
  ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  let seq = 0; const pending = new Map(), errors = [];
  ws.on('message', (b) => { const m = JSON.parse(b); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result); pending.delete(m.id); } else if (m.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 400)); });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); assert.ok(!r.exceptionDetails, JSON.stringify(r.exceptionDetails)); return r.result.value; };
  const until = async (expression, label) => { for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await delay(50); } assert.fail('Timed out: ' + label); };
  const shot = async (name, width, height = 1400) => {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 500 }); await delay(250);
    const overflow = await evaluate('document.documentElement.scrollWidth - innerWidth');
    assert.ok(overflow <= 1, name + ': horizontal overflow ' + overflow + 'px');
    const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }); fs.writeFileSync(path.join(shots, 'opshub-' + name + '-' + width + '.png'), Buffer.from(s.data, 'base64'));
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port });
  await until('!!document.querySelector(".hub-title") && document.querySelector(".hub-title").textContent.length > 5 && !/Đang tải/.test(document.querySelector(".hub-title").textContent)', 'hero');
  const real = process.env.REAL_LOCAL === '1';
  if (!real) {
    assert.match(await evaluate('document.querySelector(".hub-title").textContent'), /1 team đang chạy · 1 việc cần anh/);
    assert.match(await evaluate('document.querySelector(".hub-rail").textContent'), /Display-Program[\s\S]*IntegrationService/);
    // A fresh session is shown as just opened, never as finished.
    assert.match(await evaluate('document.querySelector(".hub-panel-b").textContent'), /termnest-new[\s\S]*Vừa mở/);
    await shot('progress', 1440);
    // Search a track id → the team card with that track focused; the chip opens the track popup.
    await evaluate('(()=>{const i=document.querySelector(".hub-ask input");i.value="W1";i.dispatchEvent(new Event("input"));})()');
    await until('document.querySelector(".hub-sugg:not([hidden]) button")', 'suggestions');
    await evaluate('document.querySelector(".hub-sugg button").click()');
    await until('document.querySelector(".hub-trk.focus")', 'focused track');
    const card = await evaluate('document.querySelector(".hub-task").textContent');
    assert.match(card, /Smart-Visibility-v2/); assert.match(card, /W0chờ xác minh/); assert.match(card, /W1đang chạy/); assert.match(card, /W2xếp hàng/); assert.match(card, /1\/4 xong/);
    await evaluate('document.querySelector(".hub-trk.focus").click()');
    assert.deepEqual(await evaluate('__popups.map(p=>[p[0],p[1],p[2].id,p[3].id,p[4]])'), [['mac', '/Users/admin/ws', '20261109-sv2-r7-robustness', 'W1', true]]);
    // Report: AI summary first, rule findings folded below.
    await evaluate('[...document.querySelectorAll(".hub-tabs button")][1].click()');
    await until('document.querySelector(".hub-aisum")', 'AI report');
    assert.match(await evaluate('document.querySelector(".hub-panel-b").textContent'), /CS7036[\s\S]*Phát hiện theo luật/);
    await shot('report', 1440);
    // Ask: the answer is rendered as Markdown.
    await evaluate('[...document.querySelectorAll(".hub-tabs button")][2].click()');
    await until('document.querySelector(".hub-composer input")', 'composer');
    await evaluate('(()=>{const i=document.querySelector(".hub-composer input");i.value="Vì sao W1 chưa xanh?";document.querySelector(".hub-composer").requestSubmit();})()');
    await until('document.querySelector(".hub-md code")', 'answer');
    await shot('deep', 1440, 900);
    // Settings: form with the machine and account priority.
    await evaluate('[...document.querySelectorAll(".hub-tabs button")][3].click()');
    await until('document.querySelector(".hub-set select")', 'settings');
    assert.match(await evaluate('document.querySelector(".hub-panel-b").textContent'), /Tài khoản Claude \(thứ tự ưu tiên\)[\s\S]*\.claude-tech2/);
    await shot('settings', 1440);
    await evaluate('[...document.querySelectorAll(".hub-tabs button")][0].click()');
    await evaluate('document.querySelector(".hub-chip").click()');
  }
  await shot(real ? 'real' : 'progress-narrow', real ? 1440 : 390, real ? 1800 : 2200);
  if (real) { await shot('real-narrow', 390, 2400); console.log('REAL fleet: ' + await evaluate('document.querySelector(".hub-title").textContent')); }
  assert.deepEqual(errors, [], 'no page exceptions');
  console.log('ok — screenshots in ' + shots);
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => { try { ws && ws.close(); } catch { /* closed */ } if (chrome) chrome.kill(); server.close(); });
