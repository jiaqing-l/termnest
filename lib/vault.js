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

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
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

  /** Returns false on a wrong password; never throws for that case. */
  unlock(password) {
    const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    const salt = Buffer.from(raw.salt, 'base64');
    const key = derive(password, salt);
    try {
      this.data = open(key, raw.box);
    } catch {
      return false;
    }
    this.salt = salt;
    this.key = key;
    return true;
  }

  save() {
    if (!this.key) throw new Error('vault is locked');
    writeAtomic(this.file, JSON.stringify({
      v: 1, salt: this.salt.toString('base64'), box: seal(this.key, this.data),
    }));
  }
}

module.exports = { Vault };
