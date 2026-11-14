'use strict';
// Page files (HTML, scripts, styles, fonts, locales): read once, compressed once (gzip; browsers do not ask for brotli over plain http) and cached per content.
// A page and its scripts are linked with ?v=<content hash>: that URL never changes meaning, so the browser keeps it for a year
// (immutable) and a reload costs no request. The HTML itself stays no-cache + ETag, so a new version is picked up at once.
// A URL without ?v=, or with an old one, keeps the old behaviour (ETag, 304) and is never marked immutable.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const IMMUTABLE = 'public, max-age=31536000, immutable';
const MIN_COMPRESS = 1024;
const PAGE_TTL_MS = 1000;   // how long a rendered page (HTML with versioned links) is reused before the files are looked at again

/** Content codings the browser accepts (q=0 means "not acceptable"). */
function codings(req) {
  const set = new Set();
  for (const part of String((req.headers && req.headers['accept-encoding']) || '').toLowerCase().split(',')) {
    const [name, ...params] = part.trim().split(';');
    const q = params.map((s) => s.trim()).find((s) => s.startsWith('q='));
    if (name && !(q && Number(q.slice(2)) === 0)) set.add(name.trim());
  }
  return set;
}

const hash = (buf) => crypto.createHash('sha1').update(buf).digest('base64url');
/** Eight characters of the content hash: the ?v= of a file. */
const ver = (a) => a.etag.slice(1, 9);

function createWebAssets({ pub, headers, resolve, patch, features }) {
  const cache = new Map();
  const pages = new Map();

  function asset(key, stamp, load) {
    let a = cache.get(key);
    if (!a || a.stamp !== stamp) {
      const raw = load();
      a = { stamp, raw, etag: '"' + hash(raw).slice(0, 22) + '"', gzip: undefined, brotli: undefined };
      cache.set(key, a);
    }
    return a;
  }
  // Compressed forms are made the first time a browser asks for them, then kept with the asset. Small or incompressible bodies stay raw.
  function packed(a) {
    const kind = 'gzip';
    if (a[kind] === undefined) {
      let out = null;
      if (a.raw.length >= MIN_COMPRESS) {
        const z = zlib.gzipSync(a.raw, { level: 9 });
        if (z.length < a.raw.length * 0.9) out = z;
      }
      a[kind] = out;
    }
    return a[kind];
  }
  /** Sends `a` (raw, etag) with the best coding the browser accepts; 304 when its ETag matches. */
  function sendAsset(req, res, type, a, { cacheControl = 'no-cache', vary = 'Accept-Encoding' } = {}) {
    const h = { 'Content-Type': type, ...headers, 'Cache-Control': cacheControl, ETag: a.etag, Vary: vary };
    if (String(req.headers['if-none-match'] || '').split(/\s*,\s*/).includes(a.etag)) { res.writeHead(304, h); res.end(); return; }
    const want = codings(req);
    const gz = want.has('gzip') && packed(a);
    if (gz) { res.writeHead(200, { ...h, 'Content-Encoding': 'gzip' }); res.end(gz); return; }
    res.writeHead(200, h); res.end(a.raw);
  }

  /** The asset for a served path (stat-checked, cached by mtime+size), or null when the path is not served. */
  function staticAsset(pathname) {
    const entry = resolve(pathname);
    if (!entry) return null;
    const st = fs.statSync(entry[0]);
    const a = asset(entry[0], st.mtimeMs + ':' + st.size, () => {
      const buf = fs.readFileSync(entry[0]);
      if (pathname === '/fonts/fonts.css') return Buffer.from(versionUrls(buf.toString('utf8'), /url\((['"]?)(\/fonts\/[a-z0-9-]+\.woff2)\1\)/g, 2, (m, q, p, v) => `url(${q}${p}?v=${v}${q})`));
      return patch ? patch(pathname, buf) : buf;
    });
    return { a, type: entry[1] };
  }
  function versionUrls(text, re, group, build) {
    return text.replace(re, (...m) => {
      const hit = staticAsset(m[group]);
      return hit ? build(...m.slice(0, group + 1).concat([ver(hit.a)])) : m[0];
    });
  }

  /** HTML with every local script/stylesheet linked as ?v=<hash> and the feature file versions in a <meta> (a preload of the features measured slower to first paint). */
  function page(pathname, entry) {
    const key = pathname, now = Date.now(), old = pages.get(key);
    if (old && now - old.at < PAGE_TTL_MS) return old.a;
    const base = staticAsset(pathname);
    let html = base.a.raw.toString('utf8');
    html = html.replace(/\b(src|href)="(\/[^"?#]*\.(?:js|css))"/g, (m, attr, p) => { const hit = staticAsset(p); return hit ? `${attr}="${p}?v=${ver(hit.a)}"` : m; });
    if (pathname === '/') {
      const map = {};
      for (const m of features ? features.clientModules() : []) {
        for (const ext of ['js', 'css']) {
          if (!m[ext]) continue;
          const p = `/features/${m.name}.${ext}`, hit = staticAsset(p);
          if (!hit) continue;
          map[p] = ver(hit.a);
        }
      }
      const meta = `<meta name="tw-assets" content="${JSON.stringify(map).replace(/"/g, '&quot;')}">` ;
      html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (h) => h + meta) : meta + html;
    }
    const buf = Buffer.from(html, 'utf8');
    const a = asset('page:' + key, hash(buf), () => buf);
    pages.set(key, { at: now, a });
    return a;
  }

  // ---- locales: only the language in use is sent (plus a name/flag stub for each other one, so the picker still lists them) ----
  let loc = { at: 0, stamp: '', tables: {} };
  const localeScripts = new Map();
  function locales() {
    const now = Date.now();
    if (now - loc.at < PAGE_TTL_MS) return loc;
    const dir = path.join(pub, 'locales');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    const stamp = files.map((f) => f + fs.statSync(path.join(dir, f)).mtimeMs).join('|');
    if (stamp !== loc.stamp) {
      const tables = {};
      for (const f of files) { try { tables[f.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { /* a broken file never takes the others down */ } }
      loc = { at: now, stamp, tables }; localeScripts.clear();
    } else loc.at = now;
    return loc;
  }
  const FALLBACK = 'vi';
  /** Which language the page will use: ?lang=, then the tw-lang cookie, then the browser language (the same order as public/i18n.js). */
  function pickLang(req, url, tables) {
    const q = url.searchParams.get('lang');
    if (q && tables[q]) return q;
    const c = (String(req.headers.cookie || '').match(/(?:^|;\s*)tw-lang=([a-z]{2,8})/) || [])[1];
    if (c && tables[c]) return c;
    const sys = String(req.headers['accept-language'] || '').slice(0, 2).toLowerCase();
    return tables[sys] ? sys : (tables.en ? 'en' : FALLBACK);
  }
  /** The table of one language, with the fallback language's texts it lacks (so t() answers exactly as before). */
  function tableFor(tables, lang) {
    const own = tables[lang] || {};
    if (lang === FALLBACK || !tables[FALLBACK]) return own;
    const extra = {};
    for (const [k, v] of Object.entries(tables[FALLBACK])) if (own[k] === undefined && !k.endsWith('_one')) extra[k] = v;
    return { ...extra, ...own };
  }
  const safeJson = (o) => JSON.stringify(o).replace(/</g, '\\u003c');
  function localesAsset(req, url, json) {
    const { tables, stamp } = locales(), lang = pickLang(req, url, tables), key = `${json ? 'json' : 'js'}|${lang}`;
    let s = localeScripts.get(key);
    if (!s) {
      const out = {};
      for (const k of Object.keys(tables)) out[k] = k === lang ? tableFor(tables, k) : { 'lang.name': tables[k]['lang.name'], 'lang.flag': tables[k]['lang.flag'], __stub: 1 };
      const text = json ? safeJson({ [lang]: out[lang] }) : 'window.TW_LOCALES=' + safeJson(out) + ';';
      s = Buffer.from(text); localeScripts.set(key, s);
    }
    return asset('locales:' + key, stamp, () => s);
  }

  /** Serves a page file; true when the request was answered (so the caller falls through to 404 only for unknown paths). */
  function handle(req, res, url) {
    if (req.method !== 'GET') return false;
    const vary = 'Accept-Encoding, Cookie, Accept-Language';
    if (url.pathname === '/locales.js') {
      const json = url.searchParams.get('format') === 'json';
      sendAsset(req, res, json ? 'application/json; charset=utf-8' : 'text/javascript; charset=utf-8', localesAsset(req, url, json), { vary }); return true;
    }
    const entry = resolve(url.pathname);
    if (!entry) return false;
    let hit;
    try {
      if (entry[1].startsWith('text/html')) hit = { a: page(url.pathname, entry), type: entry[1] };
      else hit = staticAsset(url.pathname);
    } catch { res.writeHead(500); res.end(); return true; }
    const v = url.searchParams.get('v');
    sendAsset(req, res, hit.type, hit.a, v && !entry[1].startsWith('text/html') && v === ver(hit.a) ? { cacheControl: IMMUTABLE } : {});
    return true;
  }

  /** A JSON body, ETag-tagged and compressed like a page file but never cached by the browser (API answers stay no-store). */
  function sendJson(req, res, text, extra) {
    const buf = Buffer.from(text), a = { raw: buf, etag: '"' + hash(buf).slice(0, 22) + '"' };
    sendAsset(req, res, 'application/json; charset=utf-8', a, { cacheControl: 'no-store', ...(extra || {}) });
  }

  return { handle, asset, sendAsset, staticAsset, page, sendJson, localesAsset, codings, ver };
}

module.exports = { createWebAssets, codings, IMMUTABLE, MIN_COMPRESS };
