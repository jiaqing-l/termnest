'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// Folders on this machine that a cloud app keeps in sync (Google Drive, iCloud Drive, OneDrive, Dropbox): a backup copied there
// is uploaded by that app. TERMNEST itself never talks to a cloud service and never needs a cloud password.
function cloudFolders(home = os.homedir(), platform = process.platform, io = fs) {
  const out = [];
  const dir = (p) => { try { return io.statSync(p).isDirectory(); } catch { return false; } };
  const kids = (p) => { try { return io.readdirSync(p).filter((n) => !n.startsWith('.')); } catch { return []; } };
  const add = (kind, p) => { if (dir(p) && !out.some((o) => o.path === p)) out.push({ kind, path: p }); };
  if (platform === 'darwin') {
    const cs = path.join(home, 'Library', 'CloudStorage');
    for (const n of kids(cs)) {
      const p = path.join(cs, n);
      if (/^GoogleDrive/i.test(n)) { const mine = kids(p).find((k) => /^(My Drive|Drive của tôi|Mon Drive|Meine Ablage)$/i.test(k)); add('gdrive', mine ? path.join(p, mine) : p); }
      else if (/^OneDrive/i.test(n)) add('onedrive', p);
      else if (/^Dropbox/i.test(n)) add('dropbox', p);
    }
    add('icloud', path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'));
  } else if (platform === 'win32') {
    for (const n of kids(home)) if (/^OneDrive/i.test(n)) add('onedrive', path.join(home, n));
    for (const letter of ['G', 'H', 'I']) add('gdrive', `${letter}:\\My Drive`);
    add('icloud', path.join(home, 'iCloudDrive'));
  }
  add('dropbox', path.join(home, 'Dropbox'));
  return out;
}

// A folder the user picked: absolute, existing, and writable by us (checked with a throwaway file).
function checkFolder(dir, io = fs) {
  if (typeof dir !== 'string' || !dir.trim() || dir.length > 1024 || /[\x00-\x1f\x7f]/.test(dir)) return 'invalid';
  const p = dir.trim();
  if (!path.isAbsolute(p)) return 'invalid';
  try { if (!io.statSync(p).isDirectory()) return 'notdir'; } catch { return 'notfound'; }
  const probe = path.join(p, `.termnest-write-test-${process.pid}`);
  try { io.writeFileSync(probe, ''); io.rmSync(probe, { force: true }); } catch { return 'denied'; }
  return '';
}

module.exports = { cloudFolders, checkFolder };
