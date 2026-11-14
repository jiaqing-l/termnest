'use strict';
// Crew panes: one orchestrator session plus N worker sessions, shown together in one screen, with a status read from the
// live panes (never guessed from files). The crew registry lives in the vault; state is derived in the browser from the
// poll snapshot (screen text, output age). Prototype: the demo agents (demo/crew-demo-agent.js) stand in for Claude/Codex.
const fs = require('fs');
const path = require('path');
const { validName } = require('../parse');

const SYNC_MS = () => Number(process.env.TW_CREW_SYNC_MS) || 1500;
const MAX_WORKERS = 8; // more than fit as panes: the page shows the busiest and folds the rest into chips
const KINDS = ['codex', 'claude'];
const DEMO = path.join(__dirname, '..', '..', 'demo', 'crew-demo-agent.js');

module.exports = {
  name: 'crewpanes',
  register(host) {
    const crews = () => (host.settings.get().crews || []);
    const save = (list) => host.settings.set({ ...host.settings.get(), crews: list });
    const find = (id) => crews().find((c) => c.id === id);
    // Workers are created by the orchestrator, one per track: UIUX-W1, UIUX-W2 …; kinds[name] says Codex or Claude.
    const workerName = (crew, n) => `${crew}-W${n}`;
    const sh = (s) => host.shq(s);
    const sock = process.env.TW_TMUX_SOCKET || '';
    const agentCmd = (role, c, name, kind) => `node ${sh(DEMO)} ${role} --crew ${sh(c.name)} --dir ${sh(c.dir)}${role === 'worker' ? ` --name ${sh(name)} --kind ${kind}` : ''}${sock ? ` --sock ${sh(sock)}` : ''}`;
    // Type a line into a session as if the person had typed it.
    async function type(backend, session, text) {
      const t = `=${session}:`;
      await backend.exec(`tmux send-keys -t ${sh(t)} -l -- ${sh(text)} && tmux send-keys -t ${sh(t)} Enter`, 8000);
    }
    // The pane is the terminal: tmux's own status line only takes a row away.
    const quiet = (backend, session) => backend.exec(`tmux set-option -t ${sh(`=${session}:`)} status off`, 5000).catch(() => {});
    async function startWorker(backend, c, name, kind) {
      await host.sessions.start(backend, { name, dir: c.dir, run: c.agent === 'real' ? kind : 'shell' });
      await quiet(backend, name);
      if (c.agent !== 'real') await type(backend, name, agentCmd('worker', c, name, kind));
    }
    // The one way a worker comes to exist: the orchestrator asks for it (HTTP /spawn, or its plan file in the demo).
    const spawning = new Set();
    async function spawnWorker(c, kind, wanted) {
      const backend = host.backendOf(c.server);
      if (!backend || !backend.ready) throw new Error('Máy chủ chưa kết nối.');
      if (!KINDS.includes(kind)) throw new Error('Loại thợ phải là codex hoặc claude.');
      if (c.workers.length >= MAX_WORKERS) throw new Error(`Tối đa ${MAX_WORKERS} thợ.`);
      const name = wanted || workerName(c.name, c.workers.length + 1);
      if (c.workers.includes(name) || spawning.has(`${c.id}/${name}`)) return c;
      if (!validName(name)) throw new Error('Tên thợ không hợp lệ.');
      spawning.add(`${c.id}/${name}`);
      try {
        await startWorker(backend, c, name, kind);
        const cur = find(c.id) || c;
        cur.workers = [...cur.workers, name]; cur.kinds = { ...(cur.kinds || {}), [name]: kind };
        save(crews().map((x) => (x.id === cur.id ? cur : x))); host.log(`crew ${cur.id}: orchestrator spawned ${name} (${kind})`);
        return cur;
      } finally { spawning.delete(`${c.id}/${name}`); }
    }
    // Demo orchestrator writes its plan to tracks.json with the kind each track needs; make sure those workers exist.
    function planOf(c) { try { return JSON.parse(fs.readFileSync(path.join(c.dir, '.crew-demo', c.name, 'tracks.json'), 'utf8')); } catch { return { tracks: [] }; } }
    const syncTimer = setInterval(() => {
      if (!process.env.TW_CREW_DEMO) return;
      for (const c of crews()) {
        if (c.agent === 'real') continue;
        const plan = planOf(c);
        if (plan.phase !== 'running') continue; // workers are created only after the person approved the plan
        for (const t of plan.tracks || []) {
          if (!t.agent || !/^W\d$/.test(t.id)) continue;
          const name = `${c.name}-${t.id}`;
          if (!c.workers.includes(name)) spawnWorker(c, t.agent, name).catch((e) => host.log(`spawn ${name}: ${e.message}`));
        }
      }
    }, SYNC_MS());
    if (syncTimer.unref) syncTimer.unref();

    // demo: only the prototype's own test button (fake agents) is shown when the server runs with TW_CREW_DEMO=1.
    host.route('GET', '/list', async ({ res }) => { host.send(res, 200, { crews: crews(), demo: !!process.env.TW_CREW_DEMO }); });

    // Registered (hand-made) crews exist only for the prototype's fake agents. A real Crew is derived from _crew/tasks and the
    // leader session (see public/features/crewpanes.js, deriveCrews): its workers are tracks, so nothing here creates sessions for them.
    const demoOnly = (res) => { if (process.env.TW_CREW_DEMO) return false; host.fail(res, 404, 'Chỉ dùng cho bản thử (TW_CREW_DEMO=1).'); return true; };
    host.route('POST', '/create', async ({ req, res }) => {
      if (demoOnly(res)) return;
      const b = await host.readJson(req), backend = host.backendOf(String(b.server || ''));
      const name = String(b.name || '');
      if (!backend || !backend.ready) { host.fail(res, 400, 'Máy chủ chưa kết nối.'); return; }
      if (!validName(name) || !validName(workerName(name, 4))) { host.fail(res, 400, 'Tên Crew chỉ gồm chữ, số, - _ (tối đa 24 ký tự).'); return; }
      const id = `${backend.cfg.id}/${name}`;
      if (find(id)) { host.fail(res, 409, 'Đã có Crew tên này.'); return; }
      const taken = new Set(((backend.snapshot && backend.snapshot.sessions) || []).map((s) => s.name));
      const names = [name, ...Array.from({ length: MAX_WORKERS }, (_, i) => workerName(name, i + 1))];
      if (names.some((x) => taken.has(x))) { host.fail(res, 409, 'Tên phiên đã tồn tại (Crew hoặc thợ trùng tên).'); return; }
      const c = { id, server: backend.cfg.id, name, dir: String(b.dir || process.env.TW_DEFAULT_DIR || require('os').homedir()), agent: b.agent === 'real' ? 'real' : 'demo',
        workers: [], kinds: {}, createdAt: Date.now() };
      try {
        await host.sessions.start(backend, { name, dir: c.dir, run: c.agent === 'real' ? 'claude' : 'shell' });
        await quiet(backend, name);
        if (c.agent !== 'real') await type(backend, name, agentCmd('orch', c));
      } catch (e) {
        for (const x of names) { try { await host.sessions.stop(backend, x); } catch { /* best effort */ } }
        host.fail(res, 400, e.message); return;
      }
      save([...crews(), c]); host.log(`crew ${id} created (workers come from the orchestrator)`);
      host.send(res, 200, { crew: c });
    });

    // Called by the orchestrator (not by a person): { id, kind: 'codex' | 'claude' }.
    // Called by the orchestrator (not by a person): { server, session, kind: 'codex' | 'claude' }. Any ordinary Claude session
    // becomes a Crew the first time it spawns a worker; there is no separate "new crew" step.
    host.route('POST', '/spawn', async ({ req, res }) => {
      if (demoOnly(res)) return;
      const b = await host.readJson(req);
      let c = find(String(b.id || (b.server && b.session ? `${b.server}/${b.session}` : '')));
      if (!c && b.server && b.session) {
        const backend = host.backendOf(String(b.server)), sess = backend && ((backend.snapshot && backend.snapshot.sessions) || []).find((x) => x.name === String(b.session));
        if (!backend || !sess) { host.fail(res, 404, 'Không thấy phiên điều phối.'); return; }
        c = { id: `${backend.cfg.id}/${sess.name}`, server: backend.cfg.id, name: sess.name, dir: sess.path || require('os').homedir(), agent: 'real', workers: [], kinds: {}, createdAt: Date.now() };
        save([...crews(), c]); host.log(`crew ${c.id} formed: ${sess.name} spawned its first worker`);
      }
      if (!c) { host.fail(res, 404, 'Không thấy Crew.'); return; }
      try { host.send(res, 200, { crew: await spawnWorker(c, String(b.kind || ''), b.name ? String(b.name) : undefined) }); }
      catch (e) { host.fail(res, 400, e.message); }
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
