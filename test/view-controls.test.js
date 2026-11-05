'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const controls = require('../public/view-controls');
const appSource = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');

function node(parent = null) {
  const classes = new Set(), listeners = {};
  return { parent, hidden: false, style: { setProperty(k, v) { this[k] = v; } }, attrs: {}, listeners,
    classList: { contains: c => classes.has(c), toggle(c, enabled) { if (enabled) classes.add(c); else classes.delete(c); } },
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(k, fn, options) { (listeners[k] ||= []).push({ fn, options }); },
    dispatch(k, props = {}) { const e = { target: this, ...props }; for (const { fn } of listeners[k] || []) fn(e); return e; },
    contains(n) { for (; n; n = n.parent) if (n === this) return true; return false; },
    append(...children) { for (const child of children) child.parent = this; },
  };
}
function fixture({ platform = 'MacIntel', userAgent = '', storage = new Map(), compact = false, native = false, denied = false } = {}) {
  const app = node(), document = node(), window = node(), crewPanel = node(), crewOutput = node(crewPanel);
  const terminalHost = node(), calls = [], hints = [], panes = [];
  let composing = false, fits = 0, shown = 0;
  app.classList.toggle('compact', compact); crewPanel.hidden = true;
  document.documentElement = { async requestFullscreen() {
    calls.push(true); if (denied) throw Error('denied');
    document.fullscreenElement = this; document.dispatch('fullscreenchange');
  } };
  document.exitFullscreen = async () => { calls.push(false); document.fullscreenElement = null; document.dispatch('fullscreenchange'); };
  if (native) window.TW_DESKTOP = { async setFullscreen(enabled) { calls.push(enabled); } };
  const o = { app, document, window, crewPanel, crewOutput, terminalHost, navigator: { platform, userAgent },
    storage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v) },
    composing: () => composing, panes: () => panes, fit() { fits++; }, say: (...args) => hints.push(args),
    showTerminal() { shown++; } };
  for (const k of ['termMinus', 'termPlus', 'termReset', 'crewMinus', 'crewPlus', 'fullscreenButton', 'exitChip']) o[k] = node();
  o.exitChip.hidden = true;
  const c = controls(o);
  function key(props = {}, type = 'keydown', viaDocument = true) {
    const e = { type, key: '=', metaKey: platform.includes('Mac'), ctrlKey: !platform.includes('Mac'),
      target: terminalHost, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...props };
    if (viaDocument) return document.dispatch(type, e);
    c.handleKey(e); return e;
  }
  return { c, o, app, document, window, storage, panes, calls, hints, key,
    composing(v) { composing = v; }, fits: () => fits, shown: () => shown };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('global terminal size steps, clamps, resets, persists and initializes new panes', () => {
  const f = fixture(); assert.equal(f.c.font(), 13);
  f.panes.push({ term: { options: { fontSize: 13 } } }, { term: { options: { fontSize: 13 } } });
  f.o.termPlus.onclick(); assert.equal(f.c.font(), 14);
  assert.ok(f.panes.every(p => p.term.options.fontSize === 14)); assert.equal(f.fits(), 1);
  assert.equal(f.storage.get('tw-term-font'), '14'); assert.equal(fixture({ storage: f.storage }).c.font(), 14);
  for (let i = 0; i < 40; i++) f.c.zoom('terminal', 1);
  assert.equal(f.c.font(), 28); assert.match(f.o.termPlus.title, /28 px/);
  for (let i = 0; i < 40; i++) f.c.zoom('terminal', -1);
  assert.equal(f.c.font(), 9);
  f.o.termReset.onclick(); assert.equal(f.c.font(), 13);
  const compact = fixture({ compact: true }); assert.equal(compact.c.font(), 12);
  compact.c.zoom('terminal', 1); compact.c.zoom('terminal', 0); assert.equal(compact.c.font(), 12);
  assert.equal(fixture({ storage: new Map([['tw-term-font', '100']]) }).c.font(), 28);
  assert.equal(fixture({ storage: new Map([['tw-term-font', 'broken']]) }).c.font(), 13);
});

test('Crew uses its own persisted CSS size and bounds, without affecting terminal or popup geometry', () => {
  const f = fixture(); f.o.crewPlus.onclick();
  assert.equal(f.o.crewOutput.style['--crew-font'], '13px'); assert.equal(f.c.font(), 13);
  assert.equal(f.storage.get('tw-crew-font'), '13'); assert.equal(f.storage.has('tw-term-font'), false);
  for (let i = 0; i < 40; i++) f.c.zoom('crew', 1);
  assert.equal(f.o.crewOutput.style['--crew-font'], '24px');
  for (let i = 0; i < 40; i++) f.c.zoom('crew', -1);
  assert.equal(f.o.crewOutput.style['--crew-font'], '9px');
  f.c.zoom('crew', 0); assert.equal(f.o.crewOutput.style['--crew-font'], '12px');
  assert.equal(f.o.crewPanel.style.height, undefined);
  assert.match(fs.readFileSync(require.resolve('../public/app.css'), 'utf8'), /#crew-output\{font-size:var\(--crew-font,12px\);height:250px\}/);
  assert.equal(fixture({ storage: f.storage }).o.crewOutput.style['--crew-font'], '12px');
});

test('blocked localStorage is optional for reading and writing both preferences', () => {
  const f = fixture({ storage: { get() { throw Error('denied'); }, set() { throw Error('denied'); } } });
  f.c.zoom('terminal', 1); f.c.zoom('crew', 1);
  assert.equal(f.c.font(), 14); assert.equal(f.o.crewOutput.style['--crew-font'], '13px');
});

test('platform modifiers, equals/plus/minus/zero and numpad combos are consumed exactly once', () => {
  for (const platform of ['MacIntel', 'Win32', 'Linux x86_64']) {
    for (const props of [{ key: '+' }, { key: '=' }, { key: 'Add', code: 'NumpadAdd' }, { key: '-' }, { key: 'Subtract', code: 'NumpadSubtract' }, { key: '0' }]) {
      const f = fixture({ platform });
      const e = { type: 'keydown', key: '=', target: f.o.terminalHost,
        metaKey: platform === 'MacIntel', ctrlKey: platform !== 'MacIntel', ...props,
        preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
      f.document.listeners.keydown[0].fn(e);
      assert.equal(e.defaultPrevented, true); assert.equal(e.stopped, true);
      const expected = props.key === '0' ? 13 : ['-', 'Subtract'].includes(props.key) ? 12 : 14;
      assert.equal(f.c.font(), expected);
      assert.equal(f.c.handleKey(e), true); assert.equal(f.c.font(), expected, 'xterm must not apply a captured event twice');
      assert.equal(f.c.handleKey({ ...e, type: 'keyup' }), true); assert.equal(f.c.font(), expected);
    }
    const f = fixture({ platform });
    assert.equal(f.c.handleKey({ type: 'keydown', key: '-', ctrlKey: platform === 'MacIntel', metaKey: platform !== 'MacIntel' }), false);
  }
  const fallback = fixture({ platform: '', userAgent: 'Mozilla Macintosh' });
  fallback.key({ metaKey: true, ctrlKey: false }, 'keydown', false); assert.equal(fallback.c.font(), 14);
});

test('Crew target follows popup descendants and last pointer/focus until an outside interaction or close', () => {
  const f = fixture(); f.o.crewPanel.hidden = false;
  f.key({ target: f.o.crewOutput }); assert.equal(f.o.crewOutput.style['--crew-font'], '13px');
  f.document.dispatch('pointerdown', { target: f.o.crewOutput });
  f.key({ target: f.document }); assert.equal(f.o.crewOutput.style['--crew-font'], '14px');
  f.document.dispatch('focusin', { target: f.o.terminalHost });
  f.key(); assert.equal(f.c.font(), 14);
  f.document.dispatch('focusin', { target: f.o.crewOutput }); f.key({ key: '0' });
  assert.equal(f.o.crewOutput.style['--crew-font'], '12px');
  f.o.crewPanel.hidden = true; f.key(); assert.equal(f.c.font(), 15);
});

test('Ctrl+wheel is non-passive, cancelled and throttled per surface; plain scroll stays native', () => {
  const f = fixture();
  for (const [host, target, options] of [[f.o.terminalHost, 'terminal', { passive: false, capture: true }], [f.o.crewOutput, 'crew', { passive: false }]]) {
    assert.deepEqual(host.listeners.wheel[0].options, options);
    let prevented = 0;
    const e = { ctrlKey: true, deltaY: -1, preventDefault() { prevented++; }, stopPropagation() {} };
    host.dispatch('wheel', e); host.dispatch('wheel', e); assert.equal(prevented, 2);
    if (target === 'terminal') assert.equal(f.c.font(), 14); else assert.equal(f.o.crewOutput.style['--crew-font'], '13px');
    host.dispatch('wheel', { ...e, ctrlKey: false }); assert.equal(prevented, 2);
  }
});

test('terminal zoom and fullscreen defer while IME is active; marked key events do not mutate or leak', async () => {
  const f = fixture({ native: true }); const pane = { term: { options: { fontSize: 13 } } }; f.panes.push(pane);
  f.composing(true); f.c.zoom('terminal', 1); f.c.zoom('terminal', 1);
  assert.equal(pane.term.options.fontSize, 13); assert.equal(f.fits(), 0);
  f.key({ key: 'F11', metaKey: false }); assert.equal(f.app.classList.contains('fs'), false);
  f.c.flush(); assert.equal(f.fits(), 0);
  f.composing(false); f.c.flush(); await flush();
  assert.equal(pane.term.options.fontSize, 15); assert.equal(f.app.classList.contains('fs'), true);
  const before = f.c.font(); f.key({ isComposing: true }); f.key({ keyCode: 229 });
  assert.equal(f.c.font(), before);
});

test('browser fullscreen, exit chip and external fullscreenchange stay in sync; Escape remains a terminal key', async () => {
  const f = fixture(); f.o.fullscreenButton.onclick(); await flush();
  assert.equal(f.app.classList.contains('fs'), true); assert.equal(f.o.exitChip.hidden, false);
  assert.ok(f.shown() >= 1); assert.equal(f.o.fullscreenButton.attrs['aria-pressed'], 'true');
  f.o.exitChip.onclick(); await flush(); assert.deepEqual(f.calls, [true, false]);
  assert.equal(f.app.classList.contains('fs'), false); assert.equal(f.o.exitChip.hidden, true);
  f.o.fullscreenButton.onclick(); await flush(); f.document.fullscreenElement = null; f.document.dispatch('fullscreenchange');
  assert.equal(f.app.classList.contains('fs'), false);
  assert.equal(f.c.handleKey({ type: 'keydown', key: 'Escape' }), false);
});

test('F11 and platform Shift+F use the desktop bridge and OS events synchronize focus mode', async () => {
  for (const platform of ['MacIntel', 'Linux x86_64']) {
    const f = fixture({ platform, native: true });
    f.key({ key: 'F11', metaKey: false, ctrlKey: false }); await flush();
    assert.equal(f.app.classList.contains('fs'), true);
    f.key({ key: 'F', shiftKey: true }); await flush(); assert.deepEqual(f.calls, [true, false]);
    f.window.dispatch('tw-fullscreen', { detail: true }); assert.equal(f.app.classList.contains('fs'), true);
    f.window.dispatch('tw-fullscreen', { detail: false }); assert.equal(f.o.exitChip.hidden, true);
    assert.equal(fixture({ storage: f.storage }).app.classList.contains('fs'), false);
  }
});

test('fullscreen denial retains usable focus mode with a hint and exit', async () => {
  const f = fixture({ denied: true }); f.o.fullscreenButton.onclick(); await flush();
  assert.equal(f.app.classList.contains('fs'), true); assert.match(f.hints[0][0], /không mở được/);
  f.o.exitChip.onclick(); await flush(); assert.equal(f.app.classList.contains('fs'), false);
});

// Run createPane itself: key handlers and fit -> onResize must use production wiring.
function terminalFixture(f) {
  const output = [], resizes = [];
  class Terminal {
    constructor(options) { this.options = options; this.cols = 80; this.rows = 24; }
    loadAddon(fit) { fit.term = this; }
    open() {} registerLinkProvider() {}
    attachCustomKeyEventHandler(fn) { this.handle = fn; }
    onData(fn) { this.data = fn; } onBinary(fn) { this.binary = fn; } onResize(fn) { this.resize = fn; }
  }
  class FitAddon { fit() { this.term.resize({ cols: Math.floor(800 / this.term.options.fontSize), rows: 20 }); } }
  const window = { Terminal, FitAddon: { FitAddon }, FileViewer: { provider() {} },
    TerminalIME: { attach(term, send, options) { term.send = send; term.idle = options.onIdle; return { onData: send, isComposing: () => false }; } } };
  const ctx = { window, wallOn: false, viewControls: f.c, panes: f.panes, focusedPane: 0, el: () => node(), $: () => f.o.terminalHost,
    ResizeObserver: class { observe() {} }, TextEncoder, paneInputIdle() {}, focusPane() {}, connectPane() {}, fitPane() {},
    vis: () => [], closePane() {}, fileViewer: {}, navigator: {}, say() {}, api: async () => ({}), setInterval: () => 0, clearTimeout() {}, setTimeout: () => 0, Math };
  vm.runInNewContext(appSource.slice(appSource.indexOf('  // ---- Scrollback'), appSource.indexOf('  function syncPanePickers(')), ctx);
  vm.runInNewContext(appSource.slice(appSource.indexOf('  function fitPane('), appSource.indexOf('  function sendData(')), ctx);
  ctx.view = 'focus';
  f.o.fit = () => ctx.sizeTerm();
  ctx.createPane(); const p = f.panes[0]; p.host.clientWidth = 800; p.host.clientHeight = 600;
  p.ws = { readyState: 1, send(data) { if (typeof data === 'string') resizes.push(JSON.parse(data)); else output.push(data); } };
  return { p, output, resizes };
}

test('xterm custom handler blocks shortcut PTY output and font changes drive existing fit/PTY resize', () => {
  for (const platform of ['MacIntel', 'Win32']) {
    const f = fixture({ platform }); const { p, output, resizes } = terminalFixture(f);
    for (const key of ['=', '-', '0', 'F11']) {
      const e = { type: 'keydown', key, metaKey: platform === 'MacIntel' && key !== 'F11', ctrlKey: platform !== 'MacIntel' && key !== 'F11',
        preventDefault() {}, stopPropagation() {} };
      if (p.term.handle(e)) p.term.send(key);
    }
    assert.equal(output.length, 0);
    f.c.zoom('terminal', 1);
    assert.equal(p.term.options.fontSize, 14);
    assert.deepEqual(resizes.at(-1), { t: 'resize', cols: 57, rows: 20 });
    if (platform === 'MacIntel') {
      const e = { type: 'keydown', key: '-', ctrlKey: true };
      if (p.term.handle(e)) p.term.send('-');
      assert.equal(new TextDecoder().decode(output[0]), '-');
    }
  }
});

test('markup, static route, desktop permission and active-pane focus styles expose the controls', () => {
  const html = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
  const css = fs.readFileSync(require.resolve('../public/app.css'), 'utf8');
  const server = fs.readFileSync(require.resolve('../server.js'), 'utf8');
  assert.ok(html.indexOf('/view-controls.js') < html.indexOf('/app.js'));
  assert.match(server, /'\/view-controls.js':/);
  for (const id of ['term-font-minus', 'term-font-plus', 'term-font-reset', 'term-fullscreen', 'crew-font-minus', 'crew-font-plus', 'fullscreen-exit']) assert.ok(html.includes('id="' + id + '"'));
  assert.match(css, /#app\.fs \.pane:not\(\.active\)\{display:none\}/);
  assert.match(css, /#app\.fs \.top,#app\.fs \.side,[^}]*\.tabs,[^}]*\.detail,[^}]*\{display:none\}/);
  assert.match(appSource, /onIdle: function \(\) \{ paneInputIdle\(\); viewControls.flush\(\)/);
  assert.match(fs.readFileSync(require.resolve('../desktop/src/bridge.js'), 'utf8'), /setFullscreen: enabled => invoke\('set_fullscreen', \{enabled\}\)/);
  assert.match(fs.readFileSync(require.resolve('../desktop/permissions/bridge.toml'), 'utf8'), /commands.allow = .*"set_fullscreen"/);
});

test('on the Windows desktop app focus mode is page-only: no native full screen, and OS events cannot cancel it', async () => {
  const f = fixture({ platform: 'Win32', native: true });
  f.key({ key: 'F11', metaKey: false, ctrlKey: false }); await flush();
  assert.equal(f.app.classList.contains('fs'), true); assert.deepEqual(f.calls, []);   // the bridge was never asked for the OS full screen
  f.window.dispatch('tw-fullscreen', { detail: false }); assert.equal(f.app.classList.contains('fs'), true);   // a Resized/Focused event does not undo it
  f.o.exitChip.onclick(); await flush(); assert.equal(f.app.classList.contains('fs'), false); assert.deepEqual(f.calls, []);
  const browser = fixture({ platform: 'Win32', native: false });   // a browser on Windows still uses the Fullscreen API
  browser.key({ key: 'F11', metaKey: false, ctrlKey: false }); await flush(); assert.deepEqual(browser.calls, [true]);
});
