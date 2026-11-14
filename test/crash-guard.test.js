'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), os = require('os'), path = require('path'), { EventEmitter } = require('events');
const { install, benign } = require('../lib/crash-guard');

function fakeProcess() {
  const p = new EventEmitter(); p.pid = 42; p.exited = null; p.exit = (c) => { p.exited = c; }; p.memoryUsage = () => ({ rss: 300 * 1048576 });
  return p;
}

test('network errors and rejections are logged and the server keeps running; other exceptions are logged, then it exits', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-crash-')), proc = fakeProcess();
  const file = install(dir, proc, () => new Date('2026-11-12T01:00:00Z'));
  proc.emit('uncaughtException', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
  proc.emit('unhandledRejection', new Error('late'));
  assert.equal(proc.exited, null);
  proc.emit('uncaughtException', new TypeError('boom'));
  assert.equal(proc.exited, 1);
  const log = fs.readFileSync(file, 'utf8');
  assert.match(log, /uncaughtException continued \(network\) pid=42 rss=300MB/);
  assert.match(log, /unhandledRejection continued/);
  assert.match(log, /uncaughtException exiting[\s\S]*TypeError: boom/);
});

test('benign recognises dropped links and handshake timeouts only', () => {
  assert.ok(benign({ code: 'EPIPE' })); assert.ok(benign(new Error('Keepalive timeout'))); assert.ok(benign(new Error('Timed out while waiting for handshake')));
  assert.ok(!benign(new Error('Cannot read properties of undefined'))); assert.ok(!benign(null));
});
