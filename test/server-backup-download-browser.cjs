'use strict';
// Actual Chrome + the unchanged shipped desktop bridge. All data, auth and native
// invokes are synthetic; system-browser downloads use an isolated browser context.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const crypto = require('node:crypto'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process'), { Writable } = require('node:stream'), WebSocket = require('ws');
const { createFeatures } = require('../lib/features');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'termnest-backup-download-browser-'));
const publicDir = path.join(__dirname, '../public'), dataDir = path.join(output, 'data'), libDir = path.join(output, 'features');
fs.mkdirSync(dataDir); fs.mkdirSync(libDir); fs.mkdirSync(path.join(output, 'downloads'));
fs.writeFileSync(path.join(libDir, 'server-backup.js'), `module.exports=require(${JSON.stringify(require.resolve('../lib/features/server-backup'))});`);
const vault = { unlocked: true, data: { servers: [], features: { 'server-backup': {
  enabled: false, contentKey: crypto.randomBytes(32).toString('base64'), keyBackedUp: true,
} } } };
const sendJSON = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
const features = createFeatures({ libDir, publicDir, deps: { dataDir, vault: () => vault, save: () => {}, remotes: () => new Map(), backendOf: () => null,
  send: sendJSON, fail: (res, status) => sendJSON(res, status, {}), readJson: async req => { let body = ''; for await (const b of req) body += b; return JSON.parse(body); } },
  log: { log: () => {}, error: () => { throw Error('fixture feature registration failed'); } } });
features.load(); const controller = features.service('server-backup'); controller.stop(); controller.stopped = false;
const store = controller.openStore(true), tx = store.begin('removed-vm', 'Saved offline VM'), chunks = [], expectedHash = crypto.createHash('sha256');
const fileSize = 96 * store.limits.chunkBytes;
for (let i = 0; i < 96; i++) { const bytes = Buffer.alloc(store.limits.chunkBytes, i); chunks.push(store.chunk(bytes)); expectedHash.update(bytes); }
store.add(tx, { path: 'files/large.bin', size: fileSize, kind: 'file', mtimeMs: 1, chunks });
const snapshot = store.commit(tx), file = store.manifest('removed-vm', snapshot.id).entries[0], originalHash = expectedHash.digest('hex');
let mintCount = 0, mintReply = null; const anonymousDownloads = [], badFetches = [], errors = [], results = [];
const nativePrelude = `
window.__TMUX_DESKTOP_ORIGIN=location.origin;window.__calls=[];window.__forbidden=[];window.__says=[];window.__rejectOpen=false;
window.__TAURI_INTERNALS__={invoke:(command,args)=>{
 if(command==='save_export'){__forbidden.push('save_export');return Promise.reject(Error('forbidden native save'))}
 if(command==='open_external'){__calls.push(args.url);if(__rejectOpen)return Promise.reject(Error('synthetic opener rejection'));return new Promise(resolve=>window.__openResolve=resolve)}
 return Promise.resolve(command==='desktop_smoke'?false:true);
}};
for(const name of ['arrayBuffer','blob'])Response.prototype[name]=function(){__forbidden.push(name);throw Error('forbidden whole-response read')};
URL.createObjectURL=()=>{__forbidden.push('objectURL');throw Error('forbidden blob')};
const originalArrayFrom=Array.from;Array.from=function(value,...args){if(ArrayBuffer.isView(value)){__forbidden.push('typed-array conversion');throw Error('forbidden IPC conversion')}return originalArrayFrom.call(this,value,...args)};
const realFetch=window.fetch;window.fetch=(url,options)=>{if(/server-backup\\/(export|download)\\?/.test(String(url))){__forbidden.push('webview download fetch');throw Error('forbidden download fetch')}return realFetch(url,options)};
window.Terminal=function(){};
`;
function html(native) { return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/features/server-backup.css"><style>body{overflow:auto}#app{padding:20px}dialog{max-width:95vw}</style>${native ? '<script src="/native-fixture.js"></script><script src="/old-bridge.js"></script>' : ''}</head><body><div id="app"><h1>Sao lưu</h1><dialog id="fixture-settings"><div id="server-backup-settings-mount"></div></dialog></div><script src="/features-host.js"></script><script>
const labels=${fs.readFileSync(path.join(publicDir, 'locales/vi.json'), 'utf8')};window.i18n=key=>labels[key]||key;window.__says=window.__says||[];window.__heartbeat=0;setInterval(()=>__heartbeat++,10);
TW.attach({api:async(method,url,body)=>{const r=await fetch(url,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});if(!r.ok)throw Error('HTTP '+r.status);return r.json()},say:(...a)=>__says.push(a),servers:()=>[],openSettings:()=>{},browseDir:()=>{}});
</script><script src="/features/server-backup.js"></script></body></html>`; }
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/features/server-backup/download-ticket/')) {
      anonymousDownloads.push({ cookie: req.headers.cookie || '', method: req.method });
      return await controller.download(req, res, url);
    }
    if (url.pathname.startsWith('/api/')) {
      if (req.headers.cookie !== 'fixture=authenticated') return sendJSON(res, 401, {});
      if (url.pathname === '/api/status') return sendJSON(res, 200, {});
      if (url.pathname === '/api/features/server-backup/download-ticket') {
        mintCount++;
        if (mintReply !== null) { req.resume(); return sendJSON(res, 201, { downloadURL: mintReply }); }
      }
      if (/server-backup\/(export|download)$/.test(url.pathname)) badFetches.push(url.pathname);
      return await features.handle(req, res, url);
    }
    if (url.pathname === '/') { res.setHeader('Set-Cookie', 'fixture=authenticated; HttpOnly; SameSite=Strict; Path=/'); res.setHeader('Content-Type', 'text/html'); return res.end(html(url.searchParams.has('native'))); }
    if (url.pathname === '/native-fixture.js') { res.setHeader('Content-Type', 'application/javascript'); return res.end(nativePrelude); }
    if (url.pathname === '/old-bridge.js') { res.setHeader('Content-Type', 'application/javascript'); return res.end(fs.readFileSync(path.join(__dirname, '../desktop/src/bridge.js'))); }
    const p = path.resolve(publicDir, '.' + url.pathname);
    if (!p.startsWith(publicDir + path.sep) || !fs.existsSync(p)) { res.statusCode = 404; return res.end(); }
    res.setHeader('Content-Type', p.endsWith('.js') ? 'application/javascript' : 'text/css'); res.end(fs.readFileSync(p));
  } catch { if (!res.headersSent) res.statusCode = 500; res.end(); }
});
const delay = ms => new Promise(r => setTimeout(r, ms));
async function hashFile(filename, options) { const hash = crypto.createHash('sha256'); for await (const bytes of fs.createReadStream(filename, options)) hash.update(bytes); return hash.digest('hex'); }
let chrome, ws, browserWS, send, closeBrowser, chromeError = '';
(async () => {
  const executable = [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean).find(p => fs.existsSync(p));
  assert.ok(executable, 'Set CHROME_BIN to actual Chrome'); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + server.address().port;
  chrome = spawn(executable, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + path.join(output, 'profile'), 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  chrome.stderr.on('data', b => { chromeError = (chromeError + b).slice(-2000); });
  const portFile = path.join(output, 'profile/DevToolsActivePort');
  for (let n = 0; n < 150 && !fs.existsSync(portFile) && chrome.exitCode === null; n++) await delay(100);
  assert.ok(fs.existsSync(portFile), 'Chrome boot: ' + chromeError);
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0], targets = await (await fetch('http://127.0.0.1:' + port + '/json')).json();
  ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl); await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let seq = 0; const pending = new Map();
  ws.on('message', raw => { const m = JSON.parse(raw); if (m.id) { const p = pending.get(m.id); if (p) { clearTimeout(p.timer); pending.delete(m.id); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); } } else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text); });
  send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout ' + method)); }, 10000); pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params })); });
  const version = await (await fetch('http://127.0.0.1:' + port + '/json/version')).json();
  browserWS = new WebSocket(version.webSocketDebuggerUrl); await new Promise((resolve, reject) => { browserWS.once('open', resolve); browserWS.once('error', reject); });
  let browserSeq = 0; const browserPending = new Map();
  browserWS.on('message', raw => { const m = JSON.parse(raw), p = browserPending.get(m.id); if (p) { clearTimeout(p.timer); browserPending.delete(m.id); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); } });
  const browserSend = (method, params = {}) => new Promise((resolve, reject) => { const id = ++browserSeq, timer = setTimeout(() => { browserPending.delete(id); reject(Error('CDP timeout ' + method)); }, 10000); browserPending.set(id, { resolve, reject, timer }); browserWS.send(JSON.stringify({ id, method, params })); });
  closeBrowser = () => browserSend('Browser.close');
  const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); assert.ok(!r.exceptionDetails, JSON.stringify(r.exceptionDetails)); return r.result.value; };
  const until = async (fn, label) => { for (let n = 0; n < 300; n++) { if (await fn()) return; await delay(30); } assert.fail('Timeout: ' + label); };
  const ui = (expression, label) => until(() => evaluate(expression), label);
  const downloadButton = index => 'document.querySelectorAll(".backup-native-download")[' + index + ']';
  await send('Runtime.enable'); await send('Page.enable');
  const { browserContextId } = await browserSend('Target.createBrowserContext');
  await browserSend('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: path.join(output, 'downloads'), browserContextId });
  await send('Page.navigate', { url: origin + '/?native' });
  await ui('window.TW_DESKTOP && document.querySelectorAll(".backup-row").length===1', 'actual bridge and offline row');
  await evaluate('document.querySelector("#fixture-settings").showModal();Array.from(document.querySelectorAll(".backup-row button")).find(b=>b.textContent==="Tải file").click()');
  await ui('document.querySelectorAll(".backup-file-list button").length===1', 'saved file');
  await evaluate('document.querySelector(".backup-file-list button").click()');
  await ui('document.querySelectorAll(".backup-native-download").length===2 && document.querySelector(".backup-preview").textContent.includes("Tệp nhị phân")', 'two native buttons');
  assert.equal(await evaluate('document.querySelectorAll(".backup-dialog a[download]").length'), 0);
  const tarHash = crypto.createHash('sha256'), sink = new Writable({ write(chunk, _, cb) { tarHash.update(chunk); cb(); } }); sink.setHeader = () => {};
  await store.export(sink, 'removed-vm', snapshot.id); const archiveHash = tarHash.digest('hex');
  for (const [index, filename, expected, width] of [[0, 'termnest-backup.tar', archiveHash, 1440], [1, 'large.bin', originalHash, 390]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 500 });
    const beforeMints = mintCount, beforeCalls = await evaluate('__calls.length'), heartbeat = await evaluate('__heartbeat');
    await evaluate(downloadButton(index) + '.click();' + downloadButton(index) + '.click()');
    await ui('__calls.length===' + (beforeCalls + 1), 'existing open_external invocation'); await delay(130);
    assert.equal(mintCount, beforeMints + 1); assert.equal(await evaluate(downloadButton(index) + '.disabled'), true);
    assert.ok((await evaluate('__heartbeat')) - heartbeat >= 5, 'heartbeat while opener pending');
    const url = await evaluate('__calls.at(-1)'); assert.equal(new URL(url).origin, origin); assert.match(new URL(url).pathname, /^\/api\/features\/server-backup\/download-ticket\/[A-Za-z0-9_-]{43}$/);
    await evaluate('__openResolve()'); await ui('!' + downloadButton(index) + '.disabled', 'opener returned');
    let reads = 0; const readChunk = store.readChunk.bind(store);
    store.readChunk = async id => { reads++; await delay(2); return readChunk(id); };
    const beforeDownload = await evaluate('__heartbeat');
    const { targetId } = await browserSend('Target.createTarget', { url, browserContextId });
    const destination = path.join(output, 'downloads', filename);
    await until(() => fs.existsSync(destination) && !fs.existsSync(destination + '.crdownload') && fs.statSync(destination).size >= fileSize, 'browser download');
    await until(() => !controller.downloads.active.size, 'lease released'); store.readChunk = readChunk;
    assert.ok(reads >= 96); assert.ok((await evaluate('__heartbeat')) - beforeDownload >= 5, 'heartbeat during browser streaming');
    assert.equal(await hashFile(destination), expected); assert.ok(fs.statSync(destination).size > 20_000_000);
    if (index === 0) assert.equal(await hashFile(destination, { start: 1536, end: 1536 + fileSize - 1 }), originalHash, 'tar payload exact');
    assert.equal((await fetch(url)).status, 404, 'single use');
    assert.equal(await evaluate('document.querySelectorAll(".backup-dialog a[download]").length'), 0);
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true);
    assert.equal(await evaluate('document.querySelector(".backup-dialog").scrollWidth<=document.querySelector(".backup-dialog").clientWidth'), true);
    const shot = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(output, 'desktop-' + width + '.png'), Buffer.from(shot.data, 'base64'));
    await browserSend('Target.closeTarget', { targetId }); results.push({ kind: index ? 'original' : 'archive', width, bytes: fs.statSync(destination).size, sha256: expected });
  }
  // Invalid server responses never reach the existing privileged opener.
  for (const bad of ['https://attacker.invalid/api/features/server-backup/download-ticket/' + 'a'.repeat(43), '//attacker.invalid/', '/api/features/server-backup/export', '/api/features/server-backup/download-ticket/' + 'a'.repeat(43) + '?file=other', '/api/features/server-backup/download-ticket/%2e%2e']) {
    mintReply = bad; const calls = await evaluate('__calls.length'), says = await evaluate('__says.length');
    await evaluate(downloadButton(0) + '.click()'); await ui('__says.length>' + says, 'invalid URL rejected'); assert.equal(await evaluate('__calls.length'), calls);
  }
  mintReply = null; await evaluate('__rejectOpen=true');
  const says = await evaluate('__says.length'); await evaluate(downloadButton(0) + '.click()'); await ui('__says.length>' + says, 'opener rejection');
  await until(() => !controller.downloads.tickets.size && !store.readers, 'failed opener cancels lease');
  assert.deepEqual(await evaluate('__forbidden'), []); assert.equal(await evaluate('__says.some(s=>s[1]===true)'), false, 'no false success'); assert.deepEqual(badFetches, []);
  assert.ok(anonymousDownloads.length >= 4); assert.ok(anonymousDownloads.every(r => !r.cookie && r.method === 'GET'), 'system browser has no app cookie');
  // Standard browser still downloads through its authenticated streaming links.
  await send('Page.navigate', { url: origin + '/?web' }); await ui('document.querySelectorAll(".backup-row").length===1', 'normal web');
  await evaluate('document.querySelector("#fixture-settings").showModal();Array.from(document.querySelectorAll(".backup-row button")).find(b=>b.textContent==="Tải file").click()');
  await ui('document.querySelector(".backup-file-list button")', 'web saved file'); await evaluate('document.querySelector(".backup-file-list button").click()');
  await ui('document.querySelectorAll(".backup-dialog a[download]").length===2', 'normal web links');
  assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".backup-dialog a[download]")).map(a=>new URL(a.href).pathname)'), ['/api/features/server-backup/export', '/api/features/server-backup/download']);
  const webDestination = path.join(output, 'downloads', 'web'); fs.mkdirSync(webDestination);
  await browserSend('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: webDestination });
  for (const [index, filename, expected] of [[0, 'termnest-backup.tar', archiveHash], [1, 'large.bin', originalHash]]) {
    await evaluate('document.querySelectorAll(".backup-dialog a[download]")[' + index + '].click()');
    const destination = path.join(webDestination, filename);
    await until(() => fs.existsSync(destination) && !fs.existsSync(destination + '.crdownload') && fs.statSync(destination).size >= fileSize, 'normal authenticated browser download');
    assert.equal(await hashFile(destination), expected);
  }
  assert.deepEqual(badFetches, ['/api/features/server-backup/export', '/api/features/server-backup/download']);
  await until(() => !store.readers, 'web download lease released');
  assert.deepEqual(errors, []); assert.equal(store.readers, 0);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, results, anonymousDownloads: anonymousDownloads.length, authenticatedWebDownloads: 2, forbidden: [], errors }, null, 2));
  console.log('PASS: actual Chrome + unchanged desktop bridge; 24 MiB original/archive exact hashes, anonymous browser downloads, heartbeat, no arrayBuffer/blob/save_export/typed-array IPC, double-click guard, URL rejection, opener cancellation, 1440/390 screenshots, normal web links. Artifacts: ' + output);
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
  controller.stop();
  if (closeBrowser && chrome?.exitCode === null) { try { await closeBrowser(); } catch { chrome.kill(); } }
  ws?.close(); browserWS?.close();
  if (chrome && chrome.exitCode === null && chrome.signalCode === null) await new Promise(resolve => { const timer = setTimeout(() => chrome.kill(), 5000); chrome.once('exit', () => { clearTimeout(timer); resolve(); }); });
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  for (let n = 0; n < 10; n++) { try { fs.rmSync(path.join(output, 'profile'), { recursive: true, force: true }); break; } catch (e) { if (e.code !== 'ENOTEMPTY' || n === 9) throw e; await delay(100); } }
  // Keep only screenshots and small evidence; plaintext fixtures/downloads are disposable.
  for (const name of ['data', 'features', 'downloads']) fs.rmSync(path.join(output, name), { recursive: true, force: true });
});
