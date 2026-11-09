# Current-user Task Scheduler adapter. No elevation, account password, service account or system service.
# Usage: powershell.exe -NoProfile -File scripts/install-supervisor.ps1 [-DryRun] [-DataDir DIR] [-PasswordFile FILE] [-Port 7681] [-NodePath EXE]
#        powershell.exe -NoProfile -File scripts/install-supervisor.ps1 -Status|-Uninstall [-DryRun]
# Optional -CreatePassword prompts securely only for a new secret inside an already private directory.
# Runtime: explicit -NodePath, then app/node.exe from the installed payload, then PATH for source installs.
# DATA defaults to the desktop launcher's Roaming AppData/Termnest; no vault migration is performed.
# Prefer -PasswordFile with an existing protected secret. Never replaces a secret or a vault.
# -DryRun prints deterministic task XML with paths only; it creates nothing and never prompts/starts a task.
# InteractiveToken + LogonTrigger means LOGIN SESSION ONLY, not unattended boot or execution after logout.
# Sleep and power-off suspend supervision. Use an always-on host for 24/7 supervision.
[CmdletBinding()]
param(
  [switch]$DryRun, [switch]$Status, [switch]$Uninstall, [switch]$CreatePassword,
  [string]$DataDir = (Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Termnest'),
  [string]$PasswordFile = '', [ValidateRange(1,65535)][int]$Port = 7681,
  [string]$NodePath = ''
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
try {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'RUNTIME_WINDOWS_REQUIRED' }
  if ($Status -and $Uninstall) { throw 'RUNTIME_ARGUMENT_INVALID' }
  function AbsolutePath([string]$Value) {
    if ($Value -notmatch '^[A-Za-z]:[\\/]' -or $Value -match '[\x00-\x1f\x7f]') { throw 'RUNTIME_PATH_INVALID' }
    return [IO.Path]::GetFullPath($Value)
  }
  function Xml([string]$Value) { return [Security.SecurityElement]::Escape($Value) }
  $AppDir = AbsolutePath (Split-Path -Parent $PSScriptRoot)
  $DataDir = AbsolutePath $DataDir
  if (-not $PasswordFile) { $PasswordFile = Join-Path $DataDir 'password' }
  $PasswordFile = AbsolutePath $PasswordFile
  # Read PE metadata before execution. Do not run a binary for a different OS/CPU,
  # including an incompatible packaged runtime, and never silently bypass a damaged payload.
  if (-not ('TermnestNativeCpu' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TermnestNativeCpu {
 [StructLayout(LayoutKind.Sequential)] public struct Info {
  public ushort Architecture, Reserved; public uint PageSize; public IntPtr Minimum, Maximum, Mask;
  public uint Count, Type, Granularity; public ushort Level, Revision;
 }
 [DllImport("kernel32.dll")] static extern void GetNativeSystemInfo(out Info info);
 public static ushort Architecture() { Info info; GetNativeSystemInfo(out info); return info.Architecture; }
}
'@
  }
  $cpu = [TermnestNativeCpu]::Architecture()
  switch ($cpu) {
    9 { $machine = 0x8664; $nodeArch = 'x64' }
    12 { $machine = 0xaa64; $nodeArch = 'arm64' }
    0 { $machine = 0x014c; $nodeArch = 'ia32' }
    default { throw 'RUNTIME_NODE_ARCH_UNSUPPORTED' }
  }
  if (-not $NodePath) {
    $bundledNode = Join-Path $AppDir 'node.exe'
    if (Test-Path -LiteralPath $bundledNode) { $NodePath = $bundledNode }
    else {
      # Several node.exe on PATH return several commands; use the first, as PATH resolution does.
      try { $NodePath = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source }
      catch { throw 'RUNTIME_NODE_REQUIRED' }
    }
  }
  try { $NodePath = (Get-Item -LiteralPath (AbsolutePath $NodePath)).FullName }
  catch { throw 'RUNTIME_NODE_REQUIRED_PATH' }
  $reader = $null
  try {
    $reader = [IO.BinaryReader]::new([IO.File]::OpenRead($NodePath))
    if ($reader.BaseStream.Length -lt 64 -or $reader.ReadUInt16() -ne 0x5a4d) { throw 'RUNTIME_NODE_INCOMPATIBLE' }
    $reader.BaseStream.Position = 60
    $peOffset = $reader.ReadUInt32()
    if ($peOffset -gt $reader.BaseStream.Length - 24) { throw 'RUNTIME_NODE_INCOMPATIBLE' }
    $reader.BaseStream.Position = $peOffset
    if ($reader.ReadUInt32() -ne 0x00004550 -or $reader.ReadUInt16() -ne $machine) { throw 'RUNTIME_NODE_INCOMPATIBLE' }
  } finally { if ($reader) { $reader.Dispose() } }
  $resolvedNode = & $NodePath -e 'process.stdout.write(JSON.stringify({path:require(''node:fs'').realpathSync.native(process.execPath),platform:process.platform,arch:process.arch}));'
  if ($LASTEXITCODE -ne 0) { throw 'RUNTIME_NODE_REQUIRED_PROBE' }
  try { $runtimeInfo = $resolvedNode | ConvertFrom-Json }
  catch { throw 'RUNTIME_NODE_INCOMPATIBLE' }
  if ($runtimeInfo.platform -ne 'win32' -or $runtimeInfo.arch -ne $nodeArch) { throw 'RUNTIME_NODE_INCOMPATIBLE' }
  $NodePath = AbsolutePath $runtimeInfo.path
  $resolvedApp = & $NodePath -e 'process.stdout.write(require(''node:fs'').realpathSync.native(process.argv[1]));' $AppDir
  if ($LASTEXITCODE -ne 0) { throw 'RUNTIME_PATH_INVALID' }
  $AppDir = AbsolutePath $resolvedApp
  $Sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $TaskName = "Termnest-Supervisor-$Sid"
  $Marker = "Termnest current-user supervisor v1; SID=$Sid"
  $Runtime = Join-Path $AppDir 'lib/service-runtime.js'
  # Only paths cross argv; no file content is printed by the validator.
  function ValidatePath([string]$Value, [bool]$Directory = $false) {
    $program = 'const r=require(process.argv[1]);r.assertPrivatePath(process.argv[2],{directory:process.argv[3]===''directory''});'
    & $NodePath -e $program $Runtime $Value $(if ($Directory) { 'directory' } else { 'file' })
    if ($LASTEXITCODE -ne 0) { throw 'RUNTIME_UNSAFE_PATH' }
  }
  # Node -e is passed directly to CreateProcess, without cmd.exe/PowerShell shell interpretation.
  # Base64 holds JavaScript containing PATHS only. It avoids Windows command-line quote/backslash ambiguity.
  $config = [ordered]@{ TW_DATA=$DataDir; TW_PASSWORD_FILE=$PasswordFile; TW_PORT=[string]$Port } | ConvertTo-Json -Compress
  $server = (Join-Path $AppDir 'server.js') | ConvertTo-Json -Compress
  $program = "Object.assign(process.env,$config);require($server);"
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($program))
  $arguments = '-e "eval(Buffer.from(' + "'$encoded','base64'" + ').toString(' + "'utf8'" + '))"'
  $xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<RegistrationInfo><Description>$(Xml $Marker)</Description></RegistrationInfo>
<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>$(Xml $Sid)</UserId></LogonTrigger></Triggers>
<Principals><Principal id="Owner"><UserId>$(Xml $Sid)</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>false</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><Enabled>true</Enabled><Hidden>true</Hidden><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings>
<Actions Context="Owner"><Exec><Command>$(Xml $NodePath)</Command><Arguments>$(Xml $arguments)</Arguments><WorkingDirectory>$(Xml $AppDir)</WorkingDirectory></Exec></Actions>
</Task>
"@
  [xml]$parsed = $xml
  if ($DryRun) {
    if ($Status) { Write-Output "RUNTIME_DRY_RUN_STATUS $TaskName" }
    elseif ($Uninstall) { Write-Output "RUNTIME_DRY_RUN_UNINSTALL $TaskName" }
    else { Write-Output $xml }
    exit 0
  }
  # COM uses Task Scheduler's native schema; no schtasks localized display parsing or credentials.
  $scheduler = New-Object -ComObject 'Schedule.Service'
  $scheduler.Connect()
  $folder = $scheduler.GetFolder('\')
  $existing = $null
  try { $existing = $folder.GetTask($TaskName) }
  catch {
    $failure = $_.Exception; $missing = $false
    while ($failure) {
      if (($failure.HResult -band 0xffffffffL) -eq 0x80070002L) { $missing = $true }
      $failure = $failure.InnerException
    }
    if (-not $missing) { throw 'RUNTIME_TASK_MANAGER_UNAVAILABLE' }
  }
  if ($existing) {
    # Task Scheduler stores the SID we registered but reads it back as an account name ("HOST\user"): compare as SIDs.
    $owner = [string]$existing.Definition.Principal.UserId
    if ($owner -and $owner -notmatch '^S-1-') {
      try { $owner = ([Security.Principal.NTAccount]$owner).Translate([Security.Principal.SecurityIdentifier]).Value } catch { $owner = '' }
    }
    if ($existing.Definition.RegistrationInfo.Description -ne $Marker -or $owner -ne $Sid) { throw 'RUNTIME_EXISTING_TASK_UNMANAGED' }
  }
  if ($Status) {
    if (-not $existing) { Write-Output 'RUNTIME_TASK_NOT_CONFIGURED'; exit 0 }
    # Numeric manager state is not an unlocked/fresh/audit-health verdict.
    Write-Output (ConvertTo-Json -Compress @{ mode='login_session'; configured=$true; state=[int]$existing.State; lastResult=[long]$existing.LastTaskResult })
    exit 0
  }
  if ($Uninstall) {
    # Delete registration only. Never Stop-ScheduledTask, taskkill, or terminate the running process/descendants.
    if ($existing) { $folder.DeleteTask($TaskName, 0) }
    Write-Output 'RUNTIME_TASK_UNREGISTERED; running supervisor and workers were not stopped'
    exit 0
  }
  if (-not (Test-Path -LiteralPath $DataDir)) {
    $null = [IO.Directory]::CreateDirectory($DataDir)
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier($Sid)))
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($id in @($Sid, 'S-1-5-18', 'S-1-5-32-544')) {
      $rule = New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($id)), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
      $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $DataDir -AclObject $acl
  }
  ValidatePath $DataDir $true
  # Installation requires the user's existing primary; never creates/replaces/unlocks/migrates a vault.
  ValidatePath (Join-Path $DataDir 'vault.json')
  if (-not (Test-Path -LiteralPath $PasswordFile)) {
    if (-not $CreatePassword -or [Console]::IsInputRedirected) { throw 'RUNTIME_PASSWORD_FILE_REQUIRED' }
    ValidatePath (Split-Path -Parent $PasswordFile) $true
    $secure = Read-Host 'Vault password' -AsSecureString
    $ptr = [IntPtr]::Zero
    $bytes = $null
    $stream = $null
    try {
      $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
      $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
      if (-not $plain.Trim() -or $plain -match '[\x00-\x1f\x7f-\x9f\ufeff]') { throw 'RUNTIME_PASSWORD_INVALID' }
      $bytes = [Text.Encoding]::UTF8.GetBytes($plain + "`n")
      if ($bytes.Length -gt 4096) { throw 'RUNTIME_PASSWORD_INVALID' }
      $plain = $null
      # CreateNew refuses overwrite; the private parent gives a private inherited ACL before any byte is written.
      $stream = [IO.File]::Open($PasswordFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
      ValidatePath $PasswordFile
      $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true)
    } finally {
      if ($stream) { $stream.Dispose() }
      if ($bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
      if ($ptr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
      if ($secure) { $secure.Dispose() }
      $plain = $null
    }
  }
  & $NodePath -e 'require(process.argv[1]).readPassword(process.argv[2]);' $Runtime $PasswordFile
  if ($LASTEXITCODE -ne 0) { throw 'RUNTIME_PASSWORD_FILE_INVALID' }
  function SameTaskDefinition($Left, $Right) {
    # The scheduler may add registration Date/URI and IDs. Compare the requested behavior, not that metadata.
    foreach ($field in @('UserId', 'LogonType', 'RunLevel')) {
      if ([string]$Left.Principal.$field -ne [string]$Right.Principal.$field) { return $false }
    }
    foreach ($field in @('MultipleInstances', 'DisallowStartIfOnBatteries', 'StopIfGoingOnBatteries',
        'AllowHardTerminate', 'StartWhenAvailable', 'RunOnlyIfNetworkAvailable', 'Enabled', 'Hidden',
        'ExecutionTimeLimit', 'RestartInterval', 'RestartCount', 'RunOnlyIfIdle', 'WakeToRun')) {
      if ([string]$Left.Settings.$field -ne [string]$Right.Settings.$field) { return $false }
    }
    if ($Left.Actions.Count -ne 1 -or $Left.Triggers.Count -ne 1) { return $false }
    foreach ($field in @('Type', 'Path', 'Arguments', 'WorkingDirectory')) {
      if ([string]$Left.Actions.Item(1).$field -ne [string]$Right.Actions.Item(1).$field) { return $false }
    }
    foreach ($field in @('Type', 'Enabled', 'UserId', 'Delay')) {
      if ([string]$Left.Triggers.Item(1).$field -ne [string]$Right.Triggers.Item(1).$field) { return $false }
    }
    return $true
  }
  # Register only if semantic task settings/actions changed; never stop/restart an existing instance.
  $definition = $scheduler.NewTask(0)
  $definition.XmlText = $xml
  if (-not $existing -or -not (SameTaskDefinition $existing.Definition $definition)) {
    $null = $folder.RegisterTaskDefinition($TaskName, $definition, 6, $Sid, $null, 3, $null)
  }
  if (-not $existing -or [int]$existing.State -ne 4) { $null = $folder.GetTask($TaskName).Run($null) }
  Write-Output 'RUNTIME_TASK_INSTALLED_LOGIN_SESSION_ONLY'
} catch {
  # Never print native exception/path/credential data. Report only fixed application codes.
  $code = [string]$_.Exception.Message
  if ($code -notmatch '^RUNTIME_[A-Z_]+$') {
    # Diagnostics for tests only: the exception TYPE and failing line, never its message (may hold paths or data).
    if ($env:TERMNEST_INSTALL_DIAG -eq '1') { [Console]::Error.WriteLine('DIAG ' + $_.Exception.GetType().FullName + ' line ' + $_.InvocationInfo.ScriptLineNumber) }
    $code = 'RUNTIME_INSTALL_FAILED'
  }
  [Console]::Error.WriteLine($code)
  exit 2
}
