'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../desktop/src/bridge.js'), 'utf8');
function bridge(origin = 'http://127.0.0.1:7681', frame = false) {
  const calls = [], events = {}, downloads = [];
  class Anchor {
    constructor(href, filename) {this.href = href; this.download = filename;}
    hasAttribute(name) {return name === 'download';}
    click() {throw new Error('Native download was not intercepted');}
  }
  const window = {__TMUX_DESKTOP_ORIGIN: 'http://127.0.0.1:7681', addEventListener() {}, __TAURI_INTERNALS__: {invoke(command, args) {calls.push({command, args}); return Promise.resolve(false);}}};
  window.top = frame ? {} : window;
  const context = {window, location: {origin, href: origin+'/', assign(url) {calls.push({navigation: url});}}, HTMLAnchorElement: Anchor, URL, TextEncoder, Uint8Array,
    alert(message) {calls.push({error: message});}, document: {addEventListener(name, cb) {events[name] = cb;}},
    fetch: async url => {downloads.push(String(url)); return {ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer};}};
  vm.runInNewContext(source, context);
  return {window, calls, events, downloads, Anchor};
}
test('native bridge is only installed in the exact local top-level origin', () => {
  for (const [origin, frame] of [['https://example.com', false], ['http://127.0.0.1:9999', false], ['http://127.0.0.1:7681', true]]) {
    assert.equal(bridge(origin, frame).window.TW_DESKTOP, undefined);
  }
});
test('detached viewer download anchors use native save, external links use explicit opener', async () => {
  const b = bridge();
  new b.Anchor('blob:http://127.0.0.1:7681/file', 'ghi-chú.md').click();
  await new Promise(resolve => setImmediate(resolve));
  const save = b.calls.find(c => c.command === 'save_export');
  assert.equal(save.args.name, 'ghi-chú.md');
  assert.deepEqual(Array.from(save.args.data), [1, 2, 3]);
  new b.Anchor('https://example.com/file', 'foreign.txt').click();
  assert.equal(b.downloads.length, 1);
  assert.ok(b.calls.some(c => c.error));
  b.window.open('https://example.com/doc');
  assert.ok(b.calls.some(c => c.command === 'open_external' && c.args.url === 'https://example.com/doc'));
});
