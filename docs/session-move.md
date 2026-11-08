# Moving a conversation between profiles

Move resolves a conversation by its exact UUID. A Claude snapshot's `aiStatus.cfg` selects its profile when available. Otherwise the source searches bounded, nonsymlink HOME `.claude*` / `.codex*` directories and the shell's configured `CLAUDE_CONFIG_DIR` / `CODEX_HOME`. Codex searches both `sessions` and `archived_sessions`. Discovery does not inspect credentials. Duplicate UUIDs are rejected unless an explicit profile selects one exact copy; duplicate files within that profile are still rejected.

When the agent has no known UUID, recent choices are scoped to its working folder and include profile provenance. A requested UUID cannot replace a known live session UUID. A recent selection must still belong to that folder at submission.

The target profile defaults to its configured shell profile and can be changed explicitly in the dialog. Only the selected profile's account is read. Normalized account emails must match; an unknown custom-profile account never falls back to the default account. Profile paths and account mapping appear in the checklist. Folder suggestions are optional: Browse opens the app's shared folder picker, including for an existing empty non-git folder. Picker return preserves drafts and requires a fresh survey.

## API compatibility

`GET /api/features/move/check` retains `server`, `session`, `to`, and optional `id`. Optional `profile` and `targetProfile` select validated discovered profiles; paths cannot select arbitrary roots. Its existing response fields remain. Additions are:

- `id`: resolved exact conversation UUID.
- `profile`: canonical source config directory.
- `targetProfile`: canonical selected target config directory.
- `targetProfiles`: directory names only; other profiles' account identities are not read.
- `receipt`: opaque five-minute check receipt, bound to the hosts, session identity, UUID, profiles, accounts, and source file fingerprint.
- Recent `pick` items add `profile` and `rel` to the existing `id`, `at`, `size`, and `ask` fields.

`POST /api/features/move/run` retains existing fields. The dialog sends `profile`, `targetProfile`, and `receipt`; explicit profile requests require the receipt. A changed file, account, session identity, or profile rejects the old receipt. Legacy requests without new profile fields still perform a fresh complete survey. Existing callers should adopt receipts to bind submission to the displayed check.

Errors retain existing localized messages and may add a machine-readable `code`, including `ambiguous`, `profile`, `scanlimit`, `stale`, `collision`, or `unsafe`. No new translation keys or prose strings are required.

## Transfer and limits

The 40 MiB cap applies to both the source and rewritten result. Source reads, account metadata, recent previews, directory discovery, and stdin upload are bounded. Source files remain intact. Target paths reject traversal and symlinks. A new file is published exclusively with private permissions and read back for byte verification. Existing files are kept only when their bytes are the identical conversation or a longer continuation with the incoming bytes as a prefix; conflicting files are never replaced. The same UUID elsewhere within the selected target profile is rejected to prevent ambiguous resume.

The current shared session launcher has no profile option, so Move creates a normal tracked shell session and sends an explicit `env CLAUDE_CONFIG_DIR=... claude --resume UUID` or `env CODEX_HOME=... codex resume UUID` command. This binds the initial resume to the verified target profile without changing the account's global configuration. The normal snapshot poll subsequently records the agent. The shared restore subsystem does not persist custom profile options; restoring that session after a later host reboot remains outside this change's file scope.

A successful transfer verifies stored bytes and resume-command delivery, not that the CLI has completed loading. The optional Stop old action additionally requires Linux process evidence: a descendant of the exact target tmux pane with the expected tool, UUID, working folder, and config environment. If that proof is unavailable or the agent has not started yet, the source stays running and `stopped` is false. Other platforms also leave the source running. No messages, restarts, or deletes are sent to either agent.

## Isolated verification

`test/move.test.js` retains the original Claude, Codex, rewriting, continuation, and recent-selection regressions. `test/move-profiles.test.js` covers profile/account selection, duplicate UUIDs, unsafe paths, archives, stale receipts, size/expansion limits, destination collisions, and live-process stop proof with synthetic processes. `test/move-browser.cjs` runs the actual frontend module in Chrome with a stubbed app contract and shared-picker dialog, including empty suggestions, pending checks, draft preservation, cancellation, and 1440/390 pixel layouts. These tests do not contact real hosts or run a real move.
