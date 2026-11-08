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
