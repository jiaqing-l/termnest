'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');
const { platformRuntimeInfo } = require('../lib/platform-supervisor');
const ROOT = path.resolve(__dirname, '..');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termnest-platform-'));
  fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const psPath = () => path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
function ps(program, input = '') {
  program = `[Console]::InputEncoding=New-Object Text.UTF8Encoding($false);[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false);` + program;
  return execFileSync(psPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(program, 'utf16le').toString('base64')],
    { input, encoding: 'utf8', timeout: 120000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }).replace(/^\ufeff/, '').trim();
}
function windowsDry(args) {
  return execFileSync(psPath(), ['-NoProfile', '-NonInteractive', '-File', path.join(ROOT, 'scripts/install-supervisor.ps1'), '-DryRun', ...args],
    { encoding: 'utf8', timeout: 15000, windowsHide: true }).replace(/^\ufeff/, '').trim();
}
function macDry(dir, args = [], app = ROOT) {
  return execFileSync('/bin/bash', [path.join(app, 'scripts/install-supervisor-macos.sh'), '--dry-run', ...args],
    { cwd: ROOT, env: { ...process.env, HOME: path.join(dir, 'absent home & Việt') }, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
}

test('pure readiness provider returns stable primitives and never turns configuration into runtime health', () => {
  const unknown = platformRuntimeInfo({ platform: 'win32' });
  assert.equal(unknown.manager, 'task_scheduler'); assert.equal(unknown.startupCode, 'STARTUP_NOT_CONFIGURED');
  assert.equal(unknown.localTeams, 'unknown'); assert.equal(unknown.remoteLinuxTeamsOverSsh, true);
  for (const p of ['win32', 'darwin', 'linux', 'unsupported']) {
    const result = platformRuntimeInfo({ platform: p, startupConfigured: true, startupVerified: true, managerAvailable: true,
      startupMode: p === 'linux' ? 'user_manager' : 'login_session', nodeAvailable: true, tmuxAvailable: true });
    assert.ok(Object.values(result).every(v => ['boolean', 'string', 'number'].includes(typeof v)));
    assert.equal(result.unattendedBoot, false); assert.equal(result.unlocked, 'unknown');
    assert.equal(result.observationsFresh, 'unknown'); assert.equal(result.auditValidated, 'unknown');
    assert.equal(result.runsDuringSleep, false); assert.equal(result.runsWhilePoweredOff, false);
  }
});

test('mock platform readiness distinguishes login-session managers, systemd linger and missing WSL dependencies', () => {
  for (const platform of ['win32', 'darwin']) {
    const r = platformRuntimeInfo({ platform, startupConfigured: true, startupMode: 'login_session', startupVerified: true, managerAvailable: true });
    assert.equal(r.startupVerified, true); assert.equal(r.requiresLogin, true); assert.equal(r.survivesLogout, false);
  }
  const options = { platform: 'linux', startupConfigured: true, startupMode: 'user_manager', startupVerified: true, managerAvailable: true };
  assert.equal(platformRuntimeInfo(options).startupCode, 'STARTUP_LINGER_REQUIRED');
  assert.equal(platformRuntimeInfo({ ...options, linger: true }).unattendedBoot, true);
  assert.equal(platformRuntimeInfo({ ...options, managerAvailable: false }).startupCode, 'STARTUP_MANAGER_UNAVAILABLE');
  assert.equal(platformRuntimeInfo({ ...options, managerAvailable: undefined }).startupCode, 'STARTUP_UNVERIFIED');
  assert.equal(platformRuntimeInfo({ ...options, startupMode: 'system_service' }).startupConfigured, false);
  for (const missing of ['wslAvailable', 'wslNodeAvailable', 'wslTmuxAvailable']) {
    const r = platformRuntimeInfo({ platform: 'win32', wslAvailable: true, wslNodeAvailable: true, wslTmuxAvailable: true, [missing]: false });
    assert.equal(r.localTeams, 'unavailable'); assert.equal(r.localTeamsCode, 'WSL_NODE_TMUX_REQUIRED');
    assert.equal(r.remoteLinuxTeamsOverSsh, true); assert.equal(r.nativeShell, 'powershell'); assert.equal(r.nativeShellPersistent, false);
  }
});

test('macOS plist dry-run escapes paths, preserves workers and creates no files or secret values',
  { skip: process.platform === 'win32' ? 'POSIX adapter; native Windows generation covered separately' : false }, t => {
    const dir = fixture(t), data = path.join(dir, 'absent & <data> " Việt $ ` %');
    const args = ['--data-dir', data, '--password-file', path.join(dir, 'absent secret'), '--port', '8765'];
    const a = macDry(dir, args), b = macDry(dir, args);
    assert.equal(a, b); assert.match(a, /&amp; &lt;data&gt; &quot; Việt/);
    assert.match(a, /<key>AbandonProcessGroup<\/key><true\/>/);
    assert.match(a, /<key>ThrottleInterval<\/key><integer>60<\/integer>/);
    assert.match(a, /<key>SuccessfulExit<\/key><false\/>/);
    assert.match(a, /<key>Umask<\/key><integer>63<\/integer>/);
    assert.match(a, /TW_PASSWORD_FILE/); assert.doesNotMatch(a, /TW_PASSWORD<|LaunchDaemon|StandardOutPath/);
    assert.deepEqual(fs.readdirSync(dir), []);
    if (process.platform === 'darwin') {
      execFileSync('/usr/bin/plutil', ['-lint', '-'], { input: a });
      const json = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { input: a, encoding: 'utf8' }));
      assert.equal(json.EnvironmentVariables.TW_DATA, data);
      assert.deepEqual(json.ProgramArguments, [fs.realpathSync(process.execPath), path.join(ROOT, 'server.js')]);
    }
    assert.match(macDry(dir, ['--status']), /RUNTIME_DRY_RUN_STATUS/);
    assert.match(macDry(dir, ['--uninstall']), /RUNTIME_DRY_RUN_UNINSTALL/);
  });

test('macOS dry-run resolves special application path and refuses unmanaged/symlinked registration',
  { skip: process.platform === 'win32' ? 'POSIX path/security checks' : false }, t => {
    const dir = fixture(t), app = path.join(dir, 'app & < > " \' Việt $ %');
    fs.mkdirSync(path.join(app, 'scripts'), { recursive: true }); fs.mkdirSync(path.join(app, 'lib'));
    fs.copyFileSync(path.join(ROOT, 'scripts/install-supervisor-macos.sh'), path.join(app, 'scripts/install-supervisor-macos.sh'));
    fs.copyFileSync(path.join(ROOT, 'lib/service-runtime.js'), path.join(app, 'lib/service-runtime.js'));
    assert.match(macDry(dir, [], app), /app &amp; &lt; &gt; &quot; &apos; Việt/);
    const agent = path.join(dir, 'absent home & Việt/Library/LaunchAgents/io.termnest.supervisor.plist');
    fs.mkdirSync(path.dirname(agent), { recursive: true }); fs.writeFileSync(agent, '<plist>unmanaged</plist>', { mode: 0o600 });
    assert.throws(() => macDry(dir), e => e.stderr.includes('RUNTIME_EXISTING_AGENT_UNMANAGED'));
    fs.unlinkSync(agent); fs.symlinkSync(path.join(dir, 'absent'), agent);
    assert.throws(() => macDry(dir), e => e.stderr.includes('RUNTIME_EXISTING_AGENT_UNMANAGED'));
    assert.equal(fs.lstatSync(agent).isSymbolicLink(), true);
  });

test('macOS adapter rejects unsupported native host before modifying state', { skip: process.platform !== 'linux' ? 'Linux unsupported-host guard' : false }, t => {
  const dir = fixture(t), home = path.join(dir, 'home');
  const r = spawnSync('/bin/bash', [path.join(ROOT, 'scripts/install-supervisor-macos.sh')], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  assert.equal(r.status, 2); assert.match(r.stderr, /RUNTIME_MACOS_REQUIRED/); assert.equal(fs.existsSync(home), false);
});

test('native Windows task XML handles non-ASCII/metacharacters and uses current-user InteractiveToken without credentials',
  { skip: process.platform !== 'win32' ? 'requires actual Windows PowerShell and Task Scheduler schema' : false }, t => {
    const dir = fixture(t), data = path.join(dir, 'absent data & Việt $ ` % \' (x)'), secret = path.join(data, 'password');
    const args = ['-DataDir', data, '-PasswordFile', secret, '-Port', '8765'];
    const a = windowsDry(args); assert.equal(a, windowsDry(args));
    assert.match(a, /<LogonType>InteractiveToken<\/LogonType>/); assert.match(a, /<RunLevel>LeastPrivilege<\/RunLevel>/);
    assert.match(a, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/); assert.match(a, /<AllowHardTerminate>false/);
    assert.doesNotMatch(a, /<Password>|TW_PASSWORD['"=:]|<BootTrigger>|HighestAvailable/);
    // Parse through the actual native task definition, WITHOUT registering/starting a task.
    const parsed = JSON.parse(ps(`$ErrorActionPreference='Stop';$text=[Console]::In.ReadToEnd();
$s=New-Object -ComObject 'Schedule.Service';$s.Connect();$d=$s.NewTask(0);$d.XmlText=$text;
[xml]$x=$text;@{command=[string]$x.Task.Actions.Exec.Command;arguments=[string]$x.Task.Actions.Exec.Arguments;sid=[string]$x.Task.Principals.Principal.UserId} | ConvertTo-Json -Compress`, a));
    assert.equal(path.resolve(parsed.command), path.resolve(process.execPath));
    const base64 = parsed.arguments.match(/Buffer\.from\('([A-Za-z0-9+/=]+)'/)[1];
    const js = Buffer.from(base64, 'base64').toString('utf8');
    const context = { process: { env: {} }, require: server => { assert.equal(server, path.join(ROOT, 'server.js')); } };
    require('node:vm').runInNewContext(js, context);
    assert.equal(context.process.env.TW_DATA, data); assert.equal(context.process.env.TW_PASSWORD_FILE, secret);
    assert.equal(context.process.env.TW_PORT, '8765'); assert.deepEqual(fs.readdirSync(dir), []);
    assert.match(windowsDry(['-Status']), /RUNTIME_DRY_RUN_STATUS/);
    assert.match(windowsDry(['-Uninstall']), /RUNTIME_DRY_RUN_UNINSTALL/);
  });

test('adapter source contracts forbid process-tree termination, secret arguments and production startup during dry-run', () => {
  const win = fs.readFileSync(path.join(ROOT, 'scripts/install-supervisor.ps1'), 'utf8');
  const mac = fs.readFileSync(path.join(ROOT, 'scripts/install-supervisor-macos.sh'), 'utf8');
  assert.doesNotMatch(win, /^\s*(Stop-ScheduledTask|Stop-Process|taskkill|schtasks)/mi);
  assert.doesNotMatch(mac, /^\s*(kill|pkill|sudo|launchctl kickstart)/m);
  assert.ok(win.indexOf('if ($DryRun)') < win.indexOf("New-Object -ComObject 'Schedule.Service'"));
  assert.ok(mac.indexOf("if (dry === '1')") < mac.indexOf("assertPrivatePath(data"));
  assert.match(win, /FileMode\]::CreateNew/); assert.match(win, /SecureStringToBSTR/); assert.match(win, /ZeroFreeBSTR/);
});

test('native verify workflow covers four OS targets without publishing or credential artifacts', () => {
  const yaml = fs.readFileSync(path.join(ROOT, '.github/workflows/verify.yml'), 'utf8');
  for (const os of ['windows-2022', 'macos-15', 'macos-15-intel', 'ubuntu-24.04']) assert.ok(yaml.includes('os: ' + os));
  for (const command of ['npm ci', 'npm test', 'cargo test --locked', 'packaging/check-payload.js', 'packaging/desktop-smoke.js']) assert.ok(yaml.includes(command));
  assert.match(yaml, /node-version: '22\.14\.0'/); assert.match(yaml, /RUSTUP_TOOLCHAIN: '1\.98\.0'/);
  assert.match(yaml, /fail-fast: false/); assert.match(yaml, /CARGO_BUILD_JOBS: '2'/);
  assert.match(yaml, /pull_request:/); assert.match(yaml, /validation\/\*\*/);
  assert.doesNotMatch(yaml, /contents: write|secrets\.|gh release|tags:|path:.*(?:home|vault|password)/);
});

test('mock launchd lifecycle installs idempotently, preserves protected files, reports state and uninstalls only owned registration',
  { skip: process.platform === 'win32' ? 'POSIX fixture manager; native Windows mock manager covered separately' : false }, t => {
    const dir = fixture(t), app = path.join(dir, 'app & Việt'), scripts = path.join(app, 'scripts');
    const bin = path.join(dir, 'bin'), home = path.join(dir, 'home'), data = path.join(dir, 'DATA');
    fs.mkdirSync(scripts, { recursive: true }); fs.mkdirSync(path.join(app, 'lib')); fs.mkdirSync(bin); fs.mkdirSync(data, { mode: 0o700 });
    const vault = path.join(data, 'vault.json'), secret = path.join(data, 'password');
    fs.writeFileSync(vault, 'encrypted-fixture', { mode: 0o600 }); fs.writeFileSync(secret, 'synthetic-fixture-password\n', { mode: 0o600 });
    fs.copyFileSync(path.join(ROOT, 'lib/service-runtime.js'), path.join(app, 'lib/service-runtime.js'));
    const manager = path.join(bin, 'launchctl'), plutil = path.join(bin, 'plutil');
    fs.writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\necho Darwin\n', { mode: 0o700 });
    fs.writeFileSync(path.join(bin, 'id'), '#!/bin/sh\necho 12345\n', { mode: 0o700 });
    fs.writeFileSync(plutil, '#!/bin/sh\ncat >/dev/null\n', { mode: 0o700 });
    fs.writeFileSync(manager, `#!/bin/sh
printf '%s\\n' "$1" >> "$HOME/manager.log"
case "$1" in
print) test -f "$HOME/loaded" ;;
bootstrap) touch "$HOME/loaded" ;;
bootout) rm "$HOME/loaded" ;;
*) exit 9 ;;
esac
`, { mode: 0o700 });
    // Change executable locations only in the isolated test copy; no real launchctl can be reached.
    const source = fs.readFileSync(path.join(ROOT, 'scripts/install-supervisor-macos.sh'), 'utf8')
      .replaceAll('/bin/launchctl', manager).replaceAll('/usr/bin/plutil', plutil);
    const installer = path.join(scripts, 'install-supervisor-macos.sh'); fs.writeFileSync(installer, source, { mode: 0o700 });
    const env = { ...process.env, HOME: home, PATH: bin + path.delimiter + process.env.PATH };
    const run = (...args) => execFileSync('/bin/bash', [installer, '--data-dir', data, '--password-file', secret, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.match(run(), /LOGIN_SESSION_ONLY/);
    const agent = path.join(home, 'Library/LaunchAgents/io.termnest.supervisor.plist');
    const before = fs.readFileSync(agent, 'utf8'), time = fs.statSync(agent).mtimeMs;
    assert.match(run(), /LOGIN_SESSION_ONLY/); assert.equal(fs.readFileSync(agent, 'utf8'), before); assert.equal(fs.statSync(agent).mtimeMs, time);
    assert.equal(fs.readFileSync(vault, 'utf8'), 'encrypted-fixture'); assert.equal(fs.readFileSync(secret, 'utf8'), 'synthetic-fixture-password\n');
    const log = fs.readFileSync(path.join(home, 'manager.log'), 'utf8');
    assert.equal(log.split('\n').filter(s => s === 'bootstrap').length, 1); assert.doesNotMatch(log, /kill|kickstart|bootout/);
    assert.match(run('--status'), /RUNTIME_AGENT_LOADED_LOGIN_SESSION_ONLY/);
    assert.match(run('--uninstall'), /RUNTIME_AGENT_UNINSTALLED/); assert.equal(fs.existsSync(agent), false);
    assert.equal(fs.existsSync(vault), true); assert.equal(fs.existsSync(secret), true);
    fs.writeFileSync(agent, '<plist>unrelated-owner</plist>', { mode: 0o600 });
    assert.throws(() => run('--uninstall'), e => e.stderr.includes('RUNTIME_EXISTING_AGENT_UNMANAGED'));
    assert.equal(fs.readFileSync(agent, 'utf8'), '<plist>unrelated-owner</plist>');
    fs.unlinkSync(agent); fs.chmodSync(secret, 0o644);
    assert.throws(() => run(), e => e.stderr.includes('RUNTIME_INSTALL_FAILED'));
    assert.equal(fs.existsSync(agent), false);
  });

test('native Windows with mock Task Scheduler installs/reruns/status/unregisters without overwriting vault or stopping workers',
  { skip: process.platform !== 'win32' ? 'Windows-only fixture uses actual ACL APIs and unregistered native task definitions' : false }, t => {
    const dir = fixture(t);
    const result = JSON.parse(ps(`
$ErrorActionPreference='Stop'
$c=[Console]::In.ReadToEnd() | ConvertFrom-Json
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false)
foreach($id in @($sid.Value,'S-1-5-18','S-1-5-32-544')) {
 $rule=New-Object Security.AccessControl.FileSystemAccessRule(([Security.Principal.SecurityIdentifier]$id),'FullControl','ContainerInherit,ObjectInherit','None','Allow')
 $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $c.dir -AclObject $acl
$data=Join-Path $c.dir 'private data & Việt'
$null=New-Item -ItemType Directory -Path $data
$vault=Join-Path $data 'vault.json';$secret=Join-Path $data 'password'
[IO.File]::WriteAllText($vault,'encrypted-fixture')
[IO.File]::WriteAllText($secret,[string]$c.password)
# Native parser only: no task is registered through this actual COM object.
$script:native=New-Object -ComObject 'Schedule.Service';$script:native.Connect()
$script:state=@{task=$null;register=0;run=0;delete=0}
$script:folder=[pscustomobject]@{}
$script:folder | Add-Member ScriptMethod GetTask {
 param($name)
 if(-not $script:state.task){throw [IO.FileNotFoundException]::new()}
 return $script:state.task
}
$script:folder | Add-Member ScriptMethod RegisterTaskDefinition {
 param($name,$definition,$flags,$user,$password,$logon,$sddl)
 if($password -or $logon -ne 3 -or $user -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value){throw 'unexpected credentials'}
 $script:state.register++
 # Mimic metadata the real manager may add; rerun must still be semantically idempotent.
 $definition.RegistrationInfo.Date='2000-01-01T00:00:00'
 $definition.RegistrationInfo.URI='\\Native-added-uri'
 $script:state.task=[pscustomobject]@{Definition=$definition;State=3;LastTaskResult=0}
 $script:state.task | Add-Member ScriptMethod Run {param($args) $script:state.run++;$this.State=4}
 return $script:state.task
}
$script:folder | Add-Member ScriptMethod DeleteTask {param($name,$flags) $script:state.delete++;$script:state.task=$null}
$script:scheduler=[pscustomobject]@{}
$script:scheduler | Add-Member ScriptMethod Connect {}
$script:scheduler | Add-Member ScriptMethod GetFolder {param($name) return $script:folder}
$script:scheduler | Add-Member ScriptMethod NewTask {param($flags) return $script:native.NewTask(0)}
function New-Object {
 [CmdletBinding(DefaultParameterSetName='Net')]
 param([Parameter(Position=0,ParameterSetName='Net')][string]$TypeName,
       [Parameter(Position=1,ParameterSetName='Net')][object[]]$ArgumentList,
       [Parameter(ParameterSetName='Com')][string]$ComObject)
 if($ComObject){if($ComObject -ne 'Schedule.Service'){throw 'unexpected COM'};return $script:scheduler}
 return Microsoft.PowerShell.Utility\\New-Object @PSBoundParameters
}
$installer=Join-Path $c.root 'scripts/install-supervisor.ps1'
$first=& $installer -DataDir $data -PasswordFile $secret -NodePath $c.node
$second=& $installer -DataDir $data -PasswordFile $secret -NodePath $c.node
$status=& $installer -Status -NodePath $c.node
$uninstall=& $installer -Uninstall -NodePath $c.node
@{register=$script:state.register;run=$script:state.run;delete=$script:state.delete;configured=($null -ne $script:state.task);
first=$first;second=$second;status=$status;uninstall=$uninstall;
vaultIntact=([IO.File]::ReadAllText($vault) -eq 'encrypted-fixture');secretIntact=([IO.File]::ReadAllText($secret) -eq $c.password)} | ConvertTo-Json -Compress
`, JSON.stringify({ dir, root: ROOT, node: process.execPath, password: 'synthetic-fixture-password' })));
    assert.equal(result.register, 1); assert.equal(result.run, 1); assert.equal(result.delete, 1);
    assert.equal(result.configured, false); assert.equal(result.vaultIntact, true); assert.equal(result.secretIntact, true);
    assert.match(result.first, /LOGIN_SESSION_ONLY/); assert.match(result.second, /LOGIN_SESSION_ONLY/);
    assert.equal(JSON.parse(result.status).mode, 'login_session'); assert.match(result.uninstall, /workers were not stopped/);
  });

test('mock missing Node dependency fails before macOS dry-run mutations', { skip: process.platform === 'win32' ? 'POSIX PATH fixture' : false }, t => {
  const dir = fixture(t), bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  // dirname is needed to resolve the script's own absolute application path; no node exists in this fixture PATH.
  fs.symlinkSync('/usr/bin/dirname', path.join(bin, 'dirname'));
  const home = path.join(dir, 'absent home');
  const result = spawnSync('/bin/bash', [path.join(ROOT, 'scripts/install-supervisor-macos.sh'), '--dry-run'],
    { env: { ...process.env, HOME: home, PATH: bin }, encoding: 'utf8' });
  assert.equal(result.status, 2); assert.match(result.stderr, /RUNTIME_NODE_REQUIRED/); assert.equal(fs.existsSync(home), false);
});
