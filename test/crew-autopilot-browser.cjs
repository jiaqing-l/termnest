'use strict';
// Crew autopilot settings in actual Chrome against a synthetic server: switch, per-team exclusion, read-back failure,
// honest agent status (only what the board reports), Linux-only note, and layout at 1440/390.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), os = require('node:os'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const publicDir = path.join(__dirname, '../public');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'termnest-crew-autopilot-'));
const shots = process.env.SHOT_DIR || output;
const posts = [];
const now = Date.now(), iso = (ms) => new Date(now - ms).toISOString();
const team = (session, root, status, code, taskIds, extra = {}) => ({ id: 'team-' + session, session, root, status, reason: { code }, lastProgressAt: status === 'progressing' ? iso(240000) : null, taskIds, requiresOwner: false, recoveryPolicy: { eligible: false, code: 'recovery_disabled' }, ...extra });
const supervision = { enabled: false, autoRecovery: false, autoEnroll: false, intervalMinutes: 30, excluded: [], workspaces: [], leaders: [], auditReadiness: [], errors: [],
  servers: [
    { id: 'mac', name: 'Mac-THANHLG', online: true, observedAt: iso(5000), freshness: { snapshotFresh: true, taskEvidenceFresh: true, maxAgeMs: 60000 },
      coordination: [{ root: '/Users/admin/ws', code: 'coordination_platform_unavailable' }], audits: [],
      discovered: [{ session: 'Vifon-SV', root: '/Users/admin/ws', taskIds: ['20261105-sv-infer-restore-model'], excluded: false },
        { session: 'tn-plugin-update', root: '/Users/admin/ws', taskIds: ['20261108-termnest-24x7'], excluded: false }],
      teams: [team('Vifon-SV', '/Users/admin/ws', 'idle', 'session_idle', ['20261105-sv-infer-restore-model']),
        team('tn-plugin-update', '/Users/admin/ws', 'blocked', 'task_blocked', ['20261108-termnest-24x7']),
        team('', '/Users/admin/ws', 'unknown', 'owner_missing', ['20261101-tools-packaging'])] },
    { id: 'vm2', name: 'dev-ubuntu-02', online: true, observedAt: iso(8000), freshness: { snapshotFresh: true, taskEvidenceFresh: true, maxAgeMs: 60000 },
      coordination: [{ root: '/home/dev/ws', code: 'coordination_owner' }],
      audits: [{ runId: 'tn-1', createdAt: iso(720000), active: false, reason: { code: 'report_valid' }, requiresOwner: false }],
      discovered: [{ session: 'crew-sfa', root: '/home/dev/ws', taskIds: ['20261108-sfa-route-kpi'], excluded: false },
        { session: 'crew-dex', root: '/home/dev/ws', taskIds: ['20261108-dex-pod-sign'], excluded: false }],
      teams: [team('crew-sfa', '/home/dev/ws', 'progressing', 'task_evidence_changed', ['20261108-sfa-route-kpi'], { recovery: { at: iso(600000), code: 'recovery_progress', requiresOwner: false }, tasks: [{ id: '20261108-sfa-route-kpi', title: 'Route KPI cho SFA', status: 'dispatched', tracks: [{ id: 'W1', state: 'merged' }, { id: 'W2', state: 'dispatched' }, { id: 'W3', state: 'failed', fixRounds: 1 }, { id: 'W6', state: 'failed', fixRounds: 1, lastExit: '7' }, { id: 'W4', state: 'pending' }] }] }),
        team('crew-dex', '/home/dev/ws', 'waiting_owner', 'owner_decision', ['20261108-dex-pod-sign'])] }] };
const board = { servers: [
  { id: 'mac', name: 'Mac-THANHLG', online: true, findings: [], sessions: [{ name: 'Vifon-SV', ai: { tool: 'claude', status: 'idle', at: now - 900000 }, bgAgents: [] },
    { name: 'tn-plugin-update', ai: null, bgAgents: [] }, { name: 'PG-App', agent: true, ai: { tool: 'claude', status: 'idle', at: now - 60000 }, bgAgents: [] }] },
  { id: 'vm2', name: 'dev-ubuntu-02', online: true, findings: [], sessions: [{ name: 'crew-sfa', ai: { tool: 'claude', status: 'busy', at: now - 30000 }, bgAgents: [{ kind: 'codex', task: '20261108-sfa-route-kpi', track: 'W2', elapsed: 600 }] },
    { name: 'crew-dex', ai: { tool: 'codex', status: 'waiting', waitingFor: 'approval', at: now - 120000 }, bgAgents: [] }] }],
  log: [], pack: { name: 'core', custom: [], rules: {}, auto: { perHour: 2, quietFrom: '23:00', quietTo: '07:00' }, templates: {} } };
let postFailure = false; const binds = [];
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/features/ops.css"><style>body{overflow:auto}.view.on{display:block}.feature-page{padding-top:16px}.main-top{position:static}</style></head><body><div class="main-top"><div class="seg"><button>Tổng quan</button><button>Terminal</button><button>Token AI</button><button>Ghi chú</button></div></div><section id="v-token"></section><dialog id="dlg-fixture-settings"><div id="ops-settings-mount"></div><div id="plugins-settings-mount"></div></dialog><script src="/features-host.js"></script><script>
const locale=${fs.readFileSync(path.join(publicDir,'locales/vi.json'),'utf8')};
window.i18n=(key,args=[])=>String(locale[key]||key).replace(/\\{(\\d+)\\}/g,(_,n)=>args[n]);
window.__ticks=[];window.setInterval=(fn,ms)=>{__ticks.push({fn,ms});return __ticks.length};
window.__refresh=()=>__ticks.filter(x=>x.ms===10000).forEach(x=>x.fn());
TW.attach({api:async(method,url,body)=>{const r=await fetch(url,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});if(!r.ok)throw Error('fixture failure');return r.json()},setView:id=>TW.setView(id),say:()=>{},openSettings:()=>document.querySelector("#dlg-fixture-settings").showModal(),browseDir:(id,start,cb)=>cb("/work/edited"),openSession:(server,session)=>fetch('/opened',{method:'POST',body:JSON.stringify({server,session})})});
</script><script src="/features/crew.js"></script><script src="/features/ops.js"></script></body></html>`;
const server = http.createServer(async (req, res) => {
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); return res.end(html); }
  if (req.url.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/features/ops/supervision') {
      if (req.method === 'POST') {
        let b = ''; for await (const c of req) b += c; const body = JSON.parse(b); posts.push(body);
        if (postFailure) { res.statusCode = 503; return res.end('{}'); }
        Object.assign(supervision, body);
        for (const s of supervision.servers) for (const d of s.discovered) d.excluded = supervision.excluded.some(x => x.serverId === s.id && x.session === d.session);
      }
      return res.end(JSON.stringify(supervision));
    }
    if (req.url === '/api/features/ops/supervision/bind') { let b = ''; for await (const c of req) b += c; binds.push(JSON.parse(b)); return res.end(JSON.stringify({ code: 'bind_done' })); }
    if (req.url.startsWith('/api/features/crewpack/track?') && req.url.includes('live=1')) return res.end(JSON.stringify({ live: true, logName: 'codex-2.log', logAt: Date.now() - 4000,
      feed: [{ kind: 'say', at: Date.now() - 9000, text: 'Build dừng ở lỗi CS7036' }, { kind: 'patch', at: Date.now() - 7000, text: 'V2/Policy.cs', ok: true }, { kind: 'exec', at: Date.now() - 5000, text: 'dotnet test --filter Sv2', ok: null, code: null, ms: null }] }));
    if (req.url.startsWith('/api/features/crewpack/track?')) return res.end(JSON.stringify({ rounds: [{ round: '1', startedAt: '2026-11-09T11:43:06+07:00', endedAt: '2026-11-09T11:44:11+07:00', seconds: 65, exit: '7', tokens: 47240, kind: 'fix', executor: 'codex', model: 'gpt-6.1-sol', effort: 'high' }],
      files: { 'FAILED': { text: 'verify failed: dart analyze', at: Date.now() - 60000 }, 'last-message.md': { text: 'Committed W3 as abc123', at: Date.now() - 120000 } }, log: 'tail of codex log', logName: 'codex-1.log', dispatch: '', changes: { repo: 'hqsoft.esales.sfa', branch: 'crew/x-w3', commits: [{ sha: 'abc1234', at: '09/11 12:08', subject: 'feat: route KPI' }], stat: ' lib/a.dart | 10 +++\n 1 file changed' } }));
    if (req.url === '/api/features/ops/board') return res.end(JSON.stringify(board));
    return res.end(JSON.stringify(req.url.includes('plugins') ? { servers: [], autoReload: false } : {}));
  }
  const p = path.resolve(publicDir, '.' + req.url); if (!p.startsWith(publicDir + path.sep) || !fs.existsSync(p)) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', p.endsWith('.js') ? 'application/javascript' : 'text/css'); res.end(fs.readFileSync(p));
});
let chrome, ws, closeBrowser, chromeError = '';
(async () => {
 const executable = [process.env.CHROME_BIN,'/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean).find(p=>fs.existsSync(p));
 assert.ok(executable,'Chrome required: set CHROME_BIN to an actual Chrome executable');
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 chrome=spawn(executable,['--headless=new','--no-sandbox','--disable-dev-shm-usage','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+path.join(output,'profile'),'about:blank'],{stdio:['ignore','ignore','pipe']}); chrome.stderr.on('data', b => { chromeError = (chromeError + b).slice(-4000); });
 const delay=ms=>new Promise(r=>setTimeout(r,ms));
 const portFile=path.join(output,'profile/DevToolsActivePort');
 for(let i=0;i<150&&!fs.existsSync(portFile)&&chrome.exitCode===null;i++)await delay(100);
 assert.ok(fs.existsSync(portFile),'Chrome started within 15 seconds: '+chromeError);
 const port=fs.readFileSync(portFile,'utf8').split('\n')[0];
 const target=(await(await fetch('http://127.0.0.1:'+port+'/json')).json()).find(x=>x.type==='page');
 ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,reject)=>{ws.on('open',r);ws.on('error',reject)});
 let seq=0;const pending=new Map(),errors=[];
 ws.on('message',b=>{const m=JSON.parse(b);if(m.id){const p=pending.get(m.id);if(p){clearTimeout(p.timer);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);pending.delete(m.id)}}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text)});
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method))},10000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}))});
 closeBrowser=()=>send('Browser.close');
 const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});assert.ok(!r.exceptionDetails,JSON.stringify(r.exceptionDetails));return r.result.value};
 const until=async(expression,label)=>{for(let i=0;i<100;i++){if(await evaluate(expression))return;await delay(50)}assert.fail('Timed out: '+label)};
 const content=()=>evaluate('document.querySelector(".ops-super-status").textContent');
 const refresh=async()=>{const n=requests.filter(r=>r.url==='/api/features/ops/supervision').length;await evaluate('__refresh()');for(let i=0;i<100&&requests.filter(r=>r.url==='/api/features/ops/supervision').length===n;i++)await delay(20);await delay(60)};
 await send('Runtime.enable');await send('Page.enable');
 await send('Page.navigate',{url:'http://127.0.0.1:'+server.address().port});
 const txt = () => evaluate('document.querySelector(".ops-crew").textContent');
 await until('!!document.querySelector(".ops-crew [name=crewAutopilot]") && !document.querySelector(".ops-crew").textContent.includes("Đang đọc")', 'settings mounted');
 await evaluate('document.querySelector("#dlg-fixture-settings").showModal()');
 assert.equal(await evaluate('document.querySelector("[name=crewAutopilot]").checked'), false);
 assert.ok((await txt()).includes('Đang tắt'));
 assert.ok(!(await txt()).includes('Cần bạn ('), 'OFF lists nothing as needing the owner');
 // Turn on: one POST with auto enrolment, then read back.
 await evaluate('document.querySelector("[name=crewAutopilot]").click()');
 await until('document.querySelector("[name=crewAutopilot]").checked && document.querySelector(".ops-crew").textContent.includes("Đang bật")', 'switch read back ON');
 assert.deepEqual(posts.at(-1), { enabled: true, autoRecovery: true, autoEnroll: true, intervalMinutes: 30 });
 const on = await txt();
 assert.ok(on.includes('Cần bạn (2)'), 'blocked + waiting teams need the owner: ' + on);
 assert.ok(on.includes('Claude: Đang xử lý') && on.includes('1 worker đang chạy (W2)'), 'agent line from board data');
 assert.ok(on.includes('Codex: Đang chờ bạn') && on.includes('Leader chạy Codex'), 'codex leader shown as watch-only');
 assert.ok(on.includes('Agent: chưa có trạng thái'), 'missing agent status is not guessed');
 assert.ok(on.includes('Chỉ theo dõi (máy không hỗ trợ tự nhắc)'), 'macOS host is marked watch-only');
 assert.ok(on.includes('1 task đang mở chưa có leader') && on.includes('20261101-tools-packaging'), 'unowned task shown');
 // Bind a leader: pick a session, click, one POST with the exact scope.
 await evaluate(`(()=>{const r=[...document.querySelectorAll('.ops-crew .ops-crew-bind')].find(r=>r.textContent.includes('20261101-tools-packaging'));const s=r.querySelector('select');s.value=[...s.options].map(o=>o.value).find(Boolean);r.querySelector('button').click();return s.value})()`);
 await until('true', 'tick'); for (let i = 0; i < 50 && !binds.length; i++) await delay(50);
 assert.equal(binds.length, 1, 'one bind request'); assert.equal(binds[0].taskId, '20261101-tools-packaging'); assert.equal(binds[0].session, 'PG-App'); assert.ok(binds[0].serverId && binds[0].root, JSON.stringify(binds[0]));
 assert.ok(on.includes('ops-audit gần nhất'), 'last audit shown');
 if (process.env.SHOT_DIR) for (const width of [1440, 390]) {
  await send('Emulation.setDeviceMetricsOverride', { width, height: 1700, deviceScaleFactor: 1, mobile: width < 500 }); await delay(150);
  await evaluate('document.querySelector(".ops-crew").scrollIntoView({block:"start"})');
  assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'), 'no overflow at ' + width);
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }); fs.writeFileSync(path.join(shots, 'crew-autopilot-' + width + '.png'), Buffer.from(shot.data, 'base64'));
 }
 // Session side panel: a leader gets a Crew block with its task and workers; a plain session gets none.
 const side = await evaluate(`(()=>{const a=document.createElement('div'),b=document.createElement('div');document.body.append(a,b);
  TW.renderDetail(a,{v:{id:'vm2'},s:{name:'crew-sfa'}});TW.renderDetail(b,{v:{id:'mac'},s:{name:'PG-App'}});
  const ca=a.querySelector('.ops-crew-detail'),cb=b.querySelector('.ops-crew-detail');return [ca&&!ca.hidden?ca.textContent:'',cb&&!cb.hidden?'shown':'']})()`);
 assert.ok(side[0].includes('20261108-sfa-route-kpi') && side[0].includes('1 worker'), 'leader side panel: ' + side[0]);
 assert.ok(side[0].includes('Route KPI cho SFA') && side[0].includes('1/5 track xong') && side[0].includes('W2 đang chạy') && side[0].includes('W3 lỗi · fix 1') && side[0].includes('W6 chưa xác minh · fix 1'), 'track chips: ' + side[0]);
 assert.equal(side[1], '', 'no crew block for a non-leader session');
 // A running track's chip shows a live activity feed at the top of its popup.
 await evaluate(`(()=>{const a=document.createElement('div');document.body.append(a);TW.renderDetail(a,{v:{id:'vm2'},s:{name:'crew-sfa'}});[...a.querySelectorAll('.ops-crew-chip')].find(b=>b.textContent.startsWith('W2')).click();})()`);
 await until("!!document.querySelector('.ops-track-live:not([hidden])')", 'live feed');
 const feed = await evaluate("document.querySelector('.ops-track-live').textContent");
 assert.ok(feed.includes('dotnet test --filter Sv2') && feed.includes('⏳') && feed.includes('Build dừng ở lỗi CS7036') && feed.includes('V2/Policy.cs'), feed);
 await evaluate("document.querySelector('.ops-track-dlg').close()");
 // A track chip opens what that track ran: last round, newest failure file first, worker log tail.
 await evaluate(`(()=>{const a=document.createElement('div');document.body.append(a);TW.renderDetail(a,{v:{id:'vm2'},s:{name:'crew-sfa'}});[...a.querySelectorAll('.ops-crew-chip')].find(b=>b.textContent.startsWith('W3')).click();})()`);
 await until("!!document.querySelector('.ops-track-dlg') && document.querySelector('.ops-track-dlg').textContent.includes('Kết quả')", 'track popup');
 const pop = await evaluate("document.querySelector('.ops-track-dlg').textContent");
 assert.ok(pop.includes('Đã code — chờ xác minh') && pop.includes('Kết quả') && pop.includes('Committed W3 as abc123') && pop.includes('Việc tiếp theo') && pop.includes('1 commit'), pop);
 assert.ok(pop.includes('Đã code — chờ xác minh') || pop.includes('Lỗi'), pop);
 await evaluate("document.querySelector('.ops-track-dlg').close()");
 // Exclude one team.
 await evaluate('[...document.querySelectorAll(".ops-crew-team")].find(r=>r.textContent.includes("crew-dex")).querySelector("input").click()');
 await until('[...document.querySelectorAll(".ops-crew-team")].find(r=>r.textContent.includes("crew-dex")).textContent.includes("Không trông")', 'excluded read back');
 assert.deepEqual(posts.at(-1), { enabled: true, autoEnroll: true, excluded: [{ serverId: 'vm2', session: 'crew-dex' }] });
 assert.ok((await txt()).includes('Cần bạn (1)'), 'excluded team no longer needs the owner');
 // A failed save is reported, not shown as applied.
 postFailure = true;
 await evaluate('document.querySelector("[name=crewAutopilot]").click()');
 await until('document.querySelector(".ops-crew").textContent.includes("Chưa lưu được")', 'failure visible');
 assert.equal(await evaluate('document.querySelector("[name=crewAutopilot]").checked'), true, 'switch reflects the server, not the click');
 // Operations page: machine cards, Need-you and Crew teams sections (no severity filter bar).
 const page = await evaluate('(document.querySelector(".ops-page")||{}).textContent||""');
 assert.ok(page, "operations page mounted"); {
  assert.equal(await evaluate('document.querySelectorAll(".ops-page .ops-mc").length'), 2, 'one card per machine');
  assert.ok(page.includes('Team crew') && page.includes('Cần bạn'), 'crew and need-you sections');
  assert.equal(await evaluate('document.querySelectorAll(".ops-page .ops-seg").length'), 0, 'severity filter removed');
  if (process.env.SHOT_DIR) { await evaluate('document.querySelector("#dlg-fixture-settings").close();document.querySelector(".ops-page").closest(".view,section")?.classList.add("on");document.querySelector(".ops-page").scrollIntoView()'); await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 1400, deviceScaleFactor: 1, mobile: false }); await delay(200);
   const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }); fs.writeFileSync(path.join(shots, 'ops-page-1200.png'), Buffer.from(shot.data, 'base64')); }
 }
 assert.deepEqual(errors, [], 'no page errors');
 console.log('crew autopilot browser check passed');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
 try { if (closeBrowser) await closeBrowser(); } catch { /* closed */ }
 if (chrome && chrome.exitCode === null) chrome.kill();
 await new Promise(resolve => server.close(resolve));
});
