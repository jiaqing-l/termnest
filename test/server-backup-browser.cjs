
'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),WebSocket=require('ws');
const publicDir=path.join(__dirname,'../public'),output=fs.mkdtempSync(path.join(os.tmpdir(),'termnest-backup-browser-'));
const requests=[],controls=[],runs=[],picked=[];
let failStatus=false,failControl=false,mismatch=false,slow=false,failFiles=false,failPreview=false,missing=false;
const now=Date.now();
const status={enabled:true,intervalMinutes:5,retention:32,storage:{host:'backup-host',path:'/encrypted/backups'},servers:[
{id:'vm1',name:'VM 1',online:true,configured:true,roots:[],includeChats:true,phase:'current',lastSuccessAt:now-10000,lastAttemptAt:now-10000,hasSnapshot:true,files:2,bytes:120,skipped:0,reason:''},
{id:'vm2',name:'VM 2',online:true,configured:true,roots:['/work/second'],includeChats:true,phase:'never',lastSuccessAt:null,lastAttemptAt:null,hasSnapshot:false,files:0,bytes:0,skipped:0,reason:''},
{id:'vm3',name:'VM 3 offline',online:false,configured:true,roots:['/work/third'],includeChats:true,phase:'offline',lastSuccessAt:now-86400000,lastAttemptAt:now-1000,hasSnapshot:true,files:3,bytes:180,skipped:0,reason:'offline'}]};
const pack={name:'core',custom:[],rules:{},auto:{},templates:{}};
const chat=[{type:'user',message:{role:'user',content:'<img src=x onerror="window.__xss=1"> Hello 🦉'}},{type:'assistant',message:{role:'assistant',content:[{type:'text',text:'Claude reply'},{type:'tool_use',name:'hidden-tool'}]}},{type:'event_msg',payload:{type:'agent_message',message:'Codex reply'}},{type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'Codex reply'}]}}].map(x=>JSON.stringify(x)).join('\n');
const longName='/saved/'+('tên-dài-🦉'.repeat(35))+'.jsonl';
const html=`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/features/ops.css"><link rel="stylesheet" href="/features/server-backup.css"><style>body{overflow:auto}.view.on{display:block}.main-top{position:static}</style></head><body><div class="main-top"><div class="seg"><button>Tổng quan</button><button>Terminal</button><button>Token AI</button><button>Ghi chú</button></div></div><section id="v-token"></section><script src="/features-host.js"></script><script>
const locale=${fs.readFileSync(path.join(publicDir,'locales/vi.json'),'utf8')};window.i18n=(key,args=[])=>String(locale[key]||key).replace(/\\{(\\d+)\\}/g,(_,n)=>args[n]);
window.__lang='vi';window.TW_I18N={lang:()=>__lang};window.__ticks=[];window.setInterval=(fn,ms)=>{__ticks.push({fn,ms});return __ticks.length};window.__refresh=()=>__ticks.filter(x=>x.ms===10000).forEach(x=>x.fn());
window.__picks=[];TW.attach({api:async(method,url,body)=>{const r=await fetch(url,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});if(!r.ok)throw Error('fixture');return r.json()},setView:id=>TW.setView(id),say:()=>{},servers:()=>[],openSession:()=>{},browseDir:(id,start,cb)=>{__picks.push({id,start});window.__pick=cb;}});
</script><script src="/features/ops.js"></script><script src="/features/server-backup.js"></script></body></html>`;
const server=http.createServer(async(req,res)=>{
 const u=new URL(req.url,'http://fixture');
 if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end(html)}
 if(u.pathname.startsWith('/api/')){
  requests.push({method:req.method,url:req.url});res.setHeader('Content-Type','application/json');
  if(u.pathname==='/api/features/server-backup/status'){if(failStatus){res.statusCode=503;return res.end('{}')}return res.end(JSON.stringify(status))}
  if(u.pathname==='/api/features/server-backup/control'){
   let b='';for await(const c of req)b+=c;const body=JSON.parse(b);controls.push(body);if(slow)await new Promise(r=>setTimeout(r,250));
   if(failControl){res.statusCode=409;return res.end('{}')}
   if(!mismatch){if('enabled'in body)status.enabled=body.enabled;if(body.servers)for(const conf of body.servers){const s=status.servers.find(s=>s.id===conf.serverId);s.roots=conf.roots;s.includeChats=conf.includeChats;}}
   return res.end(JSON.stringify(status));
  }
  if(u.pathname==='/api/features/server-backup/run'){let b='';for await(const c of req)b+=c;runs.push(JSON.parse(b));res.statusCode=202;return res.end(JSON.stringify({queued:true,serverId:runs.at(-1).serverId}))}
  if(u.pathname==='/api/features/server-backup/snapshots')return res.end(JSON.stringify({snapshots:missing?[]:[{id:'saved-1',serverId:u.searchParams.get('server'),at:now-86400000,complete:true,files:3,bytes:180},{id:'partial',at:now,complete:false,files:1,bytes:30}]}));
  if(u.pathname==='/api/features/server-backup/files'){
   if(failFiles){res.statusCode=503;return res.end('{}')}
   const second=u.searchParams.has('cursor'),search=u.searchParams.get('search');return res.end(JSON.stringify({files:search==='missing'?[]:second?[{id:'binary',path:'/saved/data.bin',kind:'file',size:20}]:[{id:'chat',path:longName,kind:'chat',tool:'claude',size:2000000},{id:'text',path:'/saved/<script>.txt',kind:'file',size:100}],nextCursor:second||search?'': '2',total:3}));
  }
  if(u.pathname==='/api/features/server-backup/preview'){
   if(failPreview){res.statusCode=422;return res.end('{}')}
   const id=u.searchParams.get('file');return res.end(JSON.stringify({path:id==='chat'?longName:id,kind:id==='chat'?'chat':'file',text:id==='chat'?chat:id==='binary'?null:'<script>window.__xss=2</script>',size:2000000,binary:id==='binary',truncated:id==='chat'}));
  }
  if(['/api/features/server-backup/download','/api/features/server-backup/export'].includes(u.pathname)){res.setHeader('Content-Type','application/octet-stream');return res.end('fixture complete original')}
  if(req.url==='/api/features/ops/board')return res.end(JSON.stringify({servers:status.servers.map((s,i)=>({id:s.id,name:s.name,online:s.online,sessions:[],findings:i===2?[{rule:'offline',key:'offline',session:'',severity:'warn',params:[],since:30}]:[{rule:'finished',key:'idle',session:'ordinary-idle',severity:'urgent',params:[],since:30}]})),log:[],pack}));
  if(req.url==='/api/features/ops/supervision')return res.end(JSON.stringify({enabled:false,autoRecovery:false,intervalMinutes:30,servers:[],workspaces:[]}));
  if(req.url==='/api/features/plugins/data')return res.end('{"servers":[],"autoReload":false}');
  return res.end('{}');
 }
 const p=path.resolve(publicDir,'.'+u.pathname);if(!p.startsWith(publicDir+path.sep)||!fs.existsSync(p)){res.statusCode=404;return res.end()}
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
 const refresh=async()=>{const count=requests.filter(r=>r.url==='/api/features/server-backup/status').length;await evaluate('__refresh()');await until('true','tick');for(let i=0;i<100&&requests.filter(r=>r.url==='/api/features/server-backup/status').length===count;i++)await delay(20);await delay(80)};
 const row=id=>'document.querySelector(\'.backup-row[data-server="'+id+'"]\')';
 const click=async(id,label)=>evaluate('Array.from('+row(id)+'.querySelectorAll("button")).find(b=>b.textContent==='+JSON.stringify(label)+').click()');
 const text=()=>evaluate('document.querySelector(".backup-card").textContent');
 const close=()=>evaluate('document.querySelector(".backup-dialog button").click()');
 await send('Runtime.enable');await send('Page.enable');await send('Page.navigate',{url:'http://127.0.0.1:'+server.address().port});
 await until('document.querySelectorAll(".backup-row").length===3','three backup rows');
 await evaluate('document.querySelector("#tab-ops").click()');
 assert.equal(await evaluate('document.querySelectorAll("#tab-server-backup,#tab-crew,.ops-super-teams").length'),0);
 assert.ok((await evaluate('document.querySelector(".ops-title").textContent')).includes('Máy: 3 · Đã kết nối: 2'));
 assert.equal(await evaluate('document.querySelectorAll(".ops-group .ops-row").length'),1,'ordinary finished/idle findings excluded');
 assert.equal(await evaluate('document.querySelectorAll(".ops-group .ops-row button").length'),2,'offline reconnect and dismiss');
 assert.ok((await text()).includes('Chỉ chat'));
 assert.equal(await evaluate('document.querySelector(".backup-destination").textContent'),'Máy lưu: backup-host');
 assert.equal(await evaluate('document.querySelector(".backup-settings").open'),false);
 assert.equal(await evaluate('document.querySelector(".backup-storage-path").textContent'),'Thư mục lưu: /encrypted/backups');
 assert.ok(await evaluate(row('vm3')+'.textContent.includes("Chat · 1 thư mục")'));
 assert.ok(!(await evaluate(row('vm3')+'.querySelectorAll("p")[1].textContent')).includes('/work/third'),'root paths stay inside folder controls');
 // Locale deliberately differs from Chrome default; all saved times use selected app language.
 for (const lang of ['vi','en']) {
  await evaluate('window.__lang='+JSON.stringify(lang));await refresh();
  const expected=await evaluate('new Date('+status.servers[2].lastSuccessAt+').toLocaleString('+JSON.stringify(lang)+',{dateStyle:"short",timeStyle:"short"})');
  assert.equal(await evaluate(row('vm3')+'.querySelector("p").textContent'),'Bản sao gần nhất: '+expected);
 }
 await evaluate('window.__lang="vi"');await refresh();
 assert.equal(await evaluate('document.querySelectorAll(".ops-expand,.ops-jump,.ops-tools button,.ops-group summary small").length'),0);
 assert.ok(await evaluate(row('vm2')+'.textContent.includes("Chưa có bản sao lưu")'));
 assert.equal(await evaluate('Array.from('+row('vm3')+'.querySelectorAll("button")).find(b=>b.textContent==="Sao lưu ngay").disabled'),true);
 const offlineCopy=structuredClone(status.servers[2]);status.servers[2].hasSnapshot=false;status.servers[2].lastSuccessAt=null;await refresh();
 assert.ok(await evaluate('document.querySelector(\'.backup-row[data-server="vm3"]\').textContent.includes("Chưa có bản sao lưu")') ,'offline never has no fabricated backup');Object.assign(status.servers[2],offlineCopy);await refresh();
 // Offline saved reads use only encrypted backup endpoints, never the source viewer.
 await click('vm3','Xem chat');await until('document.querySelectorAll(".backup-file-list button").length===1','offline chat files');
 await evaluate('document.querySelector(".backup-file-list button").click()');await until('document.querySelector(".backup-preview").textContent.includes("Claude reply")','chat parsed');
 let preview=await evaluate('document.querySelector(".backup-preview").textContent');
 assert.ok(preview.includes('<img src=x'));assert.ok(preview.includes('Chỉ hiển thị một phần'));assert.ok(!preview.includes('MiB'));assert.ok(preview.includes('Tải bản gốc đầy đủ'));assert.equal(preview.split('Codex reply').length-1,1,'Codex duplicate hidden');assert.ok(!preview.includes('hidden-tool'));
 assert.equal(await evaluate('document.querySelectorAll(".backup-preview img,.backup-preview script").length'),0);assert.equal(await evaluate('window.__xss'),undefined);
 let links=await evaluate('Array.from(document.querySelectorAll(".backup-dialog a")).map(a=>new URL(a.href).pathname)');
 assert.deepEqual(links,['/api/features/server-backup/export','/api/features/server-backup/download']);
 assert.ok(await evaluate('Array.from(document.querySelectorAll(".backup-dialog a")).every(a=>new URL(a.href).origin===location.origin && new URL(a.href).searchParams.get("server")==="vm3")'));
 assert.equal(await evaluate('fetch(document.querySelector(".backup-preview a").href).then(r=>r.text())'),'fixture complete original');
 assert.equal(await evaluate('fetch(document.querySelector(".backup-dialog a").href).then(r=>r.text())'),'fixture complete original');
 for(const width of [1440,390]){
  await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width<500});await delay(80);
  assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'),'page fits '+width);
  assert.ok(await evaluate('document.querySelector(".backup-dialog").scrollWidth<=document.querySelector(".backup-dialog").clientWidth'),'long UTF8 names fit dialog '+width);
  const shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,'saved-chat-'+width+'.png'),Buffer.from(shot.data,'base64'));
 }
 await close();
 await click('vm3','Tải file');await until('document.querySelectorAll(".backup-file-list button").length===2','all saved files');
 await evaluate('document.querySelectorAll(".backup-file-list button")[1].click()');await until('document.querySelector(".backup-preview pre")','text preview');
 assert.equal(await evaluate('document.querySelectorAll(".backup-preview script").length'),0);
 await evaluate('Array.from(document.querySelectorAll(".backup-dialog button")).find(b=>b.textContent==="Xem thêm").click()');await until('document.querySelectorAll(".backup-file-list button").length===3','paged files');
 await evaluate('document.querySelectorAll(".backup-file-list button")[2].click()');await until('document.querySelector(".backup-preview").textContent.includes("Tệp nhị phân")','binary download');assert.equal(await evaluate('document.querySelectorAll(".backup-preview pre").length'),0);
 failPreview=true;await evaluate('document.querySelector(".backup-file-list button").click()');await until('document.querySelector(".backup-preview").textContent.includes("Không đọc được")','corrupt preview failure');assert.equal(await evaluate('new URL(document.querySelector(".backup-preview a").href).pathname'),'/api/features/server-backup/download','original remains downloadable when preview is corrupt');failPreview=false;
 failFiles=true;await evaluate('document.querySelector(".backup-dialog input").value="missing";document.querySelector(".backup-dialog input").dispatchEvent(new Event("input"))');await until('document.querySelector(".backup-dialog").textContent.includes("Không đọc được")','file list error');failFiles=false;
 await evaluate('document.querySelector(".backup-dialog input").dispatchEvent(new Event("input"))');await until('document.querySelector(".backup-dialog").textContent.includes("Không có tệp phù hợp")','empty search');await close();
 missing=true;await click('vm3','Xem chat');await until('document.querySelector(".backup-dialog").textContent.includes("Chưa có bản sao lưu")','missing snapshot');await close();missing=false;
 // Clean scopes follow backend changes; dirty scopes remain drafts.
 status.servers[1].roots=['/work/second-new'];await refresh();
 assert.ok(await evaluate(row('vm2')+'.querySelector(".backup-roots").textContent.includes("/work/second-new")'));
 status.servers[1].roots=['/work/second'];await refresh();
 // Folders are explicit, picker stays on the selected connected VM, and all three configs survive.
 await evaluate(row('vm1')+'.querySelector("details").open=true');await click('vm1','Chọn thư mục trên máy');
 assert.deepEqual(await evaluate('__picks'),[{id:'vm1',start:''}]);
 await evaluate('__pick("/work/selected");');await refresh();
 assert.ok(await evaluate(row('vm1')+'.querySelector(".backup-roots").textContent.includes("/work/selected")'),'unsaved selection survives polling');
 slow=true;failControl=true;await click('vm1','Lưu lựa chọn');await click('vm1','Lưu lựa chọn');
 assert.equal(await evaluate('Array.from('+row('vm1')+'.querySelectorAll("button")).find(b=>b.textContent==="Lưu lựa chọn").disabled'),true);
 await until('document.querySelector(".backup-card").textContent.includes("dữ liệu trước đó")','rejected control marks prior data');
 assert.equal(controls.length,1);assert.ok(await evaluate(row('vm1')+'.querySelector(".backup-roots").textContent.includes("/work/selected")'));
 failControl=false;slow=false;await refresh();
 mismatch=true;await click('vm1','Lưu lựa chọn');await until('document.querySelector(".backup-card").textContent.includes("dữ liệu trước đó")','mismatched readback is unavailable');mismatch=false;await refresh();
 await click('vm1','Lưu lựa chọn');await until('!document.querySelector(".backup-card").textContent.includes("dữ liệu trước đó") && Array.from(document.querySelectorAll(".backup-row button")).some(b=>b.textContent==="Lưu lựa chọn"&&!b.disabled)','successful root readback');
 assert.deepEqual(controls.at(-1),{enabled:true,servers:[{serverId:'vm1',roots:['/work/selected'],includeChats:true},{serverId:'vm2',roots:['/work/second'],includeChats:true},{serverId:'vm3',roots:['/work/third'],includeChats:true}]});
 const picks=await evaluate('__picks.length');await click('vm3','Chọn thư mục trên máy');assert.equal(await evaluate('__picks.length'),picks,'offline folder picker unavailable');
 // A 202 never changes the displayed last-good time or enables another request.
 const oldGood=status.servers[0].lastSuccessAt;await click('vm1','Sao lưu ngay');await until('document.querySelector(".backup-card").textContent.includes("Đang chờ")','queued state');await click('vm1','Sao lưu ngay');assert.equal(runs.length,1);assert.equal(status.servers[0].lastSuccessAt,oldGood);
 status.servers[0].phase='error';status.servers[0].lastAttemptAt=now+100;status.servers[0].reason='secret_internal_code';await refresh();assert.ok((await text()).includes('Lần thử'));assert.ok(!(await text()).includes('secret_internal_code'));assert.equal(status.servers[0].lastSuccessAt,oldGood);
 status.servers[0].phase='partial';status.servers[0].reason='storage_error';await refresh();assert.ok((await text()).includes('Lần thử'));
 const caption=await evaluate(row('vm1')+'.querySelector(".backup-warning").textContent');
 assert.ok(caption.endsWith('Không ghi được bản lưu; kiểm tra máy lưu.'));assert.ok(!caption.includes('chưa hoàn tất'));
 // Pause keeps the saved copies; failure and mismatched readback cannot confirm it.
 await evaluate('document.querySelector(".backup-settings").open=true');
 failControl=true;await evaluate('document.querySelector(".backup-settings button").click()');await until('document.querySelector(".backup-card").textContent.includes("dữ liệu trước đó")','pause rejection');failControl=false;await refresh();assert.equal(status.enabled,true);
 slow=true;await evaluate('document.querySelector(".backup-settings button").click()');assert.ok(!(await text()).includes('Tự động đã tạm dừng'));await until('document.querySelector(".backup-card").textContent.includes("Tự động đã tạm dừng")','pause confirmed');slow=false;assert.equal(status.servers[2].hasSnapshot,true);
 failStatus=true;await evaluate('document.querySelector(".backup-settings button").click()');await until('document.querySelector(".backup-card").textContent.includes("dữ liệu trước đó")','successful POST but failed backup readback');assert.ok(!(await text()).includes('Tự động đang bật'));failStatus=false;await refresh();
 failStatus=true;await refresh();assert.ok((await text()).includes('dữ liệu trước đó'));assert.ok(!(await text()).includes('Tự động đang bật'));failStatus=false;await refresh();
 // Final daily screenshots: three machines, monitoring OFF, offline last-good, no theory/Crew.
 for(const width of [1440,390]){
  await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width<500});
  await evaluate('document.querySelectorAll(".backup-scope,.backup-settings,.ops-super-settings").forEach(d=>d.open=false);document.querySelector("#tab-plugins").click();document.querySelector("#tab-ops").click();document.querySelector("#tab-ops").scrollIntoView({block:"start",inline:"nearest"})');await delay(100);
  assert.equal(await evaluate('document.querySelector("#tab-ops").getAttribute("aria-pressed")'),'true');
  assert.ok(await evaluate('var r=document.querySelector("#tab-ops").getBoundingClientRect();r.left>=0&&r.right<=innerWidth+1'),'selected tab visible '+width);
  assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'),'daily page fits '+width);
  const shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,'backups-'+width+'.png'),Buffer.from(shot.data,'base64'));
 }
 assert.ok(requests.filter(r=>r.url.includes('/api/features/server-backup/')).every(r=>!r.url.includes('/source/')));
 assert.deepEqual(errors,[]);
 fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,chrome:executable,requests,controls,runs,errors},null,2));
 console.log('PASS: actual Chrome backup UI; 3 VMs/1 offline, OFF concise, normal idle excluded; saved chat/text/XSS/binary, pagination/search, original/export URLs, missing/corrupt/error/partial/prior states, queue 202, rejected and mismatched settings readback, pending dedupe, explicit picker and all server scopes preserved, 1440/390 screenshots. Artifacts: '+output);
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{if(ws)ws.close();if(chrome){chrome.kill();await new Promise(r=>{if(chrome.exitCode!==null||chrome.signalCode!==null)return r();chrome.once('exit',r)})}server.close();fs.rmSync(path.join(output,'profile'),{recursive:true,force:true})});
