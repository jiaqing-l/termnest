'use strict';
const { tr } = require('./i18n-server');
const fs = require('fs');
const path = require('path');

// Feature host: every lib/features/<name>.js exports { name, register(host) } and public/features/<name>.js|css is its
// browser half. Features own their files and routes, so independent features never edit the same shared file.
const NAME = /^[a-z][a-z0-9-]{1,31}$/;
const FILE = /^([a-z][a-z0-9-]{1,31})\.(js|css)$/;

// Raw request body up to `max` bytes (the shared readJson stops at 256 KiB, too small for a dropped image).
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (d) => { size += d.length; if (size > max) { reject(new Error('too large')); req.destroy(); return; } chunks.push(d); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function createFeatures({ libDir, publicDir, deps, log = console }) {
  const routes = [], snapshotHandlers = [], loaded = [];

  function hostFor(name) {
    return {
      name,
      // Paths are relative to /api/features/<name>. A string matches exactly; a RegExp matches the sub-path.
      route(method, pattern, handler) {
        if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method) || typeof handler !== 'function') throw new Error('Invalid route');
        if (typeof pattern === 'string' && !pattern.startsWith('/')) throw new Error('Invalid route path');
        routes.push({ name, method, pattern, handler });
      },
      onSnapshot(fn) { snapshotHandlers.push({ name, fn }); },
      remotes: () => [...deps.remotes().values()],
      backendOf: (id) => deps.backendOf(id),
      send: deps.send, fail: deps.fail, readJson: deps.readJson, shq: deps.shq, readBody,
      // Start or stop a tmux session the same way the app does (records, restore list, pets follow).
      sessions: { start: (r, o) => deps.startSession(r, o), stop: (r, name) => deps.stopSession(r, name) },
      settings: {
        get: () => ({ ...(deps.vault().data.features?.[name] || {}) }),
        set: (value) => { const v = deps.vault(); v.data.features = { ...(v.data.features || {}), [name]: value }; deps.save(); },
      },
      log: (message) => log.log(`[feature:${name}] ${message}`),
    };
  }

  function load() {
    if (!fs.existsSync(libDir)) return loaded;
    for (const file of fs.readdirSync(libDir).filter((f) => FILE.test(f) && f.endsWith('.js')).sort()) {
      try {
        const mod = require(path.join(libDir, file));
        if (!NAME.test(mod.name || '') || typeof mod.register !== 'function' || `${mod.name}.js` !== file) throw new Error('bad feature module');
        mod.register(hostFor(mod.name));
        loaded.push(mod.name);
      } catch (e) {
        log.error(`feature ${file} not loaded: ${e.message}`);
      }
    }
    return loaded;
  }

  // Browser halves: whatever sits in public/features, listed once per page load.
  function clientModules() {
    if (!fs.existsSync(publicDir)) return [];
    const byName = new Map();
    for (const file of fs.readdirSync(publicDir)) {
      const m = FILE.exec(file);
      if (!m) continue;
      const item = byName.get(m[1]) || { name: m[1], js: false, css: false };
      item[m[2]] = true; byName.set(m[1], item);
    }
    return [...byName.values()].filter((x) => x.js).sort((a, b) => a.name.localeCompare(b.name));
  }

  function staticFile(pathname) {
    const m = /^\/features\/([a-z][a-z0-9-]{1,31})\.(js|css)$/.exec(pathname);
    if (!m) return null;
    const file = path.join(publicDir, `${m[1]}.${m[2]}`);
    return fs.existsSync(file) ? [file, m[2] === 'js' ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8'] : null;
  }

  const handles = (pathname) => pathname === '/api/features' || pathname.startsWith('/api/features/');

  async function handle(req, res, url) {
    if (url.pathname === '/api/features') {
      if (req.method !== 'GET') { deps.fail(res, 405, tr('srv.features.khong_ho_tro')); return; }
      deps.send(res, 200, { modules: clientModules() }); return;
    }
    const m = /^\/api\/features\/([a-z][a-z0-9-]{1,31})(\/.*)?$/.exec(url.pathname);
    const sub = m?.[2] || '/';
    for (const r of routes) {
      if (!m || r.name !== m[1] || r.method !== req.method) continue;
      const match = typeof r.pattern === 'string' ? (r.pattern === sub ? [sub] : null) : r.pattern.exec(sub);
      if (!match) continue;
      try { await r.handler({ req, res, url, match, sub }); }
      catch (e) {
        log.error(`feature ${r.name} route failed: ${e.message}`);
        if (!res.headersSent) deps.fail(res, e.message === 'bad json' ? 400 : 500, e.message === 'bad json' ? tr('srv.server.du_lieu_khong_hop_le') : tr('srv.features.tinh_nang_gap_loi'));
      }
      return;
    }
    deps.fail(res, 404, tr('srv.server.khong_tim_thay'));
  }

  function emitSnapshot(remote, snapshot) {
    for (const h of snapshotHandlers) {
      try { h.fn(remote, snapshot); } catch (e) { log.error(`feature ${h.name} snapshot failed: ${e.message}`); }
    }
  }

  return { load, clientModules, staticFile, handles, handle, emitSnapshot, names: () => loaded.slice() };
}

module.exports = { createFeatures, NAME };
