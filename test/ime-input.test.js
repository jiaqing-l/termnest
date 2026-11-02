'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { attach } = require('../public/ime-input');

class Element {
  constructor() {
    this.listeners = []; this.children = []; this.style = { left: '24px', top: '16px', width: '8px', height: '16px', setProperty(k, v) { this[k] = v; } };
    const classes = new Set();
    this.classList = { add: k => classes.add(k), remove: k => classes.delete(k), contains: k => classes.has(k) };
    this.ownerDocument = { createElement: () => new Element() };
  }
  addEventListener(type, fn, capture = false) { this.listeners.push({ type, fn, capture }); }
  removeEventListener(type, fn, capture) { this.listeners = this.listeners.filter(l => l.type !== type || l.fn !== fn || l.capture !== capture); }
  appendChild(node) { this.children.push(node); node.parentNode = this; }
  setAttribute() {}
  querySelector() { return null; }
  getBoundingClientRect() { return this.bounds || { left: 0, top: 0, right: this.textContent.length * 8, width: this.textContent.length * 8, height: 16 }; }
  remove() { this.parentNode.children = this.parentNode.children.filter(n => n !== this); }
}
function fixture(enabled = true, onIdle) {
  const host = new Element(), area = new Element(), helpers = new Element(), writes = [], native = [];
  host.appendChild(helpers); helpers.appendChild(area);
  area.value = ''; area.selectionStart = area.selectionEnd = 0;
  const injections = [];
  const term = { element: host, textarea: area, options: { fontFamily: 'monospace', fontSize: 13 }, getSelection: () => 'selected', hasSelection: () => false,
    input(data, wasUserInput) { injections.push([data, wasUserInput]); if (!term.options.disableStdin) ime.onData(data); } };
  // These are registered first, just as in xterm.open(). The bridge must run
  // BEFORE textarea capture listeners, not merely filter duplicate onData.
  for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'input', 'keydown', 'keypress', 'keyup', 'paste']) {
    area.addEventListener(type, e => {
      native.push([type, e.key || e.data]);
      if (type === 'keydown' && e.key === 'Enter') { ime.onData('\r'); e.preventDefault(); }
      if (type === 'keydown' && e.key === 'ArrowLeft') { ime.onData('\x1b[D'); e.preventDefault(); }
      if (type === 'keydown' && e.ctrlKey && e.key === 'c' && !e.shiftKey) { ime.onData('\x03'); e.preventDefault(); }
      if (type === 'paste') { ime.onData('\x1b[200~' + e.text + '\x1b[201~'); e.preventDefault(); }
    }, true);
  }
  const ime = attach(term, text => writes.push(text), { enabled, onIdle });
  function event(type, props = {}) {
    const e = { target: area, type, key: '', code: '', keyCode: 0, isComposing: false, data: null, defaultPrevented: false,
      stopImmediatePropagation() { this.stopped = true; }, preventDefault() { this.defaultPrevented = true; }, ...props };
    const path = [host, helpers, area];
    for (const node of path) for (const l of node.listeners) {
      if (e.stopped) return e;
      if (l.type === type && l.capture) l.fn(e);
    }
    for (const node of path.reverse()) for (const l of node.listeners) {
      if (e.stopped) return e;
      if (l.type === type && !l.capture) l.fn(e);
    }
    return e;
  }
  function value(text) { area.value = text; area.selectionStart = area.selectionEnd = text.length; }
  function input(text, data = text, inputType = 'insertText', isComposing = false) {
    value(text); return event('input', { data, inputType, isComposing });
  }
  function type(text) {
    for (const key of text) {
      const code = 'Key' + key.toUpperCase();
      const e = event('keydown', { key, code });
      if (!e.defaultPrevented) { event('keypress', { key, code }); input(area.value + key, key); }
      event('keyup', { key, code });
    }
  }
  function compose(texts, prefix = '') {
    event('compositionstart');
    for (const data of texts) {
      event('keydown', { key: 'Process', keyCode: 229 });
      event('compositionupdate', { data });
      input(prefix + data, data, 'insertCompositionText', true);
      assert.equal(helpers.children.at(-1).textContent, data);
    }
  }
  return { host, area, helpers, ime, writes, native, event, input, type, compose, value, term, injections };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 15));

test('Telex v i e e t j previews every marked edit and sends việt once, normalized', async () => {
  const f = fixture(); f.compose(['v', 'vi', 'vie', 'viê', 'viêt', 'việt']);
  assert.deepEqual(f.writes, []); assert.equal(f.ime.isComposing(), true);
  f.event('compositionend', { data: 'việt' }); await tick();
  assert.deepEqual(f.writes, ['việt']); assert.equal(f.ime.isComposing(), false);
  assert.equal(f.helpers.children.at(-1).hidden, true);
  assert.deepEqual(f.native, []);
});

test('final input before or after compositionend commits exactly once', async () => {
  for (const order of ['before', 'after', 'later']) {
    const f = fixture(); f.compose(['v', 'vi', 'việt']);
    if (order === 'before') f.input('việt', 'việt', 'insertText');
    f.event('compositionend', { data: 'việt' });
    if (order === 'later') await tick();
    if (order !== 'before') f.input('việt', 'việt', 'insertReplacementText');
    await tick(); assert.deepEqual(f.writes, ['việt'], order);
  }
});

test('compositionend can precede the last DOM mutation; cancellation sends nothing', async () => {
  const f = fixture(); f.compose(['viêt']); f.event('compositionend', { data: 'việt' });
  await tick(); assert.deepEqual(f.writes, ['việt']);
  const canceled = fixture(); canceled.compose(['việt']); canceled.event('compositionend', { data: '' });
  canceled.value(''); await tick(); assert.deepEqual(canceled.writes, []);
});

test('preview anchors at the public cursor even before PTY output and stays visible at the right edge', () => {
  const f = fixture(), screen = new Element(); screen.bounds = { left: 5, top: 4, right: 805, width: 800, height: 384 };
  f.host.querySelector = () => screen; f.helpers.bounds = { left: 5, top: 4 };
  f.term.cols = 100; f.term.rows = 24; f.term.buffer = { active: { cursorX: 99, cursorY: 23, baseY: 0, viewportY: 0 } };
  f.area.style.left = '-9999em'; f.compose(['việt']);
  assert.equal(f.area.style['--tw-ime-left'], '792px'); assert.equal(f.area.style['--tw-ime-top'], '368px');
  assert.equal(f.helpers.children.at(-1).style.left, '768px'); assert.deepEqual(f.writes, []);
});

test('final WebKit input without compositionend commits and releases guards', () => {
  const f = fixture(); f.compose(['viê']); f.input('việt', 'việt', 'insertCompositionText', false);
  assert.deepEqual(f.writes, ['việt']); assert.equal(f.ime.isComposing(), false);
});

test('ASCII including repeated characters is unchanged; arrows, Ctrl+C and paste use xterm', () => {
  const f = fixture(); f.type('hello WORLD!!'); assert.equal(f.writes.join(''), 'hello WORLD!!');
  f.event('keydown', { key: 'ArrowLeft' }); f.event('keydown', { key: 'c', ctrlKey: true });
  f.event('paste', { text: 'dán\ntext' });
  assert.deepEqual(f.writes.slice(-3), ['\x1b[D', '\x03', '\x1b[200~dán\ntext\x1b[201~']);
  for (const props of [{ key: 'c', metaKey: true }, { key: 'c', ctrlKey: true, shiftKey: true }, { key: 'v', metaKey: true }]) {
    assert.equal(f.event('keydown', props).stopped, undefined);
  }
});

test('bridge uses public user input semantics; terminal selection is never erased from the PTY', () => {
  const f = fixture(); f.type('abc'); f.value('selected terminal output'); f.type('v');
  assert.equal(f.writes.join(''), 'abcv'); assert.ok(f.injections.every(entry => entry[1] === true));
  f.term.options.disableStdin = true; f.type('blocked'); assert.equal(f.writes.join(''), 'abcv');
});

test('Enter confirming composition stays native; next Enter sends one CR after the commit', async () => {
  const f = fixture(); f.compose(['việt']);
  const enter = f.event('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
  assert.equal(enter.defaultPrevented, false); assert.deepEqual(f.writes, []);
  f.event('compositionend', { data: 'việt' }); f.event('keyup', { key: 'Enter', code: 'Enter' });
  f.event('keydown', { key: 'Enter', code: 'Enter' }); await tick();
  assert.deepEqual(f.writes, ['việt', '\r']);
});

test('copy preserves active marked text; browser and desktop paste commit it before pasting', () => {
  for (const desktop of [false, true]) {
    const f = fixture(); f.compose(['việt']);
    assert.equal(f.event('keydown', { key: 'c', metaKey: true }).stopped, undefined);
    assert.equal(f.ime.isComposing(), true); assert.deepEqual(f.writes, []);
    assert.equal(f.event('keydown', { key: 'c', ctrlKey: true, shiftKey: true }).stopped, undefined);
    if (desktop) {
      f.event('keydown', { key: 'v', metaKey: true }); f.ime.preparePaste(); f.ime.onData('dán');
    } else f.event('paste', { text: 'dán' });
    assert.deepEqual(f.writes, ['việt', desktop ? 'dán' : '\x1b[200~dán\x1b[201~']);
    f.event('compositionend', { data: 'việt' }); assert.equal(f.writes.length, 2);
  }
});

test('replacement after commit erases only previously sent graphemes, not UTF-8 bytes', async () => {
  const f = fixture(); f.compose(['viê']); f.event('compositionend', { data: 'viê' }); await tick();
  f.input('việt', 'việt', 'insertReplacementText');
  assert.deepEqual(f.writes, ['viê', '\x7fệt']);
  f.input('việ', null, 'deleteContentBackward');
  assert.deepEqual(f.writes, ['viê', '\x7fệt', '\x7f']);
});

test('backspace-and-retype IME edits produce one DEL per committed character', () => {
  const f = fixture(); f.type('viet');
  f.event('keydown', { key: 'Process', keyCode: 229 });
  f.input('vi', null, 'deleteContentBackward'); f.input('việt', 'ệt');
  assert.deepEqual(f.writes, ['v', 'i', 'e', 't', '\x7f\x7f', 'ệt']);
});

test('composition replaces already committed suffix without resending its prefix', async () => {
  const f = fixture(); f.type('vi'); f.compose(['viê', 'việt']);
  f.event('compositionend', { data: 'việt' }); await tick();
  assert.deepEqual(f.writes, ['v', 'i', 'ệt']);
});

test('rapid consecutive compositions and identical words survive pending timers', async () => {
  const f = fixture();
  f.compose(['việt']); f.event('compositionend', { data: 'việt' });
  f.compose(['việt'], 'việt'); f.event('compositionend', { data: 'việt' });
  await tick(); assert.deepEqual(f.writes, ['việt', 'việt']);
});

test('a space applied by the native commit is retained without duplicating the syllable', async () => {
  const f = fixture(); f.compose(['việt']); f.value('việt ');
  f.event('compositionend', { data: 'việt' }); await tick();
  assert.deepEqual(f.writes, ['việt ']); f.input('việt ', ' ', 'insertText');
  assert.deepEqual(f.writes, ['việt ']);
});

test('blur commits once before xterm clears the textarea, with no focus restoration', async () => {
  const f = fixture(); f.compose(['việt']); f.event('blur'); f.value('');
  f.event('compositionend', { data: 'việt' }); await tick();
  assert.deepEqual(f.writes, ['việt']); assert.equal(f.ime.isComposing(), false);
});

test('CJK on the WebKit bridge previews and commits Unicode text', async () => {
  for (const text of ['你好', '日本語', '한글', '👩🏽‍💻']) {
    const f = fixture(); f.compose([text]); f.event('compositionend', { data: text });
    await tick(); assert.deepEqual(f.writes, [text]);
  }
});

test('other engines retain native xterm composition, keyboard and input events', async () => {
  const f = fixture(false); f.event('compositionstart');
  assert.equal(f.ime.isComposing(), true);
  f.event('compositionupdate', { data: '日本語' }); f.input('日本語', '日本語', 'insertCompositionText', true);
  f.event('compositionend', { data: '日本語' }); await tick();
  assert.equal(f.ime.isComposing(), false); assert.equal(f.native.length, 4); assert.deepEqual(f.writes, []);
});

test('observer guards stay active until xterm has run its delayed native commit', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const order = [], f = fixture(false, () => order.push('idle'));
  f.area.addEventListener('compositionend', () => setTimeout(() => {
    assert.equal(f.ime.isComposing(), true);
    order.push('native commit');
  }, 0));
  f.event('compositionstart'); f.event('compositionend', { data: '你好' });
  assert.equal(f.ime.isComposing(), true);
  // Run the native commit, bridge flush, and deferred idle without wall-clock waits.
  t.mock.timers.tick(0);
  assert.equal(f.ime.isComposing(), false);
  assert.deepEqual(order, ['native commit', 'idle']);
  f.ime.dispose(); assert.equal(f.host.listeners.length, 0);
});

test('idle is deferred through compositionend, disposal removes listeners and cancels sends', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let idle = 0; const f = fixture(true, () => idle++); f.compose(['việt']);
  f.event('compositionend', { data: 'việt' }); assert.equal(idle, 0); assert.equal(f.ime.isComposing(), true);
  t.mock.timers.tick(0); assert.equal(idle, 1);
  f.compose(['mới'], 'việt'); f.event('compositionend', { data: 'mới' }); f.ime.dispose();
  t.mock.timers.tick(0); assert.equal(f.host.listeners.length, 0); assert.equal(f.helpers.children.length, 1);
  assert.deepEqual(f.writes, ['việt']); assert.equal(idle, 1);
});

test('automatic platform gate enables macOS WKWebView/Safari only', () => {
  const source = fs.readFileSync(require.resolve('../public/ime-input'), 'utf8');
  for (const [platform, userAgent, enabled] of [
    ['MacIntel', 'AppleWebKit/605.1.15', true],
    ['MacIntel', 'AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', true],
    ['MacIntel', 'AppleWebKit/537.36 Chrome/130.0', false],
    ['Win32', 'AppleWebKit/537.36 Edg/130.0', false],
    ['Linux x86_64', 'Firefox/130.0', false]
  ]) {
    const context = { navigator: { platform, userAgent }, setTimeout, clearTimeout };
    vm.runInNewContext(source, context);
    const f = fixture(); f.ime.dispose();
    const ime = context.TerminalIME.attach({ textarea: f.area, element: f.host, options: {}, hasSelection: () => false }, () => {});
    assert.equal(!!f.event('keydown', { key: 'a' }).stopped, enabled, userAgent); ime.dispose();
  }
});

const app = fs.readFileSync(require.resolve('../public/app'), 'utf8');
function functionsBetween(first, next) { return app.slice(app.indexOf('  function ' + first + '('), app.indexOf('  function ' + next + '(')); }

test('poll-driven picker sync, automatic focus, fitting, and responsive split cannot disturb composition', () => {
  let busy = true, fits = 0, focuses = 0, resets = 0, domChanges = 0;
  const picker = { set textContent(_) { domChanges++; }, append() { domChanges++; } };
  const pane = { cur: { id: 'local', name: 'test' }, ime: { isComposing: () => busy, reset() {} },
    picker, host: { clientWidth: 800, clientHeight: 600 }, fit: { fit() { fits++; } }, term: { focus() { focuses++; }, reset() { resets++; } } };
  const ctx = { panes: [pane], view: 'focus', focusedPane: 0, pendingSplit: null, pendingPaneWidth: null,
    paneCount: 2, cur: pane.cur, vis: () => [], closePane() {}, el: () => ({}),
    $: () => ({ classList: { toggle() { domChanges++; } } }) };
  vm.runInNewContext(functionsBetween('terminalComposing', 'paneInputIdle') +
    functionsBetween('syncPanePickers', 'sizeTerm') + functionsBetween('resizePanes', 'sig').split('  new ResizeObserver')[0] +
    'function setSplit(n) { if (terminalComposing()) { pendingSplit = n; return; } paneCount = n; }', ctx);
  for (let poll = 0; poll < 4; poll++) {
    ctx.syncPanePickers(); ctx.fitPane(pane); ctx.focusTerminal(pane); ctx.resizePanes(700);
  }
  assert.deepEqual([fits, focuses, resets, domChanges], [0, 0, 0, 0]);
  assert.equal(ctx.pendingPaneWidth, 700);
  busy = false; ctx.syncPanePickers(); ctx.fitPane(pane); ctx.focusTerminal(pane); ctx.resizePanes(700);
  assert.equal(fits, 1); assert.equal(focuses, 1); assert.equal(resets, 1); assert.ok(domChanges > 0);
});

test('split removal is deferred and queued resize, split, reconnect and fitting resume only when all panes are idle', () => {
  let busy = true; const calls = [];
  const ctx = { panes: [{ ime: { isComposing: () => busy } }], pendingPaneWidth: 700, pendingSplit: null,
    resizePanes: w => calls.push(['resize', w]), syncPanePickers: () => calls.push('pickers'),
    connectPane: () => calls.push('connect'), sizeTerm: () => calls.push('fit') };
  vm.runInNewContext(functionsBetween('terminalComposing', 'paneItem') + functionsBetween('setSplit', 'openSession'), ctx);
  ctx.setSplit(1); ctx.paneInputIdle(); assert.deepEqual(calls, []); assert.equal(ctx.pendingSplit, 1);
  // Replace the mutation-heavy split implementation after exercising its guard.
  ctx.setSplit = n => calls.push(['split', n]); busy = false; ctx.paneInputIdle();
  assert.deepEqual(calls, [['resize', 700], ['split', 1], 'pickers', 'connect', 'fit']);
  assert.equal(ctx.pendingPaneWidth, null); assert.equal(ctx.pendingSplit, null);
});

test('IME module is served and loaded before app initialization', () => {
  const html = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
  const server = fs.readFileSync(require.resolve('../server'), 'utf8');
  assert.ok(html.indexOf('src="/ime-input.js"') < html.indexOf('src="/app.js"'));
  assert.match(server, /'\/ime-input.js': \[path.join\(PUB, 'ime-input.js'\), 'text\/javascript; charset=utf-8'\]/);
});
