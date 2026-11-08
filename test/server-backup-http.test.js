'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { Vault } = require('../lib/vault');
const { SnapshotStore } = require('../lib/server-backup-store');
const ROOT = path.resolve(__dirname, '..');
async function within(promise, label, ms = 5000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('fixture timeout: ' + label)), ms); })]); }
  finally { clearTimeout(timer); }
}
// Keep the real HTTP/auth/Host/Origin/lifecycle boundary and all real feature registration.
// Substitute backend creation, so no tmux/SSH/user account or live chats are touched.
// IPC can shorten ticket expiry and lock this fixture's real vault, without a test HTTP API.
const PROGRAM = `
const Module=require('module'),load=Module._load;
Module._load=function(name,parent,main){
 if(name==='./lib/backends'&&parent.filename.endsWith('server.js'))return {
  LOCAL_ID:'synthetic-local',localConfig:()=>({id:'synthetic-local',local:true}),
  createBackend:cfg=>({cfg,ready:false,snapshot:null,longHistory:[],lost:[],canAutoConnect:false,
   async connect(){throw Error('fixture offline');},async poll(){},scheduleRetry(){},close(){}})
 };
 const mod=load.apply(this,arguments);
 if(name==='./lib/features'&&parent.filename.endsWith('server.js'))return {...mod,createFeatures(options){
  const features=mod.createFeatures(options);
  process.on('message',m=>{
   const c=features.service('server-backup');
   if(m.fixture==='shortTTL')c.downloads.ttl=30;
   if(m.fixture==='lock'){options.deps.vault().key=null;c.tick();}
   process.send({fixture:m.fixture,readers:c.store?.readers||0,active:c.downloads.active.size,tickets:c.downloads.tickets.size});
  });return features;
 }};
 return mod;
};
const app=require('./server'); app.server.on('listening',()=>process.send({port:app.server.address().port}));
`;
function request(port, method, route, { cookie, origin, host = '127.0.0.1', body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body), headers = { Host: host + ':' + port };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (cookie) headers.Cookie = cookie; if (origin) headers.Origin = origin;
    const req = http.request({ hostname: '127.0.0.1', port, method, path: route, headers }, res => {
      const chunks = []; res.on('data', d => chunks.push(d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) })); res.on('error', reject);
    }); req.setTimeout(5000, () => req.destroy(Error('fixture HTTP timeout'))); req.on('error', reject); req.end(data);
  });
}
function streamRequest(port, route, abort = false) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256'); let size = 0;
    const req = http.get({ hostname: '127.0.0.1', port, path: route }, res => {
      res.on('data', bytes => {
        hash.update(bytes); size += bytes.length;
        if (abort) { res.destroy(); req.destroy(); resolve({ status: res.statusCode, size }); }
      });
      res.on('end', () => resolve({ status: res.statusCode, size, hash: hash.digest('hex') }));
      res.on('error', e => { if (!abort) reject(e); });
    });
    req.setTimeout(5000, () => req.destroy(Error('stream timeout'))); req.on('error', reject);
  });
}

test('real server boots locked, authenticates every saved route, enforces Host/Origin, and serves offline bytes', { timeout: 20000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-backup-http-')), home = path.join(dir, 'home'); fs.mkdirSync(home);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const password = 'synthetic-test-password', key = crypto.randomBytes(32), vault = new Vault(path.join(dir, 'vault.json'));
  vault.create(password, { servers: [], features: { 'server-backup': { enabled: false, contentKey: key.toString('base64'), keyBackedUp: true } } });
  const store = new SnapshotStore(dir, key), data = Buffer.from('OFFLINE-SYNTHETIC-original-\u0111\u1ea5t'), tx = store.begin('deleted-vm', 'Deleted VM');
  store.add(tx, { path: 'chats/claude/profile/original.jsonl', kind: 'chat', tool: 'claude', size: data.length, mtimeMs: 1, chunks: [store.chunk(data)] });
  const snapshot = store.commit(tx), file = store.manifest('deleted-vm', snapshot.id).entries[0];
  const big = store.begin('large-vm', 'Large offline VM'), chunks = [], hash = crypto.createHash('sha256'), bigSize = 88 * store.limits.chunkBytes;
  for (let i = 0; i < 88; i++) { const bytes = Buffer.alloc(store.limits.chunkBytes, i); hash.update(bytes); chunks.push(store.chunk(bytes)); }
  store.add(big, { path: 'files/large.bin', kind: 'file', size: bigSize, mtimeMs: 1, chunks });
  const bigSnapshot = store.commit(big), bigFile = store.manifest('large-vm', bigSnapshot.id).entries[0], bigHash = hash.digest('hex');
  const child = spawn(process.execPath, ['-e', PROGRAM], { cwd: ROOT, env: { ...process.env, HOME: home, USERPROFILE: home, TW_DATA: dir, TW_DEFAULT_DIR: home, TW_PORT: '0', TW_PASSWORD_FILE: undefined, TW_PACKAGED: '0' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = ''; child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; }); const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await within(exited, 'server cleanup'); } });
  const port = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('boot timeout: ' + output)), 10000); child.once('message', m => { clearTimeout(timer); resolve(m.port); }); child.once('exit', () => { clearTimeout(timer); reject(Error('boot failed: ' + output)); }); });
  const routes = ['/status', '/snapshots?server=deleted-vm', `/files?server=deleted-vm&snapshot=${snapshot.id}`, `/preview?server=deleted-vm&snapshot=${snapshot.id}&file=${file.id}`, `/download?server=deleted-vm&snapshot=${snapshot.id}&file=${file.id}`, `/export?server=deleted-vm&snapshot=${snapshot.id}`];
  for (const route of routes) assert.equal((await request(port, 'GET', '/api/features/server-backup' + route)).status, 401);
  for (const route of ['/run', '/control', '/download-ticket', '/download-cancel']) assert.equal((await request(port, 'POST', '/api/features/server-backup' + route, { body: {} })).status, 401);
  const login = await request(port, 'POST', '/api/login', { body: { password } }); assert.equal(login.status, 200);
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const state = await request(port, 'GET', '/api/features/server-backup/status', { cookie }); assert.equal(state.status, 200);
  assert.equal(JSON.parse(state.bytes).servers[0].hasSnapshot, true); assert.ok(!state.bytes.includes(Buffer.from(key.toString('base64'))));
  assert.equal((await request(port, 'GET', '/api/features/server-backup/status', { cookie, host: 'attacker.invalid' })).status, 403);
  assert.equal((await request(port, 'POST', '/api/features/server-backup/control', { cookie, origin: 'http://attacker.invalid', body: { enabled: true } })).status, 403);
  const initial = JSON.parse(state.bytes), control = { enabled: initial.enabled,
    servers: initial.servers.map(s => ({ serverId: s.id, roots: s.roots, includeChats: s.includeChats })) };
  const controlled = await request(port, 'POST', '/api/features/server-backup/control', { cookie, body: control }); assert.equal(controlled.status, 200);
  assert.equal(JSON.parse(controlled.bytes).servers[0].configured, false);
  assert.equal((await request(port, 'POST', '/api/features/server-backup/control', { cookie, body: { enabled: true, servers: [{ serverId: 'unknown', roots: [], includeChats: false }] } })).status, 400);
  for (const route of routes) assert.equal((await request(port, 'GET', '/api/features/server-backup' + route, { cookie })).status, 200, route);
  const downloaded = await request(port, 'GET', '/api/features/server-backup' + routes[4], { cookie }); assert.deepEqual(downloaded.bytes, data);
  const exported = await request(port, 'GET', '/api/features/server-backup' + routes[5], { cookie }); assert.ok(exported.bytes.includes(data));
  assert.equal((await request(port, 'GET', `/api/features/server-backup/download?server=deleted-vm&snapshot=${snapshot.id}&file=../../vault.json`, { cookie })).status, 404);
  const mint = body => request(port, 'POST', '/api/features/server-backup/download-ticket', { cookie, origin: 'http://127.0.0.1:' + port, body });
  const exact = { serverId: 'deleted-vm', snapshotId: snapshot.id, fileId: file.id };
  for (const body of [{ ...exact, serverId: 'other' }, { ...exact, snapshotId: 'f'.repeat(64) }, { ...exact, fileId: 'f'.repeat(64) }]) assert.equal((await mint(body)).status, 404);
  assert.equal((await mint({ ...exact, fileId: '../vault.json' })).status, 400);
  assert.equal((await request(port, 'POST', '/api/features/server-backup/download-ticket', { cookie, origin: 'http://attacker.invalid', body: exact })).status, 403);
  assert.equal((await request(port, 'GET', '/api/features/server-backup/download-ticket', { cookie })).status, 404);
  const minted = await mint(exact); assert.equal(minted.status, 201);
  const capability = JSON.parse(minted.bytes).downloadURL; assert.match(capability, /^\/api\/features\/server-backup\/download-ticket\/[A-Za-z0-9_-]{43}$/);
  for (const [method, options, status] of [['HEAD', {}, 405], ['POST', {}, 405], ['GET', { origin: 'http://attacker.invalid' }, 403], ['GET', { host: 'attacker.invalid' }, 403]]) {
    assert.equal((await request(port, method, capability, options)).status, status);
  }
  for (const bad of [capability + '?file=other', capability + '/extra', capability + '%2f..', '/api/features/server-backup/download-ticket/' + 'x'.repeat(43)]) {
    assert.equal((await request(port, 'GET', bad)).status, 404);
  }
  const raced = await Promise.all([request(port, 'GET', capability), request(port, 'GET', capability)]);
  assert.deepEqual(raced.map(r => r.status).sort(), [200, 404]);
  const good = raced.find(r => r.status === 200); assert.deepEqual(good.bytes, data);
  assert.match(good.headers['cache-control'], /no-store/); assert.equal(good.headers['referrer-policy'], 'no-referrer'); assert.equal(good.headers['x-content-type-options'], 'nosniff');
  assert.equal((await request(port, 'GET', capability)).status, 404);
  const archiveURL = JSON.parse((await mint({ serverId: exact.serverId, snapshotId: exact.snapshotId })).bytes).downloadURL;
  assert.ok((await request(port, 'GET', archiveURL)).bytes.equals(exported.bytes));
  const cancelled = JSON.parse((await mint(exact)).bytes).downloadURL;
  assert.equal((await request(port, 'POST', '/api/features/server-backup/download-cancel', { cookie, body: { downloadURL: cancelled } })).status, 200);
  assert.equal((await request(port, 'GET', cancelled)).status, 404);
  for (const route of routes) assert.equal((await request(port, 'GET', '/api/features/server-backup' + route)).status, 401, 'capability never authenticates other APIs');
  const fixtureCommand = async fixture => { const reply = once(child, 'message'); child.send({ fixture }); const result = (await within(reply, fixture))[0]; assert.equal(result.fixture, fixture); return result; };
  const bigBody = { serverId: 'large-vm', snapshotId: bigSnapshot.id, fileId: bigFile.id };
  const largeURL = JSON.parse((await mint(bigBody)).bytes).downloadURL;
  const largeDownload = await streamRequest(port, largeURL);
  assert.deepEqual(largeDownload, { status: 200, size: bigSize, hash: bigHash });
  assert.equal((await fixtureCommand('stats')).readers, 0);
  const abortURL = JSON.parse((await mint(bigBody)).bytes).downloadURL;
  assert.equal((await fixtureCommand('stats')).readers, 1);
  const aborted = await streamRequest(port, abortURL, true); assert.equal(aborted.status, 200); assert.ok(aborted.size < bigSize);
  let stats;
  for (let n = 0; n < 100; n++) { stats = await fixtureCommand('stats'); if (!stats.readers && !stats.active) break; await new Promise(r => setTimeout(r, 10)); }
  assert.equal(stats.readers, 0); assert.equal(stats.active, 0); assert.equal(stats.tickets, 0);
  await fixtureCommand('shortTTL'); const expiring = JSON.parse((await mint(exact)).bytes).downloadURL;
  await new Promise(r => setTimeout(r, 70)); assert.equal((await request(port, 'GET', expiring)).status, 404);
  const lockedTicket = JSON.parse((await mint(exact)).bytes).downloadURL;
  await fixtureCommand('lock');
  assert.equal((await request(port, 'GET', lockedTicket)).status, 401);
  assert.equal((await mint(exact)).status, 401);
  assert.equal((await request(port, 'GET', '/api/features/server-backup/status', { cookie })).status, 401);
  assert.ok(!output.includes(capability)); assert.ok(!output.includes(archiveURL));
  assert.ok(!/server-backup.*not loaded/i.test(output), output); assert.ok(!output.includes(data.toString()));
  child.kill('SIGTERM'); const [code] = await within(exited, 'server shutdown'); assert.equal(code, 0, output);
});
