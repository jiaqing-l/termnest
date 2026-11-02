'use strict';
// Fixture-only Chrome check: production renderer + aggregator, no provider/credential access.
const fs=require('fs'),path=require('path'),http=require('http'),assert=require('assert/strict');
const {spawn}=require('child_process'),WebSocket=require('ws');
const output=process.env.TW_CHROME_ARTIFACTS;if(!output)throw Error('TW_CHROME_ARTIFACTS required');
const fixture=require('./token-seven-fixture')(),scratch=fs.mkdtempSync(path.join(output,'merge-chrome-'));
let chrome,ws,server;const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
 const html=`<!doctype html><html lang="vi"><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><body><div id="stage"><div id="app"><header class="top"><b>Termnest</b><div class="right"></div></header><main><div class="main-top"><div class="seg"></div></div><section id="v-focus"></section></main></div></div><script src="/token-ui.js"></script><script>let scope='all';const ui=TokenUI({scope:()=>scope,view:v=>ui.setView(v),updated(){},prefs:()=>({}),servers:()=>[],api:async()=>{window.fixtureCalls=(window.fixtureCalls||0)+1;const data=await fetch('/fixture').then(r=>r.json());return window.fixtureRefreshing?{...data,scanning:true,refreshing:true,hosts:[{hostId:'remote',hostName:'demo-server',state:'reading',reason:''}]}:data;}});ui.setView('token');ui.poll(true);window.fixtureUI=ui;</script></body></html>`;
 server=http.createServer((req,res)=>{if(req.url==='/fixture'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(fixture));}else if(['/app.css','/token-ui.js'].includes(req.url)){res.setHeader('Content-Type',req.url.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(path.join(__dirname,'../public',req.url)));}else{res.setHeader('Content-Type','text/html');res.end(html);}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+scratch,'about:blank'],{stdio:'ignore'});
 let port;for(let i=0;i<100;i++){try{port=Number(fs.readFileSync(path.join(scratch,'DevToolsActivePort'),'utf8').split('\n')[0]);break;}catch{}await delay(100);}
 assert.ok(port);const target=(await(await fetch('http://127.0.0.1:'+port+'/json')).json()).find(t=>t.type==='page');
 ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.on('open',r));let id=0;const pending=new Map(),errors=[];
 ws.on('message',b=>{const m=JSON.parse(b);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params);});
 const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});
 const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 await send('Runtime.enable');await send('Page.enable');await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});await send('Page.navigate',{url:'http://127.0.0.1:'+server.address().port});
 for(let i=0;i<100;i++){if(await evaluate("document.querySelectorAll('.token-account').length===3"))break;await delay(100);}
 assert.equal(await evaluate("document.querySelectorAll('.token-account').length"),3);assert.equal(fixture.sources.length,7);
 assert.equal(await evaluate("document.querySelectorAll('.token-mini-item').length"),3);
 assert.match(await evaluate("document.querySelector('#v-token').textContent"),/Chưa có phiên/);
 assert.equal(await evaluate("document.querySelector('.token-note').classList.contains('token-action')"),false);
 assert.ok(await evaluate("[...document.querySelectorAll('.token-identity small')].every(n=>n.textContent.includes('Máy này, demo-server'))"));
 assert.ok(await evaluate("document.querySelector('.token-account').title.includes('hết hạn')"));
 assert.match(await evaluate("document.querySelector('tbody').textContent"),/termnest.*Đã đóng/);
 await evaluate("window.originalCard=document.querySelector('.token-account');const section=document.querySelector('#v-token');section.style.height='350px';section.style.overflow='auto';section.scrollTop=180;window.originalScroll=section.scrollTop");
 assert.ok(await evaluate('window.originalScroll>0'));
 await evaluate('fixtureUI.poll(true)');
 assert.ok(await evaluate("document.querySelector('.token-account')===window.originalCard"));
 await evaluate("fixtureUI.setView('over');window.callsBeforeReturn=window.fixtureCalls;fixtureUI.setView('token');fixtureUI.render()");
 assert.ok(await evaluate("window.fixtureCalls===window.callsBeforeReturn&&document.querySelector('.token-account')===window.originalCard&&document.querySelector('#v-token').scrollTop===window.originalScroll"));
 await evaluate('window.fixtureRefreshing=true;fixtureUI.poll(true)');
 assert.ok(await evaluate("document.querySelector('.token-account')===window.originalCard&&document.querySelectorAll('.token-host-unavailable').length===0&&document.querySelector('.token-note').textContent.includes('Đang cập nhật…')&&document.querySelector('#v-token').scrollTop===window.originalScroll"));
 assert.ok(await evaluate("[...document.querySelectorAll('.token-sources')].every(n=>n.title==='Máy này, demo-server'&&getComputedStyle(n).whiteSpace==='normal')"));
 const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});fs.writeFileSync(path.join(output,'token-seven-sources-three-cards.png'),Buffer.from(shot.data,'base64'));
 await evaluate("document.querySelector('select').value='claude';document.querySelector('select').dispatchEvent(new Event('change'))");assert.equal(await evaluate("document.querySelectorAll('.token-account').length"),2);assert.equal(await evaluate("document.querySelectorAll('.token-mini-item').length"),2);
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'chrome-merge-results.json'),JSON.stringify({passed:true,sources:7,cards:3,checks:['merged cards','host labels','null window','errors in tooltip only','project and closed state','mini/filter parity','unchanged DOM','tab scroll retention without polling','refresh inline status','untruncated host list'],fixtureOnly:true},null,2));console.log('Chrome seven sources → three cards PASS');
}
const deadline=setTimeout(()=>{chrome?.kill('SIGKILL');process.exit(1);},60000);
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{clearTimeout(deadline);ws?.close();if(chrome){const done=new Promise(r=>chrome.once('exit',r));chrome.kill();await done;}if(server)await new Promise(r=>server.close(r));fs.rmSync(scratch,{recursive:true,force:true});});
