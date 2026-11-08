# Background supervision

Termnest can run its backend on an always-on Linux VM while the browser or laptop is disconnected.
The Operations tab has one **Background supervision / Vận hành nền** section. Crew panels remain hidden.
Policy enabled, process alive, vault unlocked, fresh observations, delivered requests, agent responses,
and validated audit reports are separate facts. Busy or idle alone never establishes task progress.
Waiting for an owner is valid: the owner must answer permission prompts and decisions personally.
Unknown, stale, offline, missing skill/account/quota and uncertain delivery are not healthy states.

## Linux preparation

Choose the VM, Unix account, service port, existing encrypted DATA directory and workspaces with the owner.
Use the account that owns the intended tmux server and SSH keys. `tmux list-sessions` under a different
Unix account cannot establish that the actual teams are missing. Do not start a second tmux server or
restart workers to make discovery look successful. Confirm each workspace exists and the audit agent
has the correct account, installed `xspire-crew-ops-audit` skill and adequate quota there.

Install Node.js >=18, npm, tmux, tar, Python 3, make and a C/C++ compiler (Ubuntu packages
`python3 build-essential`; use the administrator's approved package procedure). Run `npm ci` in
the extracted Linux application directory. node-pty in this version has no Linux prebuilt: its native
module must compile on Linux. `npm ci --ignore-scripts` does not validate native terminals. Never
copy macOS node_modules, native helpers or binaries into the VM bundle. Run the native terminal
smoke check under the intended service user before claiming terminal readiness.

Keep the existing encrypted vault, backups and settings in their protected DATA directory. Securely
back them up before an update; never overwrite an existing destination vault. DATA must be owned by
the service user and mode 700; vault and boot password files must be regular, single-link,
owner-only files (600 or 400). The password file contains the existing vault password on one line.
Create it through an approved private terminal/secret procedure; never put the password in argv,
logs, shell history, an environment variable or the source tree. Do not print its contents.
The installer may prompt privately when no password file exists; unattended installs require an
existing protected file. Invalid or wrong secrets stop startup rather than creating a replacement vault.

Persistent key-based SSH is required for remote machines. Verify the intended account, host key and
noninteractive key access before enabling unattended policy. Password-only SSH credentials are
memory-only and do not survive boot unlock. Do not store their passwords to work around this.

## Install, inspect and restart

Extract `implementation/termnest-update-test.tar.gz` into a new application release directory: archive
entries start directly with `lib/`, `public/`, `scripts/`, `server.js`, manifests and this runbook,
with no enclosing application folder. Inspect entries first with `tar -tzf`, then extract into an empty
directory and run `sha256sum -c SHA256SUMS`. Build on the source machine with
`node scripts/package-update.js`; `--output FILE` selects a different artifact location. The command
prints the archive SHA256. The archive contains source, npm manifests and platform installer scripts,
never DATA, secrets, node_modules or previous implementation archives. SHA256 checks detect accidental
corruption; verify artifact provenance through your trusted delivery channel too.

From the Linux release directory, substitute owner-selected values:

```sh
npm ci
bash scripts/install-supervisor.sh --dry-run \
  --data-dir "$TERM_DATA" --password-file "$TERM_BOOT_PASSWORD_FILE" --port "$TERM_PORT"
bash scripts/install-supervisor.sh \
  --data-dir "$TERM_DATA" --password-file "$TERM_BOOT_PASSWORD_FILE" --port "$TERM_PORT"
loginctl show-user "$USER" -p Linger
systemctl --user status termnest-supervisor.service
node scripts/supervisor-check.js --port "$TERM_PORT"
```

`TERM_DATA` and `TERM_BOOT_PASSWORD_FILE` are absolute paths selected by the owner, outside the release
and source directories; `TERM_PORT` is the selected loopback service port. The installer writes paths,
not password contents, to a systemd user unit and binds HTTP only to `127.0.0.1`. It never overwrites a
vault. Run it as the intended user, without silently switching to root. Explicit root-owned teams
require the owner's selected root deployment, not an assumption about account visibility.

**Require `Linger=yes`** before claiming operation after logout or boot without login. `Linger=no`
is a readiness blocker: ask the administrator to approve and perform `loginctl enable-linger USER`
for that specific account, then recheck. Installation does not grant that administrative policy.
`systemctl --user is-enabled termnest-supervisor.service` and an actual controlled reboot/logout
exercise must confirm startup semantics. Merely seeing a process while logged in is insufficient.

The health checker distinguishes locked, unlocked, monitoring and error; monitoring is not a validated
audit result or proof that every remote host is reachable. Inspect authenticated Operations readiness
and observation timestamps too. Logs can be reviewed with
`journalctl --user -u termnest-supervisor.service --since today`; redact private paths/identities before
sharing logs. Do not include secret files or session contents in diagnostic bundles.

To apply an update, stop only the Termnest backend, preserve all existing workers/tmux sessions, extract
the new source into a separate release directory, run Linux `npm ci`, dry-run and rerun the installer
against the same DATA and boot password file, then explicitly restart:

```sh
systemctl --user restart termnest-supervisor.service
systemctl --user status termnest-supervisor.service
node scripts/supervisor-check.js --port "$TERM_PORT"
```

The generated unit uses `KillMode=process` so a backend restart does not kill local tmux children.
Never use `tmux kill-server`, kill worker panes or clear remote ownership to update the UI. For rollback,
stop the backend, point the installer back at the prior release with the same protected DATA/secret
and restart; confirm settings/schema compatibility first. Keep a protected pre-update backup, but
never restore old ownership/action receipts over a live system: that could repeat an uncertain action.
A DATA lock conflict means another backend owns that DATA; identify and stop the intended backend
cleanly rather than deleting its lock. Do not run two backend instances against one DATA directory.

## Native app and browser connection

The desktop shell already reuses an existing Termnest backend when its identity check succeeds on
fixed localhost port **7681** (`desktop/src/main.rs`). No Rust rebuild is needed for a VM connection.
Close Termnest and stop the laptop's local backend cleanly so port 7681 is free. Then create an SSH
local forward to the VM's loopback service port and only afterward open Termnest:

```sh
ssh -N -o ExitOnForwardFailure=yes -L "127.0.0.1:7681:127.0.0.1:${TERM_PORT}" "$TERM_VM"
```

`TERM_VM` is the owner's existing SSH host alias/account. Never bind the forward to a LAN address,
`0.0.0.0`, or use `-g`. Keep the VM service loopback-only. If the local port is occupied or identity
fails, resolve the conflict rather than opening another backend or changing Rust. Authenticate normally
with the VM vault when returning; the local vault is not a replacement for the VM vault.
A browser can use another local port, for example
`ssh -N -o ExitOnForwardFailure=yes -L "127.0.0.1:17681:127.0.0.1:${TERM_PORT}" "$TERM_VM"`,
then open `http://127.0.0.1:17681`. The VM supervisor continues when this tunnel or laptop goes offline;
only the viewer disconnects. Desktop supervision on Windows, macOS or Ubuntu cannot continue while
that desktop sleeps or powers off. Use the always-on VM for fleet continuity.

Windows and macOS deployment scripts, when present in the integrated release, are respectively
`scripts/install-supervisor.ps1` and `scripts/install-supervisor-macos.sh`. Consult their `--help`/script
usage before installation. W5 Windows startup uses a current-user Task Scheduler logon task with
`InteractiveToken`: it requires that user to be logged in and does not survive logout or provide
unattended boot. Inspect it with the script's `-Status` switch; `-DryRun` previews task XML. A macOS
launchd user agent requires the user's GUI login session; logout stops it. Use `--status` or
`--dry-run` on that adapter. Neither adapter establishes unattended operation before login. Protected
Windows credentials require owner ACLs, not Unix chmod assumptions. These adapters and native CI
need native evidence separately; mocked platform tests do not establish installed service readiness.

## Source and installed native resource paths

For a source checkout or extracted update archive, run the commands above from the application root:
the runbook is `docs/supervisor.md`, installers are in `scripts/`, and `node` is the installed host Node.
Run `npm ci` there on the target platform before installation.

The native application carries a prepared runtime payload instead. Its resource `app/` directory contains
`server.js`, `lib/`, production `node_modules/`, `scripts/` and this runbook as **`SUPERVISOR.md`**;
it intentionally has no `docs/` directory. Only the three supervisor installers and `supervisor-check.js`
are copied from scripts when present at build time. Rebuild after integrating platform installers.
Do not run `npm ci` inside an installed native application or replace its native modules.

Locate the installed resource root containing `app/server.js` using the installation/package contents:
on macOS it is typically `Termnest.app/Contents/Resources/app`, on Linux the package resource directory
is typically `/usr/lib/Termnest/app`, and on Windows it is the installation directory's `app` subdirectory.
Verify the actual package location rather than assuming a particular installation prefix. Set `TERM_APP`
to that `app` directory. The bundled Node sits beside `server.js`: `node-arm64` or `node-x64` on Unix,
and `node.exe` on Windows. From that directory, run the matching platform commands, for example:

```sh
cd "$TERM_APP"
# Select the architecture actually present in this payload.
./node-x64 scripts/supervisor-check.js --port "$TERM_PORT"
bash scripts/install-supervisor.sh --dry-run --data-dir "$TERM_DATA" \
  --password-file "$TERM_BOOT_PASSWORD_FILE" --port "$TERM_PORT"
# On macOS, use install-supervisor-macos.sh with the same arguments instead.
```

```powershell
Set-Location $env:TERM_APP
& .\node.exe scripts/supervisor-check.js --port $env:TERM_PORT
powershell.exe -NoProfile -File scripts/install-supervisor.ps1 -DryRun `
  -DataDir $env:TERM_DATA -PasswordFile $env:TERM_BOOT_PASSWORD_FILE -Port $env:TERM_PORT
```

Installer Node discovery must support the bundled executable (W5 integration); inspect the dry-run
service executable before installing. A health check can use bundled Node directly as shown. Preserve
the prepared application directory while its service references it, and rerun the installer after an
application upgrade or move. Keep DATA and the protected secret outside the application package;
an installer dry-run does not prove service startup, native terminal behavior or audit readiness.

## Policy, workspaces and leader ownership

In Operations, expand supervision settings, list each selected server ID and absolute workspace root
(one `serverId | root` per line), choose the audit interval, and explicitly apply enablement. The
button applies the displayed complete workspace list; an empty list removes registered roots.
Server IDs and names appear below the form. Automatic recovery is separate and requires explicit
leader registration readiness. This form does not register every observed agent session and never
enables the generic dormant automatic rule. Advanced general rules remain independently editable.

The authenticated facade is `GET/POST /api/features/ops/supervision`. GET provides policy,
workspaces, runtime readiness, registration candidates and per-server teams/audits. POST normally
sends `{enabled, autoRecovery, intervalMinutes, workspaces:[{serverId,root}]}`; existing optional
`auditConfig` and `auditAccount` fields are retained when the server/root scope is unchanged.
The backend rejects invalid scopes. To register a leader, explicitly select one fresh candidate by
server/session/workspace, enter the managed task IDs and check the scope confirmation. Applying
then sends `leaders` with that one added/updated record and preserves existing other registrations.
The backend revalidates the candidate identity against the live host and task ownership. A stale
candidate requires a page reload and fresh selection. The form never registers every agent by default. W3 revalidates every record submitted in `leaders`,
including retained registrations. If other retained leaders have stale identities, the owner must
reconcile the full registration list through the authenticated facade before adding this leader;
the compact form does not silently discard other scopes.
No boot or pane identifiers need to be entered by the user. Recovery remains a separate checkbox.

The integrated W3 candidate contract is
`registrationCandidates:[{serverId,session,root,identity}]`; registration records add `taskIds`.
Identity fields travel unchanged from the selected candidate and are never rendered as product labels.
The backend validates its `bootId`, `sessionId`, `created`, `pane`, `agentPid`, `agentStartedAt` and
`config`, and supplies the verified process start. Recovery readiness can be supplied explicitly as
`runtime.registrationReady`/`recoveryReady`, or derived conservatively from a registered leader
matching a current candidate on a fresh host. This only establishes registration readiness; backend
eligibility, task state, fresh scan and fencing still gate every actual action.

Audit account configuration is independent of leader registration. In Operations → Background supervision
(Vận hành nền) → Supervision settings, first save the intended workspace. In **Audit account / Tài khoản kiểm tra**:

1. Select the saved workspace. Enter the intended Claude profile basename (`.claude` by default,
   or the existing saved value, such as `.claude-audit`). This refers to the account already signed in
   on that host, under the service user; it does not create an account or accept credentials.
2. Select **Check account / Kiểm tra tài khoản**. The authenticated, side-effect-free
   `POST /api/features/ops/supervision/account` checks `{serverId,root,auditConfig}`. Review the readable
   verified identity, check time and skill/auth explanation. Missing skill/auth or unavailable hosts
   require correction on the intended host before another check. No account choices are fabricated.
3. Select **Confirm use for this scope / Xác nhận dùng cho phạm vi này** only if the displayed identity,
   profile and workspace are intended. This saves the returned opaque account reference for that one
   workspace, preserving all other saved workspaces, policy settings and leader registrations. It does
   not apply unsaved policy edits or implicitly enable audit/recovery. A new GET must read back the
   same profile and account before the UI reports saved. A rejected or mismatching readback requires
   checking again; an uncertain write may already have reached the backend.

The check expires after 60 seconds. Changing scope/profile, a failed check/read or offline/stale host
invalidates confirmation. Backend control revalidates account identity before any action. Quota remains
**unknown**, including after account confirmation; this never establishes full audit readiness.
Enable policy and recovery separately, only after reviewing their readiness and explicit leader scope.

UI readiness consumes optional `runtime.ready`, `unlocked`, `monitoring`, `observationsFresh`,
`validatedAuditCompletion`, `sshReady`, `auditReady`, `linger`, `registrationReady` and `recoveryReady`
booleans, `code`, `reasons`, `passwordOnlyAccounts`, and nested platform readiness. Missing fields
remain unconfirmed. A successful POST is followed by a new GET before showing confirmed state.
An unsuccessful or uncertain request remains visibly unavailable until a successful read; polling
preserves typed settings and registration choices. Host freshness uses `freshness.maxAgeMs` (default
120 seconds), `snapshotFresh`, `taskEvidenceFresh`, `online` and `observedAt`. Unknown reason codes
receive a readable owner-review message. Validate optional W5 platform readiness fields at integration.

Remote supervisor coordinator ownership/fencing controls who may audit or nudge a workspace. It is
separate from Crew task leases and grants no authority to release task leases, steal a task, answer an
owner prompt or restart an active leader. Two supervisors must not both send an action. On ownership
conflict, stale identity or uncertain delivery, inspect the intended session before further action.
A request delivered to tmux, an agent response and a validated scope-bound report are distinct milestones.
Opening a session is not a completed audit. Only meaningful task evidence establishes team progress.

## Real 3 VM × 3 team × 24 hour acceptance

Use owner-approved VMs, identities and nine explicitly registered teams. Do not fault existing production
workers merely to test the feature. Record UTC start/end, source commit, platform/runtime versions,
service user, ports, readiness (including linger/key/account/skill), selected roots and redacted exact
leader registration evidence. Establish a baseline with one validated audit per intended scope.

Run continuously for at least 24 real hours with the browser closed and the laptop/tunnel disconnected
for a measured interval. Record observations from the VM, not just screenshots. With the owner's
approved test teams, exercise host disconnect/reconnect, stale snapshots, busy without task evidence,
idle leader, owner prompt, blocked work, missing skill/account/quota, audit timeout, uncertain delivery,
backend restart during a pending audit, and competing supervisors/fencing. Include controlled VM reboot
and logout only within an approved test window. Reconnect the native app and browser using the tunnels
above; confirm normal authentication, fresh observations and preserved worker sessions.

Collect audit intended/delivered/responded/reported timestamps, valid report coverage, audit latency,
maximum observation gap, missed scheduled intervals (with explicit cause), owner waiting duration,
recovery attempts and proven progress after each, retries, uncertain sends, duplicate sends (target zero),
fencing rejections, resource use and service uptime. Verify no automatic owner answers, no action into
busy/unknown sessions, no unrelated session or generic-rule changes, no vault damage or secret exposure.
All nine team scopes must have fresh coverage or explicit owner/unavailable reasons throughout the run.
Investigate every unexplained gap and duplicate before acceptance. Keep evidence outside the bundle.

Unit tests, synthetic browser fixtures and accelerated/injected-clock fault simulations are implementation
checks. They do not establish 24-hour uptime, native Windows/macOS behavior, Linux terminal compilation,
or successful deployment to the selected fleet. Product acceptance requires the real run and owner review.
