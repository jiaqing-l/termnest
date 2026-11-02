'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');

function findBrowser({ platform = process.platform, env = process.env, home = os.homedir(), exists = fs.existsSync, registry } = {}) {
  if (platform === 'darwin') {
    for (const name of ['Google Chrome', 'Microsoft Edge']) {
      for (const base of ['/Applications', path.join(home, 'Applications')]) {
        const file = path.join(base, `${name}.app`, 'Contents', 'MacOS', name);
        if (exists(file)) return file;
      }
    }
  }
  if (platform === 'win32') {
    const win = path.win32;
    const read = registry || ((hive, exe) => {
      try {
        const output = execFileSync('reg.exe', ['query', `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`, '/ve'], { encoding: 'utf8', windowsHide: true, timeout: 2000 });
        return output.match(/REG_(?:EXPAND_)?SZ\s+(.+)/)?.[1].trim().replace(/^"|"$/g, '').replace(/%([^%]+)%/g, (_, key) => env[key] || `%${key}%`);
      } catch { return null; }
    });
    for (const [exe, relative] of [['msedge.exe', 'Microsoft\\Edge\\Application\\msedge.exe'], ['chrome.exe', 'Google\\Chrome\\Application\\chrome.exe']]) {
      for (const base of [env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', env.ProgramFiles || 'C:\\Program Files', env.LOCALAPPDATA || win.join(home, 'AppData', 'Local')]) {
        const file = win.join(base, relative);
        if (exists(file)) return file;
      }
      for (const hive of ['HKCU', 'HKLM']) {
        const file = read(hive, exe);
        if (file && exists(file)) return file;
      }
    }
  }
  return null;
}

function appWindow({ dir, fallback, stop, busy = () => false, browser = findBrowser(), launch = spawn, grace = 1200 }) {
  let child, timer, disabled = false;
  function cancel() { clearTimeout(timer); timer = null; }
  function schedule() {
    cancel();
    if (disabled || child) return;
    timer = setTimeout(() => {
      timer = null;
      if (busy()) schedule(); else stop();
    }, grace);
  }
  function open(url) {
    cancel();
    if (!browser || disabled) { disabled = true; fallback(url); return; }
    const previous = child;
    let current;
    const fail = () => {
      if (disabled) return;
      disabled = true; cancel(); child = null; fallback(url);
    };
    try {
      current = launch(browser, [`--app=${url}`, `--user-data-dir=${path.join(dir, 'app-profile')}`, '--no-first-run', '--no-default-browser-check'], { stdio: 'ignore' });
      if (!previous) child = current;
      current.once('error', fail);
      current.once('exit', (code, signal) => {
        // A second invocation hands its window to the profile's original process.
        if (previous && child === previous) return;
        if (child !== current) return;
        child = null;
        if (code !== 0 && !signal) fail(); else schedule();
      });
    } catch { fail(); }
  }
  return { open, cancel };
}
module.exports = { findBrowser, appWindow };
