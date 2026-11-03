'use strict';
// Foreground smoke check: real Chrome, HTTP/auth/WebSocket, node-pty and private tmux socket.
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const { spawn, execFileSync } = require('child_process');
const WebSocket = require('ws');
const { Vault } = require('../lib/vault');
const { LOCAL_ID } = require('../lib/backends');
const output = process.env.TW_CHROME_ARTIFACTS;
if (!output) throw Error('TW_CHROME_ARTIFACTS required');
const scratch = fs.mkdtempSync(path.join(output, 'scroll-check-'));
const data = path.join(scratch, 'data');
const cwd = path.join(scratch, "Tiếng Việt ' ; $(echo unsafe)"); fs.mkdirSync(cwd);
const socket = 'tw-scroll-' + process.pid;
const password = 'scroll-smoke-fixture';
const port = 17941, chromePort = 17942;
const children = []; let app, cdp, log = '';
const delay = ms => new Promise(r => setTimeout(r, ms));
function startApp() {
  app = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, TW_PORT: String(port), TW_DATA: data, TW_TMUX_SOCKET: socket, TW_POLL_MS: '500' }, timeout:120000, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(app); app.stdout.on('data', b => { log += b; }); app.stderr.on('data', b => { log += b; });
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(r => child.once('exit', r)); child.kill('SIGTERM');
  await Promise.race([exited, delay(4000)]);
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
}
async function main() {
  new Vault(path.join(data, 'vault.json')).create(password, { prefs:{aiAccounts:[{id:'isolated_local',hostId:LOCAL_ID,tool:'codex',directory:scratch,nickname:'Fixture',threshold:null}]}, servers: [], known: { [LOCAL_ID]: {
    bootId: 'previous-boot-fixture', sessions: { recovery: { dir: cwd, run: 'shell' } }, lost: []
  } } });
  startApp();
  for (let i=0;i<60;i++) { try { if ((await fetch(`http://127.0.0.1:${port}/api/status`)).ok) break; } catch {} await delay(100); }
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/state`)).status, 401);
  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=' + chromePort, '--user-data-dir=' + path.join(scratch, 'profile'), 'about:blank'], { timeout:120000, stdio: 'ignore' }); children.push(chrome);
  let target;
  for(let i=0;i<60;i++) { try { target=(await (await fetch(`http://127.0.0.1:${chromePort}/json`)).json()).find(t=>t.type==='page'); if(target) break; } catch {} await delay(100); }
  assert.ok(target); cdp=new WebSocket(target.webSocketDebuggerUrl); await new Promise(r=>cdp.on('open',r));
  let seq=0;const pending=new Map(),errors=[];
  cdp.on('message',b=>{const m=JSON.parse(b);if(m.id){const p=pending.get(m.id);pending.delete(m.id);if(m.error)p.reject(Error(JSON.stringify(m.error)));else p.resolve(m.result);}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);});
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});cdp.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  const until=async expression=>{for(let i=0;i<80;i++){if(await evaluate(expression))return;await delay(150);}throw Error('Timed out: '+expression);};
  const api=(method,url,body)=>evaluate(`fetch(${JSON.stringify(url)}, {method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))}}).then(async r=>({status:r.status,body:await r.json()}))`);
  const login=()=>api('POST','/api/login',{password});
  const screenshot=async name=>{const r=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,name),Buffer.from(r.data,'base64'));};
  await send('Runtime.enable');await send('Page.enable');await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url:`http://127.0.0.1:${port}/`});await until("!!document.querySelector('#login-pw') || !!document.querySelector('#login form')");
  assert.equal((await login()).status,200);await send('Page.reload');
  await until("document.querySelector('#grid').textContent.includes('recovery')");
  let state=(await api('GET','/api/state')).body;
  assert.equal(state.servers[0].local,true);assert.equal(state.servers[0].hostname,require('os').hostname());
  assert.equal(state.servers[0].sessions.length,0);assert.equal(state.servers[0].lost[0].name,'recovery');
  assert.equal(await evaluate("!!document.querySelector('#grid .srv-head button[aria-label^=\"Gỡ\"]')"),false);
  assert.equal((await api('DELETE',`/api/servers/${LOCAL_ID}`)).status,400);
  assert.equal((await api('POST',`/api/servers/${LOCAL_ID}/restore`,{})).body.restored[0],'recovery');
  await until("document.querySelectorAll('.card[role=button]').length === 1");
  await evaluate("document.querySelector('.card[role=button]').click()");
  await until("document.querySelector('.xterm-screen') !== null");
  await delay(700);
  const tm=(...a)=>execFileSync('tmux',['-L',socket,...a],{encoding:'utf8',timeout:3000}).trim();
  const wheel=async(deltaY)=>{const box=await evaluate("(()=>{const r=document.querySelector('.terminal').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()");await send('Input.dispatchMouseEvent',{type:'mouseWheel',x:box.x,y:box.y,deltaX:0,deltaY});await delay(500);};
  // Headless Chrome does not always focus xterm's input after the pane opens.
  const focusTerm=()=>evaluate("document.querySelector('.xterm-helper-textarea').focus()");
  await focusTerm();
  // Fill history in the real pane, then drive it only with the wheel.
  await send('Input.insertText',{text:'seq 1 400'});
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
  await delay(1200);
  const hist=Number(tm('display-message','-p','-t','=recovery:','#{history_size}'));
  assert.ok(hist>300,'history exists in tmux: '+hist+' pane: '+tm('capture-pane','-p','-t','=recovery:').slice(-300));
  await until("(document.querySelector('.tscroll')&&!document.querySelector('.tscroll').hidden)");
  assert.equal(tm('display-message','-p','-t','=recovery:','#{pane_in_mode}'),'0');
  await wheel(-300);
  assert.equal(tm('display-message','-p','-t','=recovery:','#{pane_in_mode}'),'1','wheel up enters tmux copy-mode instead of sending Up keys');
  const pos1=Number(tm('display-message','-p','-t','=recovery:','#{scroll_position}'));
  assert.ok(pos1>0,'scrolled up: '+pos1);
  await wheel(-300);
  assert.ok(Number(tm('display-message','-p','-t','=recovery:','#{scroll_position}'))>pos1,'wheel keeps scrolling');
  await wheel(100000);
  assert.equal(tm('display-message','-p','-t','=recovery:','#{pane_in_mode}'),'0','wheel down to the bottom leaves copy-mode');
  // Thumb drag reaches the top.
  await wheel(-300);
  await until("document.querySelector('.tscroll').classList.contains('scrolled')");
  const rect=await evaluate("(()=>{const r=document.querySelector('.tscroll').getBoundingClientRect();return {x:r.left+r.width/2,top:r.top}})()");
  await send('Input.dispatchMouseEvent',{type:'mousePressed',x:rect.x,y:rect.top+2,button:'left',clickCount:1});
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:rect.x,y:rect.top+2,button:'left',clickCount:1});
  await delay(700);
  assert.ok(Number(tm('display-message','-p','-t','=recovery:','#{scroll_position}'))>hist-5,'dragging to the top of the bar jumps to the oldest line');
  // Typing while scrolled must leave copy-mode first and still reach the shell.
  await focusTerm();
  await send('Input.insertText',{text:"printf 'TYPED-AFTER-SCROLL\\n'"});
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
  await delay(1000);
  assert.equal(tm('display-message','-p','-t','=recovery:','#{pane_in_mode}'),'0');
  assert.ok(tm('capture-pane','-p','-t','=recovery:').includes('TYPED-AFTER-SCROLL'),'keystrokes reach the shell after leaving copy-mode');
  await screenshot('scroll-terminal.png');
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(output,'scroll-browser-results.json'),JSON.stringify({pass:true}));
}
main().catch(err=>{console.error(err);fs.writeFileSync(path.join(output,'scroll-browser-error.txt'),String(err.stack)+'\n'+log);process.exitCode=1;}).finally(async()=>{
  if(cdp)cdp.close();for(const child of children.reverse())await stop(child);
  try{execFileSync('tmux',['-L',socket,'kill-server'],{stdio:'ignore',timeout:3000});}catch{}
  fs.rmSync(scratch,{recursive:true,force:true});
});
