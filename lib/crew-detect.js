'use strict';
// Which machines run an Xspire-style crew (a session works under a folder with _crew/tasks). Written by the optional crew pack
// (lib/features/crewpack.js), read by features that only make sense there (the .NET build / migration watchdog rules).
// Nothing here knows the crew's rules: it is only "seen _crew on this machine within the last 10 minutes".
const seen = new Map();
module.exports = {
  mark(serverId, on) { if (on) seen.set(serverId, Date.now()); else seen.delete(serverId); },
  has(serverId) { const at = seen.get(serverId); return !!at && Date.now() - at < 10 * 60 * 1000; },
};
