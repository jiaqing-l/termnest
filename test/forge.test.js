'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const F = require('../lib/forge');

test('remotes in every usual form map to host + project path', () => {
  assert.deepEqual(F.parseRemote('git@gitlab.example.com:group/sub/repo.git'), { host: 'gitlab.example.com', path: 'group/sub/repo' });
  assert.deepEqual(F.parseRemote('ssh://git@gitlab.example.com:2222/group/repo.git'), { host: 'gitlab.example.com', path: 'group/repo' });
  assert.deepEqual(F.parseRemote('https://oauth2:secret@GitLab.example.com/group/repo'), { host: 'gitlab.example.com', path: 'group/repo' });
  assert.deepEqual(F.parseRemote('https://github.com/owner/repo.git'), { host: 'github.com', path: 'owner/repo' });
  assert.equal(F.parseRemote('not a url'), null);
});

test('a token is only ever sent to the address of its own link', () => {
  const links = [{ id: 'a', kind: 'gitlab', url: 'https://gitlab.example.com', token: 't1' }, { id: 'b', kind: 'github', url: 'https://api.github.com', token: 't2' }];
  assert.equal(F.linkFor(links, 'git@gitlab.example.com:g/r.git').link.id, 'a');
  assert.equal(F.linkFor(links, 'git@other.example.com:g/r.git'), null);
  const q = F.requests(links[0], 'g/sub/r', 'crew/task-w1');
  assert.ok(q.mr.startsWith('https://gitlab.example.com/api/v4/projects/g%2Fsub%2Fr/merge_requests'));
  assert.ok(q.mr.includes('source_branch=crew%2Ftask-w1'));
  assert.equal(F.requests(links[0], 'g/r', 'bad branch; rm'), null);
  assert.deepEqual(F.headers(links[0]), { 'PRIVATE-TOKEN': 't1' });
  assert.equal(F.cleanUrl('gitlab', 'https://user:pw@gitlab.example.com/x'), '');
  assert.equal(F.cleanUrl('gitlab', 'ftp://gitlab.example.com'), '');
  assert.equal(F.cleanUrl('gitlab', 'https://gitlab.example.com/some/path'), 'https://gitlab.example.com');
  assert.equal(F.cleanUrl('github', 'https://evil.example.com'), 'https://api.github.com');
});

test('MR / PR and pipeline are read from the forge answers as they are', () => {
  const gl = F.summarize('gitlab', [{ state: 'merged', title: 'A', web_url: 'u1', iid: 7 }, { state: 'opened', title: 'B', web_url: 'u2', iid: 8, draft: true }], [{ status: 'failed', web_url: 'p1' }]);
  assert.deepEqual(gl, { mr: { state: 'opened', title: 'B', url: 'u2', number: 8, draft: true }, ci: { state: 'failed', url: 'p1' } });
  const gh = F.summarize('github', [{ state: 'closed', merged_at: '2026-11-07', title: 'C', html_url: 'u3', number: 3 }], { check_runs: [{ status: 'completed', conclusion: 'success', html_url: 'c1' }, { status: 'in_progress', html_url: 'c2' }] });
  assert.deepEqual(gh, { mr: { state: 'merged', title: 'C', url: 'u3', number: 3, draft: false }, ci: { state: 'running', url: 'c1' } });
  assert.deepEqual(F.summarize('gitlab', [], []), { mr: null, ci: null });
});
