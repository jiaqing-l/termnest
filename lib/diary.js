'use strict';
const { outcome } = require('../public/pet-state');
const LIMITS = Object.freeze({ entries: 40, sessions: 500 });
const key = (server, s) => JSON.stringify([server, s.name, s.created]);
function append(record, type, at, detail = '') {
  record.events.push({ type, at, detail });
  record.events = record.events.slice(-LIMITS.entries);
  record.last = at;
}
function observe(saved, server, sessions, now) {
  const data = saved || {};
  for (const s of sessions) {
    const id = key(server, s);
    let r = data[id];
    if (!r) {
      r = data[id] = { events: [], state: '', outcome: '', last: now };
      // First sight is not evidence that the task just started.
      append(r, 'observed', now);
    }
    if (r.state !== s.state) {
      if (s.state === 'wait') append(r, 'waiting', now);
      else if (r.state === 'wait') append(r, 'resumed', now);
    }
    const result = outcome(s);
    if (result && result !== r.outcome) append(r, result, now, 'exit ' + s.exitStatus);
    r.state = s.state; r.outcome = result; r.last = now;
  }
  const keys = Object.keys(data).sort((a, b) => data[b].last - data[a].last);
  keys.slice(LIMITS.sessions).forEach((id) => delete data[id]);
  return data;
}
function answered(data, server, s, now) {
  const r = s && data?.[key(server, s)];
  if (r && s.state === 'wait') append(r, 'answered', now);
}
function entries(data, server, s) { return data?.[key(server, s)]?.events || []; }
module.exports = { LIMITS, observe, answered, entries };
