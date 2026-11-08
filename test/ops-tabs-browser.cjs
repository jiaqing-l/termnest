'use strict';
// Actual Chrome and product feature host/styles; every API/control action stays inside this synthetic server.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), os = require('node:os'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const publicDir = path.join(__dirname, '../public');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'termnest-ops-tabs-'));
const requests = [], posts = [], opened = [], accountChecks = [];
const now = Date.now();
const states = ['unknown', 'waiting_owner', 'blocked', 'progressing', 'idle', 'stalled', 'completed', 'unknown', 'blocked'];
const codes = ['awaiting_task_progress', 'owner_decision', 'task_blocked', 'task_evidence_changed', 'session_idle', 'no_task_progress', 'task_completed', 'future_reason', 'ownership_conflict'];
const supervision = { enabled:false,autoRecovery:false,intervalMinutes:30,workspaces:[{serverId:'vm1',root:'/work/one'}],runtime:{ready:false,unlocked:true,monitoring:true,registrationReady:false,auditReady:false,reasons:[{code:'skill_missing'}]},servers:Array.from({length:3},(_,i)=>({id:'vm'+(i+1),name:'VM '+(i+1),online:i!==2,observedAt:now-(i===2?600000:1000),freshness:{snapshotFresh:i!==2,maxAgeMs:120000},teams:Array.from({length:3},(_,j)=>{const n=i*3+j;return {id:'team'+n,session:'leader-'+n,root:'/work/'+n,status:states[n],reason:{code:codes[n],params:{untrusted:'DO-NOT-RENDER'}},requiresOwner:[1,2,8].includes(n),lastProgressAt:n===3?now-10000:null,lastAction:n===0?{code:'prompt_delivered',at:now-20000}:n===4?{code:'future_reason',params:{untrusted:'DO-NOT-RENDER'},at:now-20000}:null}}),audits:i===0?[{phase:'timeout',reason:{code:'audit_timeout'},requiresOwner:true}]:i===1?[{phase:'delivered',reason:{code:'prompt_delivered'},verification:'unverified'},{phase:'running',reason:{code:'audit_running'},verification:'unverified'}]:[{phase:'unavailable',reason:{code:'account_missing'},requiresOwner:true}]}))};
supervision.leaders = [];
supervision.registrationCandidates = [{serverId:'vm1',session:'leader-0',root:'/work/edited',identity:{bootId:'fixture-boot',sessionId:'$1',created:1,pane:'%1',agentPid:123,agentStartedAt:1,config:'.claude'}}];
const ruleIds = ['asking','finished','dormant','aborted','unknown','bgjob','quota','exited','overload','lost','offline','unheard'];
const pack = {name:'core',custom:[],rules:Object.fromEntries(ruleIds.map(id=>[id,{level:id==='dormant'?'suggest':'notify',after:30,template:'continue'}])),auto:{perHour:2,quietFrom:'22:00',quietTo:'07:00'},templates:{continue:'Keep the original general rule'}};
const payloads = {'/api/features/ops/board':{servers:[],log:[],pack},'/api/features/plugins/data':{servers:[],autoReload:false}};
let accountFailure = false, accountMode = '', accountSlow = false, accountReadbackMismatch = false;
const accountRef = 'a'.repeat(64);
let getFailure = false, postFailure = false, rereadFailure = false, slowPost = false;
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/features/ops.css"><style>body{overflow:auto}.view.on{display:block}.feature-page{padding-top:16px}.main-top{position:static}</style></head><body><div class="main-top"><div class="seg"><button>Tổng quan</button><button>Terminal</button><button>Token AI</button><button>Ghi chú</button></div></div><section id="v-token"></section><script src="/features-host.js"></script><script>
const locale=${fs.readFileSync(path.join(publicDir,'locales/vi.json'),'utf8')};
window.i18n=(key,args=[])=>String(locale[key]||key).replace(/\\{(\\d+)\\}/g,(_,n)=>args[n]);
window.__ticks=[];window.setInterval=(fn,ms)=>{__ticks.push({fn,ms});return __ticks.length};
window.__refresh=()=>__ticks.filter(x=>x.ms===10000).forEach(x=>x.fn());
TW.attach({api:async(method,url,body)=>{const r=await fetch(url,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});if(!r.ok)throw Error('fixture failure');return r.json()},setView:id=>TW.setView(id),say:()=>{},openSession:(server,session)=>fetch('/opened',{method:'POST',body:JSON.stringify({server,session})})});
</script><script src="/features/crew.js"></script><script src="/features/ops.js"></script></body></html>`;
const server = http.createServer(async(req,res)=>{
 if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end(html)}
 if(req.url==='/opened'){let b='';for await(const c of req)b+=c;opened.push(JSON.parse(b));return res.end('{}')}
 if(req.url.startsWith('/api/')){
  requests.push({method:req.method,url:req.url});res.setHeader('Content-Type','application/json');
  if(req.url==='/api/features/ops/supervision/account'){
   assert.equal(req.method,'POST');let b='';for await(const c of req)b+=c;const body=JSON.parse(b);accountChecks.push(body);
   assert.deepEqual(Object.keys(body).sort(),['auditConfig','root','serverId']);
   if(accountSlow)await new Promise(r=>setTimeout(r,300));
   if(accountFailure||!supervision.workspaces.some(w=>w.serverId===body.serverId&&w.root===body.root)){res.statusCode=409;return res.end('{}')}
   return res.end(JSON.stringify({...body,accountRef,label:'Audit owner',code:accountMode==='skill'?'audit_skill_missing':accountMode==='unknown'?'future_account_reason':'audit_account_registration_required',observedAt:Date.now()-(accountMode==='expired'?61000:0),quota:'unknown',...(accountMode==='scope'?{root:'/wrong/scope'}:{})}));
  }
  if(req.url==='/api/features/ops/supervision'){
   if(req.method==='POST'){
    let b='';for await(const c of req)b+=c;const body=JSON.parse(b);posts.push(body);
    if(slowPost)await new Promise(r=>setTimeout(r,300));
    if(postFailure||body.autoRecovery&&!supervision.runtime.registrationReady&&!supervision.leaders.length&&!body.leaders){res.statusCode=409;return res.end('{"error":"registration required"}')}
    if(body.leaders){assert.deepEqual(body.leaders[0].identity,supervision.registrationCandidates[0].identity);supervision.runtime.registrationReady=true;}
    Object.assign(supervision,body);if(accountReadbackMismatch)supervision.workspaces=body.workspaces.map((w,i)=>i===0?{...w,[accountReadbackMismatch]:accountReadbackMismatch==='auditConfig'?'.claude-mismatch':'c'.repeat(64)}:w);if(rereadFailure)getFailure=true;
   }else if(getFailure){res.statusCode=503;return res.end('{}')}
   return res.end(JSON.stringify(supervision));
  }
  return res.end(JSON.stringify(payloads[req.url]||{}));
 }
 const p=path.resolve(publicDir,'.'+req.url);if(!p.startsWith(publicDir+path.sep)||!fs.existsSync(p)){res.statusCode=404;return res.end()}
 res.setHeader('Content-Type',p.endsWith('.js')?'application/javascript':'text/css');res.end(fs.readFileSync(p));
});
let chrome,ws,chromeError = '';

(async()=>{
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
 const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});assert.ok(!r.exceptionDetails,JSON.stringify(r.exceptionDetails));return r.result.value};
 const until=async(expression,label)=>{for(let i=0;i<100;i++){if(await evaluate(expression))return;await delay(50)}assert.fail('Timed out: '+label)};
 const content=()=>evaluate('document.querySelector(".ops-super-status").textContent');
 const refresh=async()=>{const n=requests.filter(r=>r.url==='/api/features/ops/supervision').length;await evaluate('__refresh()');for(let i=0;i<100&&requests.filter(r=>r.url==='/api/features/ops/supervision').length===n;i++)await delay(20);await delay(60)};
 await send('Runtime.enable');await send('Page.enable');
 await send('Page.navigate',{url:'http://127.0.0.1:'+server.address().port});
 await until('!!document.querySelector("#v-ops .ops-head") && !!document.querySelector(".ops-super-form")','Ops mounted with supervision data');
 assert.equal(await evaluate('document.querySelectorAll("#tab-crew,#v-crew,.ops-crew,.cp-board,.crew-detail").length'),0);
 assert.equal(await evaluate('document.querySelectorAll("#v-ops .ops-plug").length'),0);
 assert.equal(await evaluate('document.querySelectorAll("#v-plugins .ops-plug").length'),1);
 assert.equal(await evaluate('const detail=document.createElement("div");TW.renderDetail(detail,{});detail.children.length'),0);
 await evaluate('document.querySelector("#tab-ops").click()');
 await until('document.querySelector("#v-ops").classList.contains("on")','Ops selected');
 let c=await content();
 assert.equal(c,'Chưa bật','OFF has exactly one status line');
 assert.equal(await evaluate('document.querySelectorAll(".ops-super-teams,.ops-super-row").length'),0,'OFF has no measured team grid or warnings');
 supervision.enabled=true;await refresh();
 assert.equal(await evaluate('document.querySelectorAll(".ops-super-row").length'),2,'only connected sessions requiring the owner are actionable');
 assert.ok(!(await content()).includes('leader-4'),'ordinary idle is not urgent');
 assert.ok(!(await content()).includes('DO-NOT-RENDER'));
 await evaluate('document.querySelector(".ops-super-row button").click()');await delay(40);assert.equal(opened.length,1);assert.equal(opened[0].session,'leader-1');
 supervision.enabled=false;await refresh();
 await evaluate('document.querySelector(".ops-super-settings").open=true;document.querySelector("[name=enabled]").click();document.querySelector("[name=autoRecovery]").click()');
 assert.equal(await evaluate('document.querySelector("[name=save]").disabled'),true,'missing registration prevents recovery');
 await evaluate('document.querySelector("[name=enabled]").click()');
 assert.equal(await evaluate('document.querySelector("[name=save]").disabled'),false,'OFF stays available despite missing recovery prerequisites');
 await evaluate('document.querySelector("[name=enabled]").click()');
 await evaluate('document.querySelector("[name=autoRecovery]").click();document.querySelector("[name=workspaces]").value="vm1 | /work/edited";document.querySelector("[name=workspaces]").dispatchEvent(new Event("input"));document.querySelector("[name=intervalMinutes]").value="45";document.querySelector("[name=intervalMinutes]").dispatchEvent(new Event("input"));document.querySelector("[name=workspaces]").blur()');
 await refresh();
 assert.equal(await evaluate('document.querySelector("[name=workspaces]").value'),'vm1 | /work/edited','text survives redraw after losing focus');
 assert.equal(await evaluate('document.querySelector("[name=intervalMinutes]").value'),'45');
 postFailure=true;slowPost=true;
 await evaluate('document.querySelector("[name=save]").click();document.querySelector("[name=save]").click()');
 assert.equal(await evaluate('document.querySelector("[name=save]").disabled'),true,'pending blocks duplicate POST');
 assert.ok(!(await content()).includes('Đã bật theo dõi tự động'));
 await until('document.querySelector(".ops-super-status").textContent.includes("Không lấy được")','POST failure visible');
 assert.equal(posts.length,1);assert.ok(!(await content()).includes('Đã bật theo dõi tự động'),'no optimistic enabled after failure');
 assert.equal(await evaluate('document.querySelector("[name=workspaces]").value'),'vm1 | /work/edited');
 postFailure=false;slowPost=false;supervision.runtime.registrationReady=true;await refresh();
 await evaluate('document.querySelector("[name=autoRecovery]").click();document.querySelector("[name=save]").click()');
 await until('document.querySelector(".ops-super-status").textContent.includes("Đã bật theo dõi tự động") && !document.querySelector("[name=save]").disabled','POST and GET confirmed enabled');
 assert.deepEqual(posts.at(-1),{enabled:true,autoRecovery:true,intervalMinutes:45,workspaces:[{serverId:'vm1',root:'/work/edited'}]});
 assert.ok(posts.every(p=>!('leaders' in p)&&!('pack' in p)&&!('auto' in p)),'no implicit leader/general-rule updates');
 getFailure=true;await refresh();assert.ok((await content()).includes('Không lấy được'));assert.ok(!(await content()).includes('Đã bật theo dõi tự động'),'GET failure clears enabled state');
 getFailure=false;await refresh();
 rereadFailure=true;await evaluate('document.querySelector("[name=save]").click()');
 await until('document.querySelector(".ops-super-status").textContent.includes("Không lấy được")','successful POST but failed reread stays unavailable');
 assert.ok(!(await content()).includes('Đã bật theo dõi tự động'));
 rereadFailure=false;getFailure=false;await refresh();
 // Explicit registration preserves existing policy and rejects a candidate that changed during editing.
 supervision.runtime.registrationReady=false; await refresh();
 assert.equal(await evaluate('document.querySelector("[name=save]").disabled'),true);
 await evaluate('document.querySelector("[name=leader]").value="0";document.querySelector("[name=leader]").dispatchEvent(new Event("change"));document.querySelector("[name=taskIds]").value="task-one";document.querySelector("[name=confirmLeader]").click()');
 const beforeRegistration=posts.length;
 supervision.registrationCandidates[0].identity.agentPid=124;await refresh();
 await evaluate('document.querySelector("[name=save]").click()');await delay(60);
 assert.equal(posts.length,beforeRegistration,'identity changed during edit cannot register');
 supervision.registrationCandidates[0].identity.agentPid=123;await refresh();
 postFailure=true;await evaluate('document.querySelector("[name=save]").click()');
 await until('document.querySelector(".ops-super-status").textContent.includes("Không lấy được")','registration rejection stays unavailable');
 assert.equal(supervision.leaders.length,0,'failed registration has no effect');
 postFailure=false;await refresh();await evaluate('document.querySelector("[name=save]").click()');
 await until('!document.querySelector("[name=save]").disabled && document.querySelector(".ops-super-status").textContent.includes("Đã bật theo dõi tự động")','registration confirmed');
 assert.deepEqual(posts.at(-1).leaders,[{serverId:'vm1',root:'/work/edited',session:'leader-0',taskIds:['task-one'],identity:supervision.registrationCandidates[0].identity}]);
 assert.equal(supervision.leaders.length,1,'exactly one explicitly selected leader registered');
 assert.ok(!await evaluate('document.querySelector(".ops-super").textContent.includes("fixture-boot")'),'no raw identity in product labels');
 delete supervision.runtime.registrationReady;await refresh();await evaluate('document.querySelector("[name=leader]").value="";document.querySelector("[name=confirmLeader]").checked=false;document.querySelector("[name=leader]").dispatchEvent(new Event("change"))');
 assert.equal(await evaluate('document.querySelector("[name=save]").disabled'),false,'W3 leader/candidate identity contract accepted without optional readiness flags');
 // Real account onboarding contract: saved scopes only, exact identity binding and explicit confirmation.
 const accountText=()=>evaluate('document.querySelector(".ops-super-account").textContent');
 const checkAccount=async()=>{await evaluate('document.querySelector("[name=checkAccount]").click()');await until('!document.querySelector("[name=checkAccount]").disabled','account check settled')};
 const changeProfile=async value=>evaluate('document.querySelector("[name=accountProfile]").value='+JSON.stringify(value)+';document.querySelector("[name=accountProfile]").dispatchEvent(new Event("input"))');
 supervision.workspaces.push({serverId:'vm2',root:'/work/other',auditConfig:'.claude-other',auditAccount:'b'.repeat(64),futureOptional:'preserve'});
 const originalLeaders=structuredClone(supervision.leaders);
 await refresh();
 assert.equal(await evaluate('document.querySelector("[name=accountProfile]").value'),'.claude');
 assert.equal(await evaluate('document.querySelector("[name=confirmAccount]").disabled'),true);
 const beforeCheckPosts=posts.length;
 accountSlow=true;await evaluate('document.querySelector("[name=checkAccount]").click();document.querySelector("[name=checkAccount]").click()');
 assert.equal(await evaluate('document.querySelector("[name=save]").disabled'),true,'account pending also blocks policy writes');
 await until('!document.querySelector("[name=checkAccount]").disabled','slow account check settled');accountSlow=false;
 assert.equal(accountChecks.length,1,'pending discovery deduplicated');
 assert.equal(posts.length,beforeCheckPosts,'discovery does not change saved policy');
 assert.ok(!(await accountText()).includes(accountRef),'opaque reference is not a product label');
 assert.deepEqual(accountChecks.at(-1),{serverId:'vm1',root:'/work/edited',auditConfig:'.claude'});
 assert.ok((await accountText()).includes('Audit owner'));
 assert.ok((await accountText()).includes('Hạn mức chưa được xác minh'));
 assert.equal(await evaluate('document.querySelector("[name=confirmAccount]").disabled'),false);
 await changeProfile('.claude-audit');assert.equal(await evaluate('document.querySelector("[name=confirmAccount]").disabled'),true,'profile edit invalidates identity');
 await refresh();assert.equal(await evaluate('document.querySelector("[name=accountProfile]").value'),'.claude-audit','profile text survives polling');
 await checkAccount();
 await evaluate('document.querySelector("[name=accountWorkspace]").selectedIndex=1;document.querySelector("[name=accountWorkspace]").dispatchEvent(new Event("change"))');
 assert.equal(await evaluate('document.querySelector("[name=confirmAccount]").disabled'),true,'scope edit invalidates identity');
 assert.equal(await evaluate('document.querySelector("[name=accountProfile]").value'),'.claude-other','existing scope profile restored');
 await evaluate('document.querySelector("[name=accountWorkspace]").selectedIndex=0;document.querySelector("[name=accountWorkspace]").dispatchEvent(new Event("change"))');
 await changeProfile('.claude-audit');
 for(const mode of ['skill','unknown','scope','expired']){
  accountMode=mode;await checkAccount();
  assert.equal(await evaluate('document.querySelector("[name=confirmAccount]").disabled'),true,'invalid discovery: '+mode);
  assert.ok(!(await accountText()).includes('future_account_reason'),'unknown reason translated safely');
  if(mode==='skill')assert.ok((await accountText()).includes('Audit owner'),'verified identity stays readable with skill blocker');
 }
 accountMode='';accountSlow=true;await evaluate('document.querySelector("[name=checkAccount]").click()');await changeProfile('.claude-race');await changeProfile('.claude-audit');
 await until('!document.querySelector("[name=checkAccount]").disabled','changed profile response discarded');accountSlow=false;
 assert.equal(await evaluate('document.querySelector("[name=confirmAccount]").disabled'),true,'changed-away-and-back inputs discard in-flight identity');
 await checkAccount();accountFailure=true;await checkAccount();accountFailure=false;
 assert.equal(await evaluate('document.querySelector("[name=confirmAccount]").disabled'),true,'failed check invalidates previous success');
 await checkAccount();supervision.servers[0].online=false;await refresh();
 assert.equal(await evaluate('document.querySelector("[name=confirmAccount]").disabled'),true,'offline invalidates identity');
 supervision.servers[0].online=true;await refresh();
 assert.equal(await evaluate('document.querySelector("[name=confirmAccount]").disabled'),true,'reconnecting requires explicit recheck');
 await checkAccount();getFailure=true;await refresh();getFailure=false;await refresh();
 assert.equal(await evaluate('document.querySelector("[name=confirmAccount]").disabled'),true,'GET failure invalidates identity even after recovery');
 await checkAccount();
 await evaluate('window.__realNow=Date.now;Date.now=()=>__realNow()+61000');await refresh();
 assert.equal(await evaluate('document.querySelector("[name=confirmAccount]").disabled'),true,'identity expires after a minute');
 await evaluate('Date.now=__realNow');
 // Rejected confirmation, mismatching readback, and failed readback cannot show saved.
 await checkAccount();postFailure=true;await evaluate('document.querySelector("[name=confirmAccount]").click()');
 await until('!document.querySelector("[name=checkAccount]").disabled','rejected account confirmation');postFailure=false;
 assert.ok(!(await accountText()).includes('Đã lưu tài khoản'));
 assert.equal(await evaluate('document.querySelector("[name=confirmAccount]").disabled'),true);
 for(const field of ['auditConfig','auditAccount']){
  await checkAccount();accountReadbackMismatch=field;await evaluate('document.querySelector("[name=confirmAccount]").click()');
  await until('!document.querySelector("[name=checkAccount]").disabled','mismatching account readback: '+field);accountReadbackMismatch=false;
  assert.ok(!(await accountText()).includes('Đã lưu tài khoản'));
  assert.equal(await evaluate('document.querySelector("[name=confirmAccount]").disabled'),true);
 }
 await checkAccount();assert.equal(await evaluate('document.querySelector("[name=confirmAccount]").disabled'),false,'valid check before failed readback');rereadFailure=true;await evaluate('document.querySelector("[name=confirmAccount]").click()');
 await until('document.querySelector(".ops-super-status").textContent.includes("Không lấy được")','failed account readback');
 assert.ok(!(await accountText()).includes('Đã lưu tài khoản'));
 rereadFailure=false;getFailure=false;await refresh();
 // Unsaved general settings must not leak into the account-only update.
 await evaluate('document.querySelector("[name=intervalMinutes]").value="88";document.querySelector("[name=intervalMinutes]").dispatchEvent(new Event("input"))');
 supervision.enabled=false;supervision.autoRecovery=false;await refresh();
 const savedPolicy=structuredClone(supervision), beforeConfirmPosts=posts.length;
 await checkAccount();slowPost=true;
 await evaluate('document.querySelector("[name=confirmAccount]").click();document.querySelector("[name=confirmAccount]").click()');
 assert.ok(!(await accountText()).includes('Đã lưu tài khoản'),'no optimistic saved message');
 await until('document.querySelector(".ops-super-account").textContent.includes("Đã lưu tài khoản")','successful account readback');slowPost=false;
 assert.equal(posts.length,beforeConfirmPosts+1,'confirmation pending deduplicated');
 assert.deepEqual(posts.at(-1),{enabled:savedPolicy.enabled,autoRecovery:savedPolicy.autoRecovery,intervalMinutes:savedPolicy.intervalMinutes,workspaces:savedPolicy.workspaces.map((w,i)=>i===0?{...w,auditConfig:'.claude-audit',auditAccount:accountRef}:w)});
 assert.deepEqual(supervision.leaders,originalLeaders,'account confirmation preserves leader registrations');
 assert.equal(await evaluate('document.querySelector("[name=intervalMinutes]").value'),'88','unsaved policy input preserved');
 assert.ok((await accountText()).includes('Hạn mức chưa được xác minh'),'saved identity never implies quota readiness');
 // Ordinary policy updates preserve the saved account and unrelated scope metadata too.
 await evaluate('document.querySelector("[name=workspaces]").value="vm1 | /work/edited\\nvm2 | /work/other";document.querySelector("[name=workspaces]").dispatchEvent(new Event("input"));document.querySelector("[name=save]").click()');
 await until('!document.querySelector("[name=save]").disabled','normal policy readback after onboarding');
 assert.deepEqual(posts.at(-1).workspaces,savedPolicy.workspaces.map((w,i)=>i===0?{...w,auditConfig:'.claude-audit',auditAccount:accountRef}:w));
 assert.deepEqual(supervision.leaders,originalLeaders);
 assert.equal(await evaluate('document.querySelectorAll(".ops-tools button,.ops-expand,.ops-jump,.ops-group summary small").length'),0,'daily header has no duplicate controls or category descriptions');
 // Advanced rules remain editable even after focus leaves the form and several refreshes occur.
 await evaluate('Array.from(document.querySelectorAll(".ops-super-settings > button")).find(b=>b.textContent===i18n("ops.chinh_luat")).click();document.querySelector(".ops-rules textarea").value="Retain this unsaved rule";document.querySelector(".ops-rules textarea").dispatchEvent(new Event("input"));document.querySelector(".ops-rules textarea").blur()');
 await refresh();assert.equal(await evaluate('document.querySelector(".ops-rules textarea").value'),'Retain this unsaved rule');
 assert.equal(await evaluate('document.querySelector(".ops-super-settings").contains(document.querySelector(".ops-rules"))'),true,'rules stay inside collapsed Setup');
 assert.equal(await evaluate('document.querySelectorAll(".ops-edit-rules").length'),1,'polling does not duplicate rule control');
 assert.equal(pack.rules.dormant.level,'suggest');assert.equal(pack.templates.continue,'Keep the original general rule');
 // Accelerated display-only 24-hour fault sequence: this does not exercise the scheduler or establish uptime.
 for(let hour=0;hour<=24;hour++){
  supervision.servers[0].observedAt=Date.now()-(hour===12?600000:1000);
  supervision.servers[1].online=hour!==8;
  await refresh();
  assert.equal(await evaluate('document.querySelectorAll(".ops-super-teams").length'),0,'no theory grid at simulated hour '+hour);
 }
 for(const width of [1440,390]){
  await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width<500});await delay(100);
  await evaluate('document.querySelector("#tab-plugins").click();document.querySelector("#tab-ops").click()');await delay(60);
  assert.equal(await evaluate('document.querySelector("#tab-ops").getAttribute("aria-pressed")'),'true');
  assert.ok(await evaluate('var t=document.querySelector("#tab-ops").getBoundingClientRect(),s=t.width; t.left>=0 && t.right<=innerWidth+1 && s>0'),'selected tab visible at '+width);
  assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'), 'no page overflow at '+width);
  await evaluate('document.querySelector(".ops-super-settings").open=false;document.querySelector("#tab-ops").scrollIntoView({block:"start"})');
  const shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,'ops-'+width+'.png'),Buffer.from(shot.data,'base64'));
  await evaluate('document.querySelector(".ops-super-settings").open=true;document.querySelector(".ops-super-settings").scrollIntoView({block:"start"})');await delay(50);
  assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'),'settings fit at '+width);
  const settings=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,'settings-'+width+'.png'),Buffer.from(settings.data,'base64'));
  await evaluate('document.querySelector(".ops-super-account").scrollIntoView({block:"start"})');
  const account=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,'account-'+width+'.png'),Buffer.from(account.data,'base64'));
 }
 await evaluate('document.querySelector("#tab-plugins").click()');assert.equal(await evaluate('document.querySelector("#v-plugins").classList.contains("on")'),true);
 assert.ok(!requests.some(r=>/\/api\/features\/(crew|crewpack)(\/|$)/.test(r.url)), 'no Crew API polling');
 assert.ok(requests.filter(r=>r.method==='POST').every(r=>['/api/features/ops/supervision','/api/features/ops/supervision/account'].includes(r.url)),'no unrelated backend control actions');
 assert.deepEqual(errors,[]);
 console.log('PASS: actual Chrome; 3 VM; concise OFF and owner actions; registration prerequisites; GET/POST success/failure and reread failure; no optimistic enabled; pending dedupe; scope/profile/identity-bound account check and confirmation, expiry, rejection and readback; unrelated scopes preserved; forms preserved without focus; general rule unchanged; no Crew UI/polling; 1440/390 fit and selected tab visible. Display-only simulated 24-hour sequence, not uptime proof. Artifacts: '+output);
 fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,chrome:executable,requests,posts,accountChecks,opened,errors,simulatedHours:24},null,2));
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{if(ws)ws.close();if(chrome){chrome.kill();await new Promise(r=>{if(chrome.exitCode!==null||chrome.signalCode!==null)return r();chrome.once('exit',r)})}server.close();fs.rmSync(path.join(output,'profile'),{recursive:true,force:true})});
