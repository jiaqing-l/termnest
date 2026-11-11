'use strict';
// An HTML report runs in a sandboxed frame that cannot load files, so images, stylesheets and scripts that sit next to it never
// showed. They are read here, through the session's own (contained) file reader, and put into the page as data: URLs / <style> /
// inline <script>. Only files the session can already read are used; nothing is fetched from the network.
const path = require('path');
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
const MAX_FILES = 60, MAX_BYTES = 12 * 1024 * 1024, PARALLEL = 6;

function isLocal(ref) { return !!ref && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref); }
function resolve(fromFile, ref) {
  const clean = ref.split(/[?#]/)[0];
  if (!clean) return '';
  let decoded; try { decoded = decodeURIComponent(clean); } catch { decoded = clean; }
  const flavor = /^[A-Za-z]:[\\/]|\\/.test(fromFile) ? path.win32 : path.posix;
  return flavor.resolve(flavor.dirname(fromFile), decoded);
}

// readMany(paths) → files in the same order: when given, every picture is fetched in one call instead of one call each.
async function inlineAssets(html, htmlPath, read, readMany) {
  let text = String(html);
  if (!htmlPath || typeof read !== 'function') return text;
  const urls = new Map();            // "dir-of-owner\0ref" -> data URL ('' when it could not be read)
  const jobs = [];
  let files = 0, bytes = 0;
  const want = (owner, ref) => {
    if (!isLocal(ref)) return null;
    const abs = resolve(owner, ref); if (!abs) return null;
    if (urls.has(abs)) return abs;
    if (files >= MAX_FILES) return null;
    files += 1; urls.set(abs, '');
    const job = async (pre) => {
      const file = pre !== undefined ? pre : await read(abs);
      if (!file || file.error) return;
      let url = '';
      if (file.kind === 'image' && file.base64) url = 'data:' + file.mime + ';base64,' + file.base64;
      else if (/\.svg$/i.test(abs) && typeof file.text === 'string') url = 'data:image/svg+xml;base64,' + Buffer.from(file.text).toString('base64');
      if (url && bytes + url.length <= MAX_BYTES) { bytes += url.length; urls.set(abs, url); }
    };
    job.abs = abs; jobs.push(job);
    return abs;
  };
  async function drain() {
    if (typeof readMany === 'function' && jobs.length) {
      const batch = jobs.splice(0);
      let got = null; try { got = await readMany(batch.map((j) => j.abs)); } catch { got = null; }
      if (Array.isArray(got) && got.length === batch.length) { await Promise.all(batch.map((j, i) => j(got[i] || null).catch(() => {}))); return; }
      jobs.push(...batch); // the batch call failed: fall back to one call per file
    }
    while (jobs.length) { const batch = jobs.splice(0, PARALLEL); await Promise.all(batch.map((j) => j().catch(() => {}))); }
  }
  const cssUrl = /url\(\s*(["']?)(.*?)\1\s*\)/gi;
  const imgSrc = /(<img\b[^>]*?\bsrc\s*=\s*)(["'])(.*?)\2/gi;
  const linkTag = /<link\b[^>]*>/gi;
  const scriptTag = /<script\b([^>]*?)\bsrc\s*=\s*(["'])(.*?)\2([^>]*)>\s*<\/script\s*>/gi;

  // Stylesheets next to the page: read them first so the images they point to can be collected as well.
  const sheets = new Map();          // abs path of css -> css text
  for (const tag of text.match(linkTag) || []) {
    if (!/\brel\s*=\s*["']?stylesheet/i.test(tag)) continue;
    const href = (tag.match(/\bhref\s*=\s*(["'])(.*?)\1/i) || [])[2];
    if (!isLocal(href) || sheets.size >= 10) continue;
    const abs = resolve(htmlPath, href); if (!abs || sheets.has(abs)) continue;
    sheets.set(abs, '');
    try { const f = await read(abs); if (f && !f.error && typeof f.text === 'string' && f.text.length < 800000) sheets.set(abs, f.text); } catch { /* skip it */ }
  }
  // Scripts next to the page (sample data, small helpers) become inline scripts, in their original order.
  const scripts = new Map();         // abs path of js -> js text
  let scriptBytes = 0;
  for (const m of text.matchAll(scriptTag)) {
    const src = m[3];
    if (!isLocal(src) || scripts.size >= 20) continue;
    const abs = resolve(htmlPath, src); if (!abs || scripts.has(abs)) continue;
    scripts.set(abs, '');
    try {
      const f = await read(abs);
      if (f && !f.error && typeof f.text === 'string' && f.text.length < 2000000 && scriptBytes + f.text.length <= MAX_BYTES) { scriptBytes += f.text.length; scripts.set(abs, f.text); }
    } catch { /* skip it */ }
  }
  const collect = (owner, source) => { source.replace(cssUrl, (m, q, ref) => { want(owner, ref); return m; }); };
  collect(htmlPath, text);
  text.replace(imgSrc, (m, pre, q, ref) => { want(htmlPath, ref); return m; });
  sheets.forEach((css, abs) => collect(abs, css));
  await drain();

  const swap = (owner, source) => source.replace(cssUrl, (m, q, ref) => {
    if (!isLocal(ref)) return m;
    const url = urls.get(resolve(owner, ref));
    return url ? 'url("' + url + '")' : m;
  });
  text = text.replace(linkTag, (tag) => {
    if (!/\brel\s*=\s*["']?stylesheet/i.test(tag)) return tag;
    const href = (tag.match(/\bhref\s*=\s*(["'])(.*?)\1/i) || [])[2];
    if (!isLocal(href)) return tag;
    const abs = resolve(htmlPath, href), css = sheets.get(abs);
    return css ? '<style>' + swap(abs, css).replace(/<\/style/gi, '<\\/style') + '</style>' : tag;
  });
  text = text.replace(scriptTag, (m, before, q, src, after) => {
    if (!isLocal(src)) return m;
    const js = scripts.get(resolve(htmlPath, src));
    if (!js) return m;
    // Keep type (module, json…); drop attributes that only make sense for a fetched file.
    const attrs = (before + ' ' + after).replace(/\s(?:async|defer|integrity|crossorigin|referrerpolicy|nomodule)(?:\s*=\s*(["']).*?\1|\s*=\s*\S+)?/gi, '').trim();
    return '<script' + (attrs ? ' ' + attrs : '') + '>' + js.replace(/<\/script/gi, '<\\/script') + '</script>';
  });
  text = text.replace(imgSrc, (m, pre, q, ref) => {
    if (!isLocal(ref)) return m;
    const url = urls.get(resolve(htmlPath, ref));
    return url ? pre + q + url + q : m;
  });
  return swap(htmlPath, text);
}
module.exports = { inlineAssets, isLocal, resolve };
