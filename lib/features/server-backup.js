'use strict';
const { BackupController, codeOf } = require('../server-backup-controller');
const { error } = require('../server-backup-store');
module.exports = {
  name: 'server-backup',
  register(host) {
    const controller = new BackupController(host); host.provide('server-backup', controller);
    host.onSnapshot(() => controller.tick());
    const route = (method, pathname, fn) => host.route(method, pathname, async ctx => {
      try {
        // Defense in depth: the real server authenticates before dispatch. A locked vault
        // must also be harmless during feature registration and direct host lifecycle calls.
        if (pathname !== '/status' && !host.privateData.unlocked()) throw error('vault_locked');
        ctx.res.setHeader?.('Cache-Control', 'no-store');
        ctx.res.setHeader?.('X-Content-Type-Options', 'nosniff');
        ctx.res.setHeader?.('Referrer-Policy', 'no-referrer');
        await fn(ctx);
      } catch (e) {
        if (e.message === 'bad json') e = error('invalid');
        const code = codeOf(e), status = e.code === 'vault_locked' ? 401 : e.code === 'not_found' ? 404 :
          ['busy', 'offline', 'unconfigured', 'stopping'].includes(e.code) ? 409 : e.code === 'invalid' ? 400 : 500;
        const safe = ['busy', 'offline', 'unconfigured', 'stopping', 'invalid'].includes(e.code) ? e.code : code;
        if (!ctx.res.headersSent && !ctx.res.destroyed) host.send(ctx.res, status, { error: safe, code: safe });
        else ctx.res.destroy?.();
      }
    });
    const saved = url => {
      const serverId = url.searchParams.get('server'), snapshotId = url.searchParams.get('snapshot');
      const store = controller.openStore(); if (!store) throw error('not_found');
      return { store, serverId, snapshotId };
    };
    route('GET', '/status', ({ res }) => host.send(res, 200, controller.status()));
    route('POST', '/download-ticket', async ({ req, res }) => {
      const ticket = controller.createDownload(await host.readJson(req));
      res.once?.('close', () => { if (!res.writableFinished) controller.cancelDownload(ticket.downloadURL); });
      try { host.send(res, 201, ticket); } catch (e) { controller.cancelDownload(ticket.downloadURL); throw e; }
    });
    route('POST', '/download-cancel', async ({ req, res }) => {
      controller.cancelDownload((await host.readJson(req))?.downloadURL); host.send(res, 200, { cancelled: true });
    });
    route('POST', '/control', async ({ req, res }) => host.send(res, 200, controller.control(await host.readJson(req))));
    route('POST', '/run', async ({ req, res }) => { const b = await host.readJson(req); if (typeof b.serverId !== 'string') throw error('invalid'); host.send(res, 202, controller.run(b.serverId)); });
    route('GET', '/snapshots', ({ res, url }) => {
      const store = controller.openStore(); host.send(res, 200, { snapshots: store?.snapshots(url.searchParams.get('server')) || [] });
    });
    route('GET', '/files', ({ res, url }) => {
      const { store, serverId, snapshotId } = saved(url), search = (url.searchParams.get('search') || '').toLowerCase(), raw = url.searchParams.get('cursor') || '0';
      if (search.length > 200 || !/^\d{1,8}$/.test(raw)) throw error('invalid');
      const offset = Number(raw), manifest = store.manifest(serverId, snapshotId);
      const rows = manifest.entries.filter(f => f.path.toLowerCase().includes(search));
      const files = rows.slice(offset, offset + 500).map(({ chunks, ...f }) => f);
      host.send(res, 200, { files, nextCursor: offset + 500 < rows.length ? String(offset + 500) : null, total: rows.length });
    });
    route('GET', '/preview', ({ res, url }) => { const { store, serverId, snapshotId } = saved(url); host.send(res, 200, store.preview(serverId, snapshotId, url.searchParams.get('file'))); });
    route('GET', '/download', ({ res, url }) => { const { store, serverId, snapshotId } = saved(url); return store.stream(res, serverId, snapshotId, url.searchParams.get('file')); });
    route('GET', '/export', ({ res, url }) => { const { store, serverId, snapshotId } = saved(url); return store.export(res, serverId, snapshotId); });
  },
};
