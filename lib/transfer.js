'use strict';
// "Chuyển máy": one encrypted .termnest file carries everything to a new computer — the TERMNEST data (servers, settings,
// notes, AI accounts) and the chats of the sessions that ran on the old computer itself. On the new computer each chat is
// placed in the same repository (found by its git origin, wherever it lives there), its old paths are rewritten, and the
// session appears in "Khôi phục phiên". Chats whose repository is not on the new computer wait until it is cloned.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runOnHost } = require('./file-viewer');
const move = require('./features/move');

const KIND = 'termnest-move';
const MAX_TOTAL = 200 * 1024 * 1024;
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;

// Sessions of this computer that hold a known conversation: the ones running now and the ones remembered for a restore.
function localChats(local, known) {
  const out = new Map();
  for (const s of local?.snapshot?.sessions || []) if (s.aiTool && UUID.test(s.aiSessionId || '')) out.set(s.name, { name: s.name, tool: s.aiTool, id: s.aiSessionId, dir: s.aiCwd || s.path });
  for (const [name, v] of Object.entries(known?.sessions || {})) if (!out.has(name) && (v.run === 'claude' || v.run === 'codex') && UUID.test(v.resume || '')) out.set(name, { name, tool: v.run, id: v.resume, dir: v.dir });
  return [...out.values()];
}

// Reads each chat on this computer (bounded in total). Returns { chats, bytes, skipped }.
async function collect(local, known, sizesOnly) {
  const chats = [], skipped = []; let bytes = 0;
  for (const c of localChats(local, known)) {
    try {
      const head = await runOnHost(local, move.sourceRuntime, { tool: c.tool, id: c.id, dir: c.dir, max: 0 });
      if (head.code) { skipped.push({ name: c.name, why: head.code }); continue; }
      if (bytes + head.size > MAX_TOTAL) { skipped.push({ name: c.name, why: 'toolarge' }); continue; }
      bytes += head.size;
      if (sizesOnly) { chats.push({ ...c, size: head.size, origin: head.origin }); continue; }
      const got = await runOnHost(local, move.sourceRuntime, { tool: c.tool, id: c.id, dir: c.dir, max: MAX_TOTAL }, { timeout: 120000, maxBuffer: MAX_TOTAL * 2 });
      if (got.code) { skipped.push({ name: c.name, why: got.code }); bytes -= head.size; continue; }
      chats.push({ ...c, rel: got.rel, root: got.root, origin: got.origin, sub: got.sub, b64: got.b64 });
    } catch { skipped.push({ name: c.name, why: 'failed' }); }
  }
  return { chats, bytes, skipped };
}

// "Kèm chat server": the chats of the sessions on the servers too, as a spare copy in case a server is lost or reinstalled.
// Sessions running now and the ones remembered for a restore; read on each server over its SSH link, within the same budget.
async function collectServers(remotes, knownAll, sizesOnly, used = 0) {
  const chats = [], skipped = []; let bytes = 0;
  for (const r of remotes) {
    if (r.cfg.local || !r.ready || r.mode === 'powershell') continue;
    for (const c of localChats(r, knownAll?.[r.cfg.id])) {
      try {
        const head = await runOnHost(r, move.sourceRuntime, { tool: c.tool, id: c.id, dir: c.dir, max: 0 });
        if (head.code) { skipped.push({ name: c.name, server: r.cfg.id, why: head.code }); continue; }
        if (used + bytes + head.size > MAX_TOTAL) { skipped.push({ name: c.name, server: r.cfg.id, why: 'toolarge' }); continue; }
        bytes += head.size;
        const base = { ...c, server: r.cfg.id, serverName: r.publicView ? r.publicView().name : r.cfg.id, size: head.size };
        if (sizesOnly) { chats.push(base); continue; }
        const got = await runOnHost(r, move.sourceRuntime, { tool: c.tool, id: c.id, dir: c.dir, max: MAX_TOTAL }, { timeout: 120000, maxBuffer: MAX_TOTAL * 2 });
        if (got.code) { skipped.push({ name: c.name, server: r.cfg.id, why: got.code }); bytes -= head.size; continue; }
        chats.push({ ...base, rel: got.rel, root: got.root, origin: got.origin, sub: got.sub, b64: got.b64 });
      } catch { skipped.push({ name: c.name, server: r.cfg.id, why: 'failed' }); }
    }
  }
  return { chats, bytes, skipped };
}

// A spare server chat goes back only where it is missing: the server still having it (the usual case) leaves it untouched.
async function restoreOnServer(r, c, shq) {
  const head = await runOnHost(r, move.sourceRuntime, { tool: c.tool, id: c.id, dir: c.dir, max: 0 });
  if (!head.code) return 'present';
  const where = await runOnHost(r, move.placeRuntime, { dir: c.dir, origin: c.origin, sub: c.sub, seeds: (r.snapshot?.sessions || []).map((s) => s.path).filter(Boolean) }, { timeout: 30000 });
  const dir = (where.places || [])[0]?.path;
  if (!dir) return 'waiting';
  const inRepo = c.root && (!c.sub || dir.endsWith('/' + c.sub));
  const fromRoot = inRepo ? c.root : c.dir, toRoot = inRepo && c.sub ? dir.slice(0, -(c.sub.length + 1)) : dir;
  const text = move.rewritePaths(Buffer.from(c.b64, 'base64').toString('utf8'), fromRoot, toRoot).text;
  const out = await r.exec(`sh -c ${shq(move.writeScript(c.tool, c.id, c.rel, dir, shq))}`, 120000, 64 * 1024, Buffer.from(text, 'utf8'));
  return out.code === 0 ? 'written' : 'waiting';
}

// Desktop first (easy to find), then Downloads, then the home folder.
function exportDir(home = os.homedir()) {
  for (const d of [path.join(home, 'Desktop'), path.join(home, 'Downloads'), home]) { try { if (fs.statSync(d).isDirectory()) return d; } catch { /* next */ } }
  return home;
}
function exportName(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `TERMNEST-chuyen-may-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.termnest`;
}

// Places waiting chats on this computer. Each one: find its folder (same repository), rewrite old paths, write the file,
// remember the session for "Khôi phục phiên". Returns the chats still waiting (their repository is not here yet).
async function place(local, chats, known, shq) {
  const waiting = [], placed = [];
  const seeds = [...new Set([...(local?.snapshot?.sessions || []).map((s) => s.path), ...Object.values(known?.sessions || {}).map((v) => v.dir)].filter(Boolean))];
  for (const c of chats) {
    try {
      const where = await runOnHost(local, move.placeRuntime, { dir: c.dir, origin: c.origin, sub: c.sub, seeds }, { timeout: 30000 });
      const dir = (where.places || [])[0]?.path;
      if (!dir) { waiting.push(c); continue; }
      const inRepo = c.root && (!c.sub || dir.endsWith('/' + c.sub));
      const fromRoot = inRepo ? c.root : c.dir, toRoot = inRepo && c.sub ? dir.slice(0, -(c.sub.length + 1)) : dir;
      const text = move.rewritePaths(Buffer.from(c.b64, 'base64').toString('utf8'), fromRoot, toRoot).text;
      const out = await local.exec(`sh -c ${shq(move.writeScript(c.tool, c.id, c.rel, dir, shq))}`, 120000, 64 * 1024, Buffer.from(text, 'utf8'));
      if (out.code !== 0) { waiting.push(c); continue; }
      placed.push({ name: c.name, dir, tool: c.tool, id: c.id });
    } catch { waiting.push(c); }
  }
  return { placed, waiting };
}

module.exports = { KIND, MAX_TOTAL, localChats, collect, collectServers, restoreOnServer, exportDir, exportName, place };
