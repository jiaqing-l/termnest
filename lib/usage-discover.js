'use strict';
const crypto = require('crypto');
const { runOnHost } = require('./file-viewer');

// The usage report needs the same accounts the token cards show: declared ones plus whatever sits in the default
// config folders of each host (~/.claude, ~/.claude-*, ~/.codex, CLAUDE_CONFIG_DIR, CODEX_HOME). Only the account
// e-mail is read from them, never a token.

// Self-contained so it runs on the host itself (see lib/file-viewer.js runOnHost).
function discoverRuntime() {
  const fs = require('fs'), os = require('os'), path = require('path');
  const stat = (p) => fs.promises.stat(p).catch(() => null);
  const json = async (p) => { try { return JSON.parse(await fs.promises.readFile(p, 'utf8')); } catch { return null; } };
  return async function discover({ home, env }) {
    home = home || os.homedir(); env = env || process.env;
    const resolve = (d) => path.resolve(d === '~' ? home : d.startsWith('~/') ? path.join(home, d.slice(2)) : d);
    const dirs = [];
    for (const tool of ['claude', 'codex']) { const d = path.join(home, '.' + tool); if (await stat(d)) dirs.push([tool, d]); }
    try {
      for (const e of await fs.promises.readdir(home, { withFileTypes: true })) {
        if (!e.isDirectory() || !e.name.startsWith('.claude-')) continue;
        const d = path.join(home, e.name);
        if ((await stat(path.join(d, '.claude.json'))) || (await stat(path.join(d, 'projects')))) dirs.push(['claude', d]);
      }
    } catch { /* unreadable home */ }
    if (env.CLAUDE_CONFIG_DIR) dirs.push(['claude', resolve(env.CLAUDE_CONFIG_DIR)]);
    if (env.CODEX_HOME) dirs.push(['codex', resolve(env.CODEX_HOME)]);
    const seen = new Set(), out = [];
    for (const [tool, directory] of dirs) {
      let key = directory; try { key = await fs.promises.realpath(directory); } catch { /* keep as is */ }
      if (seen.has(tool + ':' + key)) continue; seen.add(tool + ':' + key);
      let email = null;
      if (tool === 'claude') {
        const obj = (await json(path.join(directory, '.claude.json'))) || (directory === path.join(home, '.claude') ? await json(path.join(home, '.claude.json')) : null);
        email = obj && obj.oauthAccount && obj.oauthAccount.emailAddress || null;
      } else {
        const auth = await json(path.join(directory, 'auth.json')), token = auth && auth.tokens && auth.tokens.id_token;
        try { email = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')).email || null; } catch { /* no identity */ }
      }
      out.push({ tool, directory, email: typeof email === 'string' ? email.trim().toLowerCase().slice(0, 200) : null });
    }
    return out;
  };
}

const keyOf = (a) => `${a.hostId}|${a.tool}|${a.directory}`;
const idOf = (hostId, tool, directory) => `${hostId}_${tool}_${crypto.createHash('sha1').update(directory).digest('hex').slice(0, 10)}`;

// Declared accounts first (their nickname wins), then discovered folders not already declared.
function merge(declared, found) {
  const seen = new Set(declared.map(keyOf)), accounts = [...declared], emails = new Map();
  for (const f of found) {
    const cfg = { id: idOf(f.hostId, f.tool, f.directory), tool: f.tool, hostId: f.hostId, directory: f.directory, nickname: '', threshold: null };
    if (f.email) emails.set(cfg.id, f.email);
    if (seen.has(keyOf(cfg))) continue; seen.add(keyOf(cfg)); accounts.push(cfg);
  }
  return { accounts, emails };
}

const TTL_MS = 60000;
function createDiscovery(now = Date.now) {
  const cache = new Map();
  return async function discoverAll(backends) {
    const found = [];
    await Promise.all(backends.map(async (backend) => {
      const id = backend.cfg.id, hit = cache.get(id);
      let list = hit && now() - hit.at < TTL_MS ? hit.list : null;
      if (!list) {
        try { list = await runOnHost(backend, discoverRuntime, {}); } catch { list = (hit && hit.list) || []; }
        cache.set(id, { at: now(), list });
      }
      for (const a of list) found.push({ ...a, hostId: id });
    }));
    return found;
  };
}

module.exports = { discoverRuntime, merge, createDiscovery, idOf };
