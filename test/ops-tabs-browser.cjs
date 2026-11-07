'use strict';
// Isolated browser regression: actual feature host, renderer and styles, synthetic API data.
const fs = require('fs'), path = require('path'), http = require('http'), assert = require('assert/strict');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const publicDir = path.join(__dirname, '../public');
const output = fs.mkdtempSync('/private/tmp/termnest-ops-tabs-');
const requests = [];
const payloads = {
 '/api/features/ops/board':{servers:[],log:[],pack:{rules:{}}},
 '/api/features/plugins/data':{servers:[],autoReload:false},
};
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/features/ops.css"><style>body{overflow:auto}.view.on{display:block}.feature-page{padding-top:16px}.main-top{position:static}</style></head><body><div class="main-top"><div class="seg"><button>Tổng quan</button><button>Terminal</button><button>Token AI</button><button>Ghi chú</button></div></div><section id="v-token"></section><script src="/features-host.js"></script><script>
const locale=${fs.readFileSync(path.join(publicDir,'locales/vi.json'),'utf8')};
window.i18n=(key,args=[])=>String(locale[key]||key).replace(/\\{(\\d+)\\}/g,(_,n)=>args[n]);
TW.attach({api:async(method,url,body)=>{const r=await fetch(url,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});if(!r.ok)throw Error(url);return r.json()},setView:id=>TW.setView(id),say:()=>{},openSession:()=>{}});
</script><script src="/features/crew.js"></script><script src="/features/ops.js"></script></body></html>`;
const server = http.createServer((req,res)=>{
 if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end(html)}
 if(req.url.startsWith('/api/')){requests.push(req.url);res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(payloads[req.url]||{}))}
 const p=path.join(publicDir,req.url);if(!p.startsWith(publicDir)||!fs.existsSync(p)){res.statusCode=404;return res.end()}
 res.setHeader('Content-Type',p.endsWith('.js')?'application/javascript':'text/css');res.end(fs.readFileSync(p));
});
let chrome,ws;
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+path.join(output,'profile'),'about:blank'],{stdio:'ignore'});
 const delay=ms=>new Promise(r=>setTimeout(r,ms));
 const portFile=path.join(output,'profile/DevToolsActivePort');
 for(let i=0;i<100&&!fs.existsSync(portFile);i++)await delay(100);
 const port=fs.readFileSync(portFile,'utf8').split('\n')[0];
 const target=(await(await fetch('http://127.0.0.1:'+port+'/json')).json()).find(x=>x.type==='page');
 ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.on('open',r));
 let seq=0;const pending=new Map(),errors=[];
 ws.on('message',b=>{const m=JSON.parse(b);if(m.id){pending.get(m.id)(m.result);pending.delete(m.id)}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text)});
 const send=(method,params={})=>new Promise(r=>{const id=++seq;pending.set(id,r);ws.send(JSON.stringify({id,method,params}))});
 const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});assert.ok(!r.exceptionDetails,JSON.stringify(r.exceptionDetails));return r.result.value};
 await send('Runtime.enable');await send('Page.enable');
 await send('Page.navigate',{url:'http://127.0.0.1:'+server.address().port});
 for(let i=0;i<100;i++){if(await evaluate('!!document.querySelector("#v-ops .ops-head") && !!document.querySelector("#v-plugins .ops-plug")'))break;await delay(100)}
 assert.equal(await evaluate('document.querySelectorAll("#tab-crew,#v-crew,.ops-crew,.cp-board,.crew-detail").length'),0);
 assert.equal(await evaluate('document.querySelectorAll("#v-ops .ops-plug").length'),0);
 assert.equal(await evaluate('document.querySelectorAll("#v-plugins .ops-plug").length'),1);
 assert.equal(await evaluate('const detail=document.createElement("div");TW.renderDetail(detail,{});detail.children.length'),0);
 await evaluate('document.querySelector("#tab-ops").click()');
 assert.equal(await evaluate('document.querySelector("#v-ops").classList.contains("on")'),true);
 for(const width of [1440,390]){
  await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width<500});
  await delay(100);
  assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'), 'no horizontal page overflow at '+width);
  const shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,'ops-'+width+'.png'),Buffer.from(shot.data,'base64'));
 }
 await evaluate('document.querySelector("#tab-plugins").click()');
 assert.equal(await evaluate('document.querySelector("#v-plugins").classList.contains("on")'),true);
 assert.ok(!requests.some(url=>/\/api\/features\/(crew|crewpack)(\/|$)/.test(url)), 'no Crew API polling');
 assert.deepEqual(errors,[]);console.log('PASS: Crew tab/panels absent, no Crew API polling, Ops and plugins work, 1440/390 no overflow. Artifacts: '+output);
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{if(ws)ws.close();if(chrome)chrome.kill();server.close()});
