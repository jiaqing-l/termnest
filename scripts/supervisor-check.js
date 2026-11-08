#!/usr/bin/env node
'use strict';
const http = require('node:http');
let port = process.env.TW_PORT || '7681';
const args = process.argv.slice(2);
if (args.length) {
  if (args.length !== 2 || args[0] !== '--port') { console.error('RUNTIME_ARGUMENT_INVALID'); process.exit(2); }
  port = args[1];
}
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) { console.error('RUNTIME_PORT_INVALID'); process.exit(2); }
let finished = false;
function report(unlocked, monitoring, error) {
  if (finished) return;
  finished = true;
  console.log(JSON.stringify({ state: error ? 'error' : monitoring ? 'monitoring' : unlocked ? 'unlocked' : 'locked', unlocked, monitoring, error }));
  process.exitCode = !error && monitoring ? 0 : 1;
}
const req = http.get({ host: '127.0.0.1', port: Number(port), path: '/api/supervisor/status', timeout: 3000, agent: false }, res => {
  let text = '';
  res.setEncoding('utf8');
  res.on('data', chunk => { text += chunk; if (text.length > 1024) { report(false, false, true); res.destroy(); } });
  res.on('end', () => {
    try {
      const v = JSON.parse(text);
      if (res.statusCode !== 200 || !['unlocked', 'monitoring', 'error'].every(k => typeof v[k] === 'boolean')) throw Error();
      report(v.unlocked, v.monitoring, v.error);
    } catch { report(false, false, true); }
  });
  res.on('error', () => report(false, false, true));
});
req.on('timeout', () => { report(false, false, true); req.destroy(); });
req.on('error', () => report(false, false, true));
