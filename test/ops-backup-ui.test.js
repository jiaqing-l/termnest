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

test('fresh supervisor owner waits, blocks and stalls join sessions and preserve unmatched legitimate issues', () => {
  const { opsSessionRows } = require('../public/features/ops');
  // A leader that is idle with no crew progress is stalled; one that is busy working is not paged (see the next block).
  const board = { servers: [{ id: 'vm1', online: true, sessions: ['leader', 'blocked', 'stalled'].map(name => ({ name, ai: { status: name === 'stalled' ? 'idle' : 'busy' } })), findings: [] }] };
  const host = { id: 'vm1', online: true, observedAt: Date.now(), freshness: { snapshotFresh: true, taskEvidenceFresh: true }, teams: [
    { id: 'one', session: 'leader', requiresOwner: true, status: 'waiting_owner', reason: { code: 'owner_decision' } },
    { id: 'two', session: 'blocked', requiresOwner: true, status: 'blocked', reason: { code: 'task_blocked' } },
    { id: 'three', session: 'stalled', requiresOwner: true, status: 'stalled', reason: { code: 'no_task_progress' } },
    { id: 'unmatched', session: '', root: '/work/unmatched', requiresOwner: true, status: 'blocked', reason: { code: 'task_blocked' } }
  ], audits: [{ runId: 'audit', teamSession: 'leader', active: true, requiresOwner: true, reason: { code: 'audit_timeout' } }] };
  const rows = opsSessionRows(board, { enabled: true, servers: [host] });
  assert.equal(rows.length, 4);
  assert.equal(rows.filter(x => x.f.session === 'leader').length, 1);
  assert.deepEqual(rows.map(x => x.f.ownerKind), ['wait', 'blocked', 'stalled', 'blocked']);
  assert.equal(rows[3].f.settings, true);
  board.servers[0].findings.push({ session: 'leader', rule: 'asking', severity: 'urgent' });
  assert.equal(opsSessionRows(board, { enabled: true, servers: [host] })[0].f.rule, 'asking');
  // Busy leader, crew files unchanged for a while: it is working, not stuck.
  board.servers[0].sessions.find(x => x.name === 'stalled').ai.status = 'busy';
  assert.equal(opsSessionRows(board, { enabled: true, servers: [host] }).filter(x => x.f.ownerKind === 'stalled').length, 0);
});

test('unknown, stale and configuration supervisor flags never promote measured busy sessions or urgent counts', () => {
  const { opsSessionRows } = require('../public/features/ops');
  const board = { servers: [{ id: 'vm1', online: true, sessions: [{ name: 'leader', ai: { status: 'busy' } }], findings: [] }] };
  const host = { id: 'vm1', online: true, observedAt: Date.now(), freshness: { snapshotFresh: true, taskEvidenceFresh: true }, teams: [], audits: [],
    coordination: [{ root: '/work', code: 'coordination_unvalidated', requiresOwner: true }], errors: [{ code: 'task_evidence_stale' }] };
  const supervision = { enabled: true, servers: [host], auditReadiness: [{ serverId: 'vm1', requiresOwner: true, code: 'account_missing' }] };
  function observedOnly() {
    const rows = opsSessionRows(board, supervision);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].f.rule, 'observed_busy');
    assert.equal(rows.filter(x => x.f.severity === 'urgent').length, 0);
  }
  for (const code of ['task_evidence_stale', 'registration_required', 'workspace_only', 'awaiting_task_progress', 'managed_task_missing', 'future_reason']) {
    host.teams = [{ id: 'one', session: 'leader', requiresOwner: true, status: 'unknown', reason: { code } }];
    observedOnly();
  }
  host.teams = [{ id: 'one', session: 'leader', requiresOwner: true, status: 'waiting_owner', reason: { code: 'owner_decision' } }];
  host.freshness.taskEvidenceFresh = false; observedOnly();
  host.freshness.taskEvidenceFresh = true; host.freshness.snapshotFresh = false; observedOnly();
  host.freshness.snapshotFresh = true; host.observedAt = Date.now() - 600000; observedOnly();
  host.observedAt = Date.now(); host.online = false; observedOnly();
  delete host.observedAt; host.online = true; observedOnly();
});

test('current unresolved supervisor delivery remains actionable without task evidence; resolved history and stale hosts do not', () => {
  const { opsSessionRows } = require('../public/features/ops');
  const board = { servers: [{ id: 'vm1', online: true, sessions: [{ name: 'leader', ai: { status: 'busy' } }], findings: [] }] };
  const audit = { runId: 'audit', teamSession: 'leader', active: true, requiresOwner: true, reason: { code: 'send_uncertain' } };
  const host = { id: 'vm1', online: true, observedAt: Date.now(), freshness: { snapshotFresh: true, taskEvidenceFresh: false }, teams: [], audits: [audit] };
  const supervision = { enabled: true, servers: [host] };
  assert.equal(opsSessionRows(board, supervision)[0].f.ownerKind, 'uncertain');
  audit.reason.code = 'transport_error'; audit.phase = 'uncertain'; audit.deliveryUncertain = true;
  assert.equal(opsSessionRows(board, supervision)[0].f.ownerKind, 'uncertain', 'explicit current delivery outcome survives an adapter-specific reason');
  audit.active = false;
  assert.equal(opsSessionRows(board, supervision)[0].f.rule, 'observed_busy');
  host.teams = [{ id: 'recovery', session: 'leader', status: 'unknown', requiresOwner: true, reason: { code: 'task_evidence_stale' }, recovery: { requiresOwner: true, code: 'recovery_uncertain' } }];
  assert.equal(opsSessionRows(board, supervision)[0].f.ownerKind, 'uncertain');
  host.teams[0].recovery = { requiresOwner: true, code: 'action_duplicate', delivery: 'uncertain' };
  assert.equal(opsSessionRows(board, supervision)[0].f.ownerKind, 'uncertain', 'duplicate remote receipt with uncertain delivery remains visible');
  host.freshness.snapshotFresh = false;
  assert.equal(opsSessionRows(board, supervision)[0].f.rule, 'observed_busy');
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
