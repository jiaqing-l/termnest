'use strict';
// Run: node test/capture-readme.cjs (dependencies must be installed; CHROME may override the executable).
// Real application/UI/auth/WebSocket/Markdown; invented backend and token data, isolated HOME.
const fs=require('fs'), path=require('path'), os=require('os'), assert=require('assert/strict');
const {spawn}=require('child_process');
const net=require('net');
const WebSocket=require('ws');
const {Vault}=require('../lib/vault');
const root=path.resolve(__dirname,'..'), output=process.env.CAPTURE_OUT?path.resolve(process.env.CAPTURE_OUT):path.join(root,'docs/images');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'tmux-readme-'));
const children=[]; let cdp, appLog='';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const password='demo-screenshot-password', id='11111111-1111-4111-8111-111111111111';
async function main(){
  fs.mkdirSync(output,{recursive:true});
  const reservation=net.createServer();
  await new Promise(r=>reservation.listen(0,'127.0.0.1',r));
  const port=reservation.address().port;await new Promise(r=>reservation.close(r));
  const origin='http://127.0.0.1:'+port;
  const data=path.join(scratch,'data');
  new Vault(path.join(data,'vault.json')).create(password,{servers:[{id,name:'demo-server',host:'192.0.2.10',port:22,user:'demo',auth:'password'}]});
  // An allowlisted environment prevents inheriting account/profile settings. The preload never executes commands.
  const env={PATH:process.env.PATH,NODE_PATH:process.env.NODE_PATH,HOME:scratch,USERPROFILE:scratch,TMPDIR:scratch,TW_DATA:data,TW_PORT:String(port),TW_POLL_MS:'1000',TW_DEFAULT_DIR:'/workspace/demo',TZ:'Asia/Ho_Chi_Minh'};
  const app=spawn(process.execPath,['--require',path.join(__dirname,'readme-fixture.cjs'),'server.js'],{cwd:root,env,stdio:['ignore','pipe','pipe']});children.push(app);
  app.stdout.on('data',b=>appLog+=b);app.stderr.on('data',b=>appLog+=b);
  for(let i=0;i<80&&!appLog.includes('Termnest:');i++){assert.equal(app.exitCode,null,'Fixture server must stay running');await delay(100);}
  assert.ok(appLog.includes('Termnest: '+origin),'Only connect after our isolated server binds');
  const executable=process.env.CHROME || (process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':'google-chrome');
  const chrome=spawn(executable,['--headless=new','--disable-gpu','--disable-extensions','--no-first-run','--no-default-browser-check','--disable-background-networking','--remote-debugging-port=0','--user-data-dir='+path.join(scratch,'profile'),'about:blank'],{env,stdio:'ignore'});children.push(chrome);
  chrome.on('error',e=>{appLog+='\nChrome: '+e.message;});
  let target;for(let i=0;i<80;i++){try{const debugPort=fs.readFileSync(path.join(scratch,'profile','DevToolsActivePort'),'utf8').split('\n')[0];target=(await(await fetch('http://127.0.0.1:'+debugPort+'/json',{signal:AbortSignal.timeout(1000)})).json()).find(t=>t.type==='page');if(target)break;}catch{}await delay(100);}
  assert.ok(target,'Headless Chrome must start');
  cdp=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>cdp.on('open',r));
  let seq=0;const pending=new Map(),errors=[];
  cdp.on('message',b=>{const m=JSON.parse(b);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);});
  const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++seq;pending.set(n,{resolve,reject});cdp.send(JSON.stringify({id:n,method,params}));});
  const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  const until=async expression=>{for(let i=0;i<100;i++){if(await evaluate(expression))return;await delay(100);}throw Error('Timed out: '+expression+'\n'+await evaluate('document.body.innerText.slice(0,2000)'));};
  await send('Runtime.enable');await send('Page.enable');
  // Block all external resources, including fonts. No documentation capture contacts another host.
  await send('Network.enable');await send('Network.setBlockedURLs',{urls:['https://*','http://192.0.2.*']});
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await send('Page.addScriptToEvaluateOnNewDocument',{source:"window.__terms=[];let T;Object.defineProperty(window,'Terminal',{configurable:true,get:()=>T,set:value=>{T=class extends value{constructor(...args){super(...args);window.__terms.push(this)}}}});"});
  const screenshot=async (name,selector=null)=>{
    await evaluate('document.fonts.ready');await delay(600);
    assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'),'No page overflow');
    const text=await evaluate('document.body.innerText');
    assert.ok(!/(?:\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b|\b192\.168\.\d{1,3}\.\d{1,3}\b|\/Users\/|\/home\/|C:\\Users\\|SECRET)/i.test(text),'No private fixture data');
    const clip=selector?await evaluate("(()=>{const r=document.querySelector("+JSON.stringify(selector)+").getBoundingClientRect();return{x:Math.floor(r.x)-8,y:Math.floor(r.y)-8,width:Math.ceil(r.width)+16,height:Math.ceil(r.height)+16,scale:1};})()"):null;
    const r=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false,...(clip?{clip}:{})});
    const png=Buffer.from(r.data,'base64');assert.equal(png.readUInt32BE(16),clip?clip.width:1440);assert.equal(png.readUInt32BE(20),clip?clip.height:900);assert.ok(png.length<400*1024,name+' under 400 KiB');
    fs.writeFileSync(path.join(output,name),png);console.log(name+': '+png.length+' bytes');
  };
  await send('Page.navigate',{url:origin+'/?lang='+(process.env.CAPTURE_LANG||'en')});await until("!!document.querySelector('#login form')");
  await screenshot('login.png');
  await evaluate(`fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:${JSON.stringify(password)}})}).then(r=>r.json())`);
  await send('Page.reload');await until("document.querySelectorAll('.card[role=button]').length===3");
  await until("document.querySelectorAll('.token-mini-item').length===2");
  await evaluate("document.querySelector('#srv-sel').value='"+id+"';document.querySelector('#srv-sel').dispatchEvent(new Event('change'))");
  await delay(300);
  assert.ok(await evaluate("[...document.querySelectorAll('.card[role=button]')].every(n=>n.getBoundingClientRect().bottom<=innerHeight)"),'Session cards fit in overview');
  await screenshot('overview.png');
  assert.ok(await evaluate("!!document.querySelector('.reboot')"),'Server card has reboot button');
  await screenshot('server-card.png','#fleet .fc');
  await evaluate("document.querySelector('#tab-token').click()");await until("document.querySelectorAll('.token-account').length===2");
  await screenshot('token-ai.png');
  await evaluate("document.querySelector('#tab-over').click();document.querySelector('.card[role=button]').click()");
  await until("!!document.querySelector('.xterm-screen')");
  await delay(500);await screenshot('terminal.png');
  // Use Chrome mouse input on the real xterm link, just as a reader does.
  const r=await evaluate("(()=>{const r=document.querySelector('.xterm-screen').getBoundingClientRect(),c=window.__terms[0]._core._renderService.dimensions.css.cell;return{x:r.x+c.width*14,y:r.y+c.height*6.5};})()");
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',...r});await delay(300);
  for(const type of ['mousePressed','mouseReleased'])await send('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...r});
  await until("!document.querySelector('.file-viewer').hidden && !!document.querySelector('.file-content h1')");
  await screenshot('viewer.png');
  const viewerClose="(document.querySelector('.file-viewer .viewer-close')||{click(){}}).click()";
  // Operations tab: the Ops hub on top (search, progress, report, waiting questions).
  if(viewerClose)await evaluate(viewerClose);
  await evaluate("document.querySelector('#tab-ops').click()");await until("!!document.querySelector('.hub-title') && !/Đang tải/.test(document.querySelector('.hub-title').textContent)");
  await evaluate("document.querySelector('#v-ops .feature-page').scrollTop=0");await screenshot('ops-hub.png');
  // Settings › Crew autopilot.
  await evaluate("TW.app().openSettings('sessions')");await until("!!document.querySelector('.ops-crew')");
  await screenshot('ops-settings.png');
  await evaluate("document.querySelectorAll('dialog[open]').forEach(d=>d.close())");
  assert.deepEqual(errors,[],'No browser runtime exceptions');
  console.log('README capture PASS: real UI, fake backend/token sources, isolated HOME, 1440x900.');
}
let deadline;
const timeout=new Promise((resolve,reject)=>{deadline=setTimeout(()=>reject(Error('Capture deadline exceeded')),90000);});
Promise.race([main(),timeout]).catch(e=>{console.error(e);console.error(appLog);process.exitCode=1;}).finally(async()=>{
  clearTimeout(deadline);if(cdp)cdp.close();
  for(const child of children.reverse()){if(child.exitCode===null&&child.signalCode===null){const exited=new Promise(r=>child.once('exit',r));child.kill();await Promise.race([exited,delay(2000)]);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}}}
  fs.rmSync(scratch,{recursive:true,force:true});
});
