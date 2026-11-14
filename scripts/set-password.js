'use strict';
// Sets or changes the Termnest password from a terminal, so nobody can claim it through the page.
const path = require('path');
const readline = require('readline');
const { Vault } = require('../lib/vault');

// In an installed desktop app (launcher.js beside this folder) the data lives where the app keeps it (%APPDATA%\Termnest,
// ~/Library/Application Support/Termnest, …), not in the install folder.
const fs = require('fs');
const LAUNCHER = path.join(__dirname, '..', 'launcher.js');
const DATA = process.env.TW_DATA || (fs.existsSync(LAUNCHER) ? require(LAUNCHER).dataDir() : path.join(__dirname, '..', 'data'));

function askHidden(label) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      console.error('Hãy chạy lệnh này trong terminal.');
      process.exit(1);
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(label)) process.stdout.write(label); };
    rl.question(label, (v) => { rl.close(); process.stdout.write('\n'); resolve(v); });
  });
}

async function main() {
  // The running app holds the data folder's lock and writes the vault every few seconds with the OLD key: changing the password
  // under it is silently undone. Take the same lock; refuse when the app is running.
  let lock;
  try { lock = await require('../lib/service-runtime').acquireDataLock(DATA, { strict: false }); }
  catch (e) {
    console.error(e.code === 'RUNTIME_ALREADY_RUNNING' ? 'TERMNEST đang chạy trên thư mục dữ liệu này. Hãy dừng TERMNEST trước khi đổi mật khẩu.' : `Không khóa được thư mục dữ liệu (${e.code || 'lỗi'}); chưa đổi mật khẩu.`);
    process.exit(1);
  }
  const v = new Vault(path.join(DATA, 'vault.json'));
  let data = { servers: [] };
  if (v.exists()) {
    const old = process.env.TW_OLD_PASSWORD || await askHidden('Mật khẩu hiện tại: ');
    if (!v.unlock(old)) { console.error('Sai mật khẩu.'); process.exit(1); }
    data = v.data;
  }
  const a = process.env.TW_NEW_PASSWORD || await askHidden('Mật khẩu mới (ít nhất 10 ký tự): ');
  if (a.length < 10) { console.error('Mật khẩu quá ngắn.'); process.exit(1); }
  const b = process.env.TW_NEW_PASSWORD || await askHidden('Nhập lại: ');
  if (a !== b) { console.error('Hai lần nhập không giống nhau.'); process.exit(1); }
  const fresh = new Vault(v.file);
  const oldCopies = Vault.listCopies(v.file);
  fresh.create(a, data);
  // Copies made with the OLD password would still open with it (and may sit in a synced folder): drop them once the new store opens.
  if (new Vault(v.file).unlock(a)) for (const f of oldCopies) try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  lock.release();
  console.log('Đã đặt mật khẩu. Nếu TERMNEST đang chạy: systemctl restart tmux-web');
}

main();
