'use strict';
// Crew panes: one orchestrator session plus N worker sessions, shown together in one screen, with a status read from the
// live panes (never guessed from files). The crew registry lives in the vault; state is derived in the browser from the
// poll snapshot (screen text, output age). Prototype: the demo agents (demo/crew-demo-agent.js) stand in for Claude/Codex.
const fs = require('fs');
const path = require('path');
const { validName } = require('../parse');

const MAX_WORKERS = 4;
const DEMO = path.join(__dirname, '..', '..', 'demo', 'crew-demo-agent.js');

module.exports = {
  name: 'crewpanes',
  register(host) {
    const crews = () => (host.settings.get().crews || []);
    const save = (list) => host.settings.set({ ...host.settings.get(), crews: list });
    const find = (id) => crews().find((c) => c.id === id);
    const workerName = (crew, n) => `${crew}-codex-${n}`;
    const sh = (s) => host.shq(s);
    const sock = process.env.TW_TMUX_SOCKET || '';
    const agentCmd = (kind, c, n) => `node ${sh(DEMO)} ${kind} --crew ${sh(c.name)} --dir ${sh(c.dir)} ${kind === 'orch' ? `--workers ${c.workers.length}` : `--n ${n}`}${sock ? ` --sock ${sh(sock)}` : ''}`;
    // Type a line into a session as if the person had typed it.
    async function type(backend, session, text) {
      const t = `=${session}:`;
      await backend.exec(`tmux send-keys -t ${sh(t)} -l ${sh(text)} && tmux send-keys -t ${sh(t)} Enter`, 8000);
    }
    // The pane is the terminal: tmux's own status line only takes a row away.
    const quiet = (backend, session) => backend.exec(`tmux set-option -t ${sh(`=${session}:`)} status off`, 5000).catch(() => {});
    async function startWorker(backend, c, n) {
      const name = workerName(c.name, n);
      await host.sessions.start(backend, { name, dir: c.dir, run: c.agent === 'real' ? 'codex' : 'shell' });
      await quiet(backend, name);
      if (c.agent !== 'real') await type(backend, name, agentCmd('worker', c, n));
    }

    host.route('GET', '/list', async ({ res }) => { host.send(res, 200, { crews: crews() }); });

    host.route('POST', '/create', async ({ req, res }) => {
      const b = await host.readJson(req), backend = host.backendOf(String(b.server || ''));
      const name = String(b.name || ''), n = Math.max(1, Math.min(MAX_WORKERS, parseInt(b.workers, 10) || 2));
      if (!backend || !backend.ready) { host.fail(res, 400, 'Máy chủ chưa kết nối.'); return; }
      if (!validName(name) || !validName(workerName(name, 1))) { host.fail(res, 400, 'Tên Crew chỉ gồm chữ, số, - _ (tối đa 24 ký tự).'); return; }
      const id = `${backend.cfg.id}/${name}`;
      if (find(id)) { host.fail(res, 409, 'Đã có Crew tên này.'); return; }
      const taken = new Set(((backend.snapshot && backend.snapshot.sessions) || []).map((s) => s.name));
      const names = [name, ...Array.from({ length: n }, (_, i) => workerName(name, i + 1))];
      if (names.some((x) => taken.has(x))) { host.fail(res, 409, 'Tên phiên đã tồn tại (Crew hoặc thợ trùng tên).'); return; }
      const c = { id, server: backend.cfg.id, name, dir: String(b.dir || process.env.TW_DEFAULT_DIR || require('os').homedir()), agent: b.agent === 'real' ? 'real' : 'demo',
        workers: Array.from({ length: n }, (_, i) => workerName(name, i + 1)), createdAt: Date.now() };
      try {
        await host.sessions.start(backend, { name, dir: c.dir, run: c.agent === 'real' ? 'claude' : 'shell' });
        await quiet(backend, name);
        if (c.agent !== 'real') await type(backend, name, agentCmd('orch', c));
        for (let i = 1; i <= n; i++) await startWorker(backend, c, i);
      } catch (e) {
        for (const x of names) { try { await host.sessions.stop(backend, x); } catch { /* best effort */ } }
        host.fail(res, 400, e.message); return;
      }
      save([...crews(), c]); host.log(`crew ${id} created with ${n} workers`);
      host.send(res, 200, { crew: c });
    });

    host.route('POST', '/add-worker', async ({ req, res }) => {
      const b = await host.readJson(req), c = find(String(b.id || '')), backend = c && host.backendOf(c.server);
      if (!c || !backend) { host.fail(res, 404, 'Không thấy Crew.'); return; }
      if (c.workers.length >= MAX_WORKERS) { host.fail(res, 400, `Tối đa ${MAX_WORKERS} thợ.`); return; }
      const n = c.workers.length + 1;
      try { await startWorker(backend, c, n); if (c.agent !== 'real') await type(backend, c.name, '__workers__ +1'); }
      catch (e) { host.fail(res, 400, e.message); return; }
      c.workers = [...c.workers, workerName(c.name, n)]; save(crews().map((x) => (x.id === c.id ? c : x)));
      host.send(res, 200, { crew: c });
    });

    host.route('POST', '/stop', async ({ req, res }) => {
      const b = await host.readJson(req), c = find(String(b.id || '')), backend = c && host.backendOf(c.server);
      if (!c) { host.fail(res, 404, 'Không thấy Crew.'); return; }
      if (backend) for (const x of [c.name, ...c.workers]) { try { await host.sessions.stop(backend, x); } catch { /* already gone */ } }
      save(crews().filter((x) => x.id !== c.id)); host.log(`crew ${c.id} stopped`);
      host.send(res, 200, { ok: true });
    });

    // Type into a member session (nudge the orchestrator, or step in on a worker). Only members of a registered crew.
    host.route('POST', '/send', async ({ req, res }) => {
      const b = await host.readJson(req), c = find(String(b.id || '')), backend = c && host.backendOf(c.server);
      const session = String(b.session || ''), text = String(b.text || '').slice(0, 2000);
      if (!c || !backend || ![c.name, ...c.workers].includes(session) || !text || /[\r\n\0]/.test(text)) { host.fail(res, 400, 'Yêu cầu không hợp lệ.'); return; }
      try { await type(backend, session, text); } catch (e) { host.fail(res, 400, e.message); return; }
      host.send(res, 200, { ok: true });
    });

    // Plan / tracks written by the (demo) orchestrator. Local machine only in this prototype.
    host.route('GET', '/tracks', async ({ res, url }) => {
      const c = find(String(url.searchParams.get('id') || ''));
      if (!c) { host.fail(res, 404, 'Không thấy Crew.'); return; }
      try { host.send(res, 200, JSON.parse(fs.readFileSync(path.join(c.dir, '.crew-demo', c.name, 'tracks.json'), 'utf8'))); }
      catch { host.send(res, 200, { tracks: [], phase: 'idle', task: '' }); }
    });
  },
};
