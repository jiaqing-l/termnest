'use strict';
// Real Chrome + real HTTP/auth/WebSocket routes and SSH transport; deterministic SSH fixtures.
// Run manually with TW_CHROME_ARTIFACTS pointing at the track evidence directory.
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const { spawn } = require('child_process');
const { Server } = require('ssh2');
const WebSocket = require('ws');
const { Vault } = require('../lib/vault');
const { LOCAL_ID } = require('../lib/backends');
const output = process.env.TW_CHROME_ARTIFACTS;
if (!output) throw Error('TW_CHROME_ARTIFACTS required');
const scratch = fs.mkdtempSync(path.join(output, 'chrome-check-'));
const password = 'local-browser-fixture';
const id = '11111111-1111-1111-1111-111111111111';
const children = [], connections = new Set(); let ssh, cdp;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let workerDone = false, waiting = false, logReads = 0;
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
        if (info.command.includes('@@HOST')) text = poll();
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
  new Vault(path.join(data, 'vault.json')).create(password, { prefs:{aiAccounts:[{id:'isolated_local',hostId:LOCAL_ID,tool:'codex',directory:scratch,nickname:'Fixture',threshold:null},{id:'isolated_ssh',hostId:id,tool:'codex',directory:'/fixture',nickname:'Fixture',threshold:null}]}, servers: [{ id, name: 'Chrome SSH fixture', host: '127.0.0.1', port: ssh.address().port, user: 'fixture', auth: 'password' }] });
  const app = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, TW_PORT: '17891', TW_DATA: data, TW_POLL_MS: '700', TW_TMUX_SOCKET:'tw-pet-fixture-'+process.pid }, timeout:120000, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(app);
  let serverLog = ''; app.stdout.on('data', (b) => serverLog += b); app.stderr.on('data', (b) => serverLog += b);
  for (let i = 0; i < 50; i++) { try { await fetch('http://127.0.0.1:17891/api/status'); break; } catch { await delay(100); } }
  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=17892', '--user-data-dir=' + path.join(scratch, 'profile'), 'about:blank'], { timeout:120000, stdio: 'ignore' }); children.push(chrome);
  let target;
  for (let i = 0; i < 60; i++) { try { target = (await (await fetch('http://127.0.0.1:17892/json')).json()).find((t) => t.type === 'page'); if (target) break; } catch {} await delay(100); }
  assert.ok(target, 'Chrome started'); cdp = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => cdp.on('open', r)); let seq = 0; const pending = new Map(), errors = [];
  cdp.on('message', (b) => { const msg = JSON.parse(b); if (msg.id) { const p = pending.get(msg.id); pending.delete(msg.id); if (msg.error) p.reject(Error(JSON.stringify(msg.error))); else p.resolve(msg.result); } else if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.text); });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const n = ++seq; pending.set(n, { resolve, reject }); cdp.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
  const until = async (expression) => { for (let i = 0; i < 60; i++) { if (await evaluate(expression)) return; await delay(150); } throw Error('Timed out: ' + expression); };
  const screenshot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(path.join(output, name), Buffer.from(r.data, 'base64')); };
  await send('Runtime.enable'); await send('Page.enable'); await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1400, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:17891/' }); await until("!!document.querySelector('#login-pw') || !!document.querySelector('#login form')");
  // Authenticate through the production route, then reload into the application.
  await evaluate(`fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:${JSON.stringify(password)}})}).then(r=>r.json())`);
  await evaluate(`fetch('/api/servers/${id}/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:${JSON.stringify(password)}})}).then(r=>r.json())`);
  await send('Page.reload'); await until("document.querySelectorAll('.card[role=button]').length === 5");
  await until("document.querySelector('.card .pet-slot .pet-body') !== null");
  assert.equal(await evaluate("document.querySelectorAll('.card .crew-band').length"), 1);
  assert.ok(await evaluate("document.querySelector('#grid').textContent.includes('Chưa rõ phiên')"));
  assert.ok(await evaluate("document.querySelector('.playground').getBoundingClientRect().height >= 80"), 'playground remains visible in scrolling overview');
  await until("document.querySelector('#daily-ranking').textContent.includes('claude-work')");
  assert.equal(await evaluate("document.querySelectorAll('.yard-pet:not([hidden])').length"), 3);
  assert.equal(await evaluate("document.querySelectorAll('.card .pet-name').length"), 0);
  assert.equal(await evaluate("document.querySelector('.card .pet-body').getBoundingClientRect().width"), 30);
  // Wait for the real 11–23 second idle timer, without injecting a play state.
  for (let i = 0; i < 180; i++) { if (await evaluate("document.querySelectorAll('.yard-pet.act-soccer').length === 2 && !document.querySelector('.soccer-field').hidden")) break; await delay(150); }
  assert.equal(await evaluate("document.querySelectorAll('.yard-pet.act-soccer').length"), 2);
  assert.equal(await evaluate("document.querySelectorAll('.yard-pet.act-fish').length"), 1);
  assert.equal(await evaluate("document.querySelectorAll('.yard-pet.act-soccer svg text').length"), 0, 'soccer pets are awake');
  const ballBefore = await evaluate("document.querySelector('.yard-ball').style.left");
  const petBefore = await evaluate("document.querySelector('.yard-pet.act-soccer').style.left");
  await delay(1700);
  assert.notEqual(await evaluate("document.querySelector('.yard-ball').style.left"), ballBefore);
  assert.notEqual(await evaluate("document.querySelector('.yard-pet.act-soccer').style.left"), petBefore);
  assert.ok(await evaluate("parseFloat(document.querySelector('.yard-ball').style.bottom) >= 14"));
  await screenshot('overview.png');
  await evaluate("document.querySelector('.card[aria-label=\"Mở phiên claude-work\"]').click()");
  await until("document.querySelector('#detail').textContent.includes('Crew của phiên này · 2')");
  assert.equal(await evaluate("document.querySelectorAll('.meeting-room').length"), 1);
  assert.ok(await evaluate("document.querySelector('#detail').firstElementChild.classList.contains('crew')"));
  assert.equal(await evaluate("document.querySelectorAll('#detail .pet-name').length"), 0);
  assert.equal(await evaluate("document.querySelectorAll('.crew-worker-button').length"), 2);
  assert.equal(await evaluate("document.querySelector('.meeting-member svg').getBoundingClientRect().width"), 30);
  assert.equal(await evaluate("document.querySelectorAll('.meeting-member').length"), 2);
  await evaluate("document.querySelector('.meeting-member').click()");
  await until("document.querySelector('#crew-output').textContent.includes('line 89')");
  const before = logReads; await delay(1700); assert.ok(logReads > before, 'live log refreshes within 2 seconds');
  await evaluate("document.querySelector('#crew-output').scrollTop=0; document.querySelector('#crew-output').dispatchEvent(new Event('scroll'))");
  await delay(1700); assert.equal(await evaluate("document.querySelector('#crew-output').scrollTop"), 0);
  await evaluate("document.querySelector('#crew-pause').click()");
  const paused = await evaluate("document.querySelector('#crew-output').textContent"); await delay(1800); assert.equal(await evaluate("document.querySelector('#crew-output').textContent"), paused);
  workerDone = true; waiting = true;
  await until("document.querySelector('#detail').textContent.includes('Đã rời bàn · DONE')");
  await until("document.querySelector('#detail .pet-slot').textContent.includes('Chờ bạn!')");
  assert.equal(await evaluate("document.querySelector('#crew-output script') === null"), true);
  await evaluate("document.querySelector('#crew-close').click()");
  await until("document.querySelector('.pet-diary').textContent.includes('Chờ bạn')");
  await until("document.querySelector('#detail .pet-body svg') !== null");
  await screenshot('terminal.png');
  await evaluate("document.querySelector('#tab-over').click()");
  await until("!!document.querySelector('.pet-message')");
  assert.ok(await evaluate("document.querySelector('.pet-message').textContent.includes('Do you want to continue? [y/n]')"));
  await evaluate("document.querySelector('.pet-message').click()");
  assert.equal(await evaluate("document.activeElement.getAttribute('aria-label')"), 'Trả lời claude-work');
  await delay(2600);
  assert.equal(await evaluate("document.querySelectorAll('.pet-message').length"), 1);
  await until("getComputedStyle(document.querySelector('.pet-message')).transform === 'none'");
  await evaluate("document.querySelector('#v-over').scrollTop=0");
  await delay(300);
  await screenshot('overview-waiting.png');
  await evaluate("document.querySelector('.pet-message').scrollIntoView({block:'center'})");
  await delay(300);
  assert.ok(await evaluate("getComputedStyle(document.querySelector('.pet-message')).display === 'none'"), 'compact card hides repeated question after refresh');
  await screenshot('message-pet.png');
  // Advance only browser time to exercise the real two-minute threshold without a two-minute sleep.
  await evaluate("window.__calls=[];window.Notification=class{static permission='granted';static requestPermission(){return Promise.resolve('granted')}constructor(title,options){window.__calls.push({title,options})}}");
  await evaluate("document.querySelector('#set-browser').click()");
  await evaluate("window.__realNow=Date.now;Date.now=()=>window.__realNow()+121000");
  await until("window.__calls.length === 1");
  assert.ok(await evaluate("window.__calls[0].options.icon.startsWith('data:image/png')"));
  await delay(2700); assert.equal(await evaluate("window.__calls.length"), 1);
  await evaluate("Date.now=window.__realNow;document.activeElement.blur()");
  await evaluate("document.querySelector('.qr input').value='yes';document.querySelector('.qr input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
  await until("document.querySelector('#banner').textContent.includes('Đã gửi')");
  await evaluate("document.querySelector('.card[aria-label=\"Mở phiên claude-work\"]').click()");
  await until("document.querySelector('.pet-diary').textContent.includes('Đã gửi trả lời từ web')");
  await delay(300);
  await until("document.querySelector('#detail .pet-body svg') !== null");
  await screenshot('terminal.png');
  await evaluate("Array.from(document.querySelectorAll('#detail button')).find(b=>b.textContent==='Đổi thú cưng').click()");
  await until("document.querySelector('#dlg-pet').open");
  await evaluate("document.querySelector('#pet-nickname').value='<Cat>';document.querySelector('#pet-kind').value='frog';document.querySelector('#pet-hat').value='winter';document.querySelector('#form-pet').requestSubmit()");
  await until("!document.querySelector('#dlg-pet').open");
  await until("document.querySelector('#detail .pet-slot').title.includes('<Cat>')");
  assert.equal(await evaluate("document.querySelector('#detail .pet-slot cat') === null"), true);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await until("document.documentElement.classList.contains('pets-still')");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('#detail .pet-body')).animationName"), 'none');
  await evaluate("document.querySelector('#pets-enabled').click()");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('#detail .pet-slot')).display"), 'none');
  await send('Page.reload'); await until("document.documentElement.classList.contains('pets-off')");
  await evaluate("document.querySelector('#pets-enabled').click()");
  await send('Emulation.setDeviceMetricsOverride', { width: 400, height: 860, deviceScaleFactor: 1, mobile: false });
  await evaluate("document.querySelector('.card[aria-label=\"Mở phiên claude-work\"]').click()");
  await until("document.querySelector('#detail').textContent.includes('Crew của phiên này')");
  assert.ok(await evaluate("document.documentElement.scrollWidth <= 400"), 'mobile has no horizontal overflow');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, 'chrome-results.json'), JSON.stringify({ status: 'PASS', browser: 'Google Chrome headless', fixture: 'Real app/auth/SSH/WebSocket; deterministic SSH fixture, not a Linux tmux host', checks: ['compact header: single 30px pet, no duplicate name', 'soccer: two pets run and ball moves on real timer', 'Crew first, compact worker buttons and 30px meeting pets', 'overview/card ownership', 'unknown worker label', 'terminal meeting room', 'log refresh <=2s', 'scroll up stops follow', 'pause', 'retained DONE worker', 'wait sign', 'escaped text', 'pet preferences', 'reduced motion', 'persisted switch', 'mobile width', 'message question and quick reply focus', 'one notification per wait after two minutes with local PNG icon (Notification stub)', 'persisted diary and successful reply'], screenshots: ['overview.png', 'terminal.png', 'message-pet.png'] }, null, 2));
  console.log('Chrome checks PASS');
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => {
  if (cdp) cdp.close(); for (const c of connections) c.end(); if (ssh) ssh.close();
  for (const child of children.reverse()) { child.kill('SIGTERM'); await Promise.race([new Promise((r) => child.once('exit', r)), delay(3000)]); if (child.exitCode === null) child.kill('SIGKILL'); }
  fs.rmSync(scratch, { recursive: true, force: true });
});
