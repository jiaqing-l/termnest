'use strict';
// Real Chrome + real HTTP/auth/WebSocket routes and SSH transport; deterministic SSH fixtures.
// Run manually with TW_CHROME_ARTIFACTS pointing at the track evidence directory.
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const { spawn, exec, execFileSync } = require('child_process');
const { Server } = require('ssh2');
const WebSocket = require('ws');
const { Vault } = require('../lib/vault');
const {LOCAL_ID}=require('../lib/backends');
const {claudeSessionId}=require('../lib/parse');
const output = process.env.TW_CHROME_ARTIFACTS;
if (!output) throw Error('TW_CHROME_ARTIFACTS required');
const scratch = fs.mkdtempSync(path.join(output, 'chrome-check-'));
const files=path.join(scratch,'files');fs.mkdirSync(path.join(files,'Implementation','Foo'),{recursive:true});
fs.copyFileSync(path.join(__dirname,'fixtures','reading.md'),path.join(files,'Implementation','Foo','13-BAR.md'));
const mockup=fs.readFileSync(process.env.TW_HTML_MOCKUP||path.join(__dirname,'fixtures','reading.html'),'utf8');
fs.writeFileSync(path.join(files,'demo.html'),mockup+`<script>
window.addEventListener('message',e=>{if(e.data.theme){document.documentElement.dataset.theme=e.data.theme;parent.postMessage({htmlReady:true,theme:e.data.theme,inlineCSS:getComputedStyle(document.body).display},'*');}});
parent.postMessage({htmlReady:true,inlineCSS:getComputedStyle(document.body).display},'*');
</script>`);
const password = 'local-browser-fixture';
const id = '11111111-1111-1111-1111-111111111111';
const children = [], connections = new Set(); let ssh, cdp;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let workerDone = false, waiting = true, logReads = 0;
const now = Math.floor(Date.now() / 1000);
const rows = [
  ['claude-work', 'claude', now - 10000], ['tests', 'npm', now - 5000],
  ['idle-one', 'bash', now - 90000], ['idle-two', 'bash', now - 700000], ['fishing', 'bash', now - 3000]
];
function poll() {
  const ps = ['100 1 10000 bash', '200 100 500 claude'];
  if (!workerDone) ps.push('300 200 100 bash crew-dispatch.sh --task task-demo --track W1', '301 300 90 codex exec work');
  ps.push('400 200 110 bash crew-dispatch.sh --task task-demo --track W2', '401 400 100 codex exec work', '500 1 20 bash crew-dispatch.sh --task unknown-task --track W1');
  return '@@HOST\nchrome-ssh-fixture\n@@CPU\ncpu 100 0 20 200 0 0 0\n@@MEM\nMemTotal: 1000000\nMemAvailable: 400000\n@@DISK\n/dev/a 100 50 50 50% /\n@@PS\n' + ps.join('\n') + '\n@@PSOK\n1\n@@CWD\n300 /fixture\n400 /fixture\n500 /fixture\n@@SESS\n' + rows.map(([name, cmd, created], i) => `$${i}|~|${name}|~|0|~|${created}|~|${waiting && i === 0 ? now - 60 : Math.floor(Date.now()/1000)}|~|${cmd}|~|/workspace`).join('\n') + '\n' + rows.map(([name], i) => `@@PANE $${i}\n${name}: fixture output\n${i === 0 && waiting ? 'Do you want to continue? [y/n]' : 'working'}`).join('\n') + '\n@@DETAIL\n' + rows.map((r, i) => `$${i}|~|${100+i}|~|0|~|`).join('\n') + '\n@@OWNERS\n$0|~|100\n@@END\n';
}
async function main() {
  const privateKey = require('crypto').generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  ssh = new Server({ hostKeys: [privateKey] }, (client) => {
    connections.add(client); client.on('close', () => connections.delete(client));
    client.on('authentication', (ctx) => ctx.method === 'password' && ctx.password === password ? ctx.accept() : ctx.reject());
    client.on('ready', () => client.on('session', (accept) => {
      const session = accept(); session.on('pty', (accept) => accept()); session.on('window-change', (accept) => accept && accept());
      session.on('exec', (accept, reject, info) => {
        const stream = accept();
        if (info.command.startsWith('tmux -u attach-session')) {
          stream.write('\x1b[2J\x1b[HSSH terminal fixture\r\nImplementation/Foo/13-BAR.md\r\ndemo.html\r\n\x1b[?1000h$ ');
          stream.on('data', (b) => { if (!b.toString().startsWith('\x1b[M') && !b.toString().startsWith('\x1b[<')) stream.write(b); }); return;
        }
        let text = '';
        if(info.command.startsWith('node -e ') && info.command.includes('function fileRuntime')) {
          exec(info.command,{maxBuffer:32*1024*1024,timeout:15000},(error,out)=>{stream.end(out);stream.exit(error?1:0);});return;
        }
        if(info.command.startsWith('tmux display-message'))text=files+'\n';
        else if(info.command.startsWith('node -e ')) text=JSON.stringify({tool:'claude',email:'claude.work@example.com',plan:'max',reason:'',events:Array.from({length:14},(_,i)=>({at:Date.now()-(13-i)*86400000,session:claudeSessionId('/workspace','claude-work'),total:50000+i*1000})),limits:{session:{percent:62,resetAt:Date.now()+8000000},weekly:{percent:36,resetAt:Date.now()+300000000},reason:''}});
        else if (info.command.includes('@@HOST')) text = poll();
        else if (info.command.includes('@@OS')) text = '@@OS\nSSH fixture\n@@END\n';
        else if (info.command.includes('tail -c 65536')) {
          logReads++; text = (workerDone && info.command.includes('/W1') ? 'DONE' : 'unknown') + '\n' + Array.from({ length: 90 }, (_, i) => `line ${i}: safe <script> markup`).join('\n') + '\nread ' + logReads;
        } else if (info.command.includes('command -v tmux')) text = '/usr/bin/tmux\n';
        stream.end(text); stream.exit(0);
      });
    })); client.on('error', () => {});
  });
  await new Promise((r) => ssh.listen(0, '127.0.0.1', r));
  const data = path.join(scratch, 'data');
  const configDir=path.join(scratch,'codex');fs.mkdirSync(path.join(configDir,'sessions'),{recursive:true});
  const token='fixture.'+Buffer.from(JSON.stringify({email:'local.codex@example.com','https://api.openai.com/auth':{chatgpt_plan_type:'plus'},secret:'SECRET-CLAIM'})).toString('base64url')+'.fixture';
  fs.writeFileSync(path.join(configDir,'auth.json'),JSON.stringify({tokens:{id_token:token,access_token:'SECRET-ACCESS',refresh_token:'SECRET-REFRESH'}}));
  fs.writeFileSync(path.join(configDir,'sessions','usage.jsonl'),Array.from({length:14},(_,i)=>JSON.stringify({type:'event_msg',timestamp:new Date(Date.now()-(13-i)*86400000).toISOString(),payload:{type:'token_count',info:{total_token_usage:{total_tokens:(i+1)*12000}},rate_limits:{primary:{used_percent:95,window_minutes:300,resets_at:now+6000},secondary:{used_percent:48,window_minutes:10080,resets_at:now+280000},plan_type:'plus'}}})).join('\n')+'\n');
  new Vault(path.join(data, 'vault.json')).create(password, { prefs:{aiAccounts:[{id:'local_codex',hostId:LOCAL_ID,tool:'codex',directory:configDir,nickname:'Công việc',threshold:20000},{id:'ssh_claude',hostId:id,tool:'claude',directory:'/fixture/claude',nickname:'Backend',threshold:100000}]}, servers: [{ id, name: 'Chrome SSH fixture', host: '127.0.0.1', port: ssh.address().port, user: 'fixture', auth: 'password' }] });
  const app = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, TW_PORT: '17891', TW_DATA: data, TW_POLL_MS: '700', TW_TMUX_SOCKET:'tw-token-fixture-'+process.pid }, timeout:60000, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(app);
  let serverLog = ''; app.stdout.on('data', (b) => serverLog += b); app.stderr.on('data', (b) => serverLog += b);
  for (let i = 0; i < 50; i++) { try { await fetch('http://127.0.0.1:17891/api/status',{signal:AbortSignal.timeout(2000)}); break; } catch { await delay(100); } }
  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=17892', '--user-data-dir=' + path.join(scratch, 'profile'), 'about:blank'], {timeout:60000, stdio: 'ignore' }); children.push(chrome);
  let target;
  for (let i = 0; i < 60; i++) { try { target = (await (await fetch('http://127.0.0.1:17892/json',{signal:AbortSignal.timeout(2000)})).json()).find((t) => t.type === 'page'); if (target) break; } catch {} await delay(100); }
  assert.ok(target, 'Chrome started'); cdp = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => cdp.on('open', r)); let seq = 0; const pending = new Map(), errors = [];
  cdp.on('message', (b) => { const msg = JSON.parse(b); if (msg.id) { const p = pending.get(msg.id); pending.delete(msg.id); if (msg.error) p.reject(Error(JSON.stringify(msg.error))); else p.resolve(msg.result); } else if (msg.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify(msg.params.exceptionDetails)); });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const n = ++seq; pending.set(n, { resolve, reject }); cdp.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
  const until = async (expression) => { for (let i = 0; i < 60; i++) { if (await evaluate(expression)) return; await delay(150); } console.error('Browser errors',errors);console.error(await evaluate("document.body.innerText.slice(0,1800)"));throw Error('Timed out: ' + expression); };
  const screenshot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(path.join(output, name), Buffer.from(r.data, 'base64')); };
  await send('Runtime.enable'); await send('Page.enable'); await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1400, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument',{source:"window.__terms=[];let T;Object.defineProperty(window,'Terminal',{configurable:true,get:()=>T,set:value=>{T=class extends value{constructor(...args){super(...args);window.__terms.push(this)}}}});"});
  await send('Page.navigate', { url: 'http://127.0.0.1:17891/' }); await until("!!document.querySelector('#login-pw') || !!document.querySelector('#login form')");
  // Authenticate through the production route, then reload into the application.
  await evaluate(`fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:${JSON.stringify(password)}})}).then(r=>r.json())`);
  await evaluate(`fetch('/api/servers/${id}/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:${JSON.stringify(password)}})}).then(r=>r.json())`);
  await send('Page.reload'); await until("document.querySelectorAll('.card[role=button]').length === 5");
  await until("document.querySelector('.card .pet-slot .pet-body') !== null");

  await evaluate("document.querySelector('.card[role=button]').click()");
  await until("document.querySelector('.xterm-screen') !== null");
  await delay(800);
  await evaluate("window.detailBefore=document.querySelector('#detail').firstChild;document.querySelector('.pane').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))");
  assert.ok(await evaluate("window.detailBefore===document.querySelector('#detail').firstChild"));
  const coordinates=async()=>evaluate("(()=>{const r=document.querySelector('.xterm-screen').getBoundingClientRect(),cell=window.__terms[0]._core._renderService.dimensions.css.cell;return {x:r.x,y:r.y,cw:cell.width,ch:cell.height}})()");
  let rect=await coordinates();
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:rect.x+45,y:rect.y+rect.ch*1.5});await delay(250);
  await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,x:rect.x+45,y:rect.y+rect.ch*1.5});
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x:rect.x+45,y:rect.y+rect.ch*1.5});
  await until("!document.querySelector('.file-viewer').hidden && !!document.querySelector('.file-content h1')");
  assert.equal(await evaluate("document.querySelector('.file-content h1').textContent"),'Viewer fixture');
  assert.ok(await evaluate("document.querySelector('.file-content').textContent.includes('<script>')"));
  assert.ok(!await evaluate("!!window.PWNED"));
  assert.ok(await evaluate("document.querySelector('.file-viewer strong').title.endsWith('/Implementation/Foo/13-BAR.md')"));
  for(const width of [1440,420])for(const theme of ['light','dark']){
    await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
    await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);await delay(150);
    assert.equal(await evaluate("document.querySelectorAll('.file-content table').length"),1);
    assert.ok(!await evaluate("document.querySelector('.file-content').innerText.includes('|---')"));
    assert.ok(await evaluate("document.querySelector('.file-content').scrollWidth<=document.querySelector('.file-content').clientWidth"));
    if(width===420)assert.ok(await evaluate("document.querySelector('.document-table').scrollWidth>document.querySelector('.document-table').clientWidth"));
    await screenshot(`markdown-${width}-${theme}.png`);
  }
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await evaluate("document.documentElement.dataset.theme='light'");
  // Accessible separator resizes, persists its width, and tolerates blocked storage.
  await evaluate("document.querySelector('.viewer-resize').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}))");
  assert.ok(await evaluate("Number(localStorage.getItem('file-viewer-width'))>840"));
  await evaluate("window.htmlSignals=[];window.addEventListener('message',e=>{if(e.data.htmlReady)window.htmlSignals.push(e.data)})");
  await send('Browser.grantPermissions',{origin:'http://127.0.0.1:17891',permissions:['clipboardReadWrite','clipboardSanitizedWrite']});
  await evaluate("document.querySelector('.file-viewer header button').click()");await delay(100);
  assert.ok((await evaluate("navigator.clipboard.readText()")).endsWith('/Implementation/Foo/13-BAR.md'));
  await send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:path.join(scratch,'downloads')});
  await evaluate("document.querySelectorAll('.file-viewer header button')[1].click()");await delay(300);
  for(let attempt=0;attempt<50&&!fs.existsSync(path.join(scratch,'downloads','13-BAR.md'));attempt++)await delay(100);
  assert.ok(fs.readFileSync(path.join(scratch,'downloads','13-BAR.md'),'utf8').includes('Tiếng Việt'));
  await evaluate("document.querySelectorAll('.file-viewer header button')[2].click()");
  assert.ok(await evaluate("document.querySelector('.file-viewer').hidden"));
  rect=await coordinates();
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:rect.x+25,y:rect.y+rect.ch*2.5});await delay(250);
  await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,x:rect.x+25,y:rect.y+rect.ch*2.5});
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x:rect.x+25,y:rect.y+rect.ch*2.5});
  await until("!!document.querySelector('.file-content iframe')");
  assert.equal(await evaluate("document.querySelector('.file-content iframe').getAttribute('sandbox')"),'allow-scripts');
  assert.ok(!await evaluate("!!window.PWNED"));
  await until("window.htmlSignals.length>0");
  assert.equal(await evaluate("window.htmlSignals[0].inlineCSS"),'flex');
  for(const width of [1440,420])for(const theme of ['light','dark']){
    await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
    await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.querySelector('.file-content iframe').contentWindow.postMessage({theme:${JSON.stringify(theme)}},'*')`);
    await until(`window.htmlSignals.some(s=>s.theme===${JSON.stringify(theme)})`);await delay(150);
    await screenshot(`html-${width}-${theme}.png`);
  }
  const before=await evaluate("window.htmlSignals.length");
  await evaluate("document.querySelectorAll('.file-viewer header button')[3].click()");
  await until(`window.htmlSignals.length>${before}`);
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  const missing=await evaluate(`fetch('/api/file?server=${id}&session=claude-work&path=missing.md').then(r=>r.json())`);
  assert.match(missing.error,/Không tìm thấy/);
  const escaped=await evaluate(`fetch('/api/file?server=${id}&session=claude-work&path=..%2Foutside.md').then(r=>r.json())`);
  assert.match(escaped.error,/ngoài thư mục/);
  const unauthorized=await fetch('http://127.0.0.1:17891/api/file?server='+id+'&session=claude-work&path=demo.html');assert.equal(unauthorized.status,401);
  await evaluate("document.querySelectorAll('.file-viewer header button')[2].click()");
  rect=await coordinates();
  // Option-drag must bypass tmux mouse mode on macOS.
  await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,modifiers:1,x:rect.x+2,y:rect.y+rect.ch*0.5});
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,modifiers:1,x:rect.x+20*rect.cw,y:rect.y+rect.ch*0.5});
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,modifiers:1,x:rect.x+20*rect.cw,y:rect.y+rect.ch*0.5});
  const selected=await evaluate("window.__terms[0].getSelection()");assert.ok(selected.includes('SSH terminal'),JSON.stringify({selected,rect}));
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'c',code:'KeyC',modifiers:4});
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'c',code:'KeyC',modifiers:4});await delay(100);
  assert.equal(await evaluate("navigator.clipboard.readText()"),selected);
  assert.ok(await evaluate("document.querySelector('.file-viewer').hidden"));
  const localCreated=await evaluate(`fetch('/api/servers/${LOCAL_ID}/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'viewer-local',dir:${JSON.stringify(files)},run:'shell'})}).then(r=>r.json())`);
  assert.equal(localCreated.ok,true);
  await delay(1500);
  const localRead=await evaluate(`fetch('/api/file?server=${LOCAL_ID}&session=viewer-local&path=Implementation%2FFoo%2F13-BAR.md').then(r=>r.json())`);
  assert.ok(!localRead.error,JSON.stringify(localRead));
  assert.equal(localRead.text,fs.readFileSync(path.join(files,'Implementation','Foo','13-BAR.md'),'utf8'));
  assert.equal(localRead.path,fs.realpathSync(path.join(files,'Implementation','Foo','13-BAR.md')));
  await evaluate(`fetch('/api/servers/${LOCAL_ID}/sessions/viewer-local',{method:'DELETE'}).then(r=>r.json())`);
  assert.deepEqual(errors,[]);
  // Full-limit previews use the same viewer; Markdown parses off the UI thread.
  const largeText='# Full limit'+String.fromCharCode(10,10)+('A paragraph for full limit rendering. '+String.fromCharCode(10,10)).repeat(160000);
  const tail=String.fromCharCode(10,10)+'END-OF-FILE';
  const exactMarkdown=largeText.slice(0,5*1024*1024-tail.length)+tail;assert.equal(Buffer.byteLength(exactMarkdown),5*1024*1024);
  await evaluate(`window.largeText=${JSON.stringify(exactMarkdown)};window.largeViewer=FileViewer.create(async()=>({path:'large.md',kind:'markdown',text:window.largeText}));window.beats=0;window.beatTimer=setInterval(()=>window.beats++,10);window.largeViewer.open('fixture','s','large.md')`);
  await until("[...document.querySelectorAll('.file-content article')].some(a=>a.textContent.includes('END-OF-FILE'))");
  assert.ok(await evaluate("window.beats>2"));
  await evaluate("clearInterval(window.beatTimer);document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  assert.ok(await evaluate("[...document.querySelectorAll('.file-viewer')].every(p=>p.hidden)"));
  const endScript='<script>parent.postMessage({largeHTML:true},"*")</script>';
  fs.writeFileSync(path.join(files,'large.html'),'<!doctype html><p>Large HTML</p><!--'+'a'.repeat(5*1024*1024-Buffer.byteLength('<!doctype html><p>Large HTML</p><!---->'+endScript))+'-->'+endScript);
  assert.equal(fs.statSync(path.join(files,'large.html')).size,5*1024*1024);
  await evaluate(`window.addEventListener('message',e=>{if(e.data.largeHTML)window.largeHTML=true});window.htmlViewer=FileViewer.create(async()=>fetch('/api/file?server=${id}&session=claude-work&path=large.html').then(r=>r.json()));window.htmlViewer.open('${id}','claude-work','large.html')`);
  await until("window.largeHTML===true");
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  // Quota may be missing even when valid usage exists. Keep useful usage and real reasons.
  const account=(tool,today)=>({tool,today,email:tool+'@fixture.invalid',hostName:'Fixture',hostId:'fixture',limits:{session:null,weekly:null,reason:'Quota fixture unavailable'},days:[],weeks:[],sessions:[]});
  await evaluate(`window.fixtureTokens=TokenUI({api:async()=>({accounts:${JSON.stringify([account('claude',12345),account('codex',6789)])}}),scope:()=> 'all',updated:()=>{},view:()=>{},prefs:()=>({}),servers:()=>[]});window.fixtureTokens.poll(true)`);
  await until("[...document.querySelectorAll('#token-mini')].at(-1).textContent.includes('token hôm nay')");
  assert.match(await evaluate("[...document.querySelectorAll('#token-mini')].at(-1).textContent"),/Claude.*Codex/);
  assert.match(await evaluate("[...document.querySelectorAll('#token-mini')].at(-1).title"),/Quota fixture unavailable/);
  assert.match(await evaluate("[...document.querySelectorAll('#v-token .token-note')].at(0).textContent"),/Quota fixture unavailable/);
  await evaluate("window.fixtureTokens.clear()");
  assert.match(await evaluate("[...document.querySelectorAll('#token-mini')].at(-1).textContent"),/Không đọc được/);
  // Storage failures must not prevent opening or resizing a viewer.
  await evaluate("window.originalGet=Storage.prototype.getItem;window.originalSet=Storage.prototype.setItem;Storage.prototype.getItem=()=>{throw Error('blocked')};Storage.prototype.setItem=()=>{throw Error('blocked')};window.storageViewer=FileViewer.create(async()=>({path:'test.txt',kind:'text',text:'ok'}));window.storageViewer.open('f','s','test.txt');const h=[...document.querySelectorAll('.viewer-resize')].at(-1);h.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft'}));Storage.prototype.getItem=window.originalGet;Storage.prototype.setItem=window.originalSet");
  await until("[...document.querySelectorAll('.file-content')].at(-1).textContent==='ok'");
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(output,'chrome-viewer-results.json'),JSON.stringify({passed:true,checks:['real xterm path clicks','SSH read','local real tmux read','Markdown escaped','copy full path','download','close','HTML sandbox, inline CSS/scripts and reload','1440/420 light/dark Markdown and supplied HTML mockup','Markdown table DOM and no raw separators','exact 5 MB Markdown worker and HTML','token usage without quota and reason tooltips','blocked localStorage','missing/traversal/auth errors','no click detail rebuild','Option-drag and Cmd+C while tmux mouse enabled'],limits:'Real Chrome + HTTP/auth/SSH transport; SSH tmux is a deterministic fixture, no real credentials or providers.'},null,2));

}
const deadline=setTimeout(()=>{for(const c of children)c.kill('SIGKILL');process.exit(1);},70000);
main().then(()=>console.log('Chrome viewer checks PASS')).catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
  clearTimeout(deadline);if(cdp)cdp.close();for(const c of connections)c.end();if(ssh)ssh.close();
  for(const child of children){if(child.exitCode===null&&child.signalCode===null){const exit=new Promise(r=>child.once('exit',r));child.kill();await Promise.race([exit,delay(2000)]);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exit;}}}
  try{execFileSync('tmux',['-L','tw-token-fixture-'+process.pid,'kill-server'],{stdio:'ignore'});}catch{}
  fs.rmSync(scratch,{recursive:true,force:true});
});
