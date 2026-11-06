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
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  try { const dir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } } catch { /* not every system can sync a folder */ }
}

// Encrypted copies of the store, one each time it is opened and at most one an hour after that, the newest KEEP kept: a damaged file can be replaced by the last good one.
const KEEP = 10, EVERY_MS = 60 * 60 * 1000;
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
      this.copyNext = true;   // opening the store (TERMNEST started again, often after the machine restarted) always leaves a copy
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
    if (this.copyNext || Date.now() - lastAt >= every) this.copy(text);
  }

  /** Writes an encrypted copy now: next to the store, and also into the folder chosen in Settings (a synced Drive folder…). */
  copy(text = null) {
    if (!this.key) throw new Error('vault is locked');
    text ||= JSON.stringify({ v: 1, salt: this.salt.toString('base64'), box: seal(this.key, this.data) });
    this.copyNext = false;
    const name = `vault-${Date.now()}.json`;
    try {
      fs.mkdirSync(backupDir(this.file), { recursive: true, mode: 0o700 });
      writeAtomic(path.join(backupDir(this.file), name), text);
      for (const old of backups(this.file).slice(KEEP)) fs.rmSync(old, { force: true });
      this.lastCopy = Date.now();
    } catch { /* a copy that fails never blocks saving */ }
    const extra = extraDir(this.data?.prefs?.backupDir);
    if (extra) {
      try {
        fs.mkdirSync(extra, { recursive: true, mode: 0o700 });
        writeAtomic(path.join(extra, name), text);
        const mine = fs.readdirSync(extra).filter((f) => /^vault-\d{13}\.json$/.test(f)).sort().reverse();
        for (const old of mine.slice(KEEP)) fs.rmSync(path.join(extra, old), { force: true });
        this.extraError = '';
      } catch (e) { this.extraError = e.code || 'failed'; }
    }
  }

  info() {
    const last = backups(this.file)[0];
    return { dir: backupDir(this.file), count: backups(this.file).length, lastAt: last ? Number(path.basename(last).slice(6, 19)) : 0,
      extra: extraDir(this.data?.prefs?.backupDir), extraError: this.extraError || '' };
  }
}

module.exports = { Vault, extraDir };
