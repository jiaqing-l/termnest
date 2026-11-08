#!/bin/bash
# Current-user LaunchAgent; never a root LaunchDaemon. Requires a logged-in GUI session.
# Usage: bash scripts/install-supervisor-macos.sh [--dry-run] [--data-dir DIR] [--password-file FILE] [--port 7681] [--node-path EXE]
#        bash scripts/install-supervisor-macos.sh --status|--uninstall [--dry-run]
# Dry-run prints deterministic plist XML (paths only), with no directories, prompts, writes or launchctl calls.
# Example: bash scripts/install-supervisor-macos.sh --dry-run --data-dir "$HOME/Library/Application Support/Termnest"
# Runtime: explicit --node-path, then app/node-arm64 or app/node-x64, then PATH for source installs.
# Existing owner-only single-line secret and primary vault are required; neither is created or overwritten.
# Login-session lifetime only: logout, sleep and power-off interrupt supervision. Use an always-on host for 24/7.
set -euo pipefail
umask 077
dry=0
action=install
data_dir="$HOME/Library/Application Support/Termnest"
password_file=""
port=7681
node_bin=""
while (( $# )); do
  case "$1" in
    --dry-run) dry=1; shift ;;
    --status) action=status; shift ;;
    --uninstall) action=uninstall; shift ;;
    --data-dir|--password-file|--port|--node-path)
      (( $# >= 2 )) || { echo RUNTIME_ARGUMENT_INVALID >&2; exit 2; }
      case "$1" in --data-dir) data_dir="$2";; --password-file) password_file="$2";; --port) port="$2";; --node-path) node_bin="$2";; esac
      shift 2 ;;
    --help|-h) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo RUNTIME_ARGUMENT_INVALID >&2; exit 2 ;;
  esac
done
[[ -n "$password_file" ]] || password_file="$data_dir/password"
app_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
runtime_os="$(uname -s)"
case "$(uname -m)" in
  arm64|aarch64) runtime_arch=arm64; macho_cpu=16777228 ;;
  x86_64) runtime_arch=x64; macho_cpu=16777223 ;;
  *) echo RUNTIME_NODE_ARCH_UNSUPPORTED >&2; exit 2 ;;
esac
bundled=0
if [[ -z "$node_bin" ]]; then
  if [[ -e "$app_dir/node-$runtime_arch" || -L "$app_dir/node-$runtime_arch" ]]; then
    node_bin="$app_dir/node-$runtime_arch"
    bundled=1
  else
    node_bin="$(command -v node)" || { echo RUNTIME_NODE_REQUIRED >&2; exit 2; }
  fi
fi
[[ "$node_bin" = /* && -f "$node_bin" && -x "$node_bin" ]] || { echo RUNTIME_NODE_REQUIRED >&2; exit 2; }
# Official bundled Node binaries are thin 64-bit Mach-O executables. Check CPU and
# the macOS load-command platform BEFORE execution; never try ELF, PE or an iOS binary.
# Unsupported/fat binaries fail closed; choose a native thin Node with --node-path.
validate_macos_node() {
  local magic cpu subtype kind commands size flags reserved offset=32 cmd bytes platform found=0 i
  read -r magic cpu subtype kind commands size flags reserved <<< "$(/usr/bin/od -An -N32 -t u4 "$node_bin" | /usr/bin/tr '\n' ' ')"
  [[ "$magic" = 4277009103 && "$cpu" = "$macho_cpu" && "$kind" = 2 &&
     "$commands" =~ ^[0-9]+$ && "$size" =~ ^[0-9]+$ ]] || return 1
  (( commands > 0 && commands <= 256 && size <= 1048576 )) || return 1
  for ((i=0; i<commands; i++)); do
    read -r cmd bytes <<< "$(/usr/bin/od -An -j "$offset" -N8 -t u4 "$node_bin")"
    [[ "$cmd" =~ ^[0-9]+$ && "$bytes" =~ ^[0-9]+$ ]] || return 1
    (( bytes >= 8 && offset + bytes <= 32 + size )) || return 1
    case "$cmd" in
      50) # LC_BUILD_VERSION: PLATFORM_MACOS = 1
        (( bytes >= 24 )) || return 1
        read -r platform <<< "$(/usr/bin/od -An -j "$((offset+8))" -N4 -t u4 "$node_bin")"
        [[ "$platform" = 1 ]] || return 1
        found=1 ;;
      36) (( bytes >= 16 )) || return 1; found=1 ;; # LC_VERSION_MIN_MACOSX
      37|47|48) return 1 ;; # iOS/tvOS/watchOS
    esac
    offset=$((offset+bytes))
  done
  (( found && offset == 32 + size ))
}
if [[ "$runtime_os" = Darwin ]] || (( bundled )); then
  validate_macos_node || { echo RUNTIME_NODE_INCOMPATIBLE >&2; exit 2; }
fi
# Linux dry-run is a generation-only development fixture. Native installation still requires Darwin.
# The fixed probe prints no environment or secret and confirms the selected executable's own identity.
node_identity="$("$node_bin" -p 'process.platform + "/" + process.arch')" || { echo RUNTIME_NODE_REQUIRED >&2; exit 2; }
case "$runtime_os/$node_identity" in
  Darwin/darwin/"$runtime_arch"|Linux/linux/"$runtime_arch") ;;
  *) echo RUNTIME_NODE_INCOMPATIBLE >&2; exit 2 ;;
esac
label=io.termnest.supervisor
agent_dir="$HOME/Library/LaunchAgents"
agent_file="$agent_dir/$label.plist"
if (( ! dry )); then
  [[ "$runtime_os" = Darwin ]] || { echo RUNTIME_MACOS_REQUIRED >&2; exit 2; }
  [[ "$(id -u)" != 0 ]] || { echo RUNTIME_CURRENT_USER_REQUIRED >&2; exit 2; }
  [[ -x /bin/launchctl && -x /usr/bin/plutil ]] || { echo RUNTIME_LAUNCHD_REQUIRED >&2; exit 2; }
fi
# Generate, inspect ownership and atomically install in Node: no shell interpolation in the plist.
"$node_bin" - "$app_dir" "$data_dir" "$password_file" "$port" "$agent_file" "$dry" "$action" "$node_bin" <<'NODE'
'use strict';
const fs = require('node:fs'), path = require('node:path'), { execFileSync } = require('node:child_process');
const [app, data, password, port, file, dry, action, node] = process.argv.slice(2);
const { readPassword, readProtected, assertPrivatePath } = require(path.join(app, 'lib/service-runtime'));
const fail = code => { console.error(code); process.exit(2); };
const marker = '<!-- Generated by Termnest install-supervisor-macos.sh; paths only. -->';
for (const v of [app, data, password, file, node]) if (!path.isAbsolute(v) || /[\x00-\x1f\x7f]/.test(v)) fail('RUNTIME_PATH_INVALID');
if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) fail('RUNTIME_PORT_INVALID');
const xml = v => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const string = v => `<string>${xml(v)}</string>`;
const text = `<?xml version="1.0" encoding="UTF-8"?>
${marker}
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key>${string('io.termnest.supervisor')}
<key>ProgramArguments</key><array>${string(fs.realpathSync(node))}${string(path.join(app, 'server.js'))}</array>
<key>WorkingDirectory</key>${string(app)}
<key>EnvironmentVariables</key><dict>
<key>TW_DATA</key>${string(data)}<key>TW_PASSWORD_FILE</key>${string(password)}<key>TW_PORT</key>${string(port)}
</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>60</integer>
<key>AbandonProcessGroup</key><true/>
<key>ExitTimeOut</key><integer>90</integer>
<key>Umask</key><integer>63</integer>
<key>ProcessType</key><string>Background</string>
</dict></plist>
`;
try {
  let existing;
  try { existing = readProtected(file, 65536).toString('utf8'); }
  catch (e) { if (fs.existsSync(file) || e.code !== 'RUNTIME_FILE_UNREADABLE') fail('RUNTIME_EXISTING_AGENT_UNMANAGED'); }
  // lstat also rejects a dangling symlink; never silently replace one.
  try { fs.lstatSync(file); if (!existing || !existing.includes(marker)) fail('RUNTIME_EXISTING_AGENT_UNMANAGED'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (dry === '1') {
    if (action === 'install') process.stdout.write(text);
    else console.log(`RUNTIME_DRY_RUN_${action.toUpperCase()} io.termnest.supervisor`);
    process.exit(0);
  }
  if (action !== 'install') {
    if (!existing) fail('RUNTIME_AGENT_NOT_CONFIGURED');
    process.exit(0);
  }
  assertPrivatePath(data, { directory: true });
  readPassword(password); readProtected(path.join(data, 'vault.json'), 32 * 1024 * 1024).fill(0);
  // launchd loads only validated XML, including on an unchanged/idempotent install.
  execFileSync('/usr/bin/plutil', ['-lint', '-'], { input: text, stdio: ['pipe', 'ignore', 'ignore'], timeout: 3000 });
  if (existing === text) process.exit(0);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const dir = fs.lstatSync(path.dirname(file));
  if (!dir.isDirectory() || dir.uid !== process.getuid() || (dir.mode & 0o022)) fail('RUNTIME_UNSAFE_AGENT_DIRECTORY');
  const temp = file + '.' + process.pid + '.tmp';
  try { fs.writeFileSync(temp, text, { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, file); }
  finally { try { fs.unlinkSync(temp); } catch {} }
} catch { fail('RUNTIME_INSTALL_FAILED'); }
NODE
if (( dry )); then exit 0; fi
domain="gui/$(id -u)"
case "$action" in
  status)
    # Never print launchctl's inherited environment (which may contain unrelated user secrets).
    if /bin/launchctl print "$domain/$label" >/dev/null 2>&1; then
      echo RUNTIME_AGENT_LOADED_LOGIN_SESSION_ONLY
    else echo RUNTIME_AGENT_NOT_LOADED; fi ;;
  uninstall)
    # bootout signals the supervisor only: AbandonProcessGroup preserves tmux/workers.
    if /bin/launchctl print "$domain/$label" >/dev/null 2>&1; then /bin/launchctl bootout "$domain/$label"; fi
    rm -- "$agent_file"
    echo RUNTIME_AGENT_UNINSTALLED ;;
  install)
    # Do not kickstart/bootout an already running supervisor on rerun.
    if ! /bin/launchctl print "$domain/$label" >/dev/null 2>&1; then /bin/launchctl bootstrap "$domain" "$agent_file"; fi
    echo 'RUNTIME_AGENT_INSTALLED_LOGIN_SESSION_ONLY; changed configuration applies on next start' ;;
esac
