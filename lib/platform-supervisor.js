'use strict';
// Pure capability projection. Callers supply observations; this function never probes, installs or starts anything.
// startupVerified means a native manager was observed with the intended configuration, not runtime/team health.
function platformRuntimeInfo(options = {}) {
  options = options && typeof options === 'object' ? options : {};
  const platform = typeof options.platform === 'string' ? options.platform : process.platform;
  const supported = ['win32', 'darwin', 'linux'].includes(platform);
  const manager = platform === 'win32' ? 'task_scheduler' : platform === 'darwin' ? 'launchd_agent' : platform === 'linux' ? 'systemd_user' : 'unavailable';
  const expectedMode = platform === 'linux' ? 'user_manager' : 'login_session';
  const configured = supported && options.startupConfigured === true && options.startupMode === expectedMode;
  const observed = value => value === true ? 'available' : value === false ? 'unavailable' : 'unknown';
  const managerState = observed(options.managerAvailable);
  const verified = configured && options.startupVerified === true && managerState === 'available';
  const windows = platform === 'win32';
  const localTeams = !supported ? 'unavailable' : windows
    ? options.wslAvailable === false || options.wslNodeAvailable === false || options.wslTmuxAvailable === false ? 'unavailable'
      : options.wslAvailable === true && options.wslNodeAvailable === true && options.wslTmuxAvailable === true ? 'available' : 'unknown'
    : observed(options.nodeAvailable === false || options.tmuxAvailable === false ? false
      : options.nodeAvailable === true && options.tmuxAvailable === true ? true : undefined);
  const unattendedBoot = platform === 'linux' && verified && options.linger === true;
  return Object.freeze({
    schemaVersion: 1, platform, supported, manager,
    startupSupportedMode: supported ? expectedMode : 'unavailable',
    startupMode: configured ? expectedMode : 'none', startupConfigured: configured, startupVerified: verified,
    managerState, startupCode: !supported ? 'PLATFORM_UNSUPPORTED' : !configured ? 'STARTUP_NOT_CONFIGURED'
      : managerState === 'unavailable' ? 'STARTUP_MANAGER_UNAVAILABLE' : !verified ? 'STARTUP_UNVERIFIED'
        : platform === 'linux' && options.linger !== true ? 'STARTUP_LINGER_REQUIRED' : 'STARTUP_CONFIG_VERIFIED',
    unattendedBoot, survivesLogout: unattendedBoot, requiresLogin: supported && !unattendedBoot,
    runsDuringSleep: false, runsWhilePoweredOff: false,
    nativeShell: !supported ? 'unavailable' : windows ? 'powershell' : 'posix',
    nativeShellPersistent: supported && !windows,
    localTeams, localTeamsCode: localTeams === 'available' ? 'LOCAL_TEAMS_DEPENDENCIES_AVAILABLE'
      : localTeams === 'unavailable' ? windows ? 'WSL_NODE_TMUX_REQUIRED' : 'NODE_TMUX_REQUIRED' : 'LOCAL_TEAMS_UNVERIFIED',
    remoteLinuxTeamsOverSsh: supported,
    bootSecretStorage: windows ? 'ntfs_owner_acl_plaintext' : supported ? 'unix_owner_mode_plaintext' : 'unavailable',
    // These independent facts must come from the backend and validated supervisor evidence.
    unlocked: 'unknown', observationsFresh: 'unknown', auditValidated: 'unknown',
  });
}
module.exports = { platformRuntimeInfo };
