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

test('actual board sessions are deduplicated by actionable priority and keep unknown and delivery failures visible', () => {
  const { opsSessionRows } = require('../public/features/ops');
  const session = name => ({ name, agent: true, ai: { status: 'idle', at: Date.now() - 3600000 } });
  const board = { servers: [{ id: 'vm1', online: true, sessions: [session('one'), session('two'), { name: 'unknown', agent: true, ai: null }], findings: [
    { session: 'one', key: 'dormant', rule: 'dormant', severity: 'warn', template: 'continue' },
    { session: 'one', key: 'unheard', rule: 'unheard', severity: 'urgent' },
    { session: 'two', key: 'idle', rule: 'finished', severity: 'urgent' }
  ] }] };
  let rows = opsSessionRows(board, null);
  assert.equal(rows.length, 3);
  assert.equal(rows.find(x => x.f.session === 'one').f.rule, 'unheard', 'delivery failure wins over a new send suggestion');
  assert.equal(rows.find(x => x.f.session === 'two').f.severity, 'info', 'idle is not task completion or urgent');
  assert.equal(rows.find(x => x.f.session === 'unknown').f.rule, 'observed_unknown');
  board.servers[0].findings.push({ session: 'one', key: 'asking', rule: 'asking', severity: 'urgent' });
  rows = opsSessionRows(board, { enabled: true, servers: [{ id: 'vm1', teams: [{ session: 'one', requiresOwner: true, id: 'owner' }] }] });
  assert.equal(rows.length, 3); assert.equal(rows[0].f.rule, 'asking', 'question wins and never offers a continuation template');
  assert.equal(rows[0].f.template, undefined);
  board.servers[0].online = false;
  board.servers[0].findings.push({ key: 'offline', session: '', rule: 'offline', severity: 'warn' });
  rows = opsSessionRows(board, { enabled: true, servers: [{ id: 'vm1', teams: [{ session: 'one', requiresOwner: true }] }] });
  assert.equal(rows.filter(x => x.f.severity !== 'info').length, 1, 'one offline host issue, no phantom per-session errors');
  assert.equal(rows.filter(x => x.f.rule === 'observed_unknown').length, 3, 'cached sessions remain accessible with truthful state');
});

test('supervisor owner requirements join existing sessions and preserve genuine unmatched issues', () => {
  const { opsSessionRows } = require('../public/features/ops');
  const rows = opsSessionRows({ servers: [{ id: 'vm1', online: true, sessions: [{ name: 'leader', ai: { status: 'busy' } }], findings: [] }] }, {
    enabled: true, servers: [{ id: 'vm1', teams: [{ id: 'one', session: 'leader', requiresOwner: true, reason: { code: 'task_evidence_stale' } }, { id: 'two', session: '', requiresOwner: true, root: '/work/unmatched' }], audits: [{ runId: 'audit', teamSession: 'leader', requiresOwner: true }] }]
  });
  assert.equal(rows.length, 2);
  assert.equal(rows.filter(x => x.f.session === 'leader').length, 1);
  assert.equal(rows[0].f.reason.code, 'task_evidence_stale');
  assert.equal(rows[1].f.settings, true);
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
