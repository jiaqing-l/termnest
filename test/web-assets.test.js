'use strict';
// Compression, versioned immutable caching, per-language locales, the token summary and the parallel feature loader.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib'), vm = require('vm');
const { createWebAssets, IMMUTABLE } = require('../lib/web-assets');
const { compactAccount, createTokenView } = require('../lib/tokens-summary');

function site() {
  const pub = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-web-'));
  fs.mkdirSync(path.join(pub, 'locales')); fs.mkdirSync(path.join(pub, 'features'));
  const big = 'var x = "' + 'abcdefghij'.repeat(400) + '";\n';
  fs.writeFileSync(path.join(pub, 'app.js'), big);
  fs.writeFileSync(path.join(pub, 'app.css'), 'a{color:red}');
  fs.writeFileSync(path.join(pub, 'features', 'one.js'), 'window.one=1;');
  fs.writeFileSync(path.join(pub, 'features', 'one.css'), 'b{color:blue}');
  fs.writeFileSync(path.join(pub, 'index.html'), '<!doctype html><html><head><title>t</title><link rel="stylesheet" href="/app.css"><script defer src="/locales.js"></script></head><body><script defer src="/app.js"></script><script src="/missing.js"></script></body></html>');
  fs.writeFileSync(path.join(pub, 'locales', 'vi.json'), JSON.stringify({ 'lang.name': 'Tiếng Việt', 'lang.flag': 'V', a: 'xin chào', only_vi: 'chỉ vi', n_one: 'một' }));
  fs.writeFileSync(path.join(pub, 'locales', 'en.json'), JSON.stringify({ 'lang.name': 'English', 'lang.flag': 'E', a: 'hello' }));
  const table = { '/': [path.join(pub, 'index.html'), 'text/html; charset=utf-8'], '/app.js': [path.join(pub, 'app.js'), 'text/javascript; charset=utf-8'], '/app.css': [path.join(pub, 'app.css'), 'text/css; charset=utf-8'] };
  const features = { clientModules: () => [{ name: 'one', js: true, css: true }], staticFile: (p) => ({ '/features/one.js': [path.join(pub, 'features/one.js'), 'text/javascript; charset=utf-8'], '/features/one.css': [path.join(pub, 'features/one.css'), 'text/css; charset=utf-8'] })[p] || null };
  const web = createWebAssets({ pub, headers: { 'X-Test': '1' }, features, resolve: (p) => table[p] || features.staticFile(p) });
  const call = (pathname, headers = {}, search = '') => {
    const res = { code: 0, headers: {}, body: Buffer.alloc(0), writeHead(c, h) { this.code = c; this.headers = h; }, end(b) { if (b) this.body = Buffer.from(b); } };
    const handled = web.handle({ method: 'GET', headers }, res, new URL('http://x' + pathname + search));
    return { handled, res, text: () => (res.headers['Content-Encoding'] === 'gzip' ? zlib.gunzipSync(res.body) : res.headers['Content-Encoding'] === 'br' ? zlib.brotliDecompressSync(res.body) : res.body).toString() };
  };
  return { pub, web, call };
}

test('compression: gzip by Accept-Encoding, nothing for small files, q=0 refused, Vary set', () => {
  const { call } = site();
  const raw = call('/app.js'), gz = call('/app.js', { 'accept-encoding': 'gzip, deflate' }), br = call('/app.js', { 'accept-encoding': 'gzip, br' }), no = call('/app.js', { 'accept-encoding': 'gzip;q=0' });
  assert.equal(raw.res.headers['Content-Encoding'], undefined); assert.equal(gz.res.headers['Content-Encoding'], 'gzip'); assert.equal(br.res.headers['Content-Encoding'], 'gzip');
  assert.equal(no.res.headers['Content-Encoding'], undefined);
  assert.ok(gz.res.body.length < raw.res.body.length / 2); assert.equal(gz.text(), raw.text()); assert.equal(br.text(), raw.text());
  assert.match(gz.res.headers.Vary, /Accept-Encoding/); assert.equal(gz.res.headers['X-Test'], '1');
  assert.equal(call('/app.css', { 'accept-encoding': 'gzip' }).res.headers['Content-Encoding'], undefined);   // 12 bytes: not worth it
});

test('caching: HTML links carry ?v=<hash>; only a matching v is immutable; ETag gives 304', () => {
  const { call, pub } = site();
  const html = call('/').text();
  const js = /src="\/app\.js\?v=([\w-]{8})"/.exec(html), css = /href="\/app\.css\?v=([\w-]{8})"/.exec(html);
  assert.ok(js && css, html); assert.ok(html.includes('src="/locales.js"'), 'locales vary by language: no version'); assert.ok(html.includes('src="/missing.js"'));
  const page = call('/'); assert.equal(page.res.headers['Cache-Control'], 'no-cache');
  assert.equal(call('/app.js', {}, '?v=' + js[1]).res.headers['Cache-Control'], IMMUTABLE);
  assert.equal(call('/app.js', {}, '?v=bad').res.headers['Cache-Control'], 'no-cache');
  assert.equal(call('/app.js').res.headers['Cache-Control'], 'no-cache');
  const first = call('/app.js'), again = call('/app.js', { 'if-none-match': first.res.headers.ETag });
  assert.equal(again.res.code, 304); assert.equal(again.res.body.length, 0);
  // features: their versions are in a <meta> the loader reads
  const meta = JSON.parse(/<meta name="tw-assets" content="([^"]*)">/.exec(html)[1].replace(/&quot;/g, '"'));
  assert.deepEqual(Object.keys(meta).sort(), ['/features/one.css', '/features/one.js']);
  assert.equal(call('/features/one.js', {}, '?v=' + meta['/features/one.js']).res.headers['Cache-Control'], IMMUTABLE);
  // new content => new hash (what the updater's tar overwrite does): the old URL is no longer immutable
  const before = call('/app.js').res.headers.ETag;
  const f = path.join(pub, 'app.js'); fs.writeFileSync(f, fs.readFileSync(f, 'utf8') + '// changed\n'); const t = new Date(Date.now() + 5000); fs.utimesSync(f, t, t);
  assert.notEqual(call('/app.js').res.headers.ETag, before);
  assert.equal(call('/app.js', {}, '?v=' + js[1]).res.headers['Cache-Control'], 'no-cache');
});

test('locales: only the language in use is sent, the others are name/flag stubs, missing texts fall back like t() did', () => {
  const { call } = site();
  const load = (h, s = '') => { const w = {}; vm.runInNewContext(call('/locales.js', h, s).text(), { window: w }); return w.TW_LOCALES; };
  const en = load({ 'accept-language': 'en-US' }), vi = load({ 'accept-language': 'vi' });
  assert.equal(en.en.a, 'hello'); assert.equal(en.en.only_vi, 'chỉ vi'); assert.equal(en.en.n_one, undefined); assert.equal(en.vi.a, undefined); assert.equal(en.vi['lang.name'], 'Tiếng Việt'); assert.ok(en.vi.__stub);
  assert.equal(vi.vi.a, 'xin chào'); assert.ok(vi.en.__stub); assert.equal(vi.en.a, undefined);
  assert.equal(load({ 'accept-language': 'vi', cookie: 'x=1; tw-lang=en' }).en.a, 'hello');   // cookie beats the browser language
  assert.equal(load({ 'accept-language': 'vi' }, '?lang=en').en.a, 'hello');
  const json = JSON.parse(call('/locales.js', {}, '?format=json&lang=vi').text()); assert.deepEqual(Object.keys(json), ['vi']);
  assert.match(call('/locales.js').res.headers.Vary, /Cookie/);
  assert.ok(call('/locales.js', { 'accept-language': 'en', 'accept-encoding': 'gzip' }).res.headers.ETag);
});

test('i18n.js: a stub language is fetched once, t() answers from it, the cookie is written', () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/i18n.js'), 'utf8');
  const en = { 'lang.name': 'English', a: 'hello' }, requests = [];
  const win = { TW_LOCALES: { vi: { 'lang.name': 'VI', a: 'xin chào' }, en: { 'lang.name': 'English', __stub: 1 } }, localStorage: { getItem: () => 'en', setItem() {} }, document: { cookie: '' },
    XMLHttpRequest: function () { this.open = (m, u) => requests.push(u); this.send = () => { this.status = 200; this.responseText = JSON.stringify({ en }); }; } };
  win.window = win; vm.runInNewContext(src, win);
  assert.equal(win.TW_I18N.lang(), 'en'); assert.equal(win.i18n('a'), 'hello'); assert.deepEqual(requests, ['/locales.js?format=json&lang=en']); assert.match(win.document.cookie, /tw-lang=en/);
});

test('tokens summary: totals and every non-session field unchanged, top N per metric + tmux rows kept, etag stable and sessions=all complete', () => {
  const rows = Array.from({ length: 300 }, (_, i) => ({ id: 's' + i, total: i, today: (i * 7) % 50, week: (i * 13) % 91, name: 'n' + i, ...(i === 250 ? { tmuxName: 'work' } : {}) }));
  const acc = { id: 'a', tool: 'claude', today: 5, week: 9, days: [{ day: 'd', total: 1 }], sessions: rows };
  const c = compactAccount(acc);
  assert.equal(c.sessionsTotal, 300); assert.ok(c.sessions.length < 40); assert.ok(c.sessions.some((s) => s.tmuxName === 'work'));
  for (const f of ['today', 'week']) assert.deepEqual(c.sessions.map((s) => s[f]).sort((a, b) => b - a).slice(0, 10), rows.map((s) => s[f]).sort((a, b) => b - a).slice(0, 10));
  assert.equal(c.today, 5); assert.deepEqual(c.days, acc.days);
  assert.equal(compactAccount({ id: 'b', sessions: rows.slice(0, 15) }).sessionsTotal, undefined);   // small: untouched
  const view = createTokenView(), raw = JSON.stringify({ updatedAt: 1, accounts: [acc] });
  const a = view(raw), b = view(raw), full = view(raw, { full: true });
  assert.equal(a.etag, b.etag); assert.equal(a.text, b.text); assert.notEqual(full.etag, a.etag);
  assert.equal(JSON.parse(full.text).accounts[0].sessions.length, 300); assert.equal(JSON.parse(a.text).etag, a.etag);
  assert.ok(a.text.length < full.text.length / 4);
  assert.notEqual(view(JSON.stringify({ updatedAt: 2, accounts: [acc] })).etag, a.etag);
});

test('web.sendJson: gzip for big JSON, ETag + 304, still no-store', () => {
  const { web } = site(); const text = JSON.stringify({ rows: Array.from({ length: 500 }, (_, i) => ({ i })) });
  const run = (h) => { const res = { headers: {}, writeHead(c, x) { this.code = c; this.headers = x; }, end(b) { this.body = b; } }; web.sendJson({ headers: h }, res, text); return res; };
  const gz = run({ 'accept-encoding': 'gzip' }); assert.equal(gz.headers['Content-Encoding'], 'gzip'); assert.equal(gz.headers['Cache-Control'], 'no-store'); assert.equal(zlib.gunzipSync(gz.body).toString(), text);
  assert.equal(run({ 'if-none-match': gz.headers.ETag }).code, 304); assert.equal(run({}).body.toString(), text);
});

test('feature loader: every file requested at once, scripts run in the server order (async=false), ready after all, a failing file does not stop the rest', async () => {
  const order = [];
  const nodes = [];
  const document = { head: { append(n) { nodes.push(n); } }, createElement: (tag) => ({ tag }), querySelector: (q) => (q === 'meta[name="tw-assets"]' ? { getAttribute: () => JSON.stringify({ '/features/b.js': 'v2' }) } : null) };
  const window = {}; vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/features-host.js'), 'utf8'), { window, document, console, Promise });
  const TW = window.TW; TW.attach({ api: () => Promise.resolve({ modules: [{ name: 'a', css: true }, { name: 'b' }, { name: 'c' }] }) });
  let ready = false; TW.on('ready', () => { ready = true; });
  const p = TW.load();
  await new Promise((r) => setTimeout(r, 5));
  const scripts = nodes.filter((n) => n.tag === 'script');
  assert.deepEqual(scripts.map((s) => s.src), ['/features/a.js', '/features/b.js?v=v2', '/features/c.js']);   // all inserted before any finished
  assert.ok(scripts.every((s) => s.async === false)); assert.equal(nodes.find((n) => n.tag === 'link').href, '/features/a.css'); assert.equal(ready, false);
  scripts[1].onerror(); scripts[2].onload(); await new Promise((r) => setTimeout(r, 5)); assert.equal(ready, false);
  scripts[0].onload(); await p; assert.equal(ready, true); order.push('x');
});
