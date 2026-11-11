'use strict';
const { tr, langOf, setLang } = require('./lib/i18n-server');
const crypto = require('crypto');
const zlib = require('zlib');
const HISTORY_LINES = 100000;
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const { Vault } = require('./lib/vault');
const { Remote } = require('./lib/remote');
const { LOCAL_ID, localConfig, createBackend } = require('./lib/backends');
const daily = require('./lib/daily');
const { TokenCache } = require('./lib/token-cache');
const { UsageService, validRange } = require('./lib/usage');
const { createDiscovery, merge: mergeUsageAccounts, mergeIdentity } = require('./lib/usage-discover');
const discoverUsage = createDiscovery();
const diary = require('./lib/diary');
const { scrollScript, parseScrollState } = require('./lib/scroll');
const { screensScript, parseScreens } = require('./lib/screens');
const { keysScript, BAD: BAD_KEYS } = require('./lib/keys');
const { injectReportLinks } = require('./lib/report-links');
const { createFeatures } = require('./lib/features');
const { cleanPrefs, mergePrefs, syncKnown, claudeSessionId, parseDirs, shq, validDir, validHost, validName, validUser } = require('./lib/parse');
const { cleanFlags } = require('./lib/agent-flags');
const { acquireDataLock, unlockFromFile } = require('./lib/service-runtime');

const HOST = '127.0.0.1'; // Local command execution is available: never expose directly to the LAN.
const PORT = Number(process.env.TW_PORT || 7681);
const DATA = process.env.TW_DATA || path.join(__dirname, 'data');
const tokenCache = new TokenCache({dataDir:DATA});
const usage = new UsageService();
const POLL_MS = Number(process.env.TW_POLL_MS || 3000);
const DEFAULT_DIR = process.env.TW_DEFAULT_DIR || os.homedir();
const SESSION_MS = 12 * 60 * 60 * 1000;
const ACTIVE_MS = 30 * 1000; // fast polling only while a page is active
const MAX_BODY = 256 * 1024;
const LOGIN_LIMIT = 5;
const LOGIN_LOCK_MS = 60 * 1000;
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]',
  ...(process.env.TW_ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)]);

const vault = new Vault(path.join(DATA, 'vault.json'));
const remotes = new Map();
const HISTORY_FILE = path.join(DATA, 'history.json');
let savedHistory = {};
try {
  const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) savedHistory = raw;
} catch { /* missing or corrupt history is harmless */ }

function historyPoints(points, since = Date.now() - 86400000) {
  return (Array.isArray(points) ? points : []).filter((p) => p && Number.isFinite(p.t) &&
    p.t >= since && p.t <= Date.now() && ['cpu', 'ram', 'disk'].every((k) => p[k] === null || Number.isFinite(p[k])))
    .sort((a, b) => a.t - b.t).reduce((kept, p) => {
      if (!kept.length || p.t - kept.at(-1).t >= 60000) kept.push(p);
      return kept;
    }, []).slice(-1440);
}

function saveHistory() {
  if (!vault.unlocked) return;
  const data = Object.fromEntries([...remotes].map(([id, r]) => [id, historyPoints(r.longHistory)]));
  try {
    fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
    const tmp = `${HISTORY_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, HISTORY_FILE);
  } catch { console.error('Could not save history.'); }
}
const sessions = new Map(); // cookie token -> expiry
const openTerms = new Set();
let lastSeen = 0;
let failures = 0;
let lockedUntil = 0;

const NM = path.resolve(path.dirname(require('module').createRequire(path.join(__dirname, 'server.js')).resolve('@xterm/xterm')), '../../..');
const PUB = path.join(__dirname, 'public');
// Every public/locales/<lang>.json becomes one language of window.TW_LOCALES, so a new file is a new language.
let localesCache = { stamp: '', script: '' };
function localesScript() {
  const dir = path.join(PUB, 'locales');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const stamp = files.map((f) => f + fs.statSync(path.join(dir, f)).mtimeMs).join('|');
  if (stamp !== localesCache.stamp) {
    const all = {};
    for (const f of files) { try { all[f.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { /* a broken file never takes the others down */ } }
    localesCache = { stamp, script: 'window.TW_LOCALES=' + JSON.stringify(all).replace(/</g, '\\u003c') + ';' };
  }
  return localesCache.script;
}
const STATIC = {
  '/': [path.join(PUB, 'index.html'), 'text/html; charset=utf-8'],
  '/markdown-worker.js': [path.join(PUB, 'markdown-worker.js'), 'text/javascript; charset=utf-8'],
  '/vendor/markdown-it.js': [path.join(NM, 'markdown-it/dist/markdown-it.min.js'), 'text/javascript; charset=utf-8'],
  '/file-viewer.js': [path.join(PUB, 'file-viewer.js'), 'text/javascript; charset=utf-8'],
  '/token-ui.js': [path.join(PUB, 'token-ui.js'), 'text/javascript; charset=utf-8'],
  '/usage-ui.js': [path.join(PUB, 'usage-ui.js'), 'text/javascript; charset=utf-8'],
  '/features-host.js': [path.join(PUB, 'features-host.js'), 'text/javascript; charset=utf-8'],
  '/notes-core.js': [path.join(PUB, 'notes-core.js'), 'text/javascript; charset=utf-8'],
  '/app.js': [path.join(PUB, 'app.js'), 'text/javascript; charset=utf-8'],
  '/view-controls.js': [path.join(PUB, 'view-controls.js'), 'text/javascript; charset=utf-8'],
  '/terminal-keys.js': [path.join(PUB, 'terminal-keys.js'), 'text/javascript; charset=utf-8'],
  '/mouse-filter.js': [path.join(PUB, 'mouse-filter.js'), 'text/javascript; charset=utf-8'],
  '/touch-scroll.js': [path.join(PUB, 'touch-scroll.js'), 'text/javascript; charset=utf-8'],
  '/tab-hide.js': [path.join(PUB, 'tab-hide.js'), 'text/javascript; charset=utf-8'],
  '/ime-input.js': [path.join(PUB, 'ime-input.js'), 'text/javascript; charset=utf-8'],
  '/pet-state.js': [path.join(PUB, 'pet-state.js'), 'text/javascript; charset=utf-8'],
  '/pet-scene.js': [path.join(PUB, 'pet-scene.js'), 'text/javascript; charset=utf-8'],
  '/pet-yard.js': [path.join(PUB, 'pet-yard.js'), 'text/javascript; charset=utf-8'],
  '/i18n.js': [path.join(PUB, 'i18n.js'), 'text/javascript; charset=utf-8'],
  '/wall.js': [path.join(PUB, 'wall.js'), 'text/javascript; charset=utf-8'],
  '/fx.js': [path.join(PUB, 'fx.js'), 'text/javascript; charset=utf-8'],
  '/guide': [path.join(PUB, 'guide.html'), 'text/html; charset=utf-8'],
  '/guide.js': [path.join(PUB, 'guide.js'), 'text/javascript; charset=utf-8'],
  '/guide.css': [path.join(PUB, 'guide.css'), 'text/css; charset=utf-8'],
  '/guide-page.css': [path.join(PUB, 'guide-page.css'), 'text/css; charset=utf-8'],
  '/pets.js': [path.join(PUB, 'pets.js'), 'text/javascript; charset=utf-8'],
  '/manifest.webmanifest': [path.join(PUB, 'manifest.webmanifest'), 'application/manifest+json'],
  '/sw.js': [path.join(PUB, 'sw.js'), 'text/javascript; charset=utf-8'],
  '/icon-180.png': [path.join(PUB, 'icon-180.png'), 'image/png'],
  '/icon-192.png': [path.join(PUB, 'icon-192.png'), 'image/png'],
  '/icon-512.png': [path.join(PUB, 'icon-512.png'), 'image/png'],
  '/termnest-icon.svg': [path.join(PUB, 'termnest-icon.svg'), 'image/svg+xml'],
  '/termnest-mark.svg': [path.join(PUB, 'termnest-mark.svg'), 'image/svg+xml'],
  '/termnest-logo.svg': [path.join(PUB, 'termnest-logo.svg'), 'image/svg+xml'],
  '/termnest-logo-dark.svg': [path.join(PUB, 'termnest-logo-dark.svg'), 'image/svg+xml'],
  '/termnest-logo-oncolor.svg': [path.join(PUB, 'termnest-logo-oncolor.svg'), 'image/svg+xml'],
  '/app.css': [path.join(PUB, 'app.css'), 'text/css; charset=utf-8'],
  '/look.css': [path.join(PUB, 'look.css'), 'text/css; charset=utf-8'],
  '/look.js': [path.join(PUB, 'look.js'), 'text/javascript; charset=utf-8'],
  '/vendor/xterm.js': [path.join(NM, '@xterm/xterm/lib/xterm.js'), 'text/javascript; charset=utf-8'],
  '/vendor/xterm.css': [path.join(NM, '@xterm/xterm/css/xterm.css'), 'text/css; charset=utf-8'],
  '/vendor/addon-fit.js': [path.join(NM, '@xterm/addon-fit/lib/addon-fit.js'), 'text/javascript; charset=utf-8'],
};
// Explicit static allowlist: no path traversal or arbitrary filesystem reads.
for (const name of fs.readdirSync(path.join(PUB, 'fonts'))) {
  if (/^[a-z0-9-]+\.woff2$/.test(name) || name === 'fonts.css')
    STATIC['/fonts/' + name] = [path.join(PUB, 'fonts', name), name.endsWith('.woff2') ? 'font/woff2' : 'text/css; charset=utf-8'];
}
const HEADERS = {
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:* ipc: http://ipc.localhost; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

function hostOk(req) {
  const h = String(req.headers.host || '').toLowerCase();
  const name = h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0];
  return ALLOWED_HOSTS.has(name);
}

/** Rejects cross-site requests: the Origin, when sent, must be this same page. */
function originOk(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host.toLowerCase() === String(req.headers.host || '').toLowerCase(); } catch { return false; }
}

function cookieToken(req) {
  const m = String(req.headers.cookie || '').match(/(?:^|;\s*)tw_sid=([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

function authed(req) {
  const t = cookieToken(req);
  if (!t) return false;
  const exp = sessions.get(t);
  if (!exp || exp < Date.now()) { sessions.delete(t); return false; }
  return vault.unlocked;
}

// JSON answers above 2 KiB are gzipped when the browser accepts it: /api/state is asked every 3 s while a page is open,
// which matters on a phone over VPN. Small answers are sent as they are (compressing them costs more than it saves).
const accepts = (res) => /\bgzip\b/.test(String((res.req && res.req.headers['accept-encoding']) || ''));
function send(res, code, body) {
  const json = JSON.stringify(body), headers = { 'Content-Type': 'application/json; charset=utf-8', ...HEADERS };
  if (json.length > 2048 && accepts(res)) {
    res.writeHead(code, { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
    res.end(zlib.gzipSync(json, { level: 4 })); return;
  }
  res.writeHead(code, headers);
  res.end(json);
}
// Page files (scripts, styles, fonts, locales): compressed once and revalidated by ETag. A reload asks "changed?" and gets
// 304 instead of ~830 KB; a new version (new content) is fetched at once. API answers stay no-store.
const assets = new Map();
function asset(key, stamp, load) {
  let a = assets.get(key);
  if (!a || a.stamp !== stamp) {
    const raw = load(), gz = zlib.gzipSync(raw, { level: 9 });
    a = { stamp, raw, gz: gz.length < raw.length * 0.9 ? gz : null, etag: '"' + crypto.createHash('sha1').update(raw).digest('base64url').slice(0, 22) + '"' };
    assets.set(key, a);
  }
  return a;
}
function sendAsset(req, res, type, a) {
  const headers = { 'Content-Type': type, ...HEADERS, 'Cache-Control': 'no-cache', ETag: a.etag, Vary: 'Accept-Encoding' };
  if (String(req.headers['if-none-match'] || '').split(/\s*,\s*/).includes(a.etag)) { res.writeHead(304, headers); res.end(); return; }
  const gz = a.gz && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
  res.writeHead(200, gz ? { ...headers, 'Content-Encoding': 'gzip' } : headers);
  res.end(gz ? a.gz : a.raw);
}
function fail(res, code, error, extra) { send(res, code, { error, ...(extra || {}) }); }

function readJson(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (d) => {
      size += d.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => {
      try {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('bad json');
        resolve(body);
      } catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

function saveVault() { vault.save(); }

function updateLost(r) {
  const known = vault.data.known?.[r.cfg.id];
  r.lost = (known?.lost || []).filter((name) => Object.hasOwn(known.sessions, name))
    .map((name) => ({ name, ...known.sessions[name] }));
}

function onPoll(r, snap, sessionVersion = r.sessionVersion) {
  if ((!r.cfg.local && !vault.data.servers.includes(r.cfg)) || r.sessionMutations || sessionVersion !== r.sessionVersion) return;
  if (r.cfg.local && !snap.hasTmux) return;
  vault.data.daily = daily.advance(vault.data.daily, r.cfg.id, snap.sessions, Date.now());
  vault.data.diary = diary.observe(vault.data.diary, r.cfg.id, snap.sessions, Date.now());
  vault.data.known ||= {};
  const result = syncKnown(vault.data.known[r.cfg.id], snap.bootId, snap.sessions);
  if (result.changed) {
    vault.data.known[r.cfg.id] = result.record;
  }
  saveVault();
  updateLost(r);
  if (typeof features !== 'undefined') features.emitSnapshot(r, snap);
  if ((r.cfg.local ? vault.data.prefs.autoRestoreLocal : vault.data.prefs.autoRestoreRemote) && r.lost.length && !r.restoring) {
    // One attempt per boot; failures stay visible for manual retry.
    if (r.restoreBoot !== snap.bootId) {
      r.restoreBoot = snap.bootId; r.restoring = true;
      (async () => {
        for (const session of [...r.lost]) {
          try { await startSession(r, { ...session, restoring: true }); } catch { /* keep the recovery banner */ }
        }
      })().finally(() => { r.restoring = false; });
    }
  }
}

function configureRemote(r) {
  r.onPoll = onPoll;
  r.longHistory = historyPoints(savedHistory[r.cfg.id]);
  updateLost(r);
  return r;
}

function addRemote(cfg) {
  const r = createBackend(cfg, () => { if (vault.data.servers.some((s) => s.id === cfg.id)) saveVault(); });
  configureRemote(r);
  remotes.set(cfg.id, r);
  return r;
}

// Data from another machine: "This computer" there is not this computer, so its sessions are not offered for restore here.
function forThisMachine(data) {
  const out = { ...data, servers: Array.isArray(data.servers) ? data.servers : [], known: { ...(data.known || {}) } };
  delete out.known[LOCAL_ID];
  return out;
}

// Chats carried by a "Chuyển máy" file wait (encrypted with the store's key) until this computer can place them.
const INCOMING_FILE = path.join(DATA, 'incoming-chats.json');
function keepIncoming(chats) {
  if (!chats || !chats.length) { fs.rmSync(INCOMING_FILE, { force: true }); vault.data.moveWaiting = []; return; }
  fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
  const tmp = INCOMING_FILE + '.tmp'; fs.writeFileSync(tmp, vault.sealExtra(chats), { mode: 0o600 }); fs.renameSync(tmp, INCOMING_FILE);
  vault.data.moveWaiting = chats.map((c) => ({ name: c.name, tool: c.tool, origin: c.origin || '', dir: c.dir, server: c.serverName || '' }));
}
let placing = null;
async function placeIncoming() {
  if (placing) return placing;
  placing = (async () => {
    let chats; try { chats = vault.openExtra(fs.readFileSync(INCOMING_FILE, 'utf8')); } catch { return; }
    const local = remotes.get(LOCAL_ID), T = require('./lib/transfer');
    if (!chats) return;
    // Spare copies of server chats go back to their own server, and only where that server lost them.
    const serverWaiting = [];
    for (const c of chats.filter((x) => x.server)) {
      const r = remotes.get(c.server);
      if (!r || !r.ready || r.mode === 'powershell') { serverWaiting.push(c); continue; }
      try { if (await T.restoreOnServer(r, c, shq) === 'waiting') serverWaiting.push(c); } catch { serverWaiting.push(c); }
    }
    const mine = chats.filter((x) => !x.server);
    if (!local || !local.ready || local.mode === 'powershell') { keepIncoming([...mine, ...serverWaiting]); saveVault(); return; }
    const known = vault.data.known[LOCAL_ID] ||= { bootId: '', sessions: {}, lost: [] };
    const { placed, waiting: localWaiting } = await T.place(local, mine, known, shq);
    const waiting = [...localWaiting, ...serverWaiting];
    const taken = new Set([...(local.snapshot?.sessions || []).map((s) => s.name), ...Object.keys(known.sessions)]);
    for (const p of placed) {
      const name = require('./lib/features/move').freeName(p.name, taken); taken.add(name);
      Object.defineProperty(known.sessions, name, { value: { dir: p.dir, run: p.tool, resume: p.id }, enumerable: true, configurable: true, writable: true });
      known.lost = [...new Set([...(known.lost || []), name])];
    }
    keepIncoming(waiting); saveVault(); updateLost(local);
  })().finally(() => { placing = null; });
  return placing;
}
// A restored file: a plain backup (the data) or a "Chuyển máy" file (the data plus this old computer's chats).
function restoredData(obj) {
  return obj && obj.kind === require('./lib/transfer').KIND ? { data: obj.data, chats: Array.isArray(obj.chats) ? obj.chats : [] } : { data: obj, chats: [] };
}

function startRemotes() {
  vault.data.prefs = mergePrefs(vault.data.prefs);
  vault.data.known ||= {};
  if (!remotes.has(LOCAL_ID)) {
    const local = addRemote(localConfig());
    local.connect().then(() => local.poll()).then(() => placeIncoming()).catch((err) => { local.error = err.message; });
  }
  const ids = new Set([LOCAL_ID, ...vault.data.servers.map((s) => s.id)]);
  savedHistory = Object.fromEntries(Object.entries(savedHistory).filter(([id]) => ids.has(id)));
  for (const cfg of vault.data.servers) {
    if (remotes.has(cfg.id)) {
      remotes.get(cfg.id).cfg = cfg;
      continue;
    }
    const r = addRemote(cfg);
    if (r.canAutoConnect) r.connect().then(() => r.poll()).catch(() => r.scheduleRetry());
  }
}

function setCookie(res, token) {
  res.setHeader('Set-Cookie', `tw_sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`);
}

async function login(req, res) {
  const { password } = await readJson(req);
  if (!vault.exists()) { fail(res, 409, tr('srv.server.chua_dat_mat_khau_cho')); return; }
  const now = Date.now();
  if (now < lockedUntil) {
    fail(res, 429, tr('srv.server.sai_qua_nhieu_lan_thu', [Math.ceil((lockedUntil - now) / 1000)]));
    return;
  }
  if (typeof password !== 'string' || !password || !vault.unlock(password)) {
    failures += 1;
    if (failures >= LOGIN_LIMIT) { failures = 0; lockedUntil = now + LOGIN_LOCK_MS; }
    fail(res, 401, tr('srv.server.sai_mat_khau'));
    return;
  }
  failures = 0;
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, now + SESSION_MS);
  setCookie(res, token);
  startRemotes();
  // The store was damaged and the newest good copy was used: the page tells the user from when the data is.
  send(res, 200, vault.recovered ? { ok: true, recoveredAt: vault.recovered.at } : { ok: true });
}

// seen=false: a hidden tab checking for alerts. It does not keep every machine on the fast (3 s) poll.
function publicState(seen = true) {
  if (seen) lastSeen = Date.now();
  const previousDay = vault.data.daily?.day;
  vault.data.daily = daily.advance(vault.data.daily, '', [], Date.now());
  if (previousDay !== vault.data.daily.day) saveVault();
  return { daily: { day: vault.data.daily.day, leaders: daily.leaders(vault.data.daily), summary: vault.data.daily.summary }, servers: [...remotes.values()].map((r) => { const v = r.publicView(); return { ...v, sessions: v.sessions.map((s) => ({ ...s, diary: diary.entries(vault.data.diary, r.cfg.id, s) })) }; }), now: Math.floor(Date.now() / 1000) };
}

async function addServer(req, res) {
  const b = await readJson(req);
  const host = String(b.host || '').trim();
  const user = String(b.user || '').trim();
  const port = Number(b.port || 22);
  // SSH key only unless password login is allowed in Settings. "newkey": TERMNEST makes a key and installs it with the server
  // password used once (never stored); "keyref": a key TERMNEST made that the user installed by hand; "key": the user's own key file.
  const auth = ['key', 'newkey', 'keyref'].includes(b.auth) ? b.auth : 'password';
  if (auth === 'password' && !mergePrefs(vault.data.prefs).allowPassword) { fail(res, 400, tr('srv.ssh.chi_dung_khoa')); return; }
  if (!validHost(host)) { fail(res, 400, tr('srv.server.dia_chi_may_chu_chua')); return; }
  if (!validUser(user)) { fail(res, 400, tr('srv.server.tai_khoan_chua_dung')); return; }
  if (!Number.isInteger(port) || port < 1 || port > 65535) { fail(res, 400, tr('srv.server.cong_chua_dung')); return; }
  if ((auth === 'password' || auth === 'newkey') && (typeof b.password !== 'string' || !b.password)) { fail(res, 400, tr('srv.server.nhap_mat_khau')); return; }
  if (auth === 'key' && (typeof b.key !== 'string' || !b.key.includes('PRIVATE KEY'))) {
    fail(res, 400, tr('srv.server.chon_file_khoa_ssh_rieng'));
    return;
  }
  if (vault.data.servers.some((s) => s.host === host && s.port === port && s.user === user)) {
    fail(res, 409, tr('srv.server.tai_khoan_nay_da_co'));
    return;
  }
  const cfg = { id: crypto.randomUUID(), host, port, user, auth: auth === 'password' ? 'password' : 'key', name: '', fingerprint: '' };
  if (auth === 'key') {
    cfg.key = b.key;
    if (b.passphrase) cfg.passphrase = String(b.passphrase);
  }
  if (auth === 'keyref') {
    const k = require('./lib/sshkey').take(b.keyRef);
    if (!k) { fail(res, 400, tr('srv.ssh.khoa_het_han')); return; }
    cfg.key = k.private;
  }
  if (auth === 'newkey') {
    // Log in once with the password, install a new key, then the password is forgotten.
    const once = new Remote({ ...cfg, auth: 'password' }, () => {});
    try {
      await once.connect(b.password);
      cfg.fingerprint = once.cfg.fingerprint;
      const k = require('./lib/sshkey').makeKey(require('os').hostname());
      const out = await once.exec(`sh -c ${shq(require('./lib/sshkey').INSTALL_SCRIPT)}`, 20000, 4096, Buffer.from(k.public + '\n'));
      if (out.code !== 0 || !/INSTALLED/.test(out.out || '')) throw new Error(tr('srv.ssh.khong_cai_duoc_khoa'));
      cfg.key = k.private;
    } catch (err) { once.close(); fail(res, 400, err.message); return; }
    once.close();
  }
  const r = new Remote(cfg, () => {});
  try {
    await r.connect(cfg.auth === 'password' ? b.password : undefined);
  } catch (err) {
    r.close();
    fail(res, 400, auth === 'keyref' ? tr('srv.ssh.khoa_chua_cai', [err.message]) : err.message);
    return;
  }
  r.onLearn = () => saveVault();
  configureRemote(r);
  remotes.set(cfg.id, r);
  vault.data.servers.push(cfg);
  saveVault();
  await r.poll();
  send(res, 200, { id: cfg.id });
}

function removeServer(res, id) {
  if (id === LOCAL_ID) { fail(res, 400, tr('srv.server.khong_the_go_may_nay')); return; }
  const r = remotes.get(id);
  if (!r) { fail(res, 404, tr('srv.server.khong_thay_may_chu_nay')); return; }
  r.close();
  remotes.delete(id);
  vault.data.servers = vault.data.servers.filter((s) => s.id !== id);
  if (vault.data.known) delete vault.data.known[id];
  delete savedHistory[id];
  saveHistory();
  saveVault();
  send(res, 200, { ok: true });
}

// A server that logs in with a password moves to an SSH key: a new key is installed over the open connection, a second
// connection proves the key works, and only then is the server switched (the password is forgotten).
async function switchToKey(res, r) {
  if (r.cfg.local || r.cfg.auth !== 'password') { fail(res, 400, tr('srv.ssh.da_dung_khoa')); return; }
  if (!r.ready) { fail(res, 400, tr('srv.server.may_chu_chua_ket_noi')); return; }
  const K = require('./lib/sshkey'), k = K.makeKey(os.hostname());
  try {
    const out = await r.exec(`sh -c ${shq(K.INSTALL_SCRIPT)}`, 20000, 4096, Buffer.from(k.public + '\n'));
    if (out.code !== 0 || !/INSTALLED/.test(out.out || '')) throw new Error(tr('srv.ssh.khong_cai_duoc_khoa'));
    const probe = new Remote({ ...r.cfg, auth: 'key', key: k.private }, () => {});
    try { await probe.connect(); } finally { probe.close(); }
  } catch (err) { fail(res, 400, err.message); return; }
  Object.assign(r.cfg, { auth: 'key', key: k.private }); r.password = null;
  saveVault();
  send(res, 200, { ok: true });
}

async function reconnect(req, res, id) {
  const r = remotes.get(id);
  if (!r) { fail(res, 404, tr('srv.server.khong_thay_may_chu_nay')); return; }
  const b = await readJson(req);
  // Connected but no data: drop the connection and open a fresh one (b.force from the "no data" card).
  if (r.ready && b.force === true && !r.cfg.local) { try { r.close(); } catch { /* already closed */ } }
  else if (r.ready) { send(res, 200, { ok: true }); return; }
  if (r.cfg.auth === 'password' && !r.password && !b.password) { fail(res, 400, tr('srv.server.nhap_mat_khau')); return; }
  try {
    await r.connect(r.cfg.auth === 'password' ? (b.password || r.password) : undefined);
    await r.poll();
    send(res, 200, { ok: true });
  } catch (err) {
    if (r.cfg.auth === 'password') r.password = null;
    fail(res, 400, err.message);
  }
}

function sessionDir(dir, r) {
  if (!dir && r?.cfg.local) return 'd="$HOME"';
  return dir ? `d=${shq(dir)}` : `d=${shq(DEFAULT_DIR)}\n[ -d "$d" ] || d="$HOME"`;
}

const { wslDrives, wslPath } = require('./lib/wsl-dirs');
async function listDirs(res, r, dir) {
  dir = dir.trim();
  if (r.mode === 'wsl' && /^[A-Za-z]:([\\/]|$)/.test(dir)) dir = await wslPath(r, dir.length === 2 ? dir + '\\' : dir);
  if (!validDir(dir) || (r.mode !== 'powershell' && dir && !dir.startsWith('/'))) { fail(res, 400, tr('srv.server.thu_muc_chua_dung')); return; }
  if (r.mode === 'powershell') { send(res, 200, await r.listPlainDirs(dir)); return; }
  const script = [
    sessionDir(dir, r),
    `[ -r "$d" ] && [ -x "$d" ] && cd "$d" 2>/dev/null || exit 3`,
    `pwd -P || exit 3`,
    `printf '\\000'`,
    `for d in ./*; do [ -d "$d" ] && printf '%s\\000' "\${d#./}"; done`,
    `exit 0`,
  ].join('\n');
  const out = await r.exec(`sh -c ${shq(script)}`);
  if (out.code !== 0) { fail(res, 400, tr('srv.server.khong_mo_duoc_thu_muc')); return; }
  const data = parseDirs(out.out);
  if (r.mode === 'wsl') data.drives = await wslDrives(r);
  send(res, 200, data);
}

async function createSession(req, res, r) {
  const b = await readJson(req);
  try {
    await startSession(r, { name: b.name, dir: b.dir === undefined ? '' : b.dir, run: b.run === undefined ? 'shell' : b.run });
    await r.poll();
    send(res, 200, { ok: true });
  } catch (err) { fail(res, err.status || 400, err.message); }
}

// Ignore session snapshots captured before/during a mutation; the next poll reconciles them.
async function withSessionChange(r, change) {
  r.sessionVersion = (r.sessionVersion || 0) + 1;
  r.sessionMutations = (r.sessionMutations || 0) + 1;
  try { return await change(); }
  finally { r.sessionVersion += 1; r.sessionMutations -= 1; }
}

async function startSession(r, options) {
  return withSessionChange(r, () => executeStartSession(r, options));
}

async function executeStartSession(r, { name, dir, run, restoring = false, resume = '', flags = [] }) {
  if (!validName(name)) throw new Error(tr('srv.server.ten_chi_dung_chu_khong'));
  if (!validDir(dir)) throw new Error(tr('srv.server.thu_muc_chua_dung'));
  if (!['shell', 'claude', 'codex'].includes(run)) throw new Error(tr('srv.server.lenh_chua_dung'));
  dir = dir.trim();
  // On a restore the agent starts with the options it ran with (model, permission mode): listed flags only, checked again.
  const extra = restoring ? cleanFlags(run, flags).map((f) => shq(f)).join(' ') : '', sp = extra ? ' ' + extra : '';
  // After a reboot the conversation the agent held is resumed by its own id (recorded while it ran).
  resume = restoring && typeof resume === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(resume) ? resume : '';
  // Two agents writing one transcript would corrupt it: a conversation already open in another session is not resumed twice.
  if (resume) {
    const k = vault.data.known?.[r.cfg.id], lostNames = new Set(k?.lost || []);
    const held = Object.entries(k?.sessions || {}).some(([n, v]) => n !== name && !lostNames.has(n) && v.resume === resume)
      || (r.snapshot?.sessions || []).some((s) => s.name !== name && s.aiSessionId === resume);
    if (held) resume = '';
  }
  let resolvedDir;
  if (r.mode === 'powershell') {
    resolvedDir = await r.startPlain({ name, dir, run, restoring });
  } else {
    const out = await r.exec(`sh -c ${shq([
      sessionDir(dir, r),
      `[ -d "$d" ] || { echo NODIR; exit 3; }`,
      // A framed record keeps tmux output and error markers out of the physical path.
      `(cd "$d" && printf '\\000TW_DIR\\000' && pwd -P && printf '\\000') || { echo NODIR; exit 3; }`,
      `tmux -u has-session -t ${shq(`=${name}`)} 2>/dev/null && { echo EXISTS; exit 4; }`,
      // Without a UTF-8 locale bash drops Vietnamese input. -e needs tmux 3.2, so older ones fall back.
      // tmux keeps 2000 lines per pane by default: a long Claude chat loses its beginning. Raise (never lower) the default
      // for new panes to 100000 (memory grows only with lines really written) in the same tmux call that creates the pane, so even the first session on a fresh server gets it.
      `H=''; [ "$(tmux show-options -gv history-limit 2>/dev/null)" -ge ${HISTORY_LINES} ] 2>/dev/null || H='set-option -g history-limit ${HISTORY_LINES}'`,
      `{ [ -n "$H" ] && tmux -u $H \\; new-session -d -s ${shq(name)} -c "$d" -e "LANG=\${LANG:-C.UTF-8}" 2>/dev/null; } || tmux -u new-session -d -s ${shq(name)} -c "$d" -e "LANG=\${LANG:-C.UTF-8}" 2>/dev/null || tmux -u new-session -d -s ${shq(name)} -c "$d"`,
    ].join('\n'))}`);
    if (out.code === 3) throw new Error(tr('srv.server.khong_thay_thu_muc_nay'));
    if (out.code === 4) { const err = new Error(tr('srv.server.ten_nay_da_co')); err.status = 409; throw err; }
    if (out.code !== 0) throw new Error(tr('srv.server.khong_tao_duoc_phien'));
    const records = out.out.split('\0');
    const record = records.indexOf('TW_DIR');
    if (record < 0 || !records[record + 1]?.endsWith('\n')) throw new Error(tr('srv.server.khong_doc_duoc_thu_muc'));
    resolvedDir = records[record + 1].slice(0, -1);
    if (run === 'claude') {
      const id = claudeSessionId(resolvedDir, name);
      const script = [
        `cmd=${shq(`claude --session-id ${shq(id)} --name ${shq(name)}${sp}`)}`,
        `for f in "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/${shq(id + '.jsonl')}; do`,
        `  if [ -f "$f" ]; then cmd=${shq(`claude --resume ${shq(id)}${sp}`)}; break; fi`,
        `done`,
        ...(resume ? [
          `for f in "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/${shq(resume + '.jsonl')}; do`,
          `  if [ -f "$f" ]; then cmd=${shq(`claude --resume ${shq(resume)}${sp}`)}; break; fi`,
          `done`,
        ] : []),
        // Decide remotely, but send one simple command to the user's login shell (including fish).
        `tmux send-keys -t ${shq(`=${name}:`)} "$cmd" Enter`,
      ].join('\n');
      let launched;
      try { launched = await r.exec(`sh -c ${shq(script)}`); }
      catch { launched = { code: 1 }; }
      if (launched.code !== 0) {
        await r.exec(`tmux -u kill-session -t ${shq(`=${name}`)}`).catch(() => {});
        throw new Error(tr('srv.server.khong_chay_duoc_claude'));
      }
    }
    if (run === 'codex') {
      const cmd = resume ? `codex resume ${resume}${sp}` : r.cfg.local ? await r.codexLaunch(restoring) : 'codex' + sp;
      const launched = await r.exec(`tmux send-keys -t ${shq(`=${name}:`)} ${shq(cmd)} Enter`).catch(() => ({ code: 1 }));
      if (launched.code !== 0) {
        await r.exec(`tmux -u kill-session -t ${shq(`=${name}`)}`).catch(() => {});
        throw new Error(tr('srv.server.khong_chay_duoc_codex'));
      }
    }
  }
  vault.data.known ||= {};
  const known = vault.data.known[r.cfg.id] ||= { bootId: r.snapshot?.bootId || '', sessions: {}, lost: [] };
  Object.defineProperty(known.sessions, name, { value: resume ? { dir: resolvedDir, run, resume } : { dir: resolvedDir, run }, enumerable: true, configurable: true, writable: true });
  known.lost = (known.lost || []).filter((n) => n !== name);
  const prefs = mergePrefs(vault.data.prefs);
  prefs.recentDirs = [resolvedDir, ...prefs.recentDirs.filter((d) => d !== resolvedDir)].slice(0, 8);
  vault.data.prefs = prefs;
  saveVault();
  updateLost(r);
}

async function killSession(res, r, name) {
  if (typeof name !== 'string' || !name || name.length > 128) { fail(res, 400, tr('srv.server.ten_phien_chua_dung')); return; }
  const stopped = await stopSession(r, name);
  if (!stopped) { fail(res, 400, tr('srv.server.khong_dung_duoc_phien_nay')); return; }
  await r.poll();
  send(res, 200, { ok: true });
}

function stopSession(r, name) {
  return withSessionChange(r, async () => {
    const out = r.mode === 'powershell' ? { code: r.killPlain(name) ? 0 : 1 } : await r.exec(`tmux -u kill-session -t ${shq(`=${name}`)}`);
    if (out.code !== 0) return false;
    const known = vault.data.known?.[r.cfg.id];
    if (known && Object.hasOwn(known.sessions, name)) {
      delete known.sessions[name];
      known.lost = (known.lost || []).filter((n) => n !== name);
      saveVault();
      updateLost(r);
    }
    return true;
  });
}

async function restore(req, res, r) {
  const b = await readJson(req);
  if (b.names !== undefined && (!Array.isArray(b.names) || b.names.some((n) => !validName(n)))) {
    fail(res, 400, tr('srv.server.danh_sach_phien_chua_dung')); return;
  }
  const names = b.names === undefined ? r.lost.map((s) => s.name) : [...new Set(b.names)];
  const result = { restored: [], failed: [] };
  for (const name of names) {
    const session = r.lost.find((s) => s.name === name);
    if (!session) { result.failed.push({ name, error: tr('srv.server.khong_thay_phien_can_khoi') }); continue; }
    try {
      await startSession(r, { ...session, restoring: true });
      result.restored.push(name);
    } catch (err) { result.failed.push({ name, error: err.message }); }
  }
  await r.poll();
  send(res, 200, result);
}

function dismissLost(res, r) {
  const known = vault.data.known?.[r.cfg.id];
  if (known?.lost?.length) {
    r.sessionVersion = (r.sessionVersion || 0) + 1;
    for (const name of known.lost) delete known.sessions[name];
    known.lost = [];
    saveVault();
  }
  updateLost(r);
  send(res, 200, { ok: true });
}

async function scrollSession(req, res, r, name) {
  const b = await readJson(req);
  let script;
  try { script = scrollScript(name, b.op, b.n); }
  catch { fail(res, 400, tr('srv.server.lenh_cuon_chua_dung')); return; }
  if (r.mode === 'powershell') { fail(res, 400, tr('srv.server.may_nay_chua_ho_tro')); return; }
  if (!r.ready) { fail(res, 503, tr('srv.server.may_chu_chua_ket_noi')); return; }
  const out = await r.exec(`sh -c ${shq(script)}`);
  try { send(res, 200, parseScrollState(out.out)); }
  catch { fail(res, 400, tr('srv.server.khong_doc_duoc_vi_tri')); }
}

async function screens(req, res, r) {
  const b = await readJson(req);
  let script;
  try { script = screensScript(b.names, b.lines); }
  catch { fail(res, 400, tr('srv.server.noi_dung_chua_dung')); return; }
  if (r.mode === 'powershell') { fail(res, 400, tr('srv.server.may_nay_chua_ho_tro')); return; }
  if (!r.ready) { fail(res, 503, tr('srv.server.may_chu_chua_ket_noi')); return; }
  const out = await r.exec(`sh -c ${shq(script)}`);
  send(res, 200, { screens: parseScreens(out.out, b.names) });
}

async function sendKeys(req, res, r, name) {
  const b = await readJson(req);
  // "Xóa lịch sử cuộn" from the terminal menu: drop tmux's scrollback of the pane (the screen itself stays).
  if (b.clearHistory === true) {
    if (!name || name.length > 128) { fail(res, 400, tr('srv.server.noi_dung_chua_dung')); return; }
    if (r.mode === 'powershell') { if (!r.clearPlain(name)) { fail(res, 400, tr('srv.server.noi_dung_chua_dung')); return; } send(res, 200, { ok: true }); return; }
    const out = await r.exec(`tmux clear-history -t ${shq(`=${name}:`)}`);
    if (out.code !== 0) { fail(res, 400, tr('srv.server.khong_gui_duoc_noi_dung')); return; }
    send(res, 200, { ok: true }); return;
  }
  if (!name || name.length > 128 || typeof b.text !== 'string' || b.text.length > 1000 ||
      BAD_KEYS.test(b.text) || (b.enter !== undefined && typeof b.enter !== 'boolean')) {
    fail(res, 400, tr('srv.server.noi_dung_chua_dung')); return;
  }
  const replySession = r.snapshot?.sessions?.find((s) => s.name === name);
  if (r.mode === 'powershell') {
    r.keysPlain(name, b.text.replace(/\n/g, ' '), b.enter !== false);
  } else {
    const out = (b.text || b.enter !== false) ? await r.exec(keysScript(`=${name}:`, b.text, b.enter !== false)) : { code: 0 };
    if (out.code !== 0) { fail(res, 400, tr('srv.server.khong_gui_duoc_noi_dung')); return; }
  }
  if (b.text && b.enter !== false) {
    diary.answered(vault.data.diary, r.cfg.id, replySession, Date.now());
    saveVault();
  }
  send(res, 200, { ok: true });
}

function webSetupEnabled() { return Boolean(process.env.TW_SETUP_TOKEN) && !vault.exists(); }

async function api(req, res, url) {
  const m = req.method;
  const p = url.pathname;
  if (p === '/api/status' && m === 'GET') {
    send(res, 200, { setup: vault.exists(), authed: authed(req),
      ...(webSetupEnabled() ? { webSetup: true } : {}),
      ...(process.env.TW_PACKAGED === '1' ? { packaged: true } : {}) });
    return;
  }
  if (p === '/api/supervisor/status' && m === 'GET') {
    const runtime = features.service('ops-runtime')?.status() || { monitoring: false, error: true, pending: 0 };
    const supervision = features.service('supervision');
    const status = supervision?.enabled() ? supervision.health() : null;
    send(res, 200, { processAlive: true, unlocked: vault.unlocked, monitoring: vault.unlocked && !draining && runtime.monitoring, error: runtime.error,
      observationsFresh: status?.observationsFresh === true, validatedAuditCompletion: status?.validatedAuditCompletion === true });
    return;
  }
  // First run on a new machine: start from a backup file instead of an empty store. The backup keeps its own password.
  if (p === '/api/setup/restore' && m === 'POST') {
    if (!webSetupEnabled()) { fail(res, 404, 'Not found'); return; }
    const body = await readJson(req, 400 * 1024 * 1024);
    if (!webSetupEnabled()) { fail(res, 404, 'Not found'); return; }
    const digest = (value) => crypto.createHash('sha256').update(value).digest();
    if (typeof body.setupToken !== 'string' || !crypto.timingSafeEqual(digest(body.setupToken), digest(process.env.TW_SETUP_TOKEN))) { fail(res, 403, tr('srv.server.ma_thiet_lap_khong_hop')); return; }
    const opened = typeof body.backup === 'string' && typeof body.password === 'string' ? Vault.read(body.backup, body.password) : null;
    const { data, chats } = restoredData(opened);
    if (!data || !Array.isArray(data.servers)) { fail(res, 400, tr('srv.backup.khong_mo_duoc')); return; }
    vault.create(body.password, forThisMachine(data));
    keepIncoming(chats); vault.save();
    delete process.env.TW_SETUP_TOKEN;
    send(res, 200, { ok: true }); return;
  }
  if (p === '/api/setup' && m === 'POST') {
    if (!webSetupEnabled()) { fail(res, 404, 'Not found'); return; }
    const body = await readJson(req);
    // Recheck after reading the body: another request may have created the vault.
    if (!webSetupEnabled()) { fail(res, 404, 'Not found'); return; }
    const digest = (value) => crypto.createHash('sha256').update(value).digest();
    if (typeof body.setupToken !== 'string' ||
        !crypto.timingSafeEqual(digest(body.setupToken), digest(process.env.TW_SETUP_TOKEN))) {
      fail(res, 403, tr('srv.server.ma_thiet_lap_khong_hop')); return;
    }
    if (typeof body.password !== 'string' || body.password.length < 10) {
      fail(res, 400, tr('srv.server.mat_khau_can_it_nhat')); return;
    }
    vault.create(body.password, { servers: [] });
    delete process.env.TW_SETUP_TOKEN;
    send(res, 200, { ok: true }); return;
  }
  if (p === '/api/quit' && process.env.TW_PACKAGED !== '1') {
    fail(res, 404, 'Not found'); return;
  }
  if (p === '/api/login' && m === 'POST') { await login(req, res); return; }
  if (!authed(req)) { fail(res, 401, tr('srv.server.hay_dang_nhap_lai')); return; }
  if (features.handles(p)) { await features.handle(req, res, url); return; }
  if (p === '/api/quit' && m === 'POST') {
    res.once('finish', drain);
    send(res, 200, { ok: true }); return;
  }
  if (p === '/api/logout' && m === 'POST') {
    sessions.delete(cookieToken(req));
    res.setHeader('Set-Cookie', 'tw_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    send(res, 200, { ok: true });
    return;
  }
  if (p === '/api/state' && m === 'GET') { send(res, 200, publicState(req.headers['x-tw-hidden'] !== '1')); return; }
  if ((p === '/api/file' || p === '/api/file-preview') && m === 'GET') {
    try {
      // temp=1: a file in the machine's private "Send file" folder, not in the session folder.
      const fv = require('./lib/file-viewer'), temp = url.searchParams.get('temp') === '1';
      const value = temp ? await fv.readTempFile(remotes.get(url.searchParams.get('server')), url.searchParams.get('path'))
        : await fv.readSessionFile(remotes.get(url.searchParams.get('server')), url.searchParams.get('session'), url.searchParams.get('path'));
      if(p === '/api/file-preview' && !value.error){
        if(value.kind !== 'html'){fail(res,400,tr('srv.server.chi_ho_tro_ban_xem'));return;}
        res.writeHead(200, {...HEADERS, 'Content-Type':'text/html; charset=utf-8',
          'Content-Security-Policy':"sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'"});
        let page = value.text;
        try {
          const backend = remotes.get(url.searchParams.get('server')), session = url.searchParams.get('session'), reader = require('./lib/file-viewer').readSessionFile;
          if (!temp) page = await require('./lib/html-assets').inlineAssets(page, value.path, (abs) => reader(backend, session, abs), (paths) => require('./lib/file-viewer').readSessionFiles(backend, session, paths));
        } catch { /* the report still opens, just without its pictures */ }
        res.end(injectReportLinks(page));return;
      }
      // Candidates are an answer, not a failure: send them with 200 so the viewer can list them.
      send(res, value.error && !value.candidates ? 400 : 200, value);
    } catch (e) { fail(res, 400, e.message, require('./lib/file-viewer').hostErrorExtra(e, remotes.get(url.searchParams.get('server')))); }
    return;
  }
  if (p === '/api/tokens' && m === 'GET') {
    const zone = url.searchParams.get('zone') || 'UTC';
    try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(); } catch { send(res, 400, { error: 'Invalid timezone' }); return; }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...HEADERS });
    res.end(tokenCache.get([...remotes.values()], mergePrefs(vault.data.prefs).aiAccounts, { zone })); return;
  }
  if (p === '/api/usage' && m === 'GET') {
    const zone = url.searchParams.get('zone') || 'UTC';
    try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(); validRange(url.searchParams.get('from'), url.searchParams.get('to')); }
    catch { send(res, 400, { error: tr('srv.server.khoang_ngay_hoac_mui_gio') }); return; }
    // Declared accounts plus the default config folders found on each host, so the report matches the token cards.
    const found = await discoverUsage([...remotes.values()].filter((r) => r.ready && r.mode !== 'powershell')).catch(() => []);
    const merged = mergeUsageAccounts(mergePrefs(vault.data.prefs).aiAccounts, found), accounts = merged.accounts;
    // Account emails come from the token scan, so the report names accounts the same way the cards do.
    const emails = new Map(merged.emails);
    try { for (const a of JSON.parse(tokenCache.get([...remotes.values()], accounts, { zone })).accounts || []) if (a.email) emails.set(a.id, a.email); } catch { /* names fall back to nickname or directory */ }
    const backendOf = (id) => { const r = remotes.get(id); return r?.ready ? r : null; };
    try { const report = await usage.get(backendOf, accounts, { from: url.searchParams.get('from'), to: url.searchParams.get('to'), zone, refresh: url.searchParams.get('refresh') === '1', emails }); send(res, 200, { ...report, accounts: mergeIdentity(report.accounts, emails) }); }
    catch { send(res, 500, { error: tr('srv.server.khong_doc_duoc_bao_cao') }); }
    return;
  }
  // Backups: where the encrypted copies are, an extra folder of the user's choice (a synced Drive folder…), and "copy now".
  // A new key for the "install it myself" path: the public half and the command to paste on the server.
  if (p === '/api/ssh-key/new' && m === 'POST') {
    const K = require('./lib/sshkey'), k = K.makeKey(os.hostname());
    send(res, 200, { ref: K.hold(k), publicKey: k.public, command: K.manualCommand(k.public) }); return;
  }
  if (p === '/api/backup' && m === 'GET') { send(res, 200, { ...vault.info(), suggestions: require('./lib/backup').cloudFolders() }); return; }
  if (p === '/api/backup/folder' && m === 'POST') {
    const body = await readJson(req), dir = typeof body.dir === 'string' ? body.dir.trim() : null;
    if (dir === null) { fail(res, 400, tr('srv.backup.thu_muc_khong_hop_le')); return; }
    const problem = dir ? require('./lib/backup').checkFolder(dir) : '';
    if (problem) { fail(res, 400, tr({ notfound: 'srv.backup.khong_thay_thu_muc', notdir: 'srv.backup.khong_phai_thu_muc', denied: 'srv.backup.khong_ghi_duoc' }[problem] || 'srv.backup.thu_muc_khong_hop_le')); return; }
    vault.data.prefs = { ...mergePrefs(vault.data.prefs), backupDir: dir };
    if (dir) vault.copy(); else saveVault();
    send(res, 200, vault.info()); return;
  }
  // Signed in: replace this machine's data with a backup (servers, sessions, settings, notes, AI accounts). The current data is
  // copied first, and this store keeps its own password.
  if (p === '/api/backup/restore' && m === 'POST') {
    const body = await readJson(req, 400 * 1024 * 1024);
    const opened = typeof body.backup === 'string' && typeof body.password === 'string' ? Vault.read(body.backup, body.password) : null;
    const { data, chats } = restoredData(opened);
    if (!data || !Array.isArray(data.servers)) { fail(res, 400, tr('srv.backup.khong_mo_duoc')); return; }
    vault.copy();
    const keep = new Set(data.servers.map((s) => s.id));
    for (const [id, r] of [...remotes]) if (id !== LOCAL_ID && !keep.has(id)) { r.close(); remotes.delete(id); }
    vault.data = forThisMachine(data);
    for (const cfg of vault.data.servers) if (remotes.has(cfg.id)) { remotes.get(cfg.id).close(); remotes.delete(cfg.id); }
    startRemotes(); keepIncoming(chats); saveVault();
    await placeIncoming().catch(() => {});
    send(res, 200, { ok: true, servers: vault.data.servers.length, chats: chats.length, waiting: (vault.data.moveWaiting || []).length }); return;
  }
  // "Chuyển máy": what would go into the file, writing it (the password is asked again), and retrying chats still waiting.
  if (p === '/api/transfer' && m === 'GET') {
    const local = remotes.get(LOCAL_ID), T = require('./lib/transfer');
    const c = local?.ready && local.mode !== 'powershell' ? await T.collect(local, vault.data.known?.[LOCAL_ID], true) : { chats: [], bytes: 0, skipped: [] };
    // Sessions on the servers keep their chats there: the new computer reconnects and resumes them, nothing to carry.
    const onServers = [...remotes.values()].filter((r) => !r.cfg.local).reduce((n, r) => n + (r.snapshot?.sessions || []).length, 0);
    const sc = url.searchParams.get('servers') === '1' ? await T.collectServers([...remotes.values()], vault.data.known, true, c.bytes) : null;
    const localSessions = (local?.snapshot?.sessions || []).length;
    send(res, 200, { servers: vault.data.servers.length, onServers, localSessions, serverChats: sc ? { count: sc.chats.length, bytes: sc.bytes, skipped: sc.skipped.length } : null, chats: c.chats.map((x) => ({ name: x.name, tool: x.tool, size: x.size })), bytes: c.bytes, skipped: c.skipped, dir: T.exportDir(), waiting: vault.data.moveWaiting || [] });
    return;
  }
  if (p === '/api/transfer/export' && m === 'POST') {
    const body = await readJson(req);
    if (!vault.check(body.password)) { fail(res, 400, tr('srv.server.sai_mat_khau')); return; }
    const local = remotes.get(LOCAL_ID), T = require('./lib/transfer');
    const c = local?.ready && local.mode !== 'powershell' ? await T.collect(local, vault.data.known?.[LOCAL_ID], false) : { chats: [], bytes: 0, skipped: [] };
    const sc = body.withServers === true ? await T.collectServers([...remotes.values()], vault.data.known, false, c.bytes) : { chats: [], bytes: 0, skipped: [] };
    const file = path.join(T.exportDir(), T.exportName());
    const text = Vault.pack(body.password, { kind: T.KIND, made: Date.now(), from: os.hostname(), data: vault.data, chats: [...c.chats, ...sc.chats] });
    fs.writeFileSync(file, text, { mode: 0o600 });
    send(res, 200, { path: file, bytes: Buffer.byteLength(text), chats: c.chats.length, serverChats: sc.chats.length, skipped: [...c.skipped, ...sc.skipped] }); return;
  }
  if (p === '/api/transfer/retry' && m === 'POST') { await placeIncoming().catch(() => {}); send(res, 200, { waiting: vault.data.moveWaiting || [] }); return; }
  if (p === '/api/backup/now' && m === 'POST') { vault.copy(); send(res, 200, vault.info()); return; }
  if (p === '/api/prefs' && m === 'GET') { send(res, 200, mergePrefs(vault.data.prefs)); return; }
  if (p === '/api/prefs' && m === 'PUT') {
    const input = await readJson(req);
    let prefs;
    try { prefs = cleanPrefs(input, vault.data.prefs); }
    catch { fail(res, 400, tr('srv.server.cai_dat_chua_dung')); return; }
    vault.data.prefs = prefs;
    saveVault();
    send(res, 200, prefs);
    return;
  }
  if (p === '/api/servers' && m === 'POST') { await addServer(req, res); return; }
  const crew = p.match(/^\/api\/servers\/([0-9a-f-]{36})\/crew-log$/);
  if (crew && m === 'GET') {
    const r = remotes.get(crew[1]);
    const task = url.searchParams.get('task'), track = url.searchParams.get('track');
    const { trackDir } = require('./lib/crew');
    try { trackDir({ cwd: '/', task, track }); }
    catch { fail(res, 400, tr('srv.server.ten_task_hoac_track_chua')); return; }
    const w = r?.snapshot?.workers.find((w) => w.task === task && w.track === track);
    if (!w) { fail(res, 404, tr('srv.server.khong_thay_worker')); return; }
    if (!r.ready) { fail(res, 503, tr('srv.server.may_chu_chua_ket_noi')); return; }
    const log = await r.readWorkerLog(w);
    send(res, 200, { ...log, elapsed: w.elapsed, finishedAt: w.finishedAt || null }); return;
  }
  const sv = p.match(/^\/api\/servers\/([0-9a-f-]{36})(\/connect|\/use-key|\/reboot-check|\/reboot|\/dirs|\/history|\/restore|\/lost|\/screens|\/sessions(?:\/([^/]+)(\/keys|\/scroll)?)?)?$/);
  if (sv) {
    const id = sv[1];
    const tail = sv[2] || '';
    if (!tail && m === 'DELETE') { removeServer(res, id); return; }
    if (tail === '/connect' && m === 'POST') { await reconnect(req, res, id); return; }
    const r = remotes.get(id);
    if (!r) { fail(res, 404, tr('srv.server.khong_thay_may_chu_nay')); return; }
    if (tail === '/use-key' && m === 'POST') { await switchToKey(res, r); return; }
    if (tail === '/reboot-check' && m === 'GET') {
      try { send(res, 200, await require('./lib/reboot').rebootCheck(r, shq)); } catch (err) { fail(res, 400, err.message); }
      return;
    }
    if (tail === '/reboot' && m === 'POST') {
      const body = await readJson(req);
      try { send(res, 200, await require('./lib/reboot').rebootServer(r, body.name)); }
      catch (err) { fail(res, 400, err.message); }
      return;
    }
    if (tail === '/history' && m === 'GET') {
      const hours = url.searchParams.get('hours');
      if (!['1', '6', '24'].includes(hours)) { fail(res, 400, tr('srv.server.khoang_thoi_gian_chua_dung')); return; }
      send(res, 200, { points: historyPoints(r.longHistory, Date.now() - Number(hours) * 3600000) }); return;
    }
    if (tail === '/restore' && m === 'POST') { await restore(req, res, r); return; }
    if (tail === '/lost' && m === 'DELETE') { dismissLost(res, r); return; }
    if (sv[4] === '/keys' && m === 'POST') { await sendKeys(req, res, r, decodeURIComponent(sv[3])); return; }
    if (sv[4] === '/scroll' && m === 'POST') { await scrollSession(req, res, r, decodeURIComponent(sv[3])); return; }
    if (tail === '/screens' && m === 'POST') { await screens(req, res, r); return; }
    if (tail === '/dirs' && m === 'GET') { await listDirs(res, r, url.searchParams.get('path') || ''); return; }
    if (tail === '/sessions' && m === 'POST') { await createSession(req, res, r); return; }
    if (sv[3] && !sv[4] && m === 'DELETE') { await killSession(res, r, decodeURIComponent(sv[3])); return; }
  }
  fail(res, 404, tr('srv.server.khong_tim_thay'));
}

let activeRequests = 0;
// Drop-in features (lib/features/*.js + public/features/*): see lib/features.js.
const features = createFeatures({ libDir: path.join(__dirname, 'lib', 'features'), publicDir: path.join(PUB, 'features'),
  deps: { remotes: () => remotes, backendOf: (id) => { const r = remotes.get(id); return r?.ready ? r : null; }, send, fail, readJson, shq,
    startSession: async (r, o) => { await startSession(r, o); await r.poll(); }, stopSession: async (r, name) => { const ok = await stopSession(r, name); if (ok) await r.poll(); return ok; },
    vault: () => vault, save: () => saveVault(), dataDir: DATA } });
features.load();

const server = http.createServer(async (req, res) => {
  setLang(langOf(req));   // the page sends X-TW-Lang; every message this request produces follows it
  if (!hostOk(req)) { res.writeHead(403); res.end(); return; }
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/__app' && req.method === 'GET') {
    // Legacy wire identity lets desktop releases reuse an existing source server.
    send(res, 200, { app: 'tmux-dev', active_work: activeWork() ? 1 : 0 }); return;
  }
  if (draining && req.method !== 'GET') { fail(res, 503, tr('srv.server.ung_dung_dang_dong')); return; }
  if (url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && !originOk(req)) { fail(res, 403, tr('srv.server.yeu_cau_khong_hop_le')); return; }
    activeRequests++;
    try {
      // Only this single-use saved-download capability bypasses session cookies. Host
      // and Origin guards still apply; all other feature routes go through api auth.
      if (url.pathname.startsWith('/api/features/server-backup/download-ticket/')) {
        if (!originOk(req)) { fail(res, 403, tr('srv.server.yeu_cau_khong_hop_le')); return; }
        const backup = features.service('server-backup');
        if (!backup) { res.writeHead(404); res.end(); return; }
        await backup.download(req, res, url); return;
      }
      await api(req, res, url);
    } catch (err) {
      if (!res.headersSent) fail(res, err.message === 'bad json' ? 400 : 500, err.message === 'bad json' ? tr('srv.server.du_lieu_khong_hop_le') : (err.message || tr('srv.server.co_loi_xay_ra')));
    } finally { activeRequests--; }
    return;
  }
  if (url.pathname === '/locales.js' && req.method === 'GET') { const script = localesScript(); sendAsset(req, res, 'text/javascript; charset=utf-8', asset('/locales.js', localesCache.stamp, () => Buffer.from(script))); return; }
  const entry = STATIC[url.pathname] || (req.method === 'GET' ? features.staticFile(url.pathname) : null);
  if (!entry || req.method !== 'GET') { res.writeHead(404); res.end(); return; }
  fs.stat(entry[0], (err, st) => {
    if (err) { res.writeHead(500); res.end(); return; }
    let a; try { a = asset(entry[0], st.mtimeMs + ':' + st.size, () => fs.readFileSync(entry[0])); } catch { res.writeHead(500); res.end(); return; }
    sendAsset(req, res, entry[1], a);
  });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const reject = (code) => { socket.write(`HTTP/1.1 ${code} Denied\r\n\r\n`); socket.destroy(); };
  if (draining) { reject(503); return; }
  if (!hostOk(req) || !originOk(req) || !req.headers.origin) { reject(403); return; }
  if (!authed(req)) { reject(401); return; }
  const url = new URL(req.url, 'http://localhost');
  const r = remotes.get(url.searchParams.get('server'));
  const name = url.searchParams.get('session');
  if (url.pathname !== '/ws/term' || !r || !r.ready || !name || name.length > 128) { reject(400); return; }
  wss.handleUpgrade(req, socket, head, (ws) => attach(ws, r, name, url));
});

function clampSize(v, lo, hi, dflt) {
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : dflt;
}

/** Closing this stream only detaches the tmux client; the session keeps running on the server. */
function attach(ws, r, name, url) {
  const cols = clampSize(url.searchParams.get('cols'), 10, 400, 100);
  const rows = clampSize(url.searchParams.get('rows'), 4, 200, 30);
  r.attach(name, cols, rows, (err, stream) => {
    if (err) { ws.close(4000, 'attach failed'); return; }
    // The viewer may have switched tabs while the SSH channel was opening: its socket is gone and its 'close' already fired.
    // Close the late channel at once, or every quick switch leaks one (OpenSSH allows 10 per connection; then new tabs stay black).
    if (ws.readyState !== ws.OPEN) { try { stream.close(); } catch { /* already closed */ } return; }
    // Build the session folder's file-name index while the user reads, so a bare file name opens at once.
    require('./lib/file-viewer').prewarm(r, name);
    openTerms.add(ws);
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    stream.on('data', (d) => { if (ws.readyState === ws.OPEN) ws.send(d, { binary: true }); });
    stream.stderr.on('data', (d) => { if (ws.readyState === ws.OPEN) ws.send(d, { binary: true }); });
    stream.on('close', () => ws.close(4001, 'ended'));
    ws.on('message', (msg, isBinary) => {
      if (isBinary) { stream.write(msg); return; }
      try {
        const c = JSON.parse(msg.toString('utf8'));
        if (c.t === 'resize') stream.setWindow(clampSize(c.rows, 4, 200, rows), clampSize(c.cols, 10, 400, cols), 0, 0);
      } catch { /* ignore a malformed control frame */ }
    });
    ws.on('close', () => { openTerms.delete(ws); stream.close(); });
  });
}

setInterval(() => {
  if (!vault.unlocked || Date.now() - lastSeen > ACTIVE_MS) return;
  for (const r of remotes.values()) r.poll();
}, POLL_MS).unref();

setInterval(() => {
  if (vault.unlocked) for (const r of remotes.values()) r.poll();
}, 60000).unref();

// Enabled supervision samples well inside the 60s freshness budget without browser/lastSeen activity.
setInterval(() => {
  require('./lib/supervision-state').pollUnattended(remotes.values(), vault.unlocked, features.service('supervision')?.enabled());
}, 15000).unref();

setInterval(saveHistory, 5 * 60000).unref();

setInterval(() => {
  for (const ws of openTerms) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
}, 30000).unref();

let draining = false;
const activeWork = () => activeRequests > 0 || features.service('ops-runtime')?.status().pending > 0 || features.service('supervision')?.pending() > 0 || features.service('server-backup')?.pending() > 0 || [...remotes.values()].some(r => r.restoring || r.sessionMutations);
function drain() {
  if (draining) return;
  draining = true;
  features.service('server-backup')?.stop();
  features.service('ops-runtime')?.stop();
  features.service('supervision')?.stop();
  const wait = () => activeWork() ? setTimeout(wait, 100) : shutdown();
  setImmediate(wait);
}
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  features.service('server-backup')?.stop();
  features.service('ops-runtime')?.stop();
  saveHistory();
  tokenCache.close();
  for (const ws of openTerms) ws.terminate();
  for (const r of remotes.values()) r.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGTERM', drain);
process.on('SIGINT', drain);

let dataLock;
async function boot() {
  try {
    // Private owner/ACL is required only when the vault unlocks itself from a password file (unattended service).
    dataLock = await acquireDataLock(DATA, { strict: !!process.env.TW_PASSWORD_FILE });
    if (draining) { dataLock.release(); return; }
    const headless = unlockFromFile(vault, process.env.TW_PASSWORD_FILE, () => {});
    server.once('error', () => { console.error('RUNTIME_LISTEN_FAILED'); process.exit(1); });
    server.listen(PORT, HOST, () => {
      if (headless) startRemotes();
      if (!process.argv.includes('--desktop-pipe')) console.log(`Termnest: http://${HOST}:${PORT}`);
    });
  } catch (e) {
    console.error(e.code?.startsWith('RUNTIME_') ? e.code : 'RUNTIME_START_FAILED');
    process.exit(1);
  }
}

if (typeof module !== 'undefined') { module.exports = { server, shutdown, activeWork, drain }; boot(); }
