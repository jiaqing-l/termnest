'use strict';
// Foreground smoke check: real Chrome, HTTP/auth/WebSocket, node-pty and private tmux socket.
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const { spawn, execFileSync } = require('child_process');
const WebSocket = require('ws');
const { Vault } = require('../lib/vault');
const { LOCAL_ID } = require('../lib/backends');
const output = process.env.TW_CHROME_ARTIFACTS;
if (!output) throw Error('TW_CHROME_ARTIFACTS required');
const scratch = fs.mkdtempSync(path.join(output, 'local-check-'));
const data = path.join(scratch, 'data');
const cwd = path.join(scratch, "Tiếng Việt ' ; $(echo unsafe)"); fs.mkdirSync(cwd);
const socket = 'tw-w1-' + process.pid;
const password = 'local-smoke-fixture';
const port = 17931, chromePort = 17932;
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
  // Send through the real terminal WebSocket using the application's xterm keyboard handler.
  await delay(700);
  await send('Input.insertText',{text:"printf 'LOCAL-PTY-Tiếng Việt\\n'"});
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
  await delay(700);
  let pane=execFileSync('tmux',['-L',socket,'capture-pane','-p','-t','=recovery:'],{encoding:'utf8',timeout:3000});
  assert.ok(pane.includes('LOCAL-PTY-Tiếng Việt'), 'Chrome keyboard reaches private tmux via node-pty');
  const attached=execFileSync('tmux',['-L',socket,'list-sessions','-F','#{session_attached}'],{encoding:'utf8',timeout:3000}).trim();
  assert.equal(attached,'1','Chrome attached a real tmux client');
  await screenshot('local-terminal.png');
  assert.equal(await evaluate("Array.from(document.querySelector('#n-run').options).some(o=>o.value==='codex')"),true);
  // New session via the production form, preserving hostile/Unicode path as one directory.
  await evaluate("document.querySelector('#tab-over').click()");
  const createButton=await evaluate("Array.from(document.querySelectorAll('button')).filter(b=>b.textContent.trim()==='Phiên mới').map(b=>b.id)");
  assert.ok(createButton.length);
  await evaluate(`document.getElementById(${JSON.stringify(createButton[0])}).click()`);
  await evaluate(`document.querySelector('#n-name').value='created';document.querySelector('#n-dir').value=${JSON.stringify(cwd)};document.querySelector('#n-run').value='shell';document.querySelector('#n-name').form.requestSubmit()`);
  await until("document.querySelectorAll('.card[role=button]').length === 2");
  state=(await api('GET','/api/state')).body;
  assert.equal(state.servers[0].sessions.find(s=>s.name==='created').path,fs.realpathSync(cwd));
  await evaluate("document.querySelector('#tab-over').click()");
  await delay(300);
  await screenshot('local-overview.png');
  await stop(app);
  execFileSync('tmux',['-L',socket,'has-session','-t','=created'],{timeout:3000});
  // Saved list survives tool restart, and auto restore only runs when explicitly enabled.
  const vault=new Vault(path.join(data,'vault.json'));assert.ok(vault.unlock(password));
  assert.equal(vault.data.known[LOCAL_ID].sessions.created.dir,fs.realpathSync(cwd));
  vault.data.prefs.autoRestoreLocal=true;
  vault.data.known[LOCAL_ID].bootId='another-boot-fixture';
  vault.data.known[LOCAL_ID].sessions.automatic={dir:cwd,run:'shell'};vault.save();
  startApp();for(let i=0;i<60;i++){try{if((await login()).status===200)break;}catch{}await delay(100);}
  for(let i=0;i<60;i++){state=(await api('GET','/api/state')).body;if(state.servers[0].sessions.some(s=>s.name==='automatic'))break;await delay(150);}
  assert.ok(state.servers[0].sessions.some(s=>s.name==='automatic'),'opt-in auto restore');
  assert.ok(state.servers[0].sessions.some(s=>s.name==='created'),'tmux session survives tool restart');
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(output,'local-browser-results.json'),JSON.stringify({pass:true,checks:['password gate','local first / hostname / immutable','manual restore / default off','Chrome node-pty attach / Unicode keyboard','new-session form / quoted Unicode directory','Codex option','tmux survives tool restart','persisted list / opt-in automatic restore'],bootDetection:'real macOS boot ID; reboot transition simulated in encrypted saved record',platform:process.platform,socket},null,2));
}
main().catch(err=>{console.error(err);fs.writeFileSync(path.join(output,'local-browser-error.txt'),String(err.stack)+'\n'+log);process.exitCode=1;}).finally(async()=>{
  if(cdp)cdp.close();for(const child of children.reverse())await stop(child);
  try{execFileSync('tmux',['-L',socket,'kill-server'],{stdio:'ignore',timeout:3000});}catch{}
  fs.rmSync(scratch,{recursive:true,force:true});
});
