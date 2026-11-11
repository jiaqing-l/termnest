'use strict';
// One SSH connection per saved account. Every tmux process is started by the remote sshd, so it
// never belongs to this web service: stopping or restarting the service cannot touch a session.
const crypto = require('crypto');
const { Backend } = require('./backend');
const { Client } = require('ssh2');
const { shq } = require('./parse');

const RETRY_MS = [5000, 15000, 30000, 60000];

function fingerprint(key) {
  return `SHA256:${crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

function friendlyError(err, hostKeyChanged) {
  if (hostKeyChanged) return 'Máy chủ đã đổi khóa nhận dạng. Hãy kiểm tra lại, rồi gỡ và thêm lại.';
  const m = String(err && err.message || err);
  if (/authentication methods failed/i.test(m)) return 'Sai tài khoản, mật khẩu hoặc khóa.';
  if (/passphrase|parse privatekey|unsupported key/i.test(m)) return 'Không đọc được khóa SSH. Kiểm tra file khóa và mật khẩu của khóa.';
  if (/timed out|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH/i.test(m)) {
    return 'Không vào được máy chủ. Kiểm tra địa chỉ, cổng và VPN.';
  }
  return 'Không kết nối được máy chủ.';
}

class Remote extends Backend {
  constructor(cfg, onLearn, onPoll) { super(cfg, onLearn, onPoll); }

  get canAutoConnect() { return this.cfg.auth === 'key' || !!this.password; }

  connect(password) {
    if (password !== undefined) this.password = password;
    clearTimeout(this.retryTimer);
    this.closing = false;
    return new Promise((resolve, reject) => {
      const c = new Client();
      let hostKeyChanged = false;
      let settled = false;
      c.on('ready', () => {
        settled = true;
        this.client = c;
        this.ready = true; this.readyAt = Date.now(); this.sized = new Set(); // a new connection may be a new tmux server
        this.offSince = null;
        this.error = '';
        this.retry = 0;
        this.lastSlowPoll = null;
        this.slowSys = null;
        resolve();
      });
      c.on('error', (err) => {
        this.error = friendlyError(err, hostKeyChanged);
        if (!settled) { settled = true; reject(new Error(this.error)); }
      });
      c.on('close', () => {
        const wasLive = this.client === c;
        if (wasLive) {
          this.client = null; this.ready = false; this.prevCpu = null; this.prevNet = null;
          this.offSince = this.offSince || Date.now();
        }
        if (!settled) { settled = true; reject(new Error('Không kết nối được máy chủ.')); }
        if (wasLive && !this.closing) {
          if (!this.error) this.error = 'Mất kết nối.';
          this.scheduleRetry();
        }
      });
      const opts = {
        host: this.cfg.host,
        port: this.cfg.port,
        username: this.cfg.user,
        readyTimeout: 12000,
        keepaliveInterval: 15000,
        keepaliveCountMax: 3,
        hostVerifier: (key) => {
          const seen = fingerprint(key);
          if (!this.cfg.fingerprint) { this.cfg.fingerprint = seen; this.onLearn(this); return true; }
          if (this.cfg.fingerprint === seen) return true;
          hostKeyChanged = true;
          return false;
        },
      };
      try {
        if (this.cfg.auth === 'key') {
          opts.privateKey = this.cfg.key;
          if (this.cfg.passphrase) opts.passphrase = this.cfg.passphrase;
        } else {
          opts.password = this.password;
          opts.tryKeyboard = false;
        }
        c.connect(opts);
      } catch (err) {
        settled = true;
        this.error = friendlyError(err);
        reject(new Error(this.error));
      }
    });
  }

  scheduleRetry() {
    if (!this.canAutoConnect || this.closing) return;
    const ms = RETRY_MS[Math.min(this.retry, RETRY_MS.length - 1)];
    this.retry += 1;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.connect().catch(() => this.scheduleRetry());
    }, ms);
    this.retryTimer.unref();
  }

  close() {
    this.closing = true;
    clearTimeout(this.retryTimer);
    if (this.client) this.client.end();
  }

  attach(name, cols, rows, callback) {
    // Two viewers of one session (this window and a phone, say) otherwise shrink it to the smaller one and fill the rest with dots.
    // Once per session per connection: every extra command costs a round trip and a channel on a slow link.
    // The option must be in place before the client attaches: set in parallel, the first attach is sized by the smaller viewer
    // and tmux keeps that size (status bar mid-screen, repeated lines) until the next resize.
    this.sized ||= new Set();
    const go = () => this.client.exec(`tmux -u attach-session -t ${shq(`=${name}`)}`, { pty: { term: 'xterm-256color', cols, rows } }, callback);
    if (this.sized.has(name)) { go(); return; }
    this.sized.add(name);
    this.exec(`tmux set-option -q -t ${shq(`=${name}`)} window-size latest`, 5000).catch(() => { /* older tmux: option unknown */ }).then(go);
  }

  // At most MAX_CHANNELS commands at once on one SSH connection (OpenSSH allows 10 sessions per connection by default; features
  // run in parallel with the poll). The others wait their turn. The time limit covers waiting and opening the channel too, so a
  // channel that is never granted cannot hang the poll forever.
  exec(cmd, timeoutMs = 10000, maxBytes = 2000000, input = null) {
    return new Promise((resolve, reject) => {
      if (!this.ready) { reject(new Error('Máy chủ chưa kết nối.')); return; }
      let done = false, stream = null;
      const finish = (fn, v) => { if (done) return; done = true; clearTimeout(t); release(); fn(v); };
      const t = setTimeout(() => { try { if (stream) stream.close(); } catch { /* already closed */ } finish(reject, new Error(stream ? 'Máy chủ phản hồi quá lâu.' : 'Máy chủ không mở thêm được kênh SSH (quá nhiều lệnh cùng lúc).')); }, timeoutMs);
      let held = false;
      const release = () => { if (held) { held = false; this.channels -= 1; const next = this.waiting.shift(); if (next) next(); } };
      const start = () => {
        if (done) { const next = this.waiting.shift(); if (next) next(); return; }
        held = true; this.channels += 1;
        this.client.exec(cmd, (err, st) => {
          if (err) { finish(reject, err); return; }
          stream = st;
          if (done) { try { st.close(); } catch { /* closing */ } return; }
          let out = '', bytes = 0, errOut = '';
          const decoder = new (require('string_decoder').StringDecoder)('utf8');
          if (input != null) st.end(input);
          st.on('data', (d) => { bytes += d.length; if (bytes > maxBytes) { try { st.close(); } catch { /* closing */ } finish(reject, Error('Nội dung phản hồi quá lớn.')); return; } out += decoder.write(d); });
          st.stderr.on('data', (d) => { errOut += d.toString('utf8'); });
          st.on('close', (code) => finish(resolve, { out: out + decoder.end(), err: errOut, code: code || 0 }));
        });
      };
      this.channels = this.channels || 0; this.waiting = this.waiting || [];
      if (this.channels < MAX_CHANNELS) start(); else this.waiting.push(start);
    });
  }
}

const MAX_CHANNELS = 6;
module.exports = { MAX_CHANNELS, Remote, friendlyError, fingerprint };
