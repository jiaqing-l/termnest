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

test('production backup reason resolver translates actual API codes to relevant actions in both languages', () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../public/features/server-backup.js'), 'utf8');
  const resolver = source.match(/^  function reason\(code\) \{.*\}$/m)[0];
  const groups = [
    [['quota'], /free space|fewer folders/i, /dọn chỗ|ít thư mục/i],
    [['file_limit', 'job_limit', 'scan_limit'], /select fewer folders/i, /chọn ít thư mục/i],
    [['depth_limit'], /select a more specific folder/i, /chọn thư mục cụ thể/i],
    [['storage_denied'], /storage folder.*permissions/i, /thư mục lưu.*quyền truy cập/i],
    [['source_unavailable'], /check it and reconnect/i, /kiểm tra máy rồi kết nối lại/i],
    [['unsupported_source', 'unsafe_root'], /choose another folder/i, /chọn thư mục.*khác/i],
    [['key_lost', 'key_missing'], /open the app.*check backup access/i, /mở ứng dụng.*kiểm tra quyền truy cập/i],
    [['corrupt_store'], /try another saved copy or back up again/i, /chọn bản khác hoặc sao lưu lại/i],
    [['catalog_missing'], /try backing up again/i, /thử sao lưu lại/i],
    [['vault_backup_failed'], /check storage space and permissions/i, /kiểm tra dung lượng và quyền ghi/i],
    [['vault_locked'], /open and unlock the app/i, /mở và mở khóa ứng dụng/i],
    [['source_changed'], /retry later/i, /thử lại sau/i],
    [['read_failed', 'listing_failed'], /check folder access/i, /kiểm tra quyền truy cập thư mục|kiểm tra quyền truy cập hoặc chọn thư mục/i]
  ];
  for (const [lang, index] of [['en', 1], ['vi', 2]]) {
    const locale = require('../public/locales/' + lang + '.json');
    const context = { i18n: key => locale[key] || key, t: key => locale['backup.' + key] };
    vm.createContext(context); vm.runInContext(resolver, context);
    for (const [codes, ...patterns] of groups) {
      for (const code of codes) {
        const label = context.reason(code);
        assert.notEqual(label, locale['backup.reason_unknown'], lang + ': ' + code);
        assert.match(label, patterns[index - 1], lang + ': ' + code);
        assert.doesNotMatch(label, /backup\.reason_|vault|catalog|key_missing|key_lost/i);
      }
    }
    assert.equal(context.reason('future_code_with_private_details'), lang === 'en' ? 'Could not back up; try again.' : 'Chưa sao lưu được; thử lại.');
    assert.equal(context.reason(undefined), locale['backup.reason_unknown']);
  }
});
