'use strict';
// Real Chrome + real HTTP/auth/WebSocket routes and SSH transport; deterministic SSH fixtures.
// Run manually with TW_CHROME_ARTIFACTS pointing at the track evidence directory.
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const { spawn } = require('child_process');
const { Server } = require('ssh2');
const WebSocket = require('ws');
const { Vault } = require('../lib/vault');
const {LOCAL_ID}=require('../lib/backends');
const {claudeSessionId}=require('../lib/parse');
const output = process.env.TW_CHROME_ARTIFACTS;
if (!output) throw Error('TW_CHROME_ARTIFACTS required');
const scratch = fs.mkdtempSync(path.join(output, 'chrome-check-'));
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
          stream.write('\x1b[2J\x1b[HSSH terminal fixture\r\n$ ');
          stream.on('data', (b) => stream.write(b)); return;
        }
        let text = '';
        if(info.command.includes(')().discover(')) text=JSON.stringify([{id:'ssh_claude',hostId:id,tool:'claude',directory:'/fixture/claude',nickname:'Claude',threshold:null},{id:'ssh_tech2',hostId:id,tool:'claude',directory:'/fixture/claude-tech2',nickname:'Claude tech2',threshold:null}]);
        else if(info.command.startsWith('node_bin=')) text=JSON.stringify({tool:'claude',email:info.command.includes('id\":\"ssh_tech2')?'tech2@example.com':'claude.work@example.com',plan:'max',reason:'',events:Array.from({length:14},(_,i)=>({at:now*1000-(13-i)*86400000,session:claudeSessionId('/workspace','claude-work'),total:50000+i*1000})),limits:{session:{percent:62,resetAt:Date.now()+8000000},weekly:{percent:36,resetAt:Date.now()+300000000},reason:''}});
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
  fs.writeFileSync(path.join(configDir,'sessions','usage.jsonl'),Array.from({length:14},(_,i)=>JSON.stringify({type:'event_msg',timestamp:new Date(now*1000-(13-i)*86400000).toISOString(),payload:{type:'token_count',info:{total_token_usage:{total_tokens:(i+1)*12000}},rate_limits:{primary:{used_percent:95,window_minutes:300,resets_at:now+6000},secondary:{used_percent:48,window_minutes:10080,resets_at:now+280000},plan_type:'plus'}}})).join('\n')+'\n');
  new Vault(path.join(data, 'vault.json')).create(password, { prefs:{aiAccounts:[{id:'local_codex',hostId:LOCAL_ID,tool:'codex',directory:configDir,nickname:'Công việc',threshold:20000},{id:'ssh_claude',hostId:id,tool:'claude',directory:'/fixture/claude',nickname:'Backend',threshold:100000}]}, servers: [{id:'22222222-2222-2222-2222-222222222222',name:'demo-server',host:'127.0.0.1',port:1,user:'fixture',auth:'password'}, { id, name: 'Chrome SSH fixture', host: '127.0.0.1', port: ssh.address().port, user: 'fixture', auth: 'password' }] });
  const app = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, HOME:scratch, CLAUDE_CONFIG_DIR:'', CODEX_HOME:'', TW_PORT: '17891', TW_DATA: data, TW_POLL_MS: '700', TW_TMUX_SOCKET:'tw-token-fixture-'+process.pid }, timeout:60000, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(app);
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
  const until = async (expression) => { for (let i = 0; i < 180; i++) { if (await evaluate(expression)) return; await delay(150); } console.error('Fixture server log',serverLog);console.error('Browser errors',errors);console.error(await evaluate("document.body.innerText.slice(0,1800)"));throw Error('Timed out: ' + expression); };
  const screenshot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(path.join(output, name), Buffer.from(r.data, 'base64')); };
  await send('Runtime.enable'); await send('Page.enable'); await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1400, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:17891/api/status' }); await until("location.pathname==='/api/status'");
  // Authenticate through the production route, then reload into the application.
  await evaluate(`fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:${JSON.stringify(password)}})}).then(r=>r.json())`);
  await evaluate(`fetch('/api/servers/${id}/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:${JSON.stringify(password)}})}).then(r=>r.json())`);
  await delay(1200); // Let the fixture's first backend poll supply exact tmux session IDs.
  await send('Page.navigate',{url:'http://127.0.0.1:17891/'}); await until("document.querySelectorAll('.card[role=button]').length === 5");
  await until("document.querySelector('.card .pet-slot .pet-body') !== null");

  await until("document.querySelector('#token-mini').textContent.includes('95%')");
  for(const width of [1280,1440]) {
    await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
    await evaluate("document.querySelector('#tab-over').click()");
    assert.ok(await evaluate("[...document.querySelectorAll('.card-head')].every(h=>h.scrollWidth<=h.clientWidth+1)"),'card headers fit '+width);
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.card .pet-body')).width"),'30px');
    assert.equal(await evaluate("document.querySelectorAll('.card-head .crew-band').length"),0);
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.card.wait .mini')).display"),'none');
    const footer=await evaluate("document.querySelector('.card-foot').textContent");
    assert.ok(footer.includes('Token 126'),footer);
    assert.ok(await evaluate("(()=>{const cards=[...document.querySelectorAll('#fleet .fc')].map(n=>n.getBoundingClientRect());return cards.length===3&&cards.every(r=>Math.abs(r.height-cards[0].height)<2&&Math.abs(r.width-cards[0].width)<2);})()"),'equal server cards');
    assert.ok(await evaluate("(()=>{const rings=[...document.querySelectorAll('#fleet .rings')].map(n=>n.getBoundingClientRect().top);return Math.max(...rings)-Math.min(...rings)<2;})()"),'server ring alignment');
    await screenshot('overview-'+width+'.png');
    await evaluate("document.querySelector('#tab-token').click()");
    await until("document.querySelectorAll('.token-account').length===3");
    assert.ok(await evaluate("[...document.querySelectorAll('.token-account-head')].every(h=>h.scrollWidth<=h.clientWidth+1)"),'account headers fit '+width);
    assert.ok(await evaluate("document.querySelector('#v-token').textContent.includes('local.codex@example.com')"));
    assert.ok(await evaluate("[...document.querySelectorAll('.token-reset span')].every(n=>n.textContent.match(/\\d{2}:\\d{2}/))"));
    assert.ok(!await evaluate("document.body.textContent.includes('SECRET-')"));
    assert.equal(await evaluate("document.querySelectorAll('.token-host-unavailable').length"),1);
    assert.ok(await evaluate("document.querySelector('.token-host-unavailable').textContent.includes('demo-server: chưa đọc được')"));
    assert.ok(!await evaluate("document.querySelector('#v-token').textContent.includes('chưa đặt ngưỡng')"));
    assert.equal(await evaluate("document.querySelectorAll('.token-mini-item').length"),3);
    await screenshot('token-ai-'+width+'.png');
  }
  await evaluate("document.querySelector('.token-heading select').value='codex';document.querySelector('.token-heading select').dispatchEvent(new Event('change'))");
  assert.equal(await evaluate("document.querySelectorAll('.token-account').length"),1);
  await evaluate("document.querySelector('[data-period=weeks]').click()");
  assert.ok(await evaluate("document.querySelector('.token-panel:last-of-type').textContent.includes('tuần')"));
  await send('Emulation.setFocusEmulationEnabled',{enabled:true});
  await evaluate("document.querySelector('.token-bar').focus()");
  assert.ok(await evaluate("document.querySelector('.token-chart-hint').textContent.includes('codex:')"));
  await evaluate("document.querySelector('.token-rename').click()");
  await until("!!document.querySelector('.token-config[open]')");
  await evaluate("document.querySelector('.token-config input[maxlength]').value='Đã đổi';document.querySelector('.token-config form').requestSubmit()");
  await until("document.querySelector('.token-identity')?.textContent.includes('Đã đổi')");
  await send('Page.reload');
  await until("document.querySelector('#token-mini')?.textContent.includes('Đã đổi')");
  await evaluate("document.querySelector('#tab-token').click()");
  const apiText=await evaluate("fetch('/api/tokens').then(r=>r.text())");
  assert.ok(!/SECRET-|id_token|refresh_token|access_token/.test(apiText));
  await evaluate("document.querySelector('#tab-over').click();document.querySelector('.card[role=button]').click()");
  await until("document.querySelector('.token-detail')!==null");
  assert.ok(await evaluate("document.querySelector('.token-detail').textContent.includes('Token phiên này')"));
  // Scope to local (zero sessions): house pets keep the yard populated.
  await evaluate("document.querySelector('#srv-sel').value='"+LOCAL_ID+"';document.querySelector('#srv-sel').dispatchEvent(new Event('change'))");
  await until("document.querySelectorAll('.yard-pet[data-key^=house]').length===3");
  await screenshot('house-pets.png');
  await evaluate("document.querySelector('#pets-enabled').click()");
  assert.ok(await evaluate("document.documentElement.classList.contains('pets-off')"));
  await evaluate("document.querySelector('#pets-enabled').click()");
  assert.deepEqual(errors,[]);
  if(process.env.TW_TOKEN_MOCKUP){
    await send('Page.navigate',{url:'file://'+process.env.TW_TOKEN_MOCKUP});
    await until("!!document.querySelector('#tab-token')");
    await screenshot('mockup-overview-1440.png');
    await evaluate("document.querySelector('#tab-token').click()");await delay(500);await screenshot('mockup-token-1440.png');
  }
  fs.writeFileSync(path.join(output,'chrome-token-results.json'),JSON.stringify({passed:true,widths:[1280,1440],checks:['headers fit','compact pet','waiting question once','footer chips','identity','local reset time','filters','hover/focus','rename persistence','API secret redaction','session detail'],limits:'Fixture HTTP/auth/SSH and local log data; no real provider or credential read.'},null,2));
}
const deadline=setTimeout(()=>{for(const c of children)c.kill('SIGKILL');process.exit(1);},70000);
main().then(()=>console.log('Chrome token checks PASS')).catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
  clearTimeout(deadline);if(cdp)cdp.close();for(const c of connections)c.end();if(ssh)ssh.close();
  for(const child of children){if(child.exitCode===null&&child.signalCode===null){const exit=new Promise(r=>child.once('exit',r));child.kill();await Promise.race([exit,delay(2000)]);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exit;}}}
  fs.rmSync(scratch,{recursive:true,force:true});
});
