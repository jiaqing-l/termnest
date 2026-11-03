'use strict';
const crypto = require('crypto');
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
const diary = require('./lib/diary');
const { scrollScript, parseScrollState } = require('./lib/scroll');
const { injectReportLinks } = require('./lib/report-links');
const { createFeatures } = require('./lib/features');
const { cleanPrefs, mergePrefs, syncKnown, claudeSessionId, parseDirs, shq, validDir, validHost, validName, validUser } = require('./lib/parse');

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
const STATIC = {
  '/': [path.join(PUB, 'index.html'), 'text/html; charset=utf-8'],
  '/markdown-worker.js': [path.join(PUB, 'markdown-worker.js'), 'text/javascript; charset=utf-8'],
  '/vendor/markdown-it.js': [path.join(NM, 'markdown-it/dist/markdown-it.min.js'), 'text/javascript; charset=utf-8'],
  '/file-viewer.js': [path.join(PUB, 'file-viewer.js'), 'text/javascript; charset=utf-8'],
  '/token-ui.js': [path.join(PUB, 'token-ui.js'), 'text/javascript; charset=utf-8'],
  '/usage-ui.js': [path.join(PUB, 'usage-ui.js'), 'text/javascript; charset=utf-8'],
  '/features-host.js': [path.join(PUB, 'features-host.js'), 'text/javascript; charset=utf-8'],
  '/app.js': [path.join(PUB, 'app.js'), 'text/javascript; charset=utf-8'],
  '/view-controls.js': [path.join(PUB, 'view-controls.js'), 'text/javascript; charset=utf-8'],
  '/terminal-keys.js': [path.join(PUB, 'terminal-keys.js'), 'text/javascript; charset=utf-8'],
  '/ime-input.js': [path.join(PUB, 'ime-input.js'), 'text/javascript; charset=utf-8'],
  '/pet-state.js': [path.join(PUB, 'pet-state.js'), 'text/javascript; charset=utf-8'],
  '/pet-scene.js': [path.join(PUB, 'pet-scene.js'), 'text/javascript; charset=utf-8'],
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

function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...HEADERS });
  res.end(JSON.stringify(body));
}
function fail(res, code, error) { send(res, code, { error }); }

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (d) => {
      size += d.length;
      if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); return; }
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
  if (r.cfg.local && vault.data.prefs.autoRestoreLocal && r.lost.length && !r.restoring) {
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

function startRemotes() {
  vault.data.prefs = mergePrefs(vault.data.prefs);
  vault.data.known ||= {};
  if (!remotes.has(LOCAL_ID)) {
    const local = addRemote(localConfig());
    local.connect().then(() => local.poll()).catch((err) => { local.error = err.message; });
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
  if (!vault.exists()) { fail(res, 409, 'Chưa đặt mật khẩu cho Termnest.'); return; }
  const now = Date.now();
  if (now < lockedUntil) {
    fail(res, 429, `Sai quá nhiều lần. Thử lại sau ${Math.ceil((lockedUntil - now) / 1000)} giây.`);
    return;
  }
  if (typeof password !== 'string' || !password || !vault.unlock(password)) {
    failures += 1;
    if (failures >= LOGIN_LIMIT) { failures = 0; lockedUntil = now + LOGIN_LOCK_MS; }
    fail(res, 401, 'Sai mật khẩu.');
    return;
  }
  failures = 0;
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, now + SESSION_MS);
  setCookie(res, token);
  startRemotes();
  send(res, 200, { ok: true });
}

function publicState() {
  lastSeen = Date.now();
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
  const auth = b.auth === 'key' ? 'key' : 'password';
  if (!validHost(host)) { fail(res, 400, 'Địa chỉ máy chủ chưa đúng.'); return; }
  if (!validUser(user)) { fail(res, 400, 'Tài khoản chưa đúng.'); return; }
  if (!Number.isInteger(port) || port < 1 || port > 65535) { fail(res, 400, 'Cổng chưa đúng.'); return; }
  if (auth === 'password' && (typeof b.password !== 'string' || !b.password)) { fail(res, 400, 'Nhập mật khẩu.'); return; }
  if (auth === 'key' && (typeof b.key !== 'string' || !b.key.includes('PRIVATE KEY'))) {
    fail(res, 400, 'Chọn file khóa SSH riêng tư (private key).');
    return;
  }
  if (vault.data.servers.some((s) => s.host === host && s.port === port && s.user === user)) {
    fail(res, 409, 'Tài khoản này đã có trong danh sách.');
    return;
  }
  const cfg = { id: crypto.randomUUID(), host, port, user, auth, name: '', fingerprint: '' };
  if (auth === 'key') {
    cfg.key = b.key;
    if (b.passphrase) cfg.passphrase = String(b.passphrase);
  }
  const r = new Remote(cfg, () => {});
  try {
    await r.connect(auth === 'password' ? b.password : undefined);
  } catch (err) {
    r.close();
    fail(res, 400, err.message);
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
  if (id === LOCAL_ID) { fail(res, 400, 'Không thể gỡ Máy này.'); return; }
  const r = remotes.get(id);
  if (!r) { fail(res, 404, 'Không thấy máy chủ này.'); return; }
  r.close();
  remotes.delete(id);
  vault.data.servers = vault.data.servers.filter((s) => s.id !== id);
  if (vault.data.known) delete vault.data.known[id];
  delete savedHistory[id];
  saveHistory();
  saveVault();
  send(res, 200, { ok: true });
}

async function reconnect(req, res, id) {
  const r = remotes.get(id);
  if (!r) { fail(res, 404, 'Không thấy máy chủ này.'); return; }
  const b = await readJson(req);
  if (r.ready) { send(res, 200, { ok: true }); return; }
  if (r.cfg.auth === 'password' && !r.password && !b.password) { fail(res, 400, 'Nhập mật khẩu.'); return; }
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

async function listDirs(res, r, dir) {
  dir = dir.trim();
  if (!validDir(dir) || (r.mode !== 'powershell' && dir && !dir.startsWith('/'))) { fail(res, 400, 'Thư mục chưa đúng.'); return; }
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
  if (out.code !== 0) { fail(res, 400, 'Không mở được thư mục này.'); return; }
  send(res, 200, parseDirs(out.out));
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

async function executeStartSession(r, { name, dir, run, restoring = false }) {
  if (!validName(name)) throw new Error('Tên chỉ dùng chữ không dấu, số, - hoặc _.');
  if (!validDir(dir)) throw new Error('Thư mục chưa đúng.');
  if (!['shell', 'claude', 'codex'].includes(run)) throw new Error('Lệnh chưa đúng.');
  dir = dir.trim();
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
      `tmux -u new-session -d -s ${shq(name)} -c "$d" -e "LANG=\${LANG:-C.UTF-8}" 2>/dev/null || tmux -u new-session -d -s ${shq(name)} -c "$d"`,
    ].join('\n'))}`);
    if (out.code === 3) throw new Error('Không thấy thư mục này.');
    if (out.code === 4) { const err = new Error('Tên này đã có.'); err.status = 409; throw err; }
    if (out.code !== 0) throw new Error('Không tạo được phiên.');
    const records = out.out.split('\0');
    const record = records.indexOf('TW_DIR');
    if (record < 0 || !records[record + 1]?.endsWith('\n')) throw new Error('Không đọc được thư mục của phiên.');
    resolvedDir = records[record + 1].slice(0, -1);
    if (run === 'claude') {
      const id = claudeSessionId(resolvedDir, name);
      const script = [
        `cmd=${shq(`claude --session-id ${shq(id)} --name ${shq(name)}`)}`,
        `for f in "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/${shq(id + '.jsonl')}; do`,
        `  if [ -f "$f" ]; then cmd=${shq(`claude --resume ${shq(id)}`)}; break; fi`,
        `done`,
        // Decide remotely, but send one simple command to the user's login shell (including fish).
        `tmux send-keys -t ${shq(`=${name}:`)} "$cmd" Enter`,
      ].join('\n');
      let launched;
      try { launched = await r.exec(`sh -c ${shq(script)}`); }
      catch { launched = { code: 1 }; }
      if (launched.code !== 0) {
        await r.exec(`tmux -u kill-session -t ${shq(`=${name}`)}`).catch(() => {});
        throw new Error('Không chạy được Claude.');
      }
    }
    if (run === 'codex') {
      const cmd = r.cfg.local ? await r.codexLaunch(restoring) : 'codex';
      const launched = await r.exec(`tmux send-keys -t ${shq(`=${name}:`)} ${shq(cmd)} Enter`).catch(() => ({ code: 1 }));
      if (launched.code !== 0) {
        await r.exec(`tmux -u kill-session -t ${shq(`=${name}`)}`).catch(() => {});
        throw new Error('Không chạy được Codex.');
      }
    }
  }
  vault.data.known ||= {};
  const known = vault.data.known[r.cfg.id] ||= { bootId: r.snapshot?.bootId || '', sessions: {}, lost: [] };
  Object.defineProperty(known.sessions, name, { value: { dir: resolvedDir, run }, enumerable: true, configurable: true, writable: true });
  known.lost = (known.lost || []).filter((n) => n !== name);
  const prefs = mergePrefs(vault.data.prefs);
  prefs.recentDirs = [resolvedDir, ...prefs.recentDirs.filter((d) => d !== resolvedDir)].slice(0, 8);
  vault.data.prefs = prefs;
  saveVault();
  updateLost(r);
}

async function killSession(res, r, name) {
  if (typeof name !== 'string' || !name || name.length > 128) { fail(res, 400, 'Tên phiên chưa đúng.'); return; }
  const stopped = await withSessionChange(r, async () => {
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
  if (!stopped) { fail(res, 400, 'Không dừng được phiên này.'); return; }
  await r.poll();
  send(res, 200, { ok: true });
}

async function restore(req, res, r) {
  const b = await readJson(req);
  if (b.names !== undefined && (!Array.isArray(b.names) || b.names.some((n) => !validName(n)))) {
    fail(res, 400, 'Danh sách phiên chưa đúng.'); return;
  }
  const names = b.names === undefined ? r.lost.map((s) => s.name) : [...new Set(b.names)];
  const result = { restored: [], failed: [] };
  for (const name of names) {
    const session = r.lost.find((s) => s.name === name);
    if (!session) { result.failed.push({ name, error: 'Không thấy phiên cần khôi phục.' }); continue; }
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
  catch { fail(res, 400, 'Lệnh cuộn chưa đúng.'); return; }
  if (r.mode === 'powershell') { fail(res, 400, 'Máy này chưa hỗ trợ cuộn.'); return; }
  if (!r.ready) { fail(res, 503, 'Máy chủ chưa kết nối.'); return; }
  const out = await r.exec(`sh -c ${shq(script)}`);
  try { send(res, 200, parseScrollState(out.out)); }
  catch { fail(res, 400, 'Không đọc được vị trí cuộn.'); }
}

async function sendKeys(req, res, r, name) {
  const b = await readJson(req);
  if (!name || name.length > 128 || typeof b.text !== 'string' || b.text.length > 1000 ||
      /[\x00-\x1f\x7f-\x9f]/.test(b.text) || (b.enter !== undefined && typeof b.enter !== 'boolean')) {
    fail(res, 400, 'Nội dung chưa đúng.'); return;
  }
  const target = shq(`=${name}:`);
  const replySession = r.snapshot?.sessions?.find((s) => s.name === name);
  if (r.mode === 'powershell') {
    r.keysPlain(name, b.text, b.enter !== false);
  } else {
    if (b.text) {
      const out = await r.exec(`tmux send-keys -l -t ${target} -- ${shq(b.text)}`);
      if (out.code !== 0) { fail(res, 400, 'Không gửi được nội dung.'); return; }
    }
    if (b.enter !== false) {
      const out = await r.exec(`tmux send-keys -t ${target} Enter`);
      if (out.code !== 0) { fail(res, 400, 'Không gửi được Enter.'); return; }
    }
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
  if (p === '/api/setup' && m === 'POST') {
    if (!webSetupEnabled()) { fail(res, 404, 'Not found'); return; }
    const body = await readJson(req);
    // Recheck after reading the body: another request may have created the vault.
    if (!webSetupEnabled()) { fail(res, 404, 'Not found'); return; }
    const digest = (value) => crypto.createHash('sha256').update(value).digest();
    if (typeof body.setupToken !== 'string' ||
        !crypto.timingSafeEqual(digest(body.setupToken), digest(process.env.TW_SETUP_TOKEN))) {
      fail(res, 403, 'Mã thiết lập không hợp lệ.'); return;
    }
    if (typeof body.password !== 'string' || body.password.length < 10) {
      fail(res, 400, 'Mật khẩu cần ít nhất 10 ký tự.'); return;
    }
    vault.create(body.password, { servers: [] });
    delete process.env.TW_SETUP_TOKEN;
    send(res, 200, { ok: true }); return;
  }
  if (p === '/api/quit' && process.env.TW_PACKAGED !== '1') {
    fail(res, 404, 'Not found'); return;
  }
  if (p === '/api/login' && m === 'POST') { await login(req, res); return; }
  if (!authed(req)) { fail(res, 401, 'Hãy đăng nhập lại.'); return; }
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
  if (p === '/api/state' && m === 'GET') { send(res, 200, publicState()); return; }
  if ((p === '/api/file' || p === '/api/file-preview') && m === 'GET') {
    try {
      const value = await require('./lib/file-viewer').readSessionFile(remotes.get(url.searchParams.get('server')), url.searchParams.get('session'), url.searchParams.get('path'));
      if(p === '/api/file-preview' && !value.error){
        if(value.kind !== 'html'){fail(res,400,'Chỉ hỗ trợ bản xem trước HTML.');return;}
        res.writeHead(200, {...HEADERS, 'Content-Type':'text/html; charset=utf-8',
          'Content-Security-Policy':"sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'"});
        res.end(injectReportLinks(value.text));return;
      }
      send(res, value.error ? 400 : 200, value);
    } catch (e) { fail(res, 400, e.message); }
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
    catch { send(res, 400, { error: 'Khoảng ngày hoặc múi giờ chưa đúng.' }); return; }
    const accounts = mergePrefs(vault.data.prefs).aiAccounts;
    // Account emails come from the token scan, so the report names accounts the same way the cards do.
    const emails = new Map();
    try { for (const a of JSON.parse(tokenCache.get([...remotes.values()], accounts, { zone })).accounts || []) if (a.email) emails.set(a.id, a.email); } catch { /* names fall back to nickname or directory */ }
    const backendOf = (id) => { const r = remotes.get(id); return r?.ready ? r : null; };
    try { send(res, 200, await usage.get(backendOf, accounts, { from: url.searchParams.get('from'), to: url.searchParams.get('to'), zone, refresh: url.searchParams.get('refresh') === '1', emails })); }
    catch { send(res, 500, { error: 'Không đọc được báo cáo sử dụng.' }); }
    return;
  }
  if (p === '/api/prefs' && m === 'GET') { send(res, 200, mergePrefs(vault.data.prefs)); return; }
  if (p === '/api/prefs' && m === 'PUT') {
    const input = await readJson(req);
    let prefs;
    try { prefs = cleanPrefs(input, vault.data.prefs); }
    catch { fail(res, 400, 'Cài đặt chưa đúng.'); return; }
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
    catch { fail(res, 400, 'Tên task hoặc track chưa đúng.'); return; }
    const w = r?.snapshot?.workers.find((w) => w.task === task && w.track === track);
    if (!w) { fail(res, 404, 'Không thấy worker.'); return; }
    if (!r.ready) { fail(res, 503, 'Máy chủ chưa kết nối.'); return; }
    const log = await r.readWorkerLog(w);
    send(res, 200, { ...log, elapsed: w.elapsed, finishedAt: w.finishedAt || null }); return;
  }
  const sv = p.match(/^\/api\/servers\/([0-9a-f-]{36})(\/connect|\/reboot|\/dirs|\/history|\/restore|\/lost|\/sessions(?:\/([^/]+)(\/keys|\/scroll)?)?)?$/);
  if (sv) {
    const id = sv[1];
    const tail = sv[2] || '';
    if (!tail && m === 'DELETE') { removeServer(res, id); return; }
    if (tail === '/connect' && m === 'POST') { await reconnect(req, res, id); return; }
    const r = remotes.get(id);
    if (!r) { fail(res, 404, 'Không thấy máy chủ này.'); return; }
    if (tail === '/reboot' && m === 'POST') {
      const body = await readJson(req);
      try { send(res, 200, await require('./lib/reboot').rebootServer(r, body.name)); }
      catch (err) { fail(res, 400, err.message); }
      return;
    }
    if (tail === '/history' && m === 'GET') {
      const hours = url.searchParams.get('hours');
      if (!['1', '6', '24'].includes(hours)) { fail(res, 400, 'Khoảng thời gian chưa đúng.'); return; }
      send(res, 200, { points: historyPoints(r.longHistory, Date.now() - Number(hours) * 3600000) }); return;
    }
    if (tail === '/restore' && m === 'POST') { await restore(req, res, r); return; }
    if (tail === '/lost' && m === 'DELETE') { dismissLost(res, r); return; }
    if (sv[4] === '/keys' && m === 'POST') { await sendKeys(req, res, r, decodeURIComponent(sv[3])); return; }
    if (sv[4] === '/scroll' && m === 'POST') { await scrollSession(req, res, r, decodeURIComponent(sv[3])); return; }
    if (tail === '/dirs' && m === 'GET') { await listDirs(res, r, url.searchParams.get('path') || ''); return; }
    if (tail === '/sessions' && m === 'POST') { await createSession(req, res, r); return; }
    if (sv[3] && !sv[4] && m === 'DELETE') { await killSession(res, r, decodeURIComponent(sv[3])); return; }
  }
  fail(res, 404, 'Không tìm thấy.');
}

let activeRequests = 0;
// Drop-in features (lib/features/*.js + public/features/*): see lib/features.js.
const features = createFeatures({ libDir: path.join(__dirname, 'lib', 'features'), publicDir: path.join(PUB, 'features'),
  deps: { remotes: () => remotes, backendOf: (id) => { const r = remotes.get(id); return r?.ready ? r : null; }, send, fail, readJson, shq,
    vault: () => vault, save: () => saveVault() } });
features.load();

const server = http.createServer(async (req, res) => {
  if (!hostOk(req)) { res.writeHead(403); res.end(); return; }
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/__app' && req.method === 'GET') {
    // Legacy wire identity lets desktop releases reuse an existing source server.
    send(res, 200, { app: 'tmux-dev', active_work: activeWork() ? 1 : 0 }); return;
  }
  if (draining && req.method !== 'GET') { fail(res, 503, 'Ứng dụng đang đóng.'); return; }
  if (url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && !originOk(req)) { fail(res, 403, 'Yêu cầu không hợp lệ.'); return; }
    activeRequests++;
    try {
      await api(req, res, url);
    } catch (err) {
      if (!res.headersSent) fail(res, err.message === 'bad json' ? 400 : 500, err.message === 'bad json' ? 'Dữ liệu không hợp lệ.' : (err.message || 'Có lỗi xảy ra.'));
    } finally { activeRequests--; }
    return;
  }
  const entry = STATIC[url.pathname] || (req.method === 'GET' ? features.staticFile(url.pathname) : null);
  if (!entry || req.method !== 'GET') { res.writeHead(404); res.end(); return; }
  fs.readFile(entry[0], (err, buf) => {
    if (err) { res.writeHead(500); res.end(); return; }
    res.writeHead(200, { 'Content-Type': entry[1], ...HEADERS });
    res.end(buf);
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

setInterval(saveHistory, 5 * 60000).unref();

setInterval(() => {
  for (const ws of openTerms) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
}, 30000).unref();

let draining = false;
const activeWork = () => activeRequests > 0 || [...remotes.values()].some(r => r.restoring || r.sessionMutations);
function drain() {
  if (draining) return;
  draining = true;
  const wait = () => activeWork() ? setTimeout(wait, 100) : shutdown();
  setImmediate(wait);
}
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  saveHistory();
  tokenCache.close();
  for (const ws of openTerms) ws.terminate();
  for (const r of remotes.values()) r.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGTERM', drain);
process.on('SIGINT', drain);

server.listen(PORT, HOST, () => { if (!process.argv.includes('--desktop-pipe')) console.log(`Termnest: http://${HOST}:${PORT}`); });

if (typeof module !== 'undefined') module.exports = { server, shutdown, activeWork, drain };
