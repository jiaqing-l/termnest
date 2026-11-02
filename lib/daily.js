'use strict';
const MAX_GAP_MS = 75000;
function dayKey(now) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function advance(saved, server, sessions, now) {
  const day = dayKey(now);
  const data = saved?.day === day ? saved : { day, entries: Object.fromEntries(Object.entries(saved?.entries || {}).filter(([, e]) => e.failed).map(([k, e]) => [k, { ...e, run: 0, wait: 0, failures: 0, state: '', last: now }])), summary: saved ? { day: saved.day, leaders: leaders(saved) } : null };
  const live = new Set();
  for (const s of sessions) {
    const key = `${server}/${s.name}/${s.created}`; live.add(key);
    const e = data.entries[key] ||= { server, name: s.name, run: 0, wait: 0, failures: 0, failed: saved?.day !== day && saved?.entries?.[key]?.failed || false };
    // Count only intervals actually observed, not service downtime or inferred task history.
    const gap = now - e.last;
    if (gap > 0 && gap <= MAX_GAP_MS && e.state === s.state && ['run', 'wait'].includes(s.state)) e[s.state] += gap;
    const failure = s.dead && Number.isInteger(s.exitStatus) && s.exitStatus !== 0;
    if (failure && !e.failed) e.failures++;
    e.failed = failure; e.state = s.state; e.last = now;
  }
  for (const [key, e] of Object.entries(data.entries)) if (e.server === server && !live.has(key)) { e.state = ''; e.failed = false; e.last = now; }
  return data;
}
function leaders(data) {
  return Object.fromEntries(['run', 'wait', 'failures'].map((k) => [k,
    Object.values(data?.entries || {}).filter((e) => e[k] > 0).sort((a, b) => b[k] - a[k]).slice(0, 3)
      .map((e) => ({ name: e.name, server: e.server, value: e[k] }))]));
}
module.exports = { advance, leaders, dayKey, MAX_GAP_MS };
