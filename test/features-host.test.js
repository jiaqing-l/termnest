'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { createFeatures } = require('../lib/features');

function fixture(files = {}, clientFiles = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-feat-'));
  const libDir = path.join(root, 'lib'), publicDir = path.join(root, 'pub');
  fs.mkdirSync(libDir); fs.mkdirSync(publicDir);
  for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(libDir, n), c);
  for (const [n, c] of Object.entries(clientFiles)) fs.writeFileSync(path.join(publicDir, n), c);
  const sent = [], errors = [];
  const vaultData = { data: {} }; let saves = 0;
  const deps = { remotes: () => new Map([['r1', { id: 'r1' }]]), backendOf: (id) => (id === 'r1' ? { ok: true } : null),
    send: (res, code, body) => sent.push([code, body]), fail: (res, code, msg) => sent.push([code, { error: msg }]),
    readJson: async () => ({}), shq: (x) => `'${x}'`, vault: () => vaultData, save: () => { saves++; } };
  const host = createFeatures({ libDir, publicDir, deps, log: { log() {}, error: (m) => errors.push(m) } });
  return { host, sent, errors, vaultData, saves: () => saves };
}
const req = (method) => ({ method });
const url = (p) => new URL(p, 'http://x');

test('features are loaded from lib/features and routed under their own namespace', async () => {
  const f = fixture({ 'hello.js': `module.exports={name:'hello',register(h){h.route('GET','/ping',({res})=>h.send(res,200,{pong:h.name}));h.route('POST',/^\\/echo\\/(\\w+)$/,({res,match})=>h.send(res,200,{id:match[1]}));}};` });
  assert.deepEqual(f.host.load(), ['hello']);
  assert.ok(f.host.handles('/api/features/hello/ping'));
  await f.host.handle(req('GET'), {}, url('/api/features/hello/ping'));
  await f.host.handle(req('POST'), {}, url('/api/features/hello/echo/abc'));
  assert.deepEqual(f.sent, [[200, { pong: 'hello' }], [200, { id: 'abc' }]]);
});

test('a route is reachable only through its own feature name and method', async () => {
  const f = fixture({ 'one.js': `module.exports={name:'one',register(h){h.route('GET','/x',({res})=>h.send(res,200,{a:1}));}};`,
    'two.js': `module.exports={name:'two',register(h){h.route('GET','/x',({res})=>h.send(res,200,{b:2}));}};` });
  f.host.load();
  await f.host.handle(req('GET'), {}, url('/api/features/two/x'));
  await f.host.handle(req('POST'), {}, url('/api/features/one/x'));
  await f.host.handle(req('GET'), {}, url('/api/features/none/x'));
  assert.deepEqual(f.sent.map((x) => x[0]), [200, 404, 404]); assert.deepEqual(f.sent[0][1], { b: 2 });
});

test('a broken feature never stops the others and its route errors are generic', async () => {
  const f = fixture({ 'bad.js': `module.exports={name:'bad',register(){throw new Error('boom')}};`,
    'wrongname.js': `module.exports={name:'other',register(){}};`,
    'good.js': `module.exports={name:'good',register(h){h.route('GET','/x',()=>{throw new Error('secret detail')});}};` });
  assert.deepEqual(f.host.load(), ['good']);
  assert.equal(f.errors.length, 2);
  await f.host.handle(req('GET'), {}, url('/api/features/good/x'));
  assert.equal(f.sent[0][0], 500); assert.doesNotMatch(JSON.stringify(f.sent[0][1]), /secret/);
});

test('snapshots reach every feature and one failing handler does not block the rest', () => {
  const f = fixture({ 'aa.js': `module.exports={name:'aa',register(h){h.onSnapshot(()=>{throw new Error('x')});}};`,
    'bb.js': `module.exports={name:'bb',register(h){h.onSnapshot((r,s)=>{global.__seen=(global.__seen||[]).concat([r.id+':'+s.n]);});}};` });
  f.host.load(); f.host.emitSnapshot({ id: 'r1' }, { n: 7 });
  assert.deepEqual(global.__seen, ['r1:7']); assert.equal(f.errors.length, 1);
});

test('feature settings persist through the vault under the feature name', () => {
  const f = fixture({ 'ss.js': `module.exports={name:'ss',register(h){h.route('POST','/set',({res})=>{h.settings.set({on:true});h.send(res,200,h.settings.get());});}};` });
  f.host.load();
  return f.host.handle(req('POST'), {}, url('/api/features/ss/set')).then(() => {
    assert.deepEqual(f.vaultData.data.features, { ss: { on: true } }); assert.equal(f.saves(), 1);
  });
});

test('client modules are listed and served from public/features only', () => {
  const f = fixture({}, { 'notes.js': '', 'notes.css': '', 'only-css.css': '', 'Bad Name.js': '', 'x.txt': '' });
  assert.deepEqual(f.host.clientModules(), [{ name: 'notes', js: true, css: true }]);
  assert.ok(f.host.staticFile('/features/notes.js')[1].startsWith('text/javascript'));
  assert.ok(f.host.staticFile('/features/notes.css')[1].startsWith('text/css'));
  for (const bad of ['/features/../server.js', '/features/Notes.js', '/features/x.txt', '/features/missing.js']) assert.equal(f.host.staticFile(bad), null);
});

test('browser host: events, detail sections, banners and a failing hook staying contained', () => {
  const nodes = () => { const n = { children: [], className: '', style: {}, attrs: {}, listeners: {}, append(...c) { this.children.push(...c); }, remove() { this.removed = true; }, replaceWith(x) { this.replaced = x; }, setAttribute(k, v) { this.attrs[k] = v; }, classList: { toggle() {} } }; Object.defineProperty(n, 'textContent', { set(v) { this._t = v; }, get() { return this._t; } }); return n; };
  const body = nodes();
  const document = { createElement: () => nodes(), body, head: nodes(), querySelector: () => null, getElementById: () => null };
  const window = {}; vm.runInNewContext(fs.readFileSync(require.resolve('../public/features-host.js'), 'utf8'), { window, document, console: { error() {} }, Promise });
  const TW = window.TW; const seen = [];
  TW.on('state', (s) => seen.push(s.n)); TW.on('state', () => { throw new Error('x'); }); TW.on('state', (s) => seen.push(s.n * 2));
  TW.emit('state', { n: 3 }); assert.deepEqual(seen, [3, 6]);
  const box = nodes(); TW.addDetailSection(() => { throw new Error('bad'); }); TW.addDetailSection((x) => { const n = nodes(); n.textContent = x.s.name; return n; });
  TW.renderDetail(box, { v: {}, s: { name: 'sess' } }); assert.equal(box.children.length, 1); assert.equal(box.children[0].textContent, 'sess');
  TW.banner.show({ id: 'a', level: 'urgent', title: 'T', detail: 'D', actions: [{ label: 'Go', primary: true, onClick() {} }] });
  assert.equal(body.children.length, 1); TW.banner.show({ id: 'a', title: 'T2' }); assert.ok(body.children[0].children[0].replaced); TW.banner.hide('a');
});
