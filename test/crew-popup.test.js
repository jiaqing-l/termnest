'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const app = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
const html = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
const css = fs.readFileSync(require.resolve('../public/app.css'), 'utf8');
const markup = html.match(/<section id="crew-panel"[\s\S]*?<\/section>/)[0];
const code = app.slice(app.indexOf('  var crewSelection ='), app.indexOf('  function petSync('));

function fixture(storage = new Map()) {
  const nodes = {};
  for (const [, id] of markup.matchAll(/id="([^"]+)"/g)) {
    nodes[id] = { hidden: id === 'crew-panel', textContent: '', scrollTop: 0, scrollHeight: 900, clientHeight: 150,
      attributes: {}, listeners: {}, setAttribute(k, v) { this.attributes[k] = v; },
      addEventListener(k, fn) { this.listeners[k] = fn; } };
  }
  let reads = 0, tick;
  const document = { hidden: false, dialogOpen: false, querySelector() { return this.dialogOpen ? {} : null; } };
  const context = { $: id => nodes[id], document, CREW_POLL_MS: 1500,
    localStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v) },
    api: async () => ({ text: 'latest ' + ++reads, elapsed: reads }), span: n => n + 's',
    setInterval: fn => { tick = fn; } };
  vm.createContext(context); vm.runInContext(code, context);
  return { nodes, context, document, storage, tick: () => tick(), reads: () => reads,
    open() { context.openCrew({ id: 'server' }, { task: 'long-worker-task', track: 'W1', lines: ['initial'] }); },
    escape(props = {}) {
      const e = { key: 'Escape', preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...props };
      nodes['crew-panel'].listeners.keydown(e); return e;
    } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('crew is a non-modal fixed bottom-right card with internal scrolling and mobile key clearance', () => {
  assert.match(markup, /role="region"/);
  assert.doesNotMatch(markup, /aria-modal/);
  const card = css.match(/#crew-panel\{([^}]+)\}/)[1];
  for (const rule of ['position:fixed', 'right:max(16px,env(safe-area-inset-right))', 'bottom:max(16px,env(safe-area-inset-bottom))',
    'width:min(420px,calc(100vw - 32px))', 'max-height:min(46vh,360px)', 'display:flex', 'flex-direction:column', 'margin:0', 'box-shadow:var(--shadow)']) assert.ok(card.includes(rule), rule);
  assert.ok(Number(card.match(/z-index:(\d+)/)[1]) < Number(css.match(/\.file-viewer \{[^}]*z-index:(\d+)/)[1]));
  assert.match(css, /#crew-output\{[^}]*min-height:0[^}]*overflow:auto/);
  assert.match(css, /#crew-panel\[hidden\],#crew-output\[hidden\]\{display:none\}/);
  assert.match(css, /#app\.narrow #crew-panel,#app\.compact #crew-panel\{[^}]*width:calc\(100vw - 16px\)[^}]*bottom:calc\(52px/);
  assert.match(css, /#app\.compact #crew-panel\{bottom:calc\(105px/);
  assert.doesNotMatch(code, /scrollIntoView/);
});

test('minimize hides only output, toggles its label and persists across reloads and reopen', async () => {
  const f = fixture(); f.open(); await flush();
  assert.equal(f.nodes['crew-title'].title, 'long-worker-task / W1');
  assert.equal(f.nodes['crew-output'].hidden, false);
  f.nodes['crew-min'].onclick();
  assert.equal(f.nodes['crew-output'].hidden, true);
  assert.equal(f.nodes['crew-panel'].hidden, false);
  assert.equal(f.nodes['crew-min'].textContent, 'Mở rộng');
  assert.equal(f.nodes['crew-min'].attributes['aria-expanded'], 'false');
  assert.equal(fixture(f.storage).nodes['crew-output'].hidden, true);
  f.context.closeCrew(); f.open(); await flush();
  assert.equal(f.nodes['crew-output'].hidden, true);
  f.nodes['crew-min'].onclick();
  assert.equal(f.nodes['crew-output'].hidden, false);
  assert.equal(f.nodes['crew-min'].textContent, 'Thu nhỏ');
  assert.equal(fixture(f.storage).nodes['crew-output'].hidden, false);
});

test('minimized polling updates output and status, preserves scroll position, and still pauses', async () => {
  const f = fixture(); f.open(); await flush();
  const out = f.nodes['crew-output']; out.scrollTop = 70; out.onscroll();
  f.nodes['crew-min'].onclick(); out.scrollTop = 0; out.onscroll();
  f.tick(); await flush();
  assert.equal(out.textContent, 'latest 2');
  assert.match(f.nodes['crew-status'].textContent, /2s/);
  f.nodes['crew-min'].onclick(); assert.equal(out.scrollTop, 70);
  out.scrollTop = 900; out.onscroll(); f.nodes['crew-min'].onclick();
  f.tick(); await flush(); f.nodes['crew-min'].onclick(); assert.equal(out.scrollTop, 900);
  f.nodes['crew-pause'].onclick(); f.tick(); await flush(); assert.equal(f.reads(), 3);
});

test('Escape within the popup closes and stops bubbling to the file viewer', async () => {
  const f = fixture(); f.open(); await flush();
  const e = f.escape();
  assert.equal(f.nodes['crew-panel'].hidden, true);
  assert.equal(e.defaultPrevented, true); assert.equal(e.stopped, true);
  f.tick(); await flush(); assert.equal(f.reads(), 1);
  assert.equal(f.document.onkeydown, undefined); // No global Escape handler or focus trap.
});

test('composition, handled keys, and native dialogs retain Escape handling', () => {
  for (const props of [{ isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }, { key: 'Enter' }]) {
    const f = fixture(); f.open(); f.escape(props); assert.equal(f.nodes['crew-panel'].hidden, false);
  }
  const f = fixture(); f.open(); f.document.dialogOpen = true;
  assert.equal(f.escape().stopped, undefined); assert.equal(f.nodes['crew-panel'].hidden, false);
});

test('unavailable localStorage does not prevent opening or minimizing', () => {
  const f = fixture({ get() { throw Error('denied'); }, set() { throw Error('denied'); } });
  f.open(); f.nodes['crew-min'].onclick(); assert.equal(f.nodes['crew-output'].hidden, true);
});
