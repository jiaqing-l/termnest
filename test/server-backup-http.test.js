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
// Keep the real HTTP/auth/Host/Origin/lifecycle boundary and all real feature registration.
// Substitute only backend creation, so no tmux/SSH/user account or live chats are touched.
const PROGRAM = `
const Module=require('module'),load=Module._load;
Module._load=function(name,parent,main){
 if(name==='./lib/backends'&&parent.filename.endsWith('server.js'))return {
  LOCAL_ID:'synthetic-local',localConfig:()=>({id:'synthetic-local',local:true}),
  createBackend:cfg=>({cfg,ready:false,snapshot:null,longHistory:[],lost:[],canAutoConnect:false,
   async connect(){throw Error('fixture offline');},async poll(){},scheduleRetry(){},close(){}})
 };
 return load.apply(this,arguments);
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
    }); req.on('error', reject); req.end(data);
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
  const child = spawn(process.execPath, ['-e', PROGRAM], { cwd: ROOT, env: { ...process.env, HOME: home, USERPROFILE: home, TW_DATA: dir, TW_DEFAULT_DIR: home, TW_PORT: '0', TW_PASSWORD_FILE: undefined, TW_PACKAGED: '0' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = ''; child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; }); const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } });
  const port = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('boot timeout: ' + output)), 10000); child.once('message', m => { clearTimeout(timer); resolve(m.port); }); child.once('exit', () => { clearTimeout(timer); reject(Error('boot failed: ' + output)); }); });
  const routes = ['/status', '/snapshots?server=deleted-vm', `/files?server=deleted-vm&snapshot=${snapshot.id}`, `/preview?server=deleted-vm&snapshot=${snapshot.id}&file=${file.id}`, `/download?server=deleted-vm&snapshot=${snapshot.id}&file=${file.id}`, `/export?server=deleted-vm&snapshot=${snapshot.id}`];
  for (const route of routes) assert.equal((await request(port, 'GET', '/api/features/server-backup' + route)).status, 401);
  for (const route of ['/run', '/control']) assert.equal((await request(port, 'POST', '/api/features/server-backup' + route, { body: {} })).status, 401);
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
  assert.ok(!/server-backup.*not loaded/i.test(output), output); assert.ok(!output.includes(data.toString()));
  child.kill('SIGTERM'); const [code] = await exited; assert.equal(code, 0, output);
});
