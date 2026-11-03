'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const d = require('../lib/usage-discover');

function home() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-usage-home-'));
  fs.mkdirSync(path.join(h, '.claude', 'projects'), { recursive: true });
  fs.writeFileSync(path.join(h, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'Main@Example.com' } }));
  fs.mkdirSync(path.join(h, '.claude-work', 'projects'), { recursive: true });
  fs.writeFileSync(path.join(h, '.claude-work', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'work@example.com' } }));
  fs.mkdirSync(path.join(h, '.claude-empty'));
  fs.mkdirSync(path.join(h, '.codex'));
  const payload = Buffer.from(JSON.stringify({ email: 'Codex@Example.com' })).toString('base64url');
  fs.writeFileSync(path.join(h, '.codex', 'auth.json'), JSON.stringify({ tokens: { id_token: `x.${payload}.y`, access_token: 'SECRET' } }));
  return h;
}

test('finds default and numbered config folders with their account e-mail, skipping empty ones', async () => {
  const h = home(), out = await d.discoverRuntime()({ home: h, env: {} });
  assert.deepEqual(out.map((a) => [a.tool, path.basename(a.directory), a.email]).sort(), [
    ['claude', '.claude', 'main@example.com'], ['claude', '.claude-work', 'work@example.com'], ['codex', '.codex', 'codex@example.com']]);
  assert.ok(!JSON.stringify(out).includes('SECRET'));
});

test('env config folders are included once even when they equal a default one', async () => {
  const h = home(), out = await d.discoverRuntime()({ home: h, env: { CLAUDE_CONFIG_DIR: path.join(h, '.claude'), CODEX_HOME: path.join(h, '.codex') } });
  assert.equal(out.length, 3);
});

test('merge keeps declared accounts, adds undeclared folders once and labels them by e-mail', () => {
  const declared = [{ id: 'mine', tool: 'claude', hostId: 'h1', directory: '/home/u/.claude', nickname: 'Cá nhân' }];
  const found = [{ tool: 'claude', hostId: 'h1', directory: '/home/u/.claude', email: 'a@x.com' }, { tool: 'codex', hostId: 'h1', directory: '/home/u/.codex', email: 'b@x.com' }, { tool: 'codex', hostId: 'h2', directory: '/home/u/.codex', email: null }];
  const out = d.merge(declared, found);
  assert.deepEqual(out.accounts.map((a) => [a.tool, a.hostId, a.nickname]), [['claude', 'h1', 'Cá nhân'], ['codex', 'h1', ''], ['codex', 'h2', '']]);
  assert.equal(out.emails.get(d.idOf('h1', 'codex', '/home/u/.codex')), 'b@x.com');
});
