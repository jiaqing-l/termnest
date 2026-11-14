'use strict';
// Encrypted store for the server list. Everything sensitive lives in one AES-256-GCM blob; the key
// is derived from the tool password and only ever held in memory.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

function derive(password, salt) {
  return crypto.scryptSync(password, salt, 32, SCRYPT);
}

function seal(key, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}

function open(key, box) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  d.setAuthTag(Buffer.from(box.tag, 'base64'));
  const pt = Buffer.concat([d.update(Buffer.from(box.ct, 'base64')), d.final()]);
  return JSON.parse(pt.toString('utf8'));
}

// Written to a temporary file, flushed to the disk, then renamed over the old one: a power cut leaves either the old or the new
// file, never half of one.
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ } throw e; }   // a full disk must not leave a growing pile of half files
  try { const dir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } } catch { /* not every system can sync a folder */ }
}

// Encrypted copies of the store, one each time it is opened and at most one an hour after that, the newest KEEP kept: a damaged file can be replaced by the last good one.
// Retention is tiered so a burst of copies (a crash-looping service, restarts) cannot push every older good copy out: the newest KEEP,
// plus the newest of each of the last DAYS days and WEEKS weeks. At most KEEP + DAYS + WEEKS files, whatever the interval.
const KEEP = 10, DAYS = 14, WEEKS = 4, EVERY_MS = 60 * 60 * 1000, SNAP_KEEP = 5;
const COPY_RE = /^vault-\d{13}\.json$/, SNAP_RE = /^vault-(prerestore|preremove)-\d{13}\.json$/;
function tsOf(f) { return Number(f.slice(f.length - 18, f.length - 5)); }
/** Which of the (newest first) copy names to delete. */
function expired(names, now = Date.now()) {
  const keep = new Set(names.slice(0, KEEP)), days = new Map(), weeks = new Map();
  for (const f of names) {
    const t = tsOf(f), d = Math.floor(t / 86400000), w = Math.floor(t / (7 * 86400000));
    if (now - t < DAYS * 86400000 && !days.has(d)) days.set(d, f);
    if (now - t < WEEKS * 7 * 86400000 && !weeks.has(w)) weeks.set(w, f);
  }
  for (const f of [...days.values(), ...weeks.values()]) keep.add(f);
  return names.filter((f) => !keep.has(f));
}
function prune(dir, now) {
  let all; try { all = fs.readdirSync(dir); } catch { return; }
  for (const f of expired(all.filter((n) => COPY_RE.test(n)).sort().reverse(), now)) try { fs.rmSync(path.join(dir, f), { force: true }); } catch { /* next time */ }
  for (const label of ['prerestore', 'preremove']) {
    for (const f of all.filter((n) => n.startsWith(`vault-${label}-`) && SNAP_RE.test(n)).sort().reverse().slice(SNAP_KEEP)) try { fs.rmSync(path.join(dir, f), { force: true }); } catch { /* next time */ }
  }
}
const sameData = (a, b) => crypto.createHash('sha256').update(JSON.stringify(a)).digest('hex') === crypto.createHash('sha256').update(JSON.stringify(b)).digest('hex');
function backupDir(file) { return path.join(path.dirname(file), 'backups'); }
// Copies in a folder of the user's choice go into its own TERMNEST-backup subfolder, never loose among their files.
function extraDir(dir) { return typeof dir === 'string' && path.isAbsolute(dir) ? path.join(dir, 'TERMNEST-backup') : ''; }
function backups(file) {
  try { return fs.readdirSync(backupDir(file)).filter((f) => /^vault-\d{13}\.json$/.test(f)).sort().reverse().map((f) => path.join(backupDir(file), f)); } catch { return []; }
}

class Vault {
  constructor(file) {
    this.file = file;
    this.key = null;
    this.salt = null;
    this.data = null;
  }

  exists() { return fs.existsSync(this.file); }
  get unlocked() { return this.key !== null; }

  create(password, data = { servers: [] }) {
    const salt = crypto.randomBytes(16);
    this.salt = salt;
    this.key = derive(password, salt);
    this.data = data;
    this.save();
  }

  /** Returns false on a wrong password; never throws for that case. A damaged store is replaced by the newest copy this password opens. */
  unlock(password) {
    this.recovered = null;
    const keys = new Map();   // the copies share the store's salt: one slow key derivation serves them all
    for (const file of [this.file, ...backups(this.file)]) {
      let raw, salt, key, data;
      try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); salt = Buffer.from(raw.salt, 'base64'); } catch { continue; }
      try { key = keys.get(raw.salt) || derive(password, salt); keys.set(raw.salt, key); data = open(key, raw.box); } catch { continue; }
      this.salt = salt; this.key = key; this.data = data;
      if (file !== this.file) {
        this.recovered = { at: Number(path.basename(file).slice(6, 19)) };
        try { fs.copyFileSync(this.file, `${this.file}.damaged-${Date.now()}`); } catch { /* nothing to keep */ }
        this.save();
      }
      this.copyNext = true;   // opening the store (TERMNEST started again, often after the machine restarted) leaves a copy, unless the newest one is identical
      this.lastCopyData = null;
      try {   // same salt, same key: the newest copy opens at no cost; if it is the same data there is nothing new to keep
        const newest = backups(this.file)[0];
        if (newest && file === this.file) { const nr = JSON.parse(fs.readFileSync(newest, 'utf8')); if (nr.salt === raw.salt) this.lastCopyData = open(key, nr.box); }
      } catch { /* a copy that does not open is simply not "the same" */ }
      return true;
    }
    return false;
  }

  save() {
    if (!this.key) throw new Error('vault is locked');
    const text = JSON.stringify({ v: 1, salt: this.salt.toString('base64'), box: seal(this.key, this.data) });
    writeAtomic(this.file, text);
    const last = backups(this.file)[0], lastAt = last ? Number(path.basename(last).slice(6, 19)) : 0;
    // How often is a setting (Settings → Backup and clean-up: 15 min, 1 h, 6 h, 24 h); an hour unless chosen.
    const every = [15, 60, 360, 1440].includes(this.data?.prefs?.backupMinutes) ? this.data.prefs.backupMinutes * 60000 : EVERY_MS;
    if (this.copyNext || Date.now() - lastAt >= every) this.copy(text, true);
  }

  /** Writes an encrypted copy now: next to the store, and also into the folder chosen in Settings (a synced Drive folder…). */
  copy(text = null, auto = false) {
    if (!this.key) throw new Error('vault is locked');
    // An automatic copy of data that has not changed since the last copy adds nothing (and would push older, different ones out).
    if (auto && this.lastCopyData && sameData(this.lastCopyData, this.data)) { this.copyNext = false; return; }
    text ||= JSON.stringify({ v: 1, salt: this.salt.toString('base64'), box: seal(this.key, this.data) });
    this.copyNext = false;
    const name = `vault-${Date.now()}.json`;
    try {
      fs.mkdirSync(backupDir(this.file), { recursive: true, mode: 0o700 });
      writeAtomic(path.join(backupDir(this.file), name), text);
      prune(backupDir(this.file));
      this.lastCopy = Date.now();
      this.lastCopyData = JSON.parse(JSON.stringify(this.data));
    } catch { /* a copy that fails never blocks saving */ }
    const extra = extraDir(this.data?.prefs?.backupDir);
    if (extra) {
      try {
        fs.mkdirSync(extra, { recursive: true, mode: 0o700 });
        writeAtomic(path.join(extra, name), text);
        prune(extra);
        this.extraError = '';
      } catch (e) { this.extraError = e.code || 'failed'; }
    }
  }

  /**
   * A separate, VERIFIED encrypted copy taken right before something destructive (a restore, removing a server). Kept outside the
   * rotating copies. Throws when it could not be written or does not open again: the caller must then not go on.
   */
  snapshot(label = 'prerestore') {
    if (!this.key) throw new Error('vault is locked');
    if (!/^(prerestore|preremove)$/.test(label)) throw new Error('bad snapshot label');
    const text = JSON.stringify({ v: 1, salt: this.salt.toString('base64'), box: seal(this.key, this.data) });
    const file = path.join(backupDir(this.file), `vault-${label}-${Date.now()}.json`);
    writeAtomic(file, text);
    const back = open(this.key, JSON.parse(fs.readFileSync(file, 'utf8')).box);
    if (!sameData(back, this.data)) { try { fs.rmSync(file, { force: true }); } catch { /* ignore */ } throw new Error('snapshot_verify_failed'); }
    prune(backupDir(this.file));
    return file;
  }

  /** Paths of the rotating copies next to the store (newest first). */
  static listCopies(file) { return backups(file); }

  /** The vault file is gone but encrypted copies are still there: a way back exists (nothing is restored automatically). */
  static orphanCopies(file) {
    try { if (fs.existsSync(file)) return 0; } catch { return 0; }
    return backups(file).length;
  }

  /** True when the password is this store's own password (asked again before something sensitive). */
  check(password) {
    if (!this.key || typeof password !== 'string') return false;
    try { return crypto.timingSafeEqual(derive(password, this.salt), this.key); } catch { return false; }
  }

  /** A file of its own, encrypted with a password (the "Chuyển máy" file). Same format as the store, so read() opens it. */
  static pack(password, obj) {
    const salt = crypto.randomBytes(16);
    return JSON.stringify({ v: 1, salt: salt.toString('base64'), box: seal(derive(password, salt), obj) });
  }

  /** Something kept next to the store under its key (chats waiting to be placed). */
  sealExtra(obj) { if (!this.key) throw new Error('vault is locked'); return JSON.stringify(seal(this.key, obj)); }
  openExtra(text) { try { return open(this.key, JSON.parse(text)); } catch { return null; } }

  /** Opens a backup file's text with ITS password (it may differ from this store's). Returns the data or null; never throws. */
  static read(text, password) {
    try {
      const raw = JSON.parse(text);
      if (!raw || raw.v !== 1 || typeof raw.salt !== 'string' || !raw.box) return null;
      return open(derive(password, Buffer.from(raw.salt, 'base64')), raw.box);
    } catch { return null; }
  }

  info() {
    const last = backups(this.file)[0];
    return { dir: backupDir(this.file), count: backups(this.file).length, lastAt: last ? Number(path.basename(last).slice(6, 19)) : 0,
      extra: extraDir(this.data?.prefs?.backupDir), extraError: this.extraError || '' };
  }
}

module.exports = { Vault, extraDir, expired };
