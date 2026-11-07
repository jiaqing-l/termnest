'use strict';
const crypto = require('crypto');
const { tr } = require('../i18n-server');
const { shq } = require('../parse');
const F = require('../forge');

// "Kết nối": GitLab / GitHub links with a personal access token (read-only use), kept encrypted in the vault like SSH keys.
// The token never leaves this server except to its own forge address, and is never sent back to the page.
const TTL_MS = 2 * 60 * 1000;

module.exports = {
  name: 'forge',
  register(host) {
    const cache = new Map();   // url → { at, json }
    const settings = () => { try { return host.settings.get(); } catch { return {}; } };
    const links = () => (Array.isArray(settings().links) ? settings().links : []);
    const pub = (l) => ({ id: l.id, kind: l.kind, url: l.url, user: l.user || '', tail: String(l.token || '').slice(-4), added: l.added || 0 });

    async function get(link, url) {
      const hit = cache.get(url); if (hit && Date.now() - hit.at < TTL_MS) return hit.json;
      let res;
      try { res = await fetch(url, { headers: F.headers(link), signal: AbortSignal.timeout(10000), redirect: 'error' }); }
      catch (e) {
        const host = (() => { try { return new URL(url).hostname; } catch { return url; } })(), code = (e && e.cause && e.cause.code) || (e && e.name) || '';
        throw new Error(/Timeout|Abort/i.test(code) || /timeout|aborted/i.test(String(e && e.message)) ? tr('srv.forge.qua_lau', [host]) : /ENOTFOUND|EAI_AGAIN/.test(code) ? tr('srv.forge.khong_tim_thay_may', [host]) : tr('srv.forge.khong_ket_noi_duoc_may', [host, code || String(e && e.message || '')]));
      }
      if (res.status === 401 || res.status === 403) throw new Error(tr('srv.forge.token_khong_hop_le'));
      if (res.status === 404) { cache.set(url, { at: Date.now(), json: null }); return null; }
      if (!res.ok) throw new Error(tr('srv.forge.loi_may_chu', [res.status]));
      const json = await res.json(); cache.set(url, { at: Date.now(), json }); return json;
    }
    // MR / PR and pipeline of one branch of a repo whose remote is `remote`.
    async function branchInfo(remote, branch) {
      const m = F.linkFor(links(), remote); if (!m) return { linked: false };
      const q = F.requests(m.link, m.path, branch); if (!q) return { linked: true, error: tr('srv.forge.nhanh_khong_hop_le') };
      try {
        const [mr, ci] = await Promise.all([get(m.link, q.mr), get(m.link, q.ci).catch(() => null)]);
        return { linked: true, kind: m.link.kind, repo: m.path, web: q.web, branch, ...F.summarize(m.link.kind, mr, ci) };
      } catch (e) { return { linked: true, kind: m.link.kind, repo: m.path, branch, error: e.message }; }
    }

    host.route('GET', '/links', ({ res }) => host.send(res, 200, { links: links().map(pub) }));
    host.route('POST', '/links', async ({ req, res }) => {
      const b = await host.readJson(req), kind = b.kind === 'github' ? 'github' : 'gitlab', url = F.cleanUrl(kind, b.url), token = String(b.token || '').trim();
      if (!url) { host.fail(res, 400, tr('srv.forge.dia_chi_khong_hop_le')); return; }
      if (!/^[\w.-]{8,255}$/.test(token)) { host.fail(res, 400, tr('srv.forge.token_khong_hop_le')); return; }
      const link = { id: crypto.randomUUID(), kind, url, token, added: Date.now() };
      // Check the token against the forge before keeping it; keep the user name it answers with.
      try { const me = await get(link, F.userUrl(link)); link.user = String((me && (me.username || me.login)) || ''); }
      catch (e) { host.fail(res, 400, e.message || tr('srv.forge.khong_ket_noi_duoc')); return; }
      const rest = links().filter((l) => !(l.url === url && l.kind === kind));
      host.settings.set({ ...settings(), links: rest.concat([link]).slice(-10) });
      host.send(res, 200, { link: pub(link) });
    });
    host.route('POST', '/links/remove', async ({ req, res }) => {
      const b = await host.readJson(req); host.settings.set({ ...settings(), links: links().filter((l) => l.id !== b.id) }); cache.clear();
      host.send(res, 200, { ok: true });
    });
    host.route('POST', '/links/test', async ({ req, res }) => {
      const b = await host.readJson(req), l = links().find((x) => x.id === b.id);
      if (!l) { host.fail(res, 404, tr('srv.server.khong_tim_thay')); return; }
      cache.delete(F.userUrl(l));
      try { const me = await get(l, F.userUrl(l)); host.send(res, 200, { ok: true, user: (me && (me.username || me.login)) || '' }); }
      catch (e) { host.fail(res, 400, e.message); }
    });
    // A session's repo and branch (read on its host with git), then its MR / PR and pipeline.
    const seen = new Map();   // server|session → { at, body }: the session's git query is not repeated on every redraw
    host.route('GET', '/session', async ({ url, res }) => {
      const r = host.backendOf(url.searchParams.get('server') || ''), name = url.searchParams.get('session') || '';
      const ck = (url.searchParams.get('server') || '') + '|' + name, hit = seen.get(ck);
      if (hit && Date.now() - hit.at < 60000) { host.send(res, 200, hit.body); return; }
      const sendKeep = (body) => { seen.set(ck, { at: Date.now(), body }); if (seen.size > 200) seen.delete(seen.keys().next().value); host.send(res, 200, body); };
      const s = r && ((r.snapshot && r.snapshot.sessions) || []).find((x) => x.name === name);
      if (!r || !s || r.mode === 'powershell') { sendKeep({ repo: false }); return; }
      const cwd = s.aiCwd || s.path || '';
      const out = await r.exec(`cd ${shq(cwd)} 2>/dev/null && git rev-parse --abbrev-ref HEAD 2>/dev/null && git remote get-url origin 2>/dev/null`).catch(() => ({ code: 1, out: '' }));
      const [branch, remote] = String(out.out || '').trim().split('\n');
      if (!branch || !remote || branch === 'HEAD') { sendKeep({ repo: false }); return; }
      sendKeep({ repo: true, branch, ...(await branchInfo(remote, branch)) });
    });
    // Several (remote, branch) pairs at once, for the crew pack's tracks.
    host.route('POST', '/branches', async ({ req, res }) => {
      const b = await host.readJson(req), items = (Array.isArray(b.items) ? b.items : []).slice(0, 40);
      const out = await Promise.all(items.map((x) => (typeof x.remote === 'string' && F.BRANCH.test(x.branch || '') ? branchInfo(x.remote, x.branch) : Promise.resolve({ linked: false }))));
      host.send(res, 200, { items: out, any: links().length > 0 });
    });
  },
};
