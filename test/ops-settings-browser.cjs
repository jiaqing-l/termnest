'use strict';
// Actual index.html, app.js, native Settings dialogs and feature loader; all IO is synthetic.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), os = require('node:os'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const publicDir = path.join(__dirname, '../public');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'termnest-ops-settings-'));
const requests = [], posts = [], controls = [], nudges = [], accountChecks = [], downloads = [], rulePosts = [], tokenAccounts = [];
const pluginPosts = [];
let pluginFailure = false, pluginSlow = false, pluginDiscover = false, pluginNoDiscovery = false, pluginStateFailure = false;
let pluginFreshReads = 0, pluginDiscoveryReads = 0;
const plugins = { autoReload:false, servers:[{id:"vm1",name:"Build machine",scanned:Date.now(),accounts:[{cfg:".claude-work",plugins:[{id:"xspire@market",version:"2.4.1",running:"2.3.0",scope:"user",enabled:true,changedAt:Date.now()},{id:"folder-skill@local",version:"1.2.0",running:"1.1.0",scope:"project",folder:"/work/skills",usedBySessions:true,changedAt:Date.now()}]}],stale:[{session:"dormant",status:"idle",changedAt:Date.now()},{session:"busy",status:"busy",queued:true,changedAt:Date.now()}]}],log:[] };
const now = Date.now(), accountRef = 'a'.repeat(64);
const identity = { bootId: 'fixture-boot', sessionId: '$1', created: 1, pane: '%1', agentPid: 123, agentStartedAt: 1, config: '.claude-audit' };
const supervision = { enabled: false, autoRecovery: false, intervalMinutes: 30,
 workspaces: [{ serverId: 'vm1', root: '/work/one', auditConfig: '.claude-audit', auditAccount: 'b'.repeat(64), futureOptional: 'preserve' }, { serverId: 'vm2', root: '/work/two', auditConfig: '.claude-other', auditAccount: 'c'.repeat(64) }],
 leaders: [], registrationCandidates: [{ serverId: 'vm1', session: 'dormant', root: '/work/one', identity }],
 runtime: { registrationReady: false }, servers: [
  { id: 'vm1', name: 'Build machine', online: true, observedAt: now, freshness: { snapshotFresh: true, taskEvidenceFresh: true, maxAgeMs: 120000 }, teams: [{ id: 'scope1', root: '/work/one', session: '', status: 'unknown', requiresOwner: true, reason: { code: 'registration_required' }, taskIds: ['task-one', 'task-two'] }] },
  { id: 'vm2', name: 'Other machine', online: false, observedAt: now - 600000, teams: [] }
 ] };
const pack = require('../lib/ops').withTemplates(require('../lib/ops').cleanPack({}), {});
const board = { servers: [
 { id: 'vm1', name: 'Build machine', online: true, sessions: [
  { name: 'dormant', agent: true, ai: { status: 'idle', at: now - 3600000 } },
  { name: 'asking', agent: true, ai: { status: 'waiting', at: now - 10000 } },
  { name: 'busy', agent: true, ai: { status: 'busy', at: now - 10000 } },
  { name: 'unknown', agent: true, ai: null },
  { name: 'parked', agent: true, ai: { status: 'idle', parked: true, at: now - 3600000 } },
  { name: 'ordinary', agent: true, ai: { status: 'idle', at: now - 10000 } }
 ], findings: [
  { key: 'dormant', session: 'dormant', rule: 'dormant', severity: 'warn', level: 'suggest', template: 'continue', params: [60], since: 3600, source: 'status' },
  { key: 'asking', session: 'asking', rule: 'asking', severity: 'urgent', params: [], since: 10, source: 'status' },
  { key: 'ordinary', session: 'ordinary', rule: 'finished', severity: 'info', params: [], since: 10, source: 'status' },
  { key: 'parked', session: 'parked', rule: 'dormant', severity: 'warn', level: 'notify', params: [60], since: 3600, source: 'status' }
 ] },
 { id: 'vm2', name: 'Other machine', online: false, sessions: [{ name: 'stale', agent: true, ai: { status: 'idle', at: now - 3600000 } }], findings: [{ key: 'offline', rule: 'offline', session: '', severity: 'warn', params: [], since: 60, source: 'machine' }] }
 ], log: [], pack, dismissed: 0, dismissedKeys: [] };
const backup = { enabled: true, storage: { host: 'fixture-store', path: '/encrypted/fixture-store/server-backups' }, servers: [
 { id: 'vm1', name: 'Build machine', online: true, configured: true, roots: ['/work/one'], includeChats: true, phase: 'current', hasSnapshot: true, lastSuccessAt: now - 60000, lastAttemptAt: now - 60000 },
 { id: 'vm2', name: 'Other machine', online: false, configured: true, roots: ['/work/two'], includeChats: true, phase: 'offline', hasSnapshot: true, lastSuccessAt: now - 86400000, lastAttemptAt: now - 86400000 },
 { id: 'removed', name: 'Removed source', online: false, configured: false, roots: [], includeChats: true, phase: 'offline', hasSnapshot: true, lastSuccessAt: now - 86400000, lastAttemptAt: now - 86400000 },
 { id: 'first', name: 'First connection', online: false, configured: true, roots: [], includeChats: true, phase: 'never', hasSnapshot: false }
 ] };
// Real sessions and discovered workers coexist; presentation must never promote workers to sessions.
const appSessions = ['dormant', 'asking', 'busy', 'ordinary'].map((name, i) => ({
 name, created: i + 1, state: name === 'asking' ? 'wait' : name === 'busy' ? 'run' : 'idle',
 cmd: 'claude', path: '/work/one', lines: ['Normal session ' + name], activityAge: 10, attached: false
}));
const appWorkers = [
 { task: 'internal-live-task', track: 'W1', kind: 'codex', elapsed: 120, lines: ['private live worker log'] },
 { task: 'internal-finished-task', track: 'W3', kind: 'codex', elapsed: 60, finishedAt: now - 1000, result: 'DONE', lines: ['private finished worker log'] },
 { task: 'internal-owned-task', track: 'W4', kind: 'codex', elapsed: 30, owner: { name: 'dormant', created: 1 }, lines: ['private owned worker log'] }
];
const appState = { servers: [
 { id: 'vm1', name: 'Build machine', host: 'fixture-online', user: 'fixture', on: true, hasTmux: true, sessions: appSessions, workers: appWorkers, lost: [] },
 { id: 'vm2', name: 'Other machine', host: 'fixture-offline', user: 'fixture', on: false, hasTmux: true, sessions: [], workers: appWorkers.slice(0, 2), lost: [], error: 'Offline fixture' }
] };
let failBoard = false, failSupervision = false, failPost = false, mismatch = false, slow = false, nudgeMode = 'delivered', failRuleRead = false, folder = '/work/new';
let releaseNudge;
const originalSupervision = structuredClone(supervision), originalBackup = structuredClone(backup);
const prefs = { limits: { cpu: 95, ram: 90, disk: 90 }, templates: [], commands: [], recentDirs: [], backupMinutes: 60, petsEnabled: false };
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8').replace('<head>', `<head><script>
window.__ticks=[];window.setInterval=(fn,ms)=>{__ticks.push({fn,ms});return __ticks.length};window.clearInterval=()=>{};
window.__refresh=()=>__ticks.filter(t=>t.ms===10000||t.ms===2500).forEach(t=>t.fn());
</script>`);
const server = http.createServer(async (req, res) => {
 try {
 const u = new URL(req.url, 'http://fixture');
 const send = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
 if (u.pathname === '/') { res.setHeader('Content-Type', 'text/html'); return res.end(html); }
 if (u.pathname === '/locales.js') { res.setHeader('Content-Type', 'application/javascript'); return res.end('window.TW_LOCALES='+JSON.stringify({ vi: require('../public/locales/vi.json'), en: require('../public/locales/en.json') })+';'); }
 if (u.pathname.startsWith('/api/')) {
  requests.push({ method: req.method, url: req.url });
  let body; if (req.method === 'POST') { let b=''; for await (const c of req) b+=c; body=b?JSON.parse(b):{}; }
  if (u.pathname === '/api/status') return send({ authed: true, packaged: false });
  if (u.pathname === '/api/prefs') return send(prefs);
  if (u.pathname === '/api/state') {
   if(pluginStateFailure){res.statusCode=503;return send({error:'Plugin state discovery unavailable'});}
   if(pluginDiscover){
    pluginFreshReads++;pluginDiscoveryReads++;await new Promise(r=>setTimeout(r,180));
    if(!pluginNoDiscovery && pluginDiscoveryReads>=2){appSessions.push({ ...appSessions[0],name:'tn-plugin-update' });pluginDiscover=false;}
   }
   return send(appState);
  }
  if (u.pathname === '/api/features') return send({ modules: [{ name: 'server-backup', css: true }, { name: 'ops', css: true }] }); // Deliberately backup first.
  if (u.pathname === '/api/features/ops/board') { if (failBoard) { res.statusCode=503; return send({}); } return send(board); }
  if (u.pathname === '/api/features/ops/pack') {
   if(req.method==='POST'){rulePosts.push(body);if(slow)await new Promise(r=>setTimeout(r,250));const saved=require('../lib/ops').cleanPack(body.reset?{}:body.pack);Object.assign(pack,require('../lib/ops').withTemplates(saved,{}));return send(saved);}
   if(failRuleRead){res.statusCode=503;return send({error:'Rule readback unavailable'});}return send(pack);
  }
  if (u.pathname === '/api/features/ops/supervision/account') { accountChecks.push(body); return send({ ...body, accountRef, label: 'Verified audit owner', code: 'audit_account_registration_required', observedAt: Date.now(), quota: 'unknown' }); }
  if (u.pathname === '/api/features/ops/supervision') {
   if (req.method === 'POST') {
    posts.push(body); if (slow) await new Promise(r=>setTimeout(r,250));
    if (failPost) { res.statusCode=409; return send({error:'Rejected fixture policy'}); }
    if (!mismatch) { Object.assign(supervision,body); if (body.leaders) supervision.runtime.registrationReady=true; }
   }
   if (failSupervision) { res.statusCode=503; return send({}); }
   return send(supervision);
  }
  if (u.pathname === '/api/features/ops/nudge') {
   if (nudgeMode === 'poll-first') {
    nudges.push(body);
    board.log.unshift({ server: body.server, session:'dormant',rule:'dormant',at:Date.now(),idleAt:board.servers[0].sessions[0].ai.at,delivery:'delivered',verified:null,responded:null });
    await new Promise(resolve=>{releaseNudge=resolve});
    return send({ok:true,delivery:'delivered',responded:null,progress:'unknown'});
   }
   nudges.push(body); await new Promise(r=>setTimeout(r,180));
   if (nudgeMode === 'uncertain') {
    board.log.unshift({ server: body.server, session: 'dormant', rule: 'dormant', at: Date.now(), delivery:'uncertain', code:'OPS_DELIVERY_UNCERTAIN' });
    board.servers[0].findings.push({ key:'unheard',session:'dormant',rule:'unheard',severity:'urgent',code:'OPS_DELIVERY_UNCERTAIN',params:[],since:0 });
    res.statusCode=409; return send({ error:'Delivery uncertain', code:'OPS_DELIVERY_UNCERTAIN' });
   }
   board.log.unshift({ server: body.server, session:'dormant',rule:'dormant',at:Date.now(),idleAt:board.servers[0].sessions[0].ai.at,delivery:nudgeMode,verified:null,responded:null });
   res.statusCode=nudgeMode==='pending'?202:200; return send({ ok:true,delivery:nudgeMode,responded:null,progress:'unknown' });
  }
  if (u.pathname === '/api/features/ops/dismiss') { board.dismissed++; board.servers.forEach(s=>s.findings=s.findings.filter(f=>f.key!==body.key)); return send({ok:true}); }
  if (u.pathname === '/api/features/plugins/data') return send(plugins);
  if (u.pathname.startsWith('/api/features/plugins/')) {
   assert.equal(req.method,'POST');pluginPosts.push({url:u.pathname,body});
   if(pluginSlow)await new Promise(r=>setTimeout(r,300));
   if(pluginFailure){res.statusCode=409;return send({error:'Plugin update fixture rejected'});}
   if(u.pathname.endsWith('/auto'))plugins.autoReload=body.on;
   if(u.pathname.endsWith('/refresh')){
    plugins.servers[0].accounts[0].plugins[0].running='2.5.0';plugins.servers[0].scanned+=60000;
    plugins.servers[0].stale[0].session='refreshed-stale';
   }
   if(u.pathname.endsWith('/update')){pluginDiscover=true;pluginDiscoveryReads=0;return send({session:'tn-plugin-update'});}
   if(u.pathname.endsWith('/reload'))return send({now:1,queued:1});
   return send({ok:true});
  }
  if (u.pathname === '/api/features/server-backup/status') return send(backup);
  if (u.pathname === '/api/features/server-backup/control') {
   controls.push(body); if (slow) await new Promise(r=>setTimeout(r,250));
   if (failPost) {res.statusCode=409;return send({error:'Rejected fixture backup'});}
   if (!mismatch) { if ('enabled' in body) backup.enabled=body.enabled; if (body.servers) body.servers.forEach(c=>{const s=backup.servers.find(s=>s.id===c.serverId);Object.assign(s,{roots:c.roots,includeChats:c.includeChats});}); }
   return send(backup);
  }
  if (u.pathname === '/api/features/server-backup/snapshots') return send({snapshots:[{id:'saved',at:now-86400000,complete:true},{id:'older',at:now-172800000,complete:false}]});
  if (u.pathname === '/api/features/server-backup/files') return send({files:[{id:'chat',path:'/saved/conversation.jsonl',kind:'chat'}],nextCursor:null});
  if (u.pathname === '/api/features/server-backup/preview') return send({kind:'chat',text:JSON.stringify({message:{role:'assistant',content:'Readable offline fixture conversation'}})});
  if (['/api/features/server-backup/download','/api/features/server-backup/export'].includes(u.pathname)) { downloads.push(req.url); res.setHeader('Content-Type','application/octet-stream'); return res.end('full synthetic original'); }
  if (/\/api\/servers\/[^/]+\/dirs$/.test(u.pathname)) return send({path:folder,parent:'/work',dirs:[],truncated:false});
  if (u.pathname === '/api/backup') return send({lastAt:now,dir:'/fixture/vault-backups',extraDir:'',suggestions:[]});
  if (u.pathname === '/api/transfer') return send({waiting:[]});
  if (u.pathname === '/api/tokens') return send({accounts:tokenAccounts,hosts:[]});
  if (u.pathname === '/api/usage') return send({at:Date.now(),accounts:[],hosts:[]});
  return send({});
 }
 const vendor = { '/vendor/xterm.js':'@xterm/xterm/lib/xterm.js', '/vendor/xterm.css':'@xterm/xterm/css/xterm.css', '/vendor/addon-fit.js':'@xterm/addon-fit/lib/addon-fit.js', '/vendor/markdown-it.js':'markdown-it/dist/markdown-it.min.js' };
 const p = vendor[u.pathname] ? path.join(__dirname,'../node_modules',vendor[u.pathname]) : path.resolve(publicDir,'.'+u.pathname);
 if ((!p.startsWith(publicDir+path.sep)&&!vendor[u.pathname])||!fs.existsSync(p)||fs.statSync(p).isDirectory()) {res.statusCode=404;return res.end();}
 res.setHeader('Content-Type',p.endsWith('.js')?'application/javascript':p.endsWith('.css')?'text/css':p.endsWith('.svg')?'image/svg+xml':'application/octet-stream');res.end(fs.readFileSync(p));
 } catch (e) { res.statusCode=500;res.end(JSON.stringify({error:e.message})); }
});
let chrome, ws, closeBrowser, chromeError='';
(async()=>{
 const executable=[process.env.CHROME_BIN,'/usr/bin/google-chrome','/usr/bin/chromium','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean).find(p=>fs.existsSync(p));
 assert.ok(executable,'Actual Chrome required; set CHROME_BIN');
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 chrome=spawn(executable,['--headless=new','--no-sandbox','--disable-dev-shm-usage','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+path.join(output,'profile'),'about:blank'],{stdio:['ignore','ignore','pipe']});chrome.stderr.on('data',b=>chromeError=(chromeError+b).slice(-4000));
 const delay=ms=>new Promise(r=>setTimeout(r,ms)),portFile=path.join(output,'profile/DevToolsActivePort');
 for(let i=0;i<150&&!fs.existsSync(portFile)&&chrome.exitCode===null;i++)await delay(100);
 assert.ok(fs.existsSync(portFile),'Chrome started: '+chromeError);
 const port=fs.readFileSync(portFile,'utf8').split('\n')[0],target=(await(await fetch('http://127.0.0.1:'+port+'/json')).json()).find(x=>x.type==='page');
 ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.on('open',r);ws.on('error',j)});
 let chromeVersion;
 let seq=0;const pending=new Map(),errors=[];
 ws.on('message',b=>{const m=JSON.parse(b);if(m.id){const p=pending.get(m.id);if(p){clearTimeout(p.timer);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);pending.delete(m.id)}}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails)});
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method))},10000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}))});
 closeBrowser=()=>send('Browser.close');
 const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});assert.ok(!r.exceptionDetails,JSON.stringify(r.exceptionDetails));return r.result.value};
 const until=async(expression,label)=>{for(let i=0;i<100;i++){if(await evaluate(expression))return;await delay(50)}assert.fail('Timed out: '+label+'; browser errors='+JSON.stringify(errors))};
 const refresh=async()=>{await evaluate('__refresh()');await delay(120)};
 const select=async(name,value)=>evaluate('document.querySelector('+JSON.stringify('[name='+name+']')+').value='+JSON.stringify(value)+';document.querySelector('+JSON.stringify('[name='+name+']')+').dispatchEvent(new Event("change"))');
 const backupRow=id=>'document.querySelector('+JSON.stringify('.backup-row[data-server="'+id+'"]')+')';
 const sessionRow=name=>'document.querySelector('+JSON.stringify('#v-ops .ops-row[data-session="'+name+'"]')+')';
 const clickText=async(root,label)=>evaluate('Array.from('+root+'.querySelectorAll("button")).find(b=>b.textContent==='+JSON.stringify(label)+').click()');
 const settingsTab=async tab=>evaluate('document.querySelector('+JSON.stringify('#dlg-set [data-tab="'+tab+'"]')+').click()');
 const closeSettings=async()=>evaluate('document.querySelector("#dlg-set [data-close]").click()');
 const captureDaily=async name=>{
  for(const width of [1440,390]){
   await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width<500});await delay(80);
   await evaluate('document.querySelector("#tab-ops").scrollIntoView({block:"nearest",inline:"nearest"})');
   assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'),'daily width '+width);
   await screenshot(name+'-'+width);
   if(name==='operations-all-groups-before-nudge'){
    await evaluate('document.querySelector(".g-running").scrollIntoView({block:"start"})');
    await screenshot('operations-lower-groups-before-nudge-'+width);
    await evaluate('document.querySelector(".ops-head").scrollIntoView({block:"start"})');
   }
  }
 };
 chromeVersion=await send('Browser.getVersion');await send('Runtime.enable');await send('Page.enable');
 await send('Page.navigate',{url:'http://127.0.0.1:'+server.address().port+'/?lang=vi'});
 await until('!!window.TW && !!TW.app() && !!document.querySelector("[name=save]") && !!document.querySelector(".backup-card")','full app feature load');
 assert.equal(await evaluate('document.querySelector("#tab-ops").getAttribute("aria-pressed")'),'false');
 // Initial Overview, polling and Terminal use discovered worker data without rendering Crew UI.
 const assertNoCrew = async label => {
  assert.equal(await evaluate('document.querySelectorAll(".crew,.crew-row,.meeting-room,.crew-band").length'),0,label+' has no worker nodes');
  assert.equal(await evaluate('document.querySelectorAll("#tab-crew").length'),0,label+' has no Crew tab');
  assert.equal(await evaluate('document.querySelectorAll("#tab-plugins,#v-plugins,#v-over .ops-plug,#v-focus .ops-plug,#v-ops .ops-plug,.main-top .ops-plug").length'),0,label+' has no main plugins UI');
  assert.equal(await evaluate('document.querySelector("#crew-panel").hidden'),true,label+' has no worker log popup');
  assert.equal(await evaluate('document.querySelector("#v-over").textContent.includes("Crew") || document.querySelector("#v-focus").textContent.includes("worker Crew")'),false,label+' has no Crew summary');
  assert.equal(await evaluate('Array.from(document.querySelectorAll("#grid,#detail,#tabs,#chips,#fleet")).some(n=>/internal-(live|finished|owned)-task|private .* worker log|W1|W3|W4/.test(n.textContent))'),false,label+' has no internal worker details');
 };
 assert.equal(await evaluate('document.querySelector("#v-over").classList.contains("on")'),true);
 for(const name of appSessions.map(s=>s.name))assert.ok(await evaluate('Array.from(document.querySelectorAll("#grid .card .n")).some(n=>n.textContent==='+JSON.stringify(name)+')'),'real Overview session '+name);
 await assertNoCrew('initial Overview');
 appWorkers[0].elapsed+=120;await refresh();await assertNoCrew('refreshed Overview including offline host');
 assert.equal(await evaluate('document.querySelectorAll("#grid .card .n").length'),appSessions.length,'real sessions remain after refresh');
 assert.equal(await evaluate('TW.app().servers().find(v=>v.id==="vm1").workers.length'),3,'worker discovery is preserved');
 for(const width of [1440,390]){
  await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width<500});await delay(80);
  await screenshot('overview-without-crew-'+width);
  await evaluate('Array.from(document.querySelectorAll("#grid .card")).find(n=>n.querySelector(".n")?.textContent==="dormant").click()');
  await until('document.querySelector("#v-focus").classList.contains("on") && !!document.querySelector("#detail .who")','real Terminal');
  assert.equal(await evaluate('document.querySelector("#detail .who b").textContent'),'dormant');
  assert.equal(await evaluate('document.querySelectorAll("#detail .detail-actions button").length'),2,'detach and stop controls retained');
  assert.ok(await evaluate('!!document.querySelector("#split .xterm") && !document.querySelector("#h-kill").disabled && !document.querySelector("#h-detach").disabled'),'normal Terminal and controls retained');
  await evaluate('document.querySelector("#h-info").click()');
  await assertNoCrew('Terminal '+width);await refresh();await assertNoCrew('refreshed Terminal '+width);
  await screenshot('terminal-without-crew-'+width);
  await evaluate('document.querySelector("#tab-over").click()');
 }
 assert.ok(!requests.some(r=>r.method==='DELETE'||r.method==='POST'),'presentation navigation does not mutate workers or sessions');
 await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 // Use the normal Settings button before ever visiting Operations.
 await evaluate('document.querySelector("#set").click()');await settingsTab('plugins');
 await until('!!document.querySelector("#plugins-settings-mount .pl-row")','Settings-first plugin data');
 assert.equal(await evaluate('document.querySelector("#tab-ops").getAttribute("aria-pressed")'),'false');
 assert.ok(await evaluate('document.querySelector("#plugins-settings-mount").textContent.includes(".claude-work") && document.querySelector("#plugins-settings-mount").textContent.includes("2.3.0") && document.querySelector("#plugins-settings-mount").textContent.includes("1.2.0")'));
 assert.equal(await evaluate('document.querySelectorAll("#plugins-settings-mount .pl-row button").length'),1,'folder plugin has no update action');
 assert.equal(pluginPosts.length,0,'navigation and polling issue no plugin mutations');
 pluginSlow=true;
 await evaluate('document.querySelector(".pl-auto input").focus();document.querySelector(".pl-auto input").click()');
 await refresh();assert.equal(await evaluate('document.querySelector(".pl-auto input").checked'),true,'poll cannot clobber pending auto preference');
 await until('!document.querySelector(".pl-auto input").disabled','auto save/readback');pluginSlow=false;
 assert.deepEqual(pluginPosts.at(-1),{url:'/api/features/plugins/auto',body:{on:true}});
 assert.equal(await evaluate('document.querySelector(".pl-auto input").checked'),true,'saved auto preference read back');
 await evaluate('document.querySelector(".pl-auto input").focus();window.__pluginCheckbox=document.activeElement');
 plugins.servers[0].scanned++;await refresh();
 assert.equal(await evaluate('document.activeElement===window.__pluginCheckbox'),true,'changed polling preserves keyboard focus');
 await settingsTab('backup');await settingsTab('plugins');await refresh();
 assert.equal(await evaluate('document.querySelectorAll("#plugins-settings-mount .ops-plug").length'),1);
 await evaluate('window.__pluginRefresh=document.querySelector(".pl-bar button");__pluginRefresh.focus()');
 assert.equal(await evaluate('document.activeElement===__pluginRefresh'),true,'refresh button focused before request');
 await clickText('document.querySelector("#plugins-settings-mount")',require('../public/locales/vi.json')['pl.kiem_lai']);
 await until('document.querySelector("#plugins-settings-mount").textContent.includes("2.5.0") && document.querySelector("#plugins-settings-mount").textContent.includes("refreshed-stale")','manual refresh updates visible data without blur');
 assert.equal(await evaluate('document.activeElement===__pluginRefresh'),true,'refresh retains the same meaningful focused button');
 assert.equal(await evaluate('document.querySelectorAll("#plugins-settings-mount .ops-plug").length'),1);
 assert.deepEqual(pluginPosts.at(-1),{url:'/api/features/plugins/refresh',body:{server:'vm1'}});
 assert.equal(await evaluate('document.querySelector(".pl-srv-h small").textContent'),await evaluate('i18n("pl.doc_luc",[new Date('+plugins.servers[0].scanned+').toLocaleString("vi",{dateStyle:"short",timeStyle:"short"})])'),'scan time refreshed without blur');
 pluginFailure=true;await evaluate('document.querySelector(".pl-stale-h button").click()');
 await until('document.querySelector(".pl-feedback").textContent.includes("Plugin update fixture rejected")','reload error visible in modal');
 assert.equal(await evaluate('document.querySelector("#dlg-set").open'),true,'reload failure keeps modal open');
 assert.equal(await evaluate('document.querySelector(".pl-feedback").textContent.includes(i18n("pl.da_nap",[1,1]))'),false,'failed reload never claims success');
 pluginFailure=false;await evaluate('document.querySelector(".pl-stale-h button").click()');await delay(80);
 assert.deepEqual(pluginPosts.at(-1),{url:'/api/features/plugins/reload',body:{server:'vm1',all:true}});
 assert.ok(await evaluate('document.querySelector(".pl-feedback").textContent.includes(i18n("pl.da_nap",[1,1]))'),'reload immediate and queued feedback in modal');
 pluginFailure=true;await evaluate('document.querySelector(".pl-row button").click()');
 await until('document.querySelector(".pl-feedback").textContent.includes("Plugin update fixture rejected")','actual update error');
 assert.equal(await evaluate('document.querySelector("#dlg-set").open'),true,'failed update keeps Settings open');
 pluginFailure=false;pluginStateFailure=true;await evaluate('document.querySelector(".pl-row button").click()');
 await until('document.querySelector(".pl-feedback").textContent.includes("Plugin state discovery unavailable")','discovery GET error shown');
 assert.equal(await evaluate('document.querySelector("#dlg-set").open'),true,'discovery failure keeps Settings open');
 assert.equal(await evaluate('TW.app().current()?.s.name'),'dormant','discovery error does not open fallback');
 pluginStateFailure=false;pluginNoDiscovery=true;await evaluate('document.querySelector(".pl-row button").click()');
 await until('document.querySelector(".pl-feedback").textContent.includes(i18n("pl.khong_tim_thay_phien",["tn-plugin-update"]))','bounded no-discovery failure');
 assert.equal(pluginFreshReads,3,'discovery retries bounded');
 assert.equal(await evaluate('document.querySelector("#dlg-set").open'),true);
 assert.equal(await evaluate('TW.app().current()?.s.name'),'dormant','missing session does not open fallback');
 pluginNoDiscovery=false;
 assert.equal(await evaluate('TW.app().servers().find(v=>v.id==="vm1").sessions.some(s=>s.name==="tn-plugin-update")'),false,'update session initially absent from client');
 assert.equal(appSessions.some(s=>s.name==='tn-plugin-update'),false,'session initially absent from snapshot too');
 await evaluate('document.querySelector(".pl-row button").click()');await delay(50);
 assert.equal(await evaluate('document.querySelector("#dlg-set").open'),true,'modal stays open during pending fresh discovery');
 await until('!document.querySelector("#dlg-set").open && document.querySelector("#v-focus").classList.contains("on") && document.querySelector("#detail .who b")?.textContent==="tn-plugin-update"','successful update discovers exact session then closes Settings');
 assert.equal(await evaluate('TW.app().current().s.name'),'tn-plugin-update');
 assert.equal(pluginFreshReads,5,'success retries stale snapshot before discovering new session');
 assert.equal(await evaluate('!!document.activeElement.closest("#split")'),true,'modal focus return does not steal terminal focus');
 assert.deepEqual(pluginPosts.at(-1),{url:'/api/features/plugins/update',body:{server:'vm1',cfg:'.claude-work',id:'xspire@market'}});
 await evaluate('document.querySelector("#tab-over").click();document.querySelector("#set").click()');await settingsTab('backup');
 assert.equal(await evaluate('document.querySelector("#dlg-set").open'),true);
 assert.equal(await evaluate('document.querySelector("#dlg-set .set-tab[aria-selected=true]").dataset.tab'),'backup');
 assert.equal(await evaluate('document.querySelector("#v-ops").contains(document.querySelector(".backup-card"))'),false);
 assert.equal(await evaluate('document.querySelector("#dlg-set [data-pane=backup]").contains(document.querySelector(".backup-card"))'),true);
 assert.ok(await evaluate('document.querySelector("#dlg-set [data-pane=backup]").textContent.includes("Cấu hình Termnest")'));
 assert.equal(await evaluate('document.querySelectorAll("#v-ops form,#v-ops input,#v-ops .ops-super,#v-ops .backup-card").length'),0);
 await refresh();assert.deepEqual(supervision,originalSupervision,'relocation and polling do not alter policy');assert.deepEqual(backup,originalBackup,'relocation does not alter backup config');assert.equal(posts.length+controls.length+nudges.length,0);
 // Stored reads for offline and removed hosts use the saved store and return to Settings on close/Escape.
 for(const id of ['vm2','removed']){
  await clickText(backupRow(id),'Xem chat');await until('document.querySelectorAll(".backup-file-list button").length===1','saved files '+id);
  await evaluate('document.querySelector(".backup-file-list button").click()');await until('document.querySelector(".backup-preview").textContent.includes("Readable offline")','saved chat '+id);
  assert.equal(await evaluate('fetch(document.querySelector(".backup-preview a").href).then(r=>r.text())'),'full synthetic original');
  assert.equal(await evaluate('fetch(document.querySelector(".backup-dialog a").href).then(r=>r.text())'),'full synthetic original');
  assert.ok(downloads.at(-1).includes('server='+id));
  if(id==='removed')await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});else await evaluate('document.querySelector(".backup-dialog button").click()');
  await until('!document.querySelector(".backup-dialog")','saved dialog closed');assert.equal(await evaluate('document.querySelector("#dlg-set").open'),true,'Settings stays open after '+id);
  assert.ok(await evaluate('document.activeElement.closest("#dlg-set")!==null'),'focus returns to Settings');
 }
 assert.equal(await evaluate('Array.from('+backupRow('first')+'.querySelectorAll("button")).find(b=>b.textContent==="Xem chat").disabled'),true,'first offline connection has no fabricated saved copy');
 // Native folder picker above Settings; persistent backup scope/focus and complete-list preservation.
 await evaluate(backupRow('vm1')+'.querySelector(".backup-scope").open=true');
 await clickText(backupRow('vm1'),'Chọn thư mục trên máy');await until('document.querySelector("#dlg-dir").open&&!document.querySelector("#dir-ok").disabled','native folder dialog');
 assert.equal(await evaluate('document.querySelector("#dlg-set").open'),true);await evaluate('document.querySelector("#dir-ok").click()');await delay(30);
 assert.ok(await evaluate(backupRow('vm1')+'.textContent.includes("/work/new")'));
 await evaluate(backupRow('vm1')+'.querySelector(".backup-scope input").focus()');await refresh();assert.equal(await evaluate('document.activeElement.closest(".backup-scope")!==null'),true,'backup draft focus survives polling');
 await settingsTab('sessions');await settingsTab('backup');assert.ok(await evaluate(backupRow('vm1')+'.textContent.includes("/work/new")'));
 slow=true;await clickText(backupRow('vm1'),'Lưu lựa chọn');await clickText(backupRow('vm1'),'Lưu lựa chọn');
 await until('!Array.from(document.querySelectorAll(".backup-scope button")).some(b=>b.textContent==="Lưu lựa chọn"&&b.disabled)','backup readback');slow=false;
 assert.equal(controls.length,1);assert.deepEqual(controls[0].servers.map(x=>x.serverId),['vm1','vm2','removed','first']);
 assert.deepEqual(controls[0].servers[1],{serverId:'vm2',roots:['/work/two'],includeChats:true});assert.equal(backup.servers[2].configured,false,'removed source remains unconfigured');
 // Real session/task chooser has no task ID/UUID text input and no blind enrollment.
 await settingsTab('sessions');assert.equal(await evaluate('document.querySelectorAll("[name=workspaces],[name=taskIds]").length'),0);
 assert.equal(await evaluate('document.querySelector("[name=workspaceMachine]").options[0].textContent'),'Build machine');
 await select('leader','0');assert.equal(await evaluate('document.querySelectorAll("[name=taskScope]").length'),2);assert.equal(await evaluate('document.querySelectorAll("[name=taskScope]:checked").length'),0);
 await evaluate('document.querySelector("[name=taskScope]").click();document.querySelector("[name=confirmLeader]").click();document.querySelector("[name=intervalMinutes]").value="45";document.querySelector("[name=intervalMinutes]").dispatchEvent(new Event("input"));document.querySelector("[name=intervalMinutes]").focus()');
 await refresh();assert.equal(await evaluate('document.activeElement.name'),'intervalMinutes');
 await settingsTab('backup');await settingsTab('sessions');assert.equal(await evaluate('document.querySelector("[name=intervalMinutes]").value'),'45');assert.equal(await evaluate('document.querySelectorAll("[name=taskScope]:checked").length'),1);
 const beforeIdentity=posts.length;supervision.registrationCandidates[0].identity={...identity,agentPid:999};await refresh();await evaluate('document.querySelector("[name=save]").click()');await delay(80);assert.equal(posts.length,beforeIdentity,'stale candidate cannot enroll');
 supervision.registrationCandidates[0].identity=identity;await refresh();slow=true;await evaluate('document.querySelector("[name=save]").click();document.querySelector("[name=save]").click()');
 await until('!document.querySelector("[name=save]").disabled','registration readback');slow=false;
 assert.equal(posts.length,1);assert.deepEqual(posts[0].leaders,[{serverId:'vm1',root:'/work/one',session:'dormant',taskIds:['task-one'],identity}]);
 assert.deepEqual(supervision.workspaces,originalSupervision.workspaces);assert.equal(supervision.enabled,false,'registration does not enable crew');assert.equal(supervision.autoRecovery,false);
 // Browse adds one scope and only explicit removal removes a scope; saved identity metadata is preserved.
 await evaluate('document.querySelector("[name=browseWorkspace]").click()');await until('document.querySelector("#dlg-dir").open&&!document.querySelector("#dir-ok").disabled','monitoring folder dialog');await evaluate('document.querySelector("#dir-ok").click()');await delay(30);
 await evaluate('document.querySelector("[name=save]").click()');await until('!document.querySelector("[name=save]").disabled','new workspace readback');
 assert.equal(supervision.workspaces.length,3);assert.deepEqual(supervision.workspaces.slice(0,2),originalSupervision.workspaces);
 await evaluate('document.querySelectorAll(".ops-scopes button")[2].click();document.querySelector("[name=save]").click()');await until('!document.querySelector("[name=save]").disabled','scope removal readback');assert.deepEqual(supervision.workspaces,originalSupervision.workspaces);
 // Safe guided account chooser, explicit proof and readback; unrelated policy and registrations survive.
 supervision.servers[0].freshness.taskEvidenceFresh=false;await refresh();
 assert.ok(await evaluate('document.querySelector(".ops-super-account").textContent.includes("API chưa liệt kê mọi tài khoản")'));
 assert.equal(await evaluate('document.querySelector("[name=accountChoice]").value'),'.claude-audit');
 await evaluate('document.querySelector("[name=checkAccount]").click()');await until('!document.querySelector("[name=confirmAccount]").disabled','identity proof');
 assert.equal(accountChecks.length,1);assert.deepEqual(accountChecks[0],{serverId:'vm1',root:'/work/one',auditConfig:'.claude-audit'});
 await closeSettings();await refresh();await evaluate('TW.app().openSettings("sessions")');assert.equal(await evaluate('document.querySelector("[name=confirmAccount]").disabled'),false,'valid proof survives Settings navigation');
 const beforeAccount=structuredClone(supervision);await evaluate('document.querySelector("[name=intervalMinutes]").value="88";document.querySelector("[name=intervalMinutes]").dispatchEvent(new Event("input"));document.querySelector("[name=confirmAccount]").click()');
 await until('document.querySelector(".ops-super-account").textContent.includes("Đã lưu tài khoản")','account readback');
 assert.equal(supervision.intervalMinutes,beforeAccount.intervalMinutes);assert.deepEqual(supervision.workspaces[1],beforeAccount.workspaces[1]);assert.deepEqual(supervision.leaders,beforeAccount.leaders);assert.equal(supervision.workspaces[0].auditAccount,accountRef);assert.equal(await evaluate('document.querySelector("[name=intervalMinutes]").value'),'88');
 // Failed readback is never displayed as saved; proof expires even while navigating.
 await evaluate('document.querySelector("[name=checkAccount]").click()');await until('!document.querySelector("[name=confirmAccount]").disabled','second proof');
 await evaluate('window.__now=Date.now;Date.now=()=>__now()+61000');await refresh();assert.equal(await evaluate('document.querySelector("[name=confirmAccount]").disabled'),true);await evaluate('Date.now=__now');
 await evaluate('document.querySelector(".ops-reminder-settings").open=true;document.querySelector(".ops-edit-rules").click()');
 await evaluate('document.querySelector(".ops-rules textarea").value="Keep this actual Settings draft";document.querySelector(".ops-rules textarea").dispatchEvent(new Event("input"));document.querySelector(".ops-rules textarea").focus()');
 await refresh();assert.equal(await evaluate('document.activeElement.closest(".ops-rules")!==null'),true);
 await settingsTab('backup');await settingsTab('sessions');assert.equal(await evaluate('document.querySelector(".ops-rules textarea").value'),'Keep this actual Settings draft');
 // Rules remain independent of crew status, and writes need a matching GET with duplicate clicks disabled.
 failSupervision=true;await refresh();assert.equal(await evaluate('document.querySelector(".ops-edit-rules").disabled'),false);failSupervision=false;await refresh();
 const ruleSave='Array.from(document.querySelectorAll(".ops-rules button")).find(b=>b.textContent===i18n("ops.luu"))';
 failRuleRead=true;await evaluate(ruleSave+'.click()');await until('document.querySelector("#banner").textContent.includes("Rule readback unavailable")','rule readback failure');assert.equal(await evaluate('document.querySelector(".ops-rules textarea").value'),'Keep this actual Settings draft');
 failRuleRead=false;slow=true;const beforeRules=rulePosts.length;await evaluate(ruleSave+'.click();'+ruleSave+'.click()');assert.equal(await evaluate(ruleSave+'.disabled'),true);await until('document.querySelector("#banner").textContent===i18n("ops.da_luu")','rules saved after readback');slow=false;assert.equal(rulePosts.length,beforeRules+1);
 assert.equal(pack.rules.dormant.level,'suggest','saving drafts does not enable automatic reminders');
 // Operations contains one row per session and never types into asking, busy, unknown or background board.
 await closeSettings();await evaluate('window.__opened=[];var realOpen=TW.app().openSession;TW.app().openSession=function(id,name){__opened.push({id,name});return realOpen(id,name)};document.querySelector("#tab-ops").click()');await refresh();
 await assertNoCrew('Operations');
 assert.equal(await evaluate('document.querySelectorAll("#v-ops .ops-row[data-session=dormant]").length'),1);
 assert.equal(await evaluate('document.querySelectorAll("#v-ops form,#v-ops input,#v-ops .backup-card,#tab-crew").length'),0);
 for(const name of ['asking','busy','unknown','parked','stale'])assert.equal(await evaluate('Array.from('+sessionRow(name)+'.querySelectorAll("button")).some(b=>b.textContent==="Nhắc tiếp")'),false,name+' cannot nudge');
 await clickText(sessionRow('asking'),'Mở phiên');await delay(30);assert.equal(nudges.length,0);assert.deepEqual(await evaluate('__opened.at(-1)'),{id:'vm1',name:'asking'});await evaluate('document.querySelector("#tab-ops").click()');
 await evaluate('document.querySelector(".g-routine").open=true');
 await captureDaily('operations-all-groups-before-nudge');
 await evaluate('window.__notices=[];var realSay=TW.app().say;TW.app().say=function(message,ok,ms){__notices.push({message,ok});return realSay(message,ok,ms)}');
 nudgeMode='poll-first';await clickText(sessionRow('dormant'),'Nhắc tiếp');assert.equal(await evaluate('Array.from('+sessionRow('dormant')+'.querySelectorAll("button")).find(b=>b.textContent==="Nhắc tiếp").disabled'),true);
 for(let i=0;i<100&&!releaseNudge;i++)await delay(20);
 assert.ok(releaseNudge,'POST is held until after early GET and observed busy');
 await refresh();await until(sessionRow('dormant')+'.textContent.includes("Đã gửi nhắc")','early GET delivered reminder');
 assert.equal(nudges.length,1);assert.ok(await evaluate(sessionRow('dormant')+'.closest(".g-waiting")!==null'),'delivery never moves session to Working');
 assert.equal(await evaluate('Array.from('+sessionRow('dormant')+'.querySelectorAll("button")).find(b=>b.textContent==="Nhắc tiếp").disabled'),true,'early delivered GET keeps in-flight POST disabled');
 await captureDaily('operations-delivered');
 await refresh();assert.equal(nudges.length,1);
 board.servers[0].sessions[0].ai={status:'busy',at:Date.now()};board.servers[0].findings=board.servers[0].findings.filter(f=>f.key!=='dormant');board.log[0].verified=board.log[0].responded=true;await refresh();
 assert.ok(await evaluate(sessionRow('dormant')+'.closest(".g-running")!==null'),'only a new observed busy state moves the row');
 assert.ok(await evaluate('document.querySelector(".ops-log-sec").textContent.includes(i18n("ops.delivery_responded"))'), 'observed response uses the current localized label');
 releaseNudge();releaseNudge=null;
 await until('__notices.length===1','late POST response after receipt cleanup');
 assert.deepEqual(await evaluate('__notices'),[{message:await evaluate('i18n("ops.delivery_responded")'),ok:true}],'successful receipt survives early GET cleanup without false failure');
 assert.equal(nudges.length,1,'late POST never resends');
 // Exact current response handling: accepted/pending cannot claim delivered. Uncertain is visible and never resent, even after reload.
 board.servers[0].sessions[0].ai={status:'idle',at:Date.now()-100};board.servers[0].findings.push({...originalDormant(),key:'dormant-new'});board.log=[];nudgeMode='pending';await refresh();
 await clickText(sessionRow('dormant'),'Nhắc tiếp');await until(sessionRow('dormant')+'.textContent.includes("Đang chờ xác nhận gửi")','202 pending');assert.ok(!await evaluate(sessionRow('dormant')+'.textContent.includes("Đã gửi nhắc")'));assert.equal(nudges.length,2);
 // Fresh page clears client state; server uncertainty remains authoritative.
 nudgeMode='uncertain';board.servers[0].sessions[0].ai.at=Date.now()-3600000;board.log=[];
 await send('Page.reload');await until('!!document.querySelector("[name=save]")','reloaded app');await evaluate('document.querySelector("#tab-ops").click()');await clickText(sessionRow('dormant'),'Nhắc tiếp');
 await until(sessionRow('dormant')+'.textContent.includes("Chưa rõ lời nhắc đã đến")','uncertain outcome');assert.equal(nudges.length,3);await refresh();
 await captureDaily('operations-uncertain');
 assert.equal(await evaluate('Array.from('+sessionRow('dormant')+'.querySelectorAll("button")).some(b=>b.textContent==="Nhắc tiếp")'),false);
 await send('Page.reload');await until('!!document.querySelector("[name=save]")','reload uncertain app');await evaluate('document.querySelector("#tab-ops").click()');await refresh();
 assert.equal(await evaluate('Array.from('+sessionRow('dormant')+'.querySelectorAll("button")).some(b=>b.textContent==="Nhắc tiếp")'),false);assert.equal(nudges.length,3);
 // Fresh owner findings deduplicate; unknown/stale/configuration flags never override busy.
 supervision.enabled=true;
 const host=supervision.servers[0];host.freshness.taskEvidenceFresh=true;
 for(const code of ['task_evidence_stale','registration_required','awaiting_task_progress']){
  host.teams=[{id:'owner',session:'asking',root:'/work/one',status:'waiting_owner',requiresOwner:true,reason:{code:'owner_decision'}},{id:'neutral',session:'busy',root:'/work/one',status:'unknown',requiresOwner:true,reason:{code}}];await refresh();
  assert.equal(await evaluate(sessionRow('busy')+'.dataset.rule'),'observed_busy',code+' stays observed busy');
  assert.ok(await evaluate(sessionRow('busy')+'.closest(".g-running")!==null'));
  assert.equal(await evaluate('document.querySelectorAll("#v-ops .ops-row[data-session=asking]").length'),1);assert.equal(await evaluate(sessionRow('asking')+'.dataset.rule'),'asking');
 }
 host.teams[1]={...host.teams[1],status:'stalled',reason:{code:'no_task_progress'}};await refresh();
 assert.equal(await evaluate(sessionRow('busy')+'.dataset.rule'),'owner','fresh real stall is actionable');
 assert.ok(await evaluate(sessionRow('busy')+'.textContent.includes("Lâu chưa thấy thay đổi")'));
 assert.ok(!await evaluate(sessionRow('busy')+'.textContent.includes("/work/one")'),'daily row hides raw root');
 host.freshness.snapshotFresh=false;await refresh();assert.equal(await evaluate(sessionRow('busy')+'.dataset.rule'),'observed_busy','stale host cannot promote');host.freshness.snapshotFresh=true;
 host.teams[1]={...host.teams[1],status:'unknown',reason:{code:'task_evidence_stale'}};await refresh();
 assert.equal(await evaluate('document.querySelectorAll("#v-ops .ops-src").length'),0,'daily has no diagnostic source badges');
 assert.equal(await evaluate('document.querySelectorAll("#v-ops .ops-row[data-rule=offline]").length'),1);assert.ok(!await evaluate('document.querySelector("#v-ops").textContent.includes("Mọi phiên đều ổn")'));
 const actionCount=await evaluate('document.querySelectorAll("#v-ops .g-attention .ops-row,#v-ops .g-waiting .ops-row").length');assert.equal(actionCount,3,'only asking, unresolved reminder and offline host need attention');assert.equal(await evaluate('Number(document.querySelector("#tab-ops .ops-badge").textContent)'),actionCount);
 // A proven failed/exhausted delivery must not become a fabricated three-minute no-response event.
 board.log[0].delivery='exhausted';board.servers[0].findings.find(f=>f.key==='unheard').code='OPS_NOT_SENT';await refresh();
 assert.ok(await evaluate(sessionRow('dormant')+'.textContent.includes("Chưa gửi được")'));assert.ok(!await evaluate(sessionRow('dormant')+'.textContent.includes("sau 3 phút")'));assert.equal(nudges.length,3);
 // No-response is a verification outcome after the existing three-minute window, never task progress.
 board.log[0]={...board.log[0],delivery:'delivered',verified:false,responded:false,at:Date.now()-181000};board.servers[0].findings.find(f=>f.key==='unheard').code='OPS_NO_RESPONSE';await refresh();
 assert.ok(await evaluate(sessionRow('dormant')+'.textContent.includes("sau 3 phút")'));assert.equal(nudges.length,3);
 tokenAccounts.push({id:'one-account',tool:'claude',nickname:'Fixture account',limits:{session:{percent:95},weekly:{percent:99}}});
 await evaluate('__ticks.filter(t=>t.ms===60000).forEach(t=>t.fn())');await delay(100);await refresh();
 assert.equal(await evaluate(`document.querySelectorAll('#v-ops .ops-row[data-session="acc:Fixture account"]').length`),1,'quota is counted once per account across both limits');
 const quotaPosts=requests.filter(r=>r.method==='POST').length;
 await clickText(sessionRow('acc:Fixture account'),'Xem tài khoản');
 assert.equal(await evaluate('document.querySelector("#v-token").classList.contains("on")'),true,'quota opens actual Token AI view');
 assert.equal(await evaluate('document.querySelector("#tab-token").getAttribute("aria-pressed")'),'true');
 assert.equal(requests.filter(r=>r.method==='POST').length,quotaPosts,'account navigation does not mutate credentials');
 await evaluate('document.querySelector("#tab-ops").click()');
 failBoard=true;await refresh();assert.ok(await evaluate('document.querySelector("#v-ops").textContent.includes("Không đọc được phiên mới")'));failBoard=false;await refresh();
 // Backup/board online flags can disagree while a snapshot is stale: show only the one host issue.
 backup.servers[1].online=true;backup.servers[1].phase='error';await refresh();assert.equal(await evaluate('document.querySelectorAll("#v-ops .backup-issue").length'),0);
 backup.servers[0].phase='partial';await refresh();assert.equal(await evaluate('document.querySelectorAll("#v-ops .backup-issue").length'),1);
 await evaluate('document.querySelector("#v-ops .backup-issue").click()');assert.equal(await evaluate('document.querySelector("#dlg-set .set-tab[aria-selected=true]").dataset.tab'),'backup');await closeSettings();
 backup.servers[1].online=false;backup.servers[1].phase='offline';backup.servers[0].phase='current';await refresh();
 // Actual shell keyboard tab navigation/focus and both viewport sizes, including persistent rules.
 for(const width of [1440,390]){
  await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width<500});await delay(80);
  await evaluate('document.querySelector("#tab-ops").scrollIntoView({block:"nearest",inline:"nearest"})');
  assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'),'daily width '+width);
  await screenshot('operations-'+width);
  await evaluate('TW.app().openSettings("sessions")');
  assert.equal(await evaluate('document.activeElement.dataset.tab'),'sessions');
  assert.ok(await evaluate('var d=document.querySelector("#dlg-set");d.scrollWidth<=d.clientWidth+1'),'settings width '+width);
  await screenshot('monitoring-'+width);
  await evaluate('document.querySelector(".ops-scopes").scrollIntoView({block:"start"})');await screenshot('scopes-'+width);
  await evaluate('document.querySelector(".ops-super-account").scrollIntoView({block:"start"})');await screenshot('account-'+width);
  await evaluate('document.querySelector(".ops-reminder-settings").open=true;if(!document.querySelector(".ops-rules"))document.querySelector(".ops-edit-rules").click();document.querySelector(".ops-rules").scrollIntoView({block:"start"})');assert.ok(await evaluate('var d=document.querySelector("#dlg-set .set-panes");d.scrollWidth<=d.clientWidth+1'),'rules fit '+width);await screenshot('rules-'+width);
  await settingsTab('backup');assert.ok(await evaluate('var t=document.querySelector("#dlg-set .set-tab[aria-selected=true]").getBoundingClientRect();t.left>=0&&t.right<=innerWidth+1'),'selected backup tab visible '+width);assert.ok(await evaluate('var d=document.querySelector("#dlg-set .set-panes");d.scrollWidth<=d.clientWidth+1'),'backup pane width '+width);await screenshot('backup-'+width);await evaluate('document.querySelector(".backup-scope").open=true');assert.ok(await evaluate('document.querySelector(".backup-scope input").getBoundingClientRect().width<=24'));await screenshot('backup-scope-'+width);
  await settingsTab('sessions');await evaluate('document.querySelector("#dlg-set [data-tab=sessions]").focus()');await send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});assert.equal(await evaluate('document.activeElement.dataset.tab'),'backup');
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});assert.equal(await evaluate('document.activeElement.dataset.tab'),'plugins');
  assert.ok(await evaluate('var t=document.activeElement.getBoundingClientRect();t.left>=0&&t.right<=innerWidth+1'),'plugin selected tab visible '+width);
  assert.ok(await evaluate('var d=document.querySelector("#dlg-set .set-panes");d.scrollWidth<=d.clientWidth+1'),'plugin pane fits '+width);
  assert.ok(await evaluate('document.querySelector(".pl-auto input").getBoundingClientRect().width<=40'),'plugin switch fits');
  assert.ok(await evaluate('Array.from(document.querySelectorAll("#plugins-settings-mount .pl-row")).every(n=>n.getBoundingClientRect().height<180 && n.querySelector(".ops-name").getBoundingClientRect().width>30 && n.querySelector(".ops-meta").getBoundingClientRect().width>100)'),'plugin names and profiles readable '+width);
  await screenshot('plugins-'+width);
  await closeSettings();await until('!document.querySelector("#dlg-set").open && !document.activeElement.closest("#dlg-set")','close returns focus outside Settings');
 }
 assert.equal(pluginPosts.length,8,'only explicitly requested plugin writes, including rejected update; polling/navigation never update');
 assert.deepEqual(errors,[]);
 assert.ok(!requests.some(r=>/\/api\/servers\/.*\/(keys|sessions)$/.test(r.url)&&r.method==='POST'),'no arbitrary typing or new session path');
 assert.ok(!requests.some(r=>/\/api\/features\/(crew|crewpack)/.test(r.url)),'no Crew polling');
 assert.ok(!requests.some(r=>r.method==='DELETE'||/crew-log/.test(r.url)),'no process/task removal or worker log requests');
 fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,chrome:executable,chromeVersion,requests,posts,controls,nudges,accountChecks,downloads,rulePosts,pluginPosts,errors},null,2));
 console.log('PASS: actual index/app Settings shell BEFORE Ops, backup-first feature loading, native folder/saved dialogs and focus, offline/removed saved reads and originals/export, pending full-list scope readback, real candidates/task checkboxes, account proof/expiry/readback, drafts through nav/poll, guarded nudge exact delivered/pending/uncertain/reload, owner row/badge dedupe, plugin Settings-first versions, exact auto/refresh/reload/update POSTs, pending and focused polling, update session/modal success and failure, 1440/390 plugin fit; Overview/Terminal Crew removal with live, finished, owned and offline workers. Artifacts: '+output);
 async function screenshot(name){const r=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,name+'.png'),Buffer.from(r.data,'base64'));}
 function originalDormant(){return {session:'dormant',rule:'dormant',severity:'warn',level:'suggest',template:'continue',params:[60],since:3600,source:'status'};}
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{
 if(closeBrowser&&chrome&&chrome.exitCode===null){try{await closeBrowser()}catch{chrome.kill()}}
 if(ws)ws.close();
 if(chrome)await new Promise(resolve=>{
  if(chrome.exitCode!==null||chrome.signalCode!==null)return resolve();
  const timer=setTimeout(()=>chrome.kill(),5000);
  chrome.once('exit',()=>{clearTimeout(timer);resolve()});
 });
 await new Promise(resolve=>server.close(resolve));
 // Chrome can finish an atomic profile rename just after exiting. Retry the whole traversal.
 for(let attempt=0;attempt<10;attempt++){
  try{fs.rmSync(path.join(output,'profile'),{recursive:true,force:true});break}
  catch(error){if(error.code!=='ENOTEMPTY'||attempt===9)throw error;await new Promise(resolve=>setTimeout(resolve,100))}
 }
});
