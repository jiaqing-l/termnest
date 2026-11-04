'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// A tiny DOM: enough for the yard to build itself, so we can check what it shows for a given set of sessions.
class Node {
  constructor(tag = 'div') {
    this.tag = tag; this.children = []; this.dataset = {}; this.style = { setProperty() {}, removeProperty() {} }; this.className = ''; this.hidden = false;
    this._text = ''; this.attrs = {}; this.handlers = {};
    const self = this;
    this.classList = {
      add: (...c) => { const s = new Set(self.className.split(' ').filter(Boolean)); c.forEach((x) => s.add(x)); self.className = [...s].join(' '); },
      remove: (...c) => { self.className = self.className.split(' ').filter((x) => x && !c.includes(x)).join(' '); },
      toggle: (c, on) => { self.classList[on === false || (on === undefined && self.classList.contains(c)) ? 'remove' : 'add'](c); },
      contains: (c) => self.className.split(' ').includes(c)
    };
  }
  get textContent() { return this._text + this.children.map((c) => c.textContent || '').join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  set innerHTML(v) { this._html = v; this.children = []; }
  append(...n) { n.forEach((x) => { if (typeof x === 'string') this._text += x; else { x.parent = this; this.children.push(x); } }); }
  prepend(n) { n.parent = this; this.children.unshift(n); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
  setAttribute(k, v) { this.attrs[k] = v; } getAttribute(k) { return this.attrs[k]; }
  addEventListener(t, f) { this.handlers[t] = f; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 100 }; }
  get clientWidth() { return 800; } get offsetWidth() { return 40; } get offsetHeight() { return 20; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const cls = sel.replace(/^\./, '').split('.').filter(Boolean), out = [];
    const walk = (n) => n.children.forEach((c) => { if (cls.every((x) => c.classList.contains(x))) out.push(c); walk(c); });
    walk(this); return out;
  }
}
function harness({ hour = 12, limits = { cpu: 90, ram: 90, disk: 90 } } = {}) {
  const root = new Node(), hero = new Node(), headB = new Node(), html = new Node(), doc = new Node();
  const store = {};
  doc.getElementById = (id) => (id === 'pet-yard2' ? root : null);
  doc.querySelector = (sel) => (sel === '.hero' ? hero : sel === '.playground > b' ? headB : null);
  doc.documentElement = html; doc.body = new Node(); doc.hidden = false;
  doc.createElement = (t) => new Node(t); doc.createElementNS = (n, t) => new Node(t); doc.querySelectorAll = () => [];
  const RealDate = Date;
  const context = {
    window: { PetState: require('../public/pet-state'), PetArt: { ORDER: ['cat', 'fox'], PETS: { cat: {}, fox: {} }, pet: (k, s) => '<svg data-k="' + k + '" data-s="' + s + '"/>' }, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    document: doc, localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
    Date: class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(2026, 10, 4, hour, 30); } static now() { return new RealDate(2026, 10, 4, hour, 30).getTime(); } },
    MutationObserver: class { observe() {} }, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, performance: { now: () => 0 },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, innerWidth: 1000, Math, console
  };
  context.window.document = doc;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/pet-yard.js'), 'utf8'), context);
  const records = (specs) => new Map(specs.map((s, i) => ['s/' + (s.name || 'p' + i), { v: { id: 's', on: s.on !== false, cpu: s.cpu ?? 10, ram: s.ram ?? 20, disk: s.disk ?? 30 }, s: { name: s.name || 'p' + i, state: s.state || 'idle', created: 1, cmd: '' }, outcomeAt: 0 }]));
  const sync = (specs, weather = 'sun') => context.window.PetYard.sync({ records: records(specs), servers: [], choices: {}, connected: true, overview: true, limits, open() {}, kindOf: () => 'cat', weather });
  return { root, hero, headB, store, sync, walkers: () => root.querySelectorAll('yw') };
}
const many = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ name: 'p' + i, ...extra }));

test('one pet per session, and a "+N" chip only past fourteen', () => {
  const h = harness(); h.sync(many(5));
  assert.equal(h.walkers().length, 5);
  assert.equal(h.root.querySelector('yd-more').hidden, true);
  h.sync(many(20));
  assert.equal(h.walkers().length, 14);
  assert.equal(h.root.querySelector('yd-more').hidden, false);
  assert.equal(h.root.querySelector('yd-more').textContent, '+6');
});

test('pets follow their sessions: removed ones leave, new ones arrive', () => {
  const h = harness(); h.sync(many(3)); h.sync(many(4)); assert.equal(h.walkers().length, 4);
  h.sync(many(2)); assert.equal(h.walkers().length, 2);
  h.sync([]); assert.equal(h.walkers().length, 0);
  assert.equal(h.root.querySelector('yd-empty').hidden, false);
});

test('sky follows the hour, and everyone not waiting sleeps from 23h to 6h', () => {
  const day = harness({ hour: 12 }); day.sync(many(3));
  assert.ok(day.root.classList.contains('day'));
  const dusk = harness({ hour: 18 }); dusk.sync(many(1)); assert.ok(dusk.root.classList.contains('dusk'));
  const night = harness({ hour: 21 }); night.sync(many(1)); assert.ok(night.root.classList.contains('night'));
  const late = harness({ hour: 2 }); late.sync([{ name: 'a' }, { name: 'b', state: 'wait' }]);
  assert.ok(late.root.classList.contains('midnight'));
  const [a, b] = late.walkers().sort((x, y) => (x.dataset.key < y.dataset.key ? -1 : 1));
  assert.equal(a.dataset.mode, 'sleep'); assert.equal(b.dataset.mode, 'wait');
});

test('server load and a failed session change how the pet looks', () => {
  const h = harness();
  h.sync([{ name: 'hot', cpu: 97 }, { name: 'full', disk: 96 }, { name: 'off', on: false }, { name: 'calm' }]);
  const by = Object.fromEntries(h.walkers().map((w) => [w.dataset.key.split('/')[1], w]));
  assert.ok(by.hot.classList.contains('hot')); assert.match(by.hot.children[1].textContent, /💦/);
  assert.ok(by.full.classList.contains('carry')); assert.match(by.full.children[1].textContent, /📦/);
  assert.equal(by.off.dataset.mode, 'offline');
  assert.equal(by.calm.dataset.mode, 'ok'); assert.equal(by.calm.children[1].textContent, '');
});

test('a pet that has not eaten for a day is hungry; feeding is remembered per session', () => {
  const h = harness(); h.store['tw-fed:s/p0'] = String(Date.UTC(2026, 10, 1)); // days ago
  h.sync(many(2));
  const [first, second] = h.walkers().sort((x, y) => (x.dataset.key < y.dataset.key ? -1 : 1));
  assert.ok(first.classList.contains('hungry')); assert.ok(!second.classList.contains('hungry'));
  assert.ok(Number(h.store['tw-fed:s/p1']) > 0, 'a pet seen for the first time starts fed');
});

test('weather follows the server load: sun, rain, thunder', () => {
  const h = harness();
  h.sync(many(1), 'sun'); assert.equal(h.hero.dataset.w, 'sun');
  h.sync(many(1), 'rain'); assert.equal(h.hero.dataset.w, 'rain');
  h.sync(many(1), 'storm'); assert.equal(h.hero.dataset.w, 'storm');
  assert.ok(h.hero.children[0].classList.contains('wx'), 'the weather layer sits behind the banner content');
});

test('the header offers a football button and shows how many pets are in the yard', () => {
  const h = harness(); h.sync(many(3));
  assert.match(h.headB.textContent, /Đá bóng/);
  assert.match(h.headB.textContent, /3 bạn đang ở sân/);
});
