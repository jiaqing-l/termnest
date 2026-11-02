'use strict';
// Preloaded only by capture-readme.cjs. No OS commands, SSH, account discovery or provider calls.
const { EventEmitter } = require('events');
const { Backend } = require('../lib/backend');
const { LOCAL_ID } = require('../lib/backends');
const { claudeSessionId } = require('../lib/parse');
const DEMO_ID = '11111111-1111-4111-8111-111111111111';
const markdown = '# Kế hoạch demo\n\nTài liệu mẫu của phiên **claude-demo** trên `demo-server`.\n\n## Công việc\n\n| Hạng mục | Trạng thái |\n| --- | --- |\n| Chuẩn bị dữ liệu mẫu | Hoàn tất |\n| Kiểm tra giao diện | Đang chạy |\n| Cập nhật tài liệu | Chờ duyệt |\n\n## Kiểm tra\n\n- [x] Dùng dữ liệu giả\n- [x] Kiểm tra Terminal và Crew\n- [ ] Duyệt tài liệu\n\n```bash\nnode --test test/*.test.js\n```\n\nChỉ đọc tài liệu; phiên terminal tiếp tục chạy.\n';
function pollText() {
  const now = Math.floor(Date.now() / 1000);
  const rows = [['claude-demo', 'claude', 7200], ['test-demo', 'node', 3600], ['shell-demo', 'bash', 1800]];
  return '@@HOST\ndemo-server\n@@CPU\ncpu 100 0 20 200 0 0 0\n@@MEM\nMemTotal: 8388608\nMemAvailable: 5242880\n@@DISK\n/dev/demo 104857600 35651584 69206016 34% /\n@@PS\n100 1 7200 bash\n200 100 7000 claude\n300 200 600 bash crew-dispatch.sh --task demo-docs --track W1\n301 300 590 codex exec demo\n400 200 400 bash crew-dispatch.sh --task demo-docs --track W2\n401 400 390 codex exec demo\n@@PSOK\n1\n@@CWD\n300 /workspace/demo\n400 /workspace/demo\n@@SESS\n' + rows.map(([name, cmd, age], i) => `$${i}|~|${name}|~|1|~|${now-age}|~|${i===2?now-120:now}|~|${cmd}|~|/workspace/demo`).join('\n') + '\n' + rows.map(([name], i) => `@@PANE $${i}\n${name}\n${i===2?'demo@example.com@demo-server: /workspace/demo $':'Đang kiểm tra dữ liệu demo…'}`).join('\n') + '\n@@DETAIL\n$0|~|100|~|0|~|\n$1|~|500|~|0|~|\n$2|~|600|~|0|~|\n@@OWNERS\n$0|~|100\n@@END\n';
}
class DemoBackend extends Backend {
  get canAutoConnect() { return true; }
  async connect() { this.ready = true; }
  scheduleRetry() {}
  async exec(command) {
    let out;
    if (command.includes('@@HOST')) out = pollText();
    else if (command.includes('@@OS')) out = '@@OS\nUbuntu 24.04 LTS\n@@REBOOT\n1\n@@UPDATES\n3\n@@END\n';
    else if (command.includes('tail -c 65536')) out = 'unknown\nChuẩn bị dữ liệu demo\nĐang chạy kiểm tra giao diện\nChờ kết quả kiểm tra\n';
    else if (command.startsWith('tmux display-message')) out = '/workspace/demo\n';
    else if (command.includes('function fileRuntime')) out = JSON.stringify({path:'/workspace/demo/README.md', text:markdown, kind:'markdown'});
    else throw Error('Unexpected fixture command');
    return {code:0, out, err:''};
  }
  async decorateSnapshot(snap) {
    snap.cpu = 24;
    Object.assign(snap.sys, {cores:4, uptimeSec:172800, load1:0.7, swapTotalGb:2, swapUsedGb:0.1, ramUsedGb:3, ramTotalGb:8, diskUsedGb:34, diskTotalGb:100, downMBs:0.4, upMBs:0.1, top:[{cmd:'node',cpu:12,memGb:0.4},{cmd:'claude',cpu:8,memGb:0.3}]});
    if (this.cfg.local) { snap.hostname = 'demo-local'; snap.sessions=[]; snap.workers=[]; snap.sys.rebootRequired=false; }
  }
  attach(name, cols, rows, callback) {
    const stream = new EventEmitter(); stream.stderr = new EventEmitter();
    stream.write = () => {}; stream.setWindow = () => {}; stream.close = () => {};
    callback(null, stream);
    setTimeout(() => stream.emit('data', Buffer.from('\x1b[2J\x1b[Hdemo@example.com@demo-server /workspace/demo\r\n\r\n$ node --test test/*.test.js\r\n✔ Kiểm tra dữ liệu demo\r\n✔ Kiểm tra giao diện\r\n\r\nTài liệu: README.md\r\n\r\n$ ')), 100);
  }
  close() { this.ready=false; }
}
require.cache[require.resolve('../lib/backends')].exports = {
  LOCAL_ID, localConfig:() => ({id:LOCAL_ID,local:true,host:'demo-local',user:'demo',auth:'local'}),
  createBackend:(...args) => new DemoBackend(...args)
};
class DemoTokenCache {
  get(backends, configs, {zone='UTC'}={}) {
    const now=Date.now(), session=claudeSessionId('/workspace/demo','claude-demo');
    const value=require('../lib/tokens').aggregate(['claude','codex'].map((tool,i)=>({id:'demo_'+tool,tool,email:i?'demo-codex@example.com':'demo@example.com',plan:i?'plus':'max',limits:{session:{percent:i?38:62,resetAt:now+7200000},weekly:{percent:i?24:36,resetAt:now+259200000},observedAt:now},events:Array.from({length:14},(_,d)=>({at:now-(13-d)*86400000,session,total:24000+d*2000,project:'demo'}))})),{zone,now});
    value.accounts.forEach((a,i)=>Object.assign(a,{hostId:DEMO_ID,hostIds:[DEMO_ID],hostName:'demo-server',nickname:i?'Kiểm tra':'Tài liệu',directory:'/workspace/demo',threshold:100000,hasGoodQuota:true}));
    return JSON.stringify({...value,updatedAt:now,scanning:false,hosts:[{hostId:DEMO_ID,hostName:'demo-server',state:'ready',reason:''}]});
  }
  async close() {}
}
require.cache[require.resolve('../lib/token-cache')] = {id:require.resolve('../lib/token-cache'),filename:require.resolve('../lib/token-cache'),loaded:true,exports:{TokenCache:DemoTokenCache}};
