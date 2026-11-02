'use strict';
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// Serialize startup before binding the HTTP port. Only the owner opens windows;
// secondary browser processes can otherwise exit immediately after profile handoff.
async function instance(dir, port, onOpen, noOpen = false) {
  const id = crypto.createHash('sha256').update(`${os.homedir()}\0${dir}\0${port}`).digest('hex').slice(0, 24);
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\tmux-dev-${id}` : path.join(os.tmpdir(), `tmux-dev-${id}.sock`);
  const server = net.createServer(socket => {
    socket.setTimeout(2000, () => socket.destroy());
    socket.once('data', data => { if (data.toString() === 'open') onOpen(); socket.end('ok'); });
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    const error = await new Promise(resolve => {
      server.once('error', resolve);
      server.listen(address, () => { server.removeListener('error', resolve); resolve(null); });
    });
    if (!error) {
      if (process.platform !== 'win32') fs.chmodSync(address, 0o600);
      return server;
    }
    if (error.code !== 'EADDRINUSE') throw error;
    const connected = await new Promise(resolve => {
      const socket = net.connect(address);
      socket.setTimeout(2000, () => { socket.destroy(); resolve(true); });
      socket.once('connect', () => socket.write(noOpen ? 'status' : 'open'));
      socket.once('data', () => { socket.end(); resolve(true); });
      socket.once('error', err => resolve(!['ECONNREFUSED', 'ENOENT'].includes(err.code)));
    });
    if (connected) return null;
    if (process.platform !== 'win32') { try { fs.unlinkSync(address); } catch (err) { if (err.code !== 'ENOENT') throw err; } }
  }
  throw new Error('Could not acquire app instance');
}
module.exports = { instance };
