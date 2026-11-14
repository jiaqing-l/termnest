'use strict';
// The server used to vanish with "Máy chủ Termnest đã dừng bất ngờ" and no trace. A dropped SSH link or a refused socket raises an
// 'error' event nobody listens to; that must not take every terminal down. Everything is written to crash.log so the next
// unexpected stop has a reason.
const fs = require('fs'), path = require('path');
const NETWORK = /^(ECONNRESET|EPIPE|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|ENOTFOUND|ECONNABORTED|ENETDOWN|EAI_AGAIN)$/;
const NETWORK_TEXT = /keepalive timeout|timed out while waiting for handshake|not connected|channel open failure|socket hang up|client network socket disconnected|read ECONNRESET/i;
const MAX_LOG = 512 * 1024;

function benign(err) {
  return !!err && (NETWORK.test(String(err.code || '')) || NETWORK_TEXT.test(String(err.message || err.level || '')));
}

function install(dir, proc = process, now = () => new Date()) {
  const file = path.join(dir, 'crash.log');
  const write = (kind, err, action) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      try { if (fs.statSync(file).size > MAX_LOG) fs.renameSync(file, file + '.old'); } catch { /* no log yet */ }
      const text = err && err.stack ? err.stack : String(err);
      fs.appendFileSync(file, `${now().toISOString()} ${kind} ${action} pid=${proc.pid} rss=${Math.round((proc.memoryUsage?.().rss || 0) / 1048576)}MB\n${text}\n\n`, { mode: 0o600 });
    } catch { /* the log is a courtesy */ }
  };
  proc.on('unhandledRejection', (err) => write('unhandledRejection', err, 'continued'));
  proc.on('uncaughtException', (err) => {
    if (benign(err)) { write('uncaughtException', err, 'continued (network)'); return; }
    write('uncaughtException', err, 'exiting');
    proc.exit(1);
  });
  return file;
}

module.exports = { install, benign };
