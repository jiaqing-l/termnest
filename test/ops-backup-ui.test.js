'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chatMessages } = require('../public/features/server-backup');
const jsonl = items => items.map(x => JSON.stringify(x)).join('\n');
test('Claude user and assistant text is readable; tools and images are hidden', () => {
  assert.deepEqual(chatMessages(jsonl([
    { type: 'user', message: { role: 'user', content: 'Explain this' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret bookkeeping' }, { type: 'text', text: 'Readable answer' }, { type: 'tool_use', name: 'bash', input: 'private command' }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'machine output' }, { type: 'image', source: 'https://invalid' }] } }
  ])), [{ role: 'user', text: 'Explain this' }, { role: 'assistant', text: 'Readable answer' }]);
});
test('Codex response_item messages take precedence over event duplicates', () => {
  const records = [
    { type: 'event_msg', payload: { type: 'user_message', message: 'Question' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Question' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Answer' }] } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'Answer' } },
    { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: 'bookkeeping' } }
  ];
  assert.deepEqual(chatMessages(jsonl(records)), [{ role: 'user', text: 'Question' }, { role: 'assistant', text: 'Answer' }]);
});
test('event-only chat works and ignores malformed tail records and nonmessages', () => {
  assert.deepEqual(chatMessages('partial tail\nnull\n' + jsonl([
    { type: 'event_msg', payload: { type: 'agent_message', message: 'Fallback' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'Fallback' } },
    { type: 'event_msg', payload: { type: 'token_count', message: 'hidden' } }
  ])), [{ role: 'assistant', text: 'Fallback' }]);
});
test('parser preserves literal untrusted text and repeated actual turns for safe DOM rendering', () => {
  const content = '<img src=x onerror=alert(1)> tiếng Việt 🦉';
  assert.deepEqual(chatMessages(jsonl([1, 2].map(() => ({ message: { role: 'user', content } })))), [{ role: 'user', text: content }, { role: 'user', text: content }]);
});
test('all dynamic backup labels exist in both languages with matching interpolation', () => {
  const fs = require('node:fs'), path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '../public/features/server-backup.js'), 'utf8');
  const vi = require('../public/locales/vi.json'), en = require('../public/locales/en.json');
  const keys = [...source.matchAll(/\bt\('([a-z_]+)'/g)].map(m => m[1]).concat(['online','offline','automatic','paused','user','assistant','complete','partial','files_coverage','coverage','saved_partial']);
  for (const key of keys) {
    assert.ok(vi['backup.' + key], key); assert.ok(en['backup.' + key], key);
    assert.deepEqual(vi['backup.' + key].match(/\{\d+\}/g), en['backup.' + key].match(/\{\d+\}/g));
  }
});

test('fallback-only turns retain their position among response items', () => {
  assert.deepEqual(chatMessages(jsonl([
    { type: 'event_msg', payload: { type: 'user_message', message: 'Fallback question' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Response answer' }] } }
  ])), [{ role: 'user', text: 'Fallback question' }, { role: 'assistant', text: 'Response answer' }]);
});

test('unknown and unheard findings render a neutral empty state without fake urgency in both languages', () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../public/features/ops.js'), 'utf8');
  // Run the production draw function with a small DOM adapter; do not duplicate its finding filter.
  const drawSource = source.slice(source.indexOf('  function draw() {'), source.indexOf('  function load() {'));
  function element(tag, className = '', text = '') {
    return {
      tag, className, children: [], value: text,
      append(...nodes) { this.children.push(...nodes); },
      querySelector() { return null; }, querySelectorAll() { return []; },
      get textContent() { return this.value + this.children.map(n => typeof n === 'string' ? n : n.textContent).join(''); },
      set textContent(value) { this.value = value; this.children = []; }
    };
  }
  for (const [lang, expected] of [['vi', 'Chưa có mục cần thao tác'], ['en', 'No items need action']]) {
    const locale = require('../public/locales/' + lang + '.json');
    const context = {
      pluginPage: null, plug: null, pluginTab: null, supervisionBox: null, editing: false,
      page: element('main'), tab: element('button'), supervisionForm: element('details'),
      data: { servers: [{ id: 'vm1', online: true, findings: [] }] },
      TW: {}, el: element, SEV: { urgent: 0, warn: 1, info: 2 }, filt: {},
      i18n: key => locale[key] || key, quotaFindings: () => [],
      supervisionCard: () => element('section'), summary: () => element('div'),
      button: label => element('button', '', label), logList: () => element('div'),
      keepOpen: () => {}, group: () => 'issue', icon: () => element('span'),
      row: finding => element('div', 'finding', finding.rule),
      document: { createTextNode: text => text }
    };
    vm.createContext(context); vm.runInContext(drawSource, context);
    for (const rules of [['unknown'], ['unheard'], ['unknown', 'unheard']]) {
      context.data.servers[0].findings = rules.map(rule => ({ rule, severity: 'urgent' }));
      context.draw();
      const groups = context.page.children.find(n => n.className === 'ops-groups');
      assert.equal(groups.textContent, expected, lang + ': ' + rules.join(','));
      assert.equal(groups.children.length, 1);
      assert.equal(groups.children[0].tag, 'section', 'no actionable finding group');
      assert.equal(context.tab.children.length, 0, 'no urgent badge for unreadable status');
      assert.doesNotMatch(groups.textContent, /Mọi phiên đều ổn|All sessions look fine/i);
    }
    context.data.servers[0].findings.push({ rule: 'aborted', severity: 'urgent' });
    context.draw();
    const groups = context.page.children.find(n => n.className === 'ops-groups');
    assert.equal(groups.children[0].tag, 'details', 'real actionable finding still appears');
    assert.match(groups.textContent, /aborted/);
    assert.equal(context.tab.children[0].textContent, '1', 'badge counts only the actionable finding');
  }
});
