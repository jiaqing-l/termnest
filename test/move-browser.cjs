'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),WebSocket=require('ws');
const publicDir=path.join(__dirname,'../public'),output=fs.mkdtempSync(path.join(os.tmpdir(),'termnest-move-browser-'));
const html=`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/features/move.css"></head><body><div id="detail"></div><dialog id="dlg-dir"><p>Fixture folder browser</p><button id="pick-dir">Select folder</button><button id="cancel-dir">Cancel</button></dialog><script src="/features-host.js"></script><script>
const locale=${fs.readFileSync(path.join(publicDir,'locales/vi.json'),'utf8')};window.i18n=(key,args=[])=>String(locale[key]||key).replace(/\\{(\\d+)\\}/g,(_,n)=>args[n]);
window.__requests=[];window.__picks=[];window.__pending=[];window.__slow=false;window.__pick=null;
window.__servers=[{id:'a',name:'Source',on:true},{id:'b',name:'Target B',on:true},{id:'c',name:'Target C',on:true}];
TW.attach({servers:()=>__servers,openSession:()=>{},browseDir:(id,start,cb)=>{__picks.push({id,start});__pick=cb;document.querySelector('#dlg-dir').showModal()},api:async(method,url,body)=>{
 __requests.push({method,url,body});if(method==='POST'){await new Promise(resolve=>window.__finishPost=resolve);return {ok:true,name:body.name,dir:body.dir,bytes:100}}
 if(__slow)await new Promise(resolve=>__pending.push(resolve));
 const q=new URL(url,location.origin).searchParams,to=q.get('to'),targetProfile=q.get('targetProfile')||'/'+to+'/.claude';
 return {tool:'claude',from:'same@fixture.invalid',to:'same@fixture.invalid',same:true,size:100,tooLarge:false,source:'/source/work',profile:'/source/.claude-agent03',targetProfile,targetProfiles:['/'+to+'/.claude','/'+to+'/.claude-agent07'],receipt:'receipt-'+__requests.length,places:[],home:'/'+to,name:'smart-2'};
}});
document.querySelector('#pick-dir').onclick=()=>{document.querySelector('#dlg-dir').close();const cb=__pick;__pick=null;cb('/empty/non-git-workspace')};document.querySelector('#cancel-dir').onclick=()=>document.querySelector('#dlg-dir').close();
</script><script src="/features/move.js"></script><script>TW.renderDetail(document.querySelector('#detail'),{v:__servers[0],s:{name:'smart',path:'/source/work',cmd:'claude',aiTool:'claude'}});</script></body></html>`;
const server=http.createServer((req,res)=>{if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end(html)}const p=path.resolve(publicDir,'.'+new URL(req.url,'http://fixture').pathname);if(!p.startsWith(publicDir+path.sep)||!fs.existsSync(p)){res.statusCode=404;return res.end()}res.setHeader('Content-Type',p.endsWith('.js')?'application/javascript':'text/css');res.end(fs.readFileSync(p))});
let chrome,ws,closeBrowser,chromeError = '';

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
 closeBrowser=()=>send('Browser.close');
 const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});assert.ok(!r.exceptionDetails,JSON.stringify(r.exceptionDetails));return r.result.value};
 const until=async(expression,label)=>{for(let i=0;i<100;i++){if(await evaluate(expression))return;await delay(50)}assert.fail('Timed out: '+label)};
 await send('Runtime.enable');await send('Page.enable');await send('Page.navigate',{url:'http://127.0.0.1:'+server.address().port});
 await until('document.querySelector(".mv-detail button")','move entry');
 await evaluate('document.querySelector(".mv-detail button").click()');
 await until('document.querySelector(".mv-checks").textContent.includes("same@fixture.invalid")','survey');
 const controls=`(()=>{const selects=document.querySelectorAll('.mv-row select');return {target:selects[1],profile:selects[2],place:selects[3],name:document.querySelector('.mv-row input'),go:document.querySelector('.mv-actions button[type=submit]'),rewrite:document.querySelectorAll('.mv-opt input')[0],stop:document.querySelectorAll('.mv-opt input')[1],browse:document.querySelector('.mv-row button')}})()`;
 assert.equal(await evaluate(controls+'.go.disabled'),true,'no suggestion cannot submit');
 assert.equal(await evaluate(controls+'.browse.disabled'),false,'browse remains reachable with no suggestion');
 await evaluate(`{const c=${controls};c.target.value='c';c.target.onchange()}`);
 await until('document.querySelectorAll(".mv-row select")[2].value==="/c/.claude"','target C check');
 await evaluate(`{const c=${controls};c.name.value='my-draft';c.name.oninput();c.stop.checked=true;c.rewrite.checked=false;c.profile.value='/c/.claude-agent07';c.profile.onchange()}`);
 await until('document.querySelector(".mv-checks").textContent.includes("/c/.claude-agent07")','explicit target profile check');
 await evaluate(controls+'.browse.click()');
 assert.deepEqual(await evaluate('__picks.at(-1)'),{id:'c',start:'/c'});
 assert.equal(await evaluate(controls+'.go.disabled'),true,'picker pending blocks transfer');
 await evaluate('__slow=true;document.querySelector("#pick-dir").click()');
 assert.equal(await evaluate(controls+'.target.value'),'c'); assert.equal(await evaluate(controls+'.profile.value'),'/c/.claude-agent07');
 assert.equal(await evaluate(controls+'.name.value'),'my-draft'); assert.equal(await evaluate(controls+'.stop.checked'),true); assert.equal(await evaluate(controls+'.rewrite.checked'),false);
 assert.equal(await evaluate(controls+'.go.disabled'),true,'fresh survey must finish after selecting an empty folder');
 await evaluate('__slow=false;__pending.splice(0).forEach(r=>r())');
 await until('document.querySelector(".mv-actions button[type=submit]").disabled===false','fresh picker survey');
 assert.equal(await evaluate(controls+'.place.value'),'/empty/non-git-workspace');
 // Cancellation and survey refresh also preserve all pending choices.
 await evaluate(controls+'.browse.click()');await evaluate('document.querySelector("#cancel-dir").click()');
 await until('document.querySelector(".mv-actions button[type=submit]").disabled===false','cancel picker fresh check');
 assert.equal(await evaluate(controls+'.place.value'),'/empty/non-git-workspace'); assert.equal(await evaluate(controls+'.name.value'),'my-draft');
 for(const width of [1440,390]) {
  await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width<500});await delay(60);
  assert.ok(await evaluate('document.querySelector(".mv-dlg").scrollWidth<=document.querySelector(".mv-dlg").clientWidth'),'dialog fits '+width);
  const shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,'move-'+width+'.png'),Buffer.from(shot.data,'base64'));
 }
 await evaluate(controls+'.go.click()');
 await until('__requests.some(r=>r.method==="POST")','move request');
 const body=await evaluate('__requests.find(r=>r.method==="POST").body');
 assert.equal(body.to,'c');assert.equal(body.dir,'/empty/non-git-workspace');assert.equal(body.name,'my-draft');assert.equal(body.stop,true);assert.equal(body.rewrite,false);assert.equal(body.targetProfile,'/c/.claude-agent07');assert.equal(body.profile,'/source/.claude-agent03');assert.ok(body.receipt.startsWith('receipt-'));
 assert.equal(await evaluate(controls+'.target.disabled'),true);
 assert.equal(await evaluate(controls+'.go.disabled'),true);
 await evaluate(controls+'.name.oninput()');assert.equal(await evaluate(controls+'.go.disabled'),true,'input events cannot reenable a pending transfer');
 await evaluate('__finishPost()');await until('document.querySelector(".mv-done")','transfer response');
 assert.deepEqual(errors,[]);
 fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,body,errors},null,2));
 console.log('PASS: actual Chrome move UI; empty non-git browse, target/profile/name/options drafts, pending/cancel freshness, 1440/390; artifacts: '+output);
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{
 if(closeBrowser&&chrome&&chrome.exitCode===null){try{await closeBrowser()}catch{chrome.kill()}}
 if(ws)ws.close();
 if(chrome)await new Promise(resolve=>{if(chrome.exitCode!==null||chrome.signalCode!==null)return resolve();const timer=setTimeout(()=>chrome.kill(),5000);chrome.once('exit',()=>{clearTimeout(timer);resolve()})});
 await new Promise(resolve=>server.close(resolve));
 for(let attempt=0;attempt<10;attempt++){try{fs.rmSync(path.join(output,'profile'),{recursive:true,force:true});break}catch(error){if(error.code!=='ENOTEMPTY'||attempt===9)throw error;await new Promise(resolve=>setTimeout(resolve,100))}}
});
