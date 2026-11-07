'use strict';
// The launch options of an agent worth keeping across a restore (model, permission / approval mode), read from the agent's
// real command line. Only these listed flags are kept, each value checked; anything else on the command line (prompts, paths,
// ids, unknown flags) is ignored, so a restore never replays more than "same model, same mode".
const VALUE = /^[\w.:@=-]{1,60}$/;
const SPEC = {
  claude: { withValue: ['--model', '--permission-mode', '--effort'], alone: ['--dangerously-skip-permissions', '--verbose'] },
  codex: { withValue: ['--model', '-m', '--sandbox', '-s', '--ask-for-approval', '-a', '--profile', '-p'], alone: ['--full-auto', '--dangerously-bypass-approvals-and-sandbox', '--search'] },
};

function safeFlags(tool, args) {
  const spec = SPEC[tool]; if (!spec || typeof args !== 'string') return [];
  const t = args.trim().split(/\s+/).slice(0, 80), out = [];
  for (let i = 1; i < t.length; i++) {
    const [name, inline] = t[i].includes('=') && t[i].startsWith('--') ? [t[i].slice(0, t[i].indexOf('=')), t[i].slice(t[i].indexOf('=') + 1)] : [t[i], null];
    if (spec.alone.includes(name)) { if (!out.includes(name)) out.push(name); continue; }
    if (spec.withValue.includes(name)) {
      const v = inline !== null ? inline : t[i + 1];
      if (inline === null) i++;
      if (v && VALUE.test(v) && !v.startsWith('-') && !out.includes(name)) out.push(name, v);
    }
  }
  return out.slice(0, 12);
}
// Flags as they were recorded, checked again before they go into a shell command.
function cleanFlags(tool, flags) {
  return Array.isArray(flags) ? safeFlags(tool, [tool].concat(flags.filter((f) => typeof f === 'string')).join(' ')) : [];
}

module.exports = { safeFlags, cleanFlags };
