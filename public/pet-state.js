'use strict';
(function (root) {
  const LIMITS = Object.freeze({ wait: 120000, knock: 8000, effect: 7000, day: 86400, week: 604800,
    match: 6000, idleMin: 11000, idleMax: 23000, problemsThunder: 3 });
  const COMMANDS = [
    [/^(?:\S*\/)?git\s+push(?:\s|$)/, 'box'],
    [/^(?:(?:\S*\/)?(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test|(?:\S*\/)?(?:pytest|jest|vitest)(?:\s|$)|(?:\S*\/)?(?:dotnet|cargo|go)\s+test|(?:\S*\/)?node\s+--test)(?:\s|$)/, 'test'],
    [/^(?:\S*\/)?docker\s+(?:build|buildx\s+build)(?:\s|$)/, 'hat'],
    [/^(?:\S*\/)?claude(?:\s|$)|^\d+\.\d+\.\d+$/, 'laptop']
  ];
  function activity(cmd) { return (COMMANDS.find(([re]) => re.test(String(cmd).trim())) || [null, 'normal'])[1]; }
  function badge(created, now) {
    if (!Number.isFinite(created) || created <= 0 || created > now) return '';
    return now - created >= LIMITS.week ? '👑' : now - created >= LIMITS.day ? '🎖️' : '';
  }
  function motion(enabled, reduced, hidden) { return !!enabled && !reduced && !hidden; }
  function phase(state, since, now) {
    if (state !== 'wait') return state;
    return now - since < LIMITS.wait ? 'jump' : now - since < LIMITS.wait + LIMITS.knock ? 'knock' : 'chin';
  }
  function outcome(s) { return s.dead && Number.isInteger(s.exitStatus) ? (s.exitStatus === 0 ? 'finish' : 'failure') : ''; }
  const api = { LIMITS, activity, badge, motion, phase, outcome };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PetState = api;
})(typeof window !== 'undefined' ? window : globalThis);
