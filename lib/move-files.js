'use strict';
// Files that belong to a moved conversation: what the agent wrote or edited, files the chat names, and the local
// assets (img/css/js) of those HTML pages. Only regular files inside the session's working folder travel; nothing
// outside it, no symlinks, no .git or node_modules. On the target an existing different file is kept as a backup.
const LIMIT = { files: 400, bytes: 200 * 1048576, one: 25 * 1048576 };

// Runs on the source host. Reads the conversation file and lists the related files with size and sha256.
function relatedRuntime() {
  return async function related(a) {
    const fs = require('fs'), path = require('path'), crypto = require('crypto');
    const LIMIT = a.limit, root = path.resolve(a.root), transcript = path.resolve(a.profile, a.rel);
    if (!path.isAbsolute(a.root) || !transcript.startsWith(path.resolve(a.profile) + path.sep)) return { code: 'invalid' };
    let text = '';
    try { const st = fs.statSync(transcript); if (!st.isFile() || st.size > 120 * 1048576) return { code: 'toolarge' }; text = fs.readFileSync(transcript, 'utf8'); }
    catch { return { code: 'missing' }; }
    const seen = new Set(), wanted = [];
    const add = (p, why) => {
      if (typeof p !== 'string' || !p || p.length > 600 || /[\x00-\x1f*?<>|]/.test(p)) return;
      p = p.replace(/\\\\/g, '\\').replace(/[)\].,;:'"`]+$/, '');
      const full = path.resolve(path.isAbsolute(p) ? p : path.join(root, p));
      if (!full.startsWith(root + path.sep)) return;
      const rel = path.relative(root, full);
      if (rel.split(path.sep).some((x) => x === '.git' || x === 'node_modules' || x === '..')) return;
      if (seen.has(rel)) return; seen.add(rel); wanted.push({ rel, why });
    };
    // 1. What the agent wrote or edited (Claude tool inputs; Codex apply_patch headers).
    for (const m of text.matchAll(/"(?:file_path|notebook_path)"\s*:\s*"((?:[^"\\]|\\.){1,600})"/g)) add(m[1], 'edited');
    for (const m of text.matchAll(/\*\*\* (?:Add|Update) File: ([^\\\n"]{1,600})/g)) add(m[1].trim(), 'edited');
    // 2. Files the chat names (relative to the folder, or absolute inside it).
    const EXT = 'md|markdown|html?|png|jpe?g|gif|webp|svg|css|js|mjs|json|csv|tsv|txt|pdf|xlsx|docx|pptx|yaml|yml|sql|log|sh|py|ts|tsx|dart|cs|razor';
    const named = new RegExp('(?:^|[\\s(`\'"\\[])((?:/|\\.{0,2}/)?(?:[\\w.@+-]+/)+[\\w.@+-]+\\.(?:' + EXT + '))(?=[\\s)`\'",.;:\\]]|$)', 'gi');
    for (const line of text.split('\n')) {
      if (line.length > 400000) continue;
      const plain = line.replace(/\\n/g, '\n').replace(/\\"/g, '"');
      for (const m of plain.matchAll(named)) add(m[1], 'named');
    }
    const out = []; let bytes = 0, truncated = false;
    const take = (rel, why) => {
      const full = path.join(root, rel);
      let st; try { st = fs.lstatSync(full); } catch { return false; }
      if (!st.isFile() || st.size > LIMIT.one) return false;
      if (out.length >= LIMIT.files || bytes + st.size > LIMIT.bytes) { truncated = true; return false; }
      const sha = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      out.push({ rel, size: st.size, sha, why }); bytes += st.size; return true;
    };
    for (const w of wanted) if (take(w.rel, w.why) && /\.html?$/i.test(w.rel)) {
      // 3. Local assets the page loads.
      let html = ''; try { html = fs.readFileSync(path.join(root, w.rel), 'utf8').slice(0, 4 * 1048576); } catch { /* unreadable */ }
      for (const m of html.matchAll(/(?:src|href)\s*=\s*["']([^"'#?]{1,400})/gi)) {
        if (/^(?:[a-z]+:|\/\/|data:)/i.test(m[1])) continue;
        const rel = path.relative(root, path.resolve(path.dirname(path.join(root, w.rel)), decodeURIComponent(m[1])));
        if (rel.startsWith('..') || path.isAbsolute(rel) || seen.has(rel)) continue;
        seen.add(rel); take(rel, 'asset');
      }
    }
    return { files: out, bytes, truncated };
  };
}

// Runs on the target host: which of these files are already there with the same content.
function stateRuntime() {
  return async function state(a) {
    const fs = require('fs'), path = require('path'), crypto = require('crypto'), root = path.resolve(a.root), out = {};
    for (const f of a.files) {
      const full = path.resolve(root, f.rel);
      if (!full.startsWith(root + path.sep)) { out[f.rel] = 'invalid'; continue; }
      try {
        const st = fs.lstatSync(full);
        out[f.rel] = !st.isFile() ? 'invalid' : st.size === f.size && crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex') === f.sha ? 'same' : 'differs';
      } catch { out[f.rel] = 'missing'; }
    }
    return { state: out };
  };
}

// Runs on the source host: the contents of a batch, base64.
function readRuntime() {
  return async function read(a) {
    const fs = require('fs'), path = require('path'), crypto = require('crypto'), root = path.resolve(a.root), files = [];
    for (const f of a.files) {
      const full = path.resolve(root, f.rel);
      if (!full.startsWith(root + path.sep)) return { code: 'invalid' };
      const st = fs.lstatSync(full); if (!st.isFile()) return { code: 'invalid' };
      const b = fs.readFileSync(full);
      if (crypto.createHash('sha256').update(b).digest('hex') !== f.sha) return { code: 'changed', rel: f.rel };
      files.push({ rel: f.rel, b64: b.toString('base64') });
    }
    return { files };
  };
}

// Runs on the target host, reading "header JSON\n" + the files' bytes from stdin. Each file is written next to its
// final name and renamed into place; a different existing file is first kept as "<name>.truoc-chuyen-<stamp>".
function writeFilesRuntime() {
  return async function write(a) {
    const fs = require('fs'), path = require('path'), crypto = require('crypto');
    const chunks = []; for await (const c of process.stdin) chunks.push(c);
    const all = Buffer.concat(chunks), cut = all.indexOf(10), head = JSON.parse(all.subarray(0, cut).toString('utf8'));
    const root = path.resolve(head.root), stamp = head.stamp; let at = cut + 1;
    const done = [], kept = [];
    for (const f of head.files) {
      const b = all.subarray(at, at + f.size); at += f.size;
      if (b.length !== f.size || crypto.createHash('sha256').update(b).digest('hex') !== f.sha) return { code: 'corrupt', rel: f.rel, done, kept };
      const full = path.resolve(root, f.rel);
      if (!full.startsWith(root + path.sep)) return { code: 'invalid', rel: f.rel, done, kept };
      fs.mkdirSync(path.dirname(full), { recursive: true });
      try {
        const st = fs.lstatSync(full);
        if (!st.isFile()) return { code: 'invalid', rel: f.rel, done, kept };
        if (crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex') === f.sha) { done.push(f.rel); continue; }
        fs.copyFileSync(full, full + '.truoc-chuyen-' + stamp); kept.push(f.rel);
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const tmp = full + '.termnest-' + process.pid;
      fs.writeFileSync(tmp, b); fs.renameSync(tmp, full); done.push(f.rel);
    }
    return { done, kept };
  };
}

const script = (runtime, node, shq, a) => node + ' -e ' + shq('(' + runtime.toString() + ')()(' + JSON.stringify(a) + ').then(v=>process.stdout.write(JSON.stringify(v))).catch(e=>{process.stdout.write(JSON.stringify({code:"failed"}));process.exitCode=5;});');

// Lists related files on the source and compares them with the target folder.
async function plan({ run, src, dst, profile, rel, fromRoot, toRoot }) {
  const found = await run(src, relatedRuntime, { profile, rel, root: fromRoot, limit: LIMIT }, { timeout: 60000, maxBuffer: 4 * 1048576 });
  if (found.code) return { code: found.code, files: [] };
  if (!found.files.length) return { files: [], copy: [], bytes: 0, truncated: !!found.truncated };
  const st = await run(dst, stateRuntime, { root: toRoot, files: found.files.map((f) => ({ rel: f.rel, size: f.size, sha: f.sha })) }, { timeout: 60000, maxBuffer: 4 * 1048576 });
  const copy = found.files.filter((f) => st.state && st.state[f.rel] !== 'same' && st.state[f.rel] !== 'invalid').map((f) => ({ ...f, target: st.state[f.rel] }));
  return { files: found.files, copy, bytes: copy.reduce((n, f) => n + f.size, 0), differs: copy.filter((f) => f.target === 'differs').length, truncated: !!found.truncated };
}

// Copies the planned files, in batches of at most 20 MB.
async function copy({ run, src, dst, fromRoot, toRoot, files, node, shq }) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  const result = { done: 0, kept: [] };
  for (let i = 0; i < files.length;) {
    const batch = []; let size = 0;
    while (i < files.length && (batch.length === 0 || size + files[i].size <= 20 * 1048576)) { size += files[i].size; batch.push(files[i++]); }
    const got = await run(src, readRuntime, { root: fromRoot, files: batch.map((f) => ({ rel: f.rel, sha: f.sha })) }, { timeout: 120000, maxBuffer: 64 * 1048576 });
    if (got.code) return { ...result, code: got.code, rel: got.rel };
    const head = { root: toRoot, stamp, files: batch.map((f) => ({ rel: f.rel, size: f.size, sha: f.sha })) };
    const input = Buffer.concat([Buffer.from(JSON.stringify(head) + '\n'), ...got.files.map((f) => Buffer.from(f.b64, 'base64'))]);
    const out = await dst.exec(script(writeFilesRuntime, node, shq, {}), 180000, 1048576, input);
    let v; try { v = JSON.parse(out.out); } catch { v = { code: 'failed' }; }
    if (out.code !== 0 || v.code) return { ...result, code: v.code || 'failed', rel: v.rel };
    result.done += v.done.length; result.kept.push(...v.kept);
  }
  return result;
}

module.exports = { relatedRuntime, stateRuntime, readRuntime, writeFilesRuntime, plan, copy, LIMIT };
