'use strict';
const { tr } = require('./i18n-server');
const { POLL_SCRIPT, SLOW_SCRIPT, networkSpeed, parseSlow, parsePoll, classify, isAsking, screenQuiet, shq } = require('./parse');
const { logScript, retainWorkers, RETAIN_MS } = require('./crew');
const HISTORY = 28;

// Transport contract: connect, exec, attach, close. Shared tmux polling and views.
class Backend {
  /** @param cfg saved account (with secrets). @param onLearn called when the host key is first seen. */
  constructor(cfg, onLearn, onPoll = () => {}) {
    this.cfg = cfg;
    this.onLearn = onLearn;
    this.onPoll = onPoll;
    this.client = null;
    this.ready = false;
    this.error = '';
    this.password = null; // in memory only, never written to the vault
    this.snapshot = null;
    this.prevCpu = null;
    this.screens = new Map();
    this.prevNet = null;
    this.slowSys = null;
    this.lastSlowPoll = null;
    this.netHistory = [];
    this.longHistory = [];
    this.lost = [];
    this.offSince = null;
    this.history = { cpu: [], ram: [], disk: [] };
    this.retry = 0;
    this.retryTimer = null;
    this.closing = false;
    this.polling = false;
    this.sessionVersion = 0;
    this.lastPoll = 0;
  }


  async poll() {
    if (!this.ready || this.polling) return;
    this.polling = true;
    const sessionVersion = this.sessionVersion;
    try {
      const { out, code } = await this.exec(`sh -c ${shq(POLL_SCRIPT)}`);
      if (code !== undefined && code !== 0) throw new Error('Poll failed');
      const now = Date.now();
      const snap = parsePoll(out, Math.floor(now / 1000));
      Object.assign(snap.sys, networkSpeed(this.prevNet?.bytes, snap.netBytes, this.prevNet ? now - this.prevNet.t : 0));
      this.prevNet = { bytes: snap.netBytes, t: now };
      this.netHistory.push(snap.sys.downMBs);
      this.netHistory = this.netHistory.slice(-HISTORY);
      snap.sys.net = this.netHistory;
      delete snap.netBytes;
      if (this.lastSlowPoll === null || now - this.lastSlowPoll >= 60000) {
        this.lastSlowPoll = now;
        try {
          const slow = await this.exec(`sh -c ${shq(SLOW_SCRIPT)}`);
          if (slow.code === 0) this.slowSys = parseSlow(slow.out);
        } catch { /* retain the last successful slow sample */ }
      }
      if (this.slowSys) Object.assign(snap.sys, this.slowSys);
      if (this.decorateSnapshot) await this.decorateSnapshot(snap);
      if (snap.cpuTicks && this.prevCpu) {
        const total = snap.cpuTicks.total - this.prevCpu.total;
        const idle = snap.cpuTicks.idle - this.prevCpu.idle;
        snap.cpu = total > 0 ? Math.round((1 - idle / total) * 100) : 0;
      } else {
        if(!Number.isFinite(snap.cpu))snap.cpu = null;
      }
      snap.workers = snap.workersReliable ? retainWorkers(this.snapshot?.workers || [], snap.workers, now) : (this.snapshot?.workers || snap.workers);
      delete snap.workersReliable;
      for (const w of snap.workers) {
        if (!w.task || !w.cwd || (w.finishedAt && ['DONE', 'FAILED'].includes(w.result))) continue;
        try {
          const log = await this.readWorkerLog(w);
          w.lines = log.text.split('\n').filter(Boolean).slice(-3);
          if (w.finishedAt) {
            if (log.result !== w.result) w.resultAt = now;
            w.result = log.result;
          }
        } catch { /* inaccessible logs never discard the worker */ }
      }
      this.prevCpu = snap.cpuTicks;
      delete snap.cpuTicks;
      for (const k of ['cpu', 'ram', 'disk']) {
        if (snap[k] === null || snap[k] === undefined) continue;
        this.history[k].push(snap[k]);
        if (this.history[k].length > HISTORY) this.history[k].shift();
      }
      const screens = new Map();
      for (const s of snap.sessions) {
        // A ticking clock or counter is not work: judge by how long the words on screen have really stayed the same.
        const seen = screenQuiet(this.screens.get(s.name + '/' + s.created), s.lines, s.activityAge, now);
        screens.set(s.name + '/' + s.created, seen.rec);
        s.state = classify({ cmd: s.cmd, lines: s.lines, activityAge: seen.quiet });
        s.asking = s.state === 'wait' && isAsking({ cmd: s.cmd, lines: s.lines });
      }
      this.screens = screens;
      for (const s of snap.sessions) {
        const previous = this.snapshot?.sessions.find((p) => p.name === s.name && p.created === s.created);
        s.stateSince = previous?.state === s.state ? previous.stateSince || now : now;
      }
      this.snapshot = snap;
      if (this.rebooting && snap.bootId && snap.bootId !== this.rebooting.bootId) this.rebooting = null;
      this.lastPoll = now;
      this.longHistory = this.longHistory.filter((p) => p.t >= now - 86400000);
      if (!this.longHistory.length || now - this.longHistory.at(-1).t >= 60000) {
        this.longHistory.push({ t: now, cpu: snap.cpu, ram: snap.ram, disk: snap.disk });
        this.longHistory = this.longHistory.slice(-1440);
      }
      this.onPoll(this, snap, sessionVersion);
    } catch {
      // A failed poll keeps the last snapshot; the close handler reports real connection loss.
    } finally {
      this.polling = false;
    }
  }

  async readWorkerLog(w) {
    const log = await this.exec(`sh -c ${shq(logScript(w))}`);
    if (log.code !== 0) throw new Error(tr('srv.backend.khong_doc_duoc_log_an'));
    const split = log.out.indexOf('\n');
    const result = log.out.slice(0, split);
    return { text: log.out.slice(split + 1), result: ['DONE', 'FAILED'].includes(result) ? result : 'unknown' };
  }

  publicView() {
    const c = this.cfg;
    const s = this.snapshot;
    return {
      id: c.id,
      name: (s && s.hostname) || c.name || c.host,
      host: c.host,
      port: c.port,
      user: c.user,
      auth: c.auth,
      fingerprint: c.fingerprint || '',
      on: this.ready,
      rebooting: !!this.rebooting,
      error: this.ready ? '' : this.error,
      needsPassword: !this.ready && c.auth === 'password' && !this.password,
      hasTmux: s ? s.hasTmux : true,
      cpu: s ? s.cpu : null,
      ram: s ? s.ram : null,
      disk: s ? s.disk : null,
      history: this.history,
      sys: s ? s.sys : null,
      lost: this.lost,
      offSince: this.offSince,
      sessions: this.ready && s ? s.sessions : [],
      houseSessions: s ? s.sessions : [],
      workers: s ? s.workers.filter((w) => !w.finishedAt || Date.now() - w.finishedAt < RETAIN_MS) : [],
    };
  }
}

module.exports = { Backend };
