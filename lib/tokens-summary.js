'use strict';
// /api/tokens answers every 30 s per open page, and one account can carry thousands of per-session rows (600 KB). The browser only
// lists the top sessions and looks up the ones that live in a tmux session, so by default each account keeps: the top N by today,
// the top N by this week (stable, so ties resolve as in the full list), and every row linked to a tmux session. Totals, days, weeks,
// limits and everything else are untouched; `sessionsTotal` says how many rows the account really has. `sessions=all` returns all rows.
const crypto = require('crypto');
const TOP = 10;

function compactAccount(a, top = TOP) {
  const rows = Array.isArray(a.sessions) ? a.sessions : null;
  if (!rows || rows.length <= top * 2) return a;
  const keep = new Set();
  rows.forEach((s, i) => { if (s && s.tmuxName) keep.add(i); });
  for (const field of ['today', 'week']) {
    rows.map((s, i) => [Number(s && s[field]) || 0, i]).sort((x, y) => y[0] - x[0] || x[1] - y[1]).slice(0, top).forEach(([, i]) => keep.add(i));
  }
  if (keep.size === rows.length) return a;
  return { ...a, sessions: rows.filter((s, i) => keep.has(i)), sessionsTotal: rows.length };
}

/** A view of the token answer for `raw` (the JSON text the cache returns): { text, etag }. */
function createTokenView() {
  let memo = { raw: null, compact: null, full: null };
  return function view(raw, { full = false } = {}) {
    if (memo.raw !== raw) memo = { raw, compact: null, full: null };
    const key = full ? 'full' : 'compact';
    if (!memo[key]) {
      const obj = JSON.parse(raw);
      const body = full ? obj : { ...obj, accounts: (obj.accounts || []).map((a) => compactAccount(a)) };
      const etag = crypto.createHash('sha1').update(JSON.stringify(body)).digest('base64url').slice(0, 16);
      memo[key] = { etag, text: JSON.stringify({ ...body, etag }) };
    }
    return memo[key];
  };
}

module.exports = { compactAccount, createTokenView, TOP };
