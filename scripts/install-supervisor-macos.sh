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
  arm64|aarch64) runtime_arch=arm64 ;;
  x86_64) runtime_arch=x64 ;;
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
# Validate before execution using only macOS base-system tools (no Node, Python or
# developer tools needed). Decode bytes explicitly: FAT/FAT64 tables may have either
# byte order. Bound file size, architecture count and load-command reads; validate
# every selectable slice, including the one launchd may prefer outside Rosetta.
# Format references: Apple cctools include/mach-o/{fat,loader}.h.
macho_words() {
  /usr/bin/od -An -v -j "$1" -N "$2" -t u1 "$node_bin" 2>/dev/null |
    /usr/bin/awk -v byte_count="$2" -v little="$3" '
      { for (i=1; i<=NF; i++) b[n++]=$i }
      END {
        if (n != byte_count || n % 4) exit 1
        for (i=0; i<n; i+=4) {
          if (little) v=b[i]+256*b[i+1]+65536*b[i+2]+16777216*b[i+3]
          else v=16777216*b[i]+65536*b[i+1]+256*b[i+2]+b[i+3]
          printf "%.0f ", v
        }
        print ""
      }'
}
validate_macos_slice() {
  local start="$1" span="$2" expected_cpu="$3" expected_subtype="$4" header
  local magic cpu subtype kind commands size flags reserved
  (( span >= 32 )) || return 1
  header="$(macho_words "$start" 32 1)" || return 1
  read -r magic cpu subtype kind commands size flags reserved <<< "$header"
  # Supported x64/arm64 macOS executables use little-endian 64-bit Mach-O.
  [[ "$magic" = 4277009103 && "$kind" = 2 && "$reserved" = 0 ]] || return 1
  [[ "$cpu" = 16777223 || "$cpu" = 16777228 ]] || return 1
  if (( expected_cpu )); then
    [[ "$cpu" = "$expected_cpu" && "$subtype" = "$expected_subtype" ]] || return 1
  fi
  (( commands > 0 && commands <= 256 && size >= 8 && size <= 1048576 && size <= span - 32 )) || return 1
  /usr/bin/od -An -v -j "$((start+32))" -N "$size" -t u1 "$node_bin" 2>/dev/null |
    /usr/bin/awk -v byte_count="$size" -v commands="$commands" '
      function u32(p) { return b[p]+256*b[p+1]+65536*b[p+2]+16777216*b[p+3] }
      { for (i=1; i<=NF; i++) b[n++]=$i }
      END {
        if (n != byte_count) exit 1
        p=0; found=0
        for (i=0; i<commands; i++) {
          if (p+8 > n) exit 1
          cmd=u32(p); size=u32(p+4)
          if (size < 8 || size % 8 || size > n-p) exit 1
          if (cmd == 50) { # LC_BUILD_VERSION: macOS, bounded build_tool_version array
            if (size < 24 || u32(p+8) != 1 || u32(p+20) > (size-24)/8) exit 1
            found=1
          } else if (cmd == 36) { # LC_VERSION_MIN_MACOSX
            if (size != 16) exit 1
            found=1
          } else if (cmd == 37 || cmd == 47 || cmd == 48) exit 1 # iOS/tvOS/watchOS
          p+=size
        }
        if (!found || p != n) exit 1
      }' || return 1
  case "$cpu" in 16777223) slice_arch=x64 ;; 16777228) slice_arch=arm64 ;; esac
}
validate_macos_node() {
  local total header magic count little=0 wide=0 entry=20 table slices start span cpu subtype slice_arch
  total="$(/usr/bin/wc -c < "$node_bin")" || return 1
  total="${total//[[:space:]]/}"
  [[ "$total" =~ ^[0-9]+$ ]] || return 1
  (( total >= 32 && total <= 1073741824 )) || return 1
  header="$(macho_words 0 8 0)" || return 1
  read -r magic count <<< "$header"
  node_arches=" "
  case "$magic" in
    3489328638) # Little-endian MH_MAGIC_64, read as big-endian bytes
      validate_macos_slice 0 "$total" 0 0 || return 1
      node_arches=" $slice_arch " ;;
    3405691582|3199925962|3405691583|3216703178)
      case "$magic" in 3199925962|3216703178) little=1 ;; esac
      case "$magic" in 3405691583|3216703178) wide=1; entry=32 ;; esac
      header="$(macho_words 0 8 "$little")" || return 1
      read -r magic count <<< "$header"
      (( count > 0 && count <= 64 )) || return 1
      table=$((8+count*entry))
      (( table <= total )) || return 1
      slices="$(/usr/bin/od -An -v -N "$table" -t u1 "$node_bin" 2>/dev/null |
        /usr/bin/awk -v byte_count="$table" -v total="$total" -v count="$count" -v little="$little" -v wide="$wide" -v entry="$entry" '
          function u32(p) {
            if (little) return b[p]+256*b[p+1]+65536*b[p+2]+16777216*b[p+3]
            return 16777216*b[p]+65536*b[p+1]+256*b[p+2]+b[p+3]
          }
          function bounded64(p) {
            # File size is capped at 1 GiB: refuse high words before any floating-point conversion.
            if (u32(p+(little ? 4 : 0)) != 0) return -1
            return u32(p+(little ? 0 : 4))
          }
          { for (i=1; i<=NF; i++) b[n++]=$i }
          END {
            if (n != byte_count) exit 1
            for (i=0; i<count; i++) {
              p=8+i*entry; cpu=u32(p); subtype=u32(p+4)
              if (cpu != 16777223 && cpu != 16777228) exit 1
              if (seen[cpu]++) exit 1
              start=wide ? bounded64(p+8) : u32(p+8)
              size=wide ? bounded64(p+16) : u32(p+12)
              align=u32(p+(wide ? 24 : 16))
              if (wide && u32(p+28) != 0) exit 1
              if (start < byte_count || size < 32 || start > total || size > total-start || align > 30 || start % (2^align)) exit 1
              for (j=0; j<i; j++) if (start < ends[j] && starts[j] < start+size) exit 1
              starts[i]=start; ends[i]=start+size
              printf "%.0f %.0f %.0f %.0f\n", start, size, cpu, subtype
            }
          }')" || return 1
      while read -r start span cpu subtype; do
        validate_macos_slice "$start" "$span" "$cpu" "$subtype" || return 1
        node_arches="$node_arches$slice_arch "
      done <<< "$slices" ;;
    *) return 1 ;;
  esac
  # Bundles must match this execution context. For source/explicit Node, another
  # CPU is usable only if the native loader can run it (e.g. installed Rosetta).
  # uname describes the current execution context, never proof of Intel hardware.
  if [[ "$node_arches" != *" $runtime_arch "* ]]; then
    (( ! bundled )) || return 1
    case "$node_arches" in ' x64 ') /usr/bin/arch -x86_64 /usr/bin/true >/dev/null 2>&1 || return 1 ;;
      ' arm64 ') /usr/bin/arch -arm64 /usr/bin/true >/dev/null 2>&1 || return 1 ;; *) return 1 ;; esac
  fi
}
if [[ "$runtime_os" = Darwin ]] || (( bundled )); then
  validate_macos_node || { echo RUNTIME_NODE_INCOMPATIBLE >&2; exit 2; }
fi
# Linux dry-run is a generation-only development fixture. Native installation still requires Darwin.
# The fixed probe prints no environment or secret and confirms the selected executable's own identity.
node_identity="$("$node_bin" -p 'process.platform + "/" + process.arch')" || { echo RUNTIME_NODE_REQUIRED >&2; exit 2; }
case "$runtime_os/$node_identity" in
  Darwin/darwin/x64|Darwin/darwin/arm64)
    [[ "$node_arches" = *" ${node_identity#darwin/} "* ]] || { echo RUNTIME_NODE_INCOMPATIBLE >&2; exit 2; } ;;
  Linux/linux/"$runtime_arch") ;;
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
const runtimeNode = fs.realpathSync(node);
// launchd has a minimal PATH. Match the desktop's Homebrew support and include
// the selected runtime plus system tools, without inheriting shell environment.
// A colon cannot represent a single PATH entry; omit that optional runtime dir.
const toolPath = [...new Set([path.dirname(runtimeNode), '/opt/homebrew/bin', '/usr/local/bin',
  '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(v => path.isAbsolute(v) && v.length <= 4096 && !/[:\x00-\x1f\x7f]/.test(v)))].join(':');
const text = `<?xml version="1.0" encoding="UTF-8"?>
${marker}
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key>${string('io.termnest.supervisor')}
<key>ProgramArguments</key><array>${string(runtimeNode)}${string(path.join(app, 'server.js'))}</array>
<key>WorkingDirectory</key>${string(app)}
<key>EnvironmentVariables</key><dict>
<key>PATH</key>${string(toolPath)}
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
