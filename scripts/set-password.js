'use strict';
// Sets or changes the Termnest password from a terminal, so nobody can claim it through the page.
const path = require('path');
const readline = require('readline');
const { Vault } = require('../lib/vault');

const DATA = process.env.TW_DATA || path.join(__dirname, '..', 'data');

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
  fresh.create(a, data);
  console.log('Đã đặt mật khẩu. Nếu Termnest đang chạy: systemctl restart tmux-web');
}

main();
