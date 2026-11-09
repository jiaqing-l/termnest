'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { tokenRuntime } = require('../lib/token-source');
const { aggregate, cleanAccounts } = require('../lib/tokens');
const rt = tokenRuntime();
const at = '2026-11-01T10:00:00Z';
const claude = (n = 10) => ({ type: 'assistant', timestamp: at, sessionId: '11111111-1111-4111-8111-111111111111', message: { id: 'msg-one', usage: { input_tokens: n, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 }, content: [{ text: 'SECRET-PROMPT' }] } });
const codex = (n, time = at) => ({ type: 'event_msg', timestamp: time, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: n, output_tokens: 5, total_tokens: n + 5, cached_input_tokens: 2, reasoning_output_tokens: 1 } }, rate_limits: { primary: { used_percent: 42, window_minutes: 300, resets_at: 1793617200 }, secondary: { used_percent: 17, window_minutes: 10080, resets_at: 1794000000 }, plan_type: 'plus' } } });
function fixture(t, tool) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-token-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); fs.mkdirSync(path.join(dir, tool === 'claude' ? 'projects' : 'sessions')); return dir; }
test('Claude duplicate message snapshots replace totals; malformed usage is unavailable', () => {
 const state = rt.empty(); rt.line(claude(), 'claude', state); rt.line(claude(12), 'claude', state);
 assert.equal(Object.values(state.seen).reduce((n,e) => n + e[2], 0), 22);
 rt.line({ ...claude(), message: { id: 'bad', usage: { input_tokens: 'oops' } } }, 'claude', state); assert.equal(state.bad, true);
 assert.ok(!JSON.stringify(state).includes('SECRET-PROMPT'));
});
test('Codex cumulative usage is delta-based, repeated snapshots not double counted', () => {
 const state = rt.empty(); rt.line({ type:'session_meta', payload:{ id:'22222222-2222-4222-8222-222222222222' } }, 'codex', state);
 rt.line(codex(10), 'codex', state); rt.line(codex(10), 'codex', state); rt.line(codex(20,'2026-11-02T10:00:00Z'), 'codex', state);
 assert.equal(Object.values(state.buckets).reduce((n,e)=>n+e.total,0),25); assert.equal(state.quota.session.percent,42);
});
test('incremental reads preserve partial lines, skip unchanged history and invalidate truncation', async t => {
 const dir = fixture(t,'claude'), file = path.join(dir,'projects','a.jsonl');
 fs.writeFileSync(path.join(dir,'.claude.json'),JSON.stringify({oauthAccount:{emailAddress:'user@example.com'},secret:'SECRET-LOGIN'}));
 fs.writeFileSync(file,JSON.stringify(claude())+'\n'); const cache={}; const cfg={id:'one',tool:'claude',directory:dir};
 const options={quota:false}; let a=await rt.read(cfg,cache,options); assert.equal(a.buckets[0].total,20); assert.equal(a.email,'user@example.com');
 const bytes=cache.bytes; await rt.read(cfg,cache,options); assert.equal(cache.bytes,bytes);
 fs.appendFileSync(file,'{"type":'); a=await rt.read(cfg,cache,options); assert.match(a.reason,/đang ghi dở/);
 fs.appendFileSync(file,'BROKEN}\n'); a=await rt.read(cfg,cache,options); assert.match(a.reason,/Bỏ qua 1 dòng log lỗi/);
 fs.writeFileSync(file,JSON.stringify(claude(5))+'\n'); a=await rt.read(cfg,cache,options); assert.equal(a.buckets[0].total,15);
 assert.ok(!JSON.stringify({a,cache}).includes('SECRET-'));
});
test('Codex identity decodes email only, quota failure never leaks secrets', async t => {
 const dir=fixture(t,'codex'); const jwt='fixture.'+Buffer.from(JSON.stringify({email:'codex@example.com',secret:'SECRET-CLAIM'})).toString('base64url')+'.fixture';
 fs.writeFileSync(path.join(dir,'auth.json'),JSON.stringify({tokens:{id_token:jwt,access_token:'SECRET-ACCESS',refresh_token:'SECRET-REFRESH'}}));
 fs.writeFileSync(path.join(dir,'sessions','a.jsonl'),JSON.stringify(codex(20))+'\n');
 const a=await rt.read({id:'two',tool:'codex',directory:dir},{},{quota:false}); assert.equal(a.email,'codex@example.com'); assert.equal(a.plan,'plus'); assert.ok(!JSON.stringify(a).includes('SECRET'));
 const q=await rt.claudeQuota(dir,{request:async()=>{throw Error('SECRET-ACCESS');},credential:async()=> 'SECRET-ACCESS'}); assert.match(q.reason,/Không đọc được/); assert.ok(!JSON.stringify(q).includes('SECRET'));
});
test('provider normalizes only valid percentages and reset times',()=>{
 assert.equal(rt.quota({five_hour:{utilization:101,resets_at:at}},'claude').session,null);
 assert.equal(rt.quota({five_hour:{utilization:40,resets_at:at},seven_day:{utilization:12,resets_at:at}},'claude').weekly.percent,12);
 // A plan with weekly limits only (five_hour null, limits lists weekly kinds): no 5-hour dial, not "no session yet".
 const weeklyOnly=rt.quota({five_hour:null,seven_day:{utilization:39,resets_at:at},limits:[{kind:'weekly_all',group:'weekly'},{kind:'weekly_scoped',group:'weekly'}]},'claude');
 assert.equal(weeklyOnly.noSession,true); assert.equal(weeklyOnly.reasons.session,'Không có giới hạn 5 giờ'); assert.equal(weeklyOnly.weekly.percent,39);
 assert.equal(rt.quota({five_hour:null,seven_day:{utilization:39,resets_at:at}},'claude').noSession,undefined);
 // Codex with only the weekly window: no 5-hour dial either; with a 5-hour window present it stays.
 const sec=Math.floor(Date.parse(at)/1000);
 assert.equal(rt.quota({primary:{used_percent:41,window_minutes:10080,resets_at:sec}},'codex').noSession,true);
 assert.equal(rt.quota({primary:{used_percent:5,window_minutes:300,resets_at:sec},secondary:{used_percent:41,window_minutes:10080,resets_at:sec}},'codex').noSession,undefined);
 assert.equal(require('../lib/tokens').aggregate([{tool:'claude',email:'a@b.co',limits:weeklyOnly}]).accounts[0].limits.noSession,true);
});
test('week boundaries use viewer timezone, not UTC; missing is null',()=>{
 const events=[{at:Date.parse('2026-11-01T18:00:00Z'),session:'s',total:15}];
 const a=aggregate([{id:'one',tool:'claude',events,reason:''}],{zone:'Asia/Ho_Chi_Minh',now:Date.parse('2026-11-02T02:00:00Z')});
 assert.equal(a.accounts[0].today,15); assert.equal(a.accounts[0].week,15); assert.equal(a.accounts[0].days[0].day,'2026-11-02');
 const b=aggregate([{id:'one',tool:'claude',events:[],reason:'Không đọc được'}],{zone:'UTC'}); assert.equal(b.accounts[0].today,null);
});
test('declared configs and nicknames are bounded and explicitly allowlisted',()=>{
 assert.deepEqual(cleanAccounts([{id:'work',hostId:'host',tool:'claude',directory:'~/.claude-work',nickname:'Work',threshold:1000,access_token:'SECRET'}])[0],{id:'work',hostId:'host',tool:'claude',directory:'~/.claude-work',nickname:'Work',threshold:1000});
 assert.throws(()=>cleanAccounts([{id:'bad',tool:'other'}]));
});
test('cached aliases preserve each declared account ID', async()=>{
 const {readBackend}=require('../lib/tokens');
 const backend={ready:false}; const a={id:'first',tool:'codex',directory:'/fixture'};
 await readBackend(backend,[a]);
 const rows=await readBackend(backend,[{...a,id:'second'}]); assert.equal(rows[0].id,'second');
});
test('partial usage tail marks totals incomplete until a complete line arrives',async t=>{
 const dir=fixture(t,'codex'),file=path.join(dir,'sessions','a.jsonl');
 fs.writeFileSync(file,JSON.stringify(codex(10))+'\n'+JSON.stringify(codex(20)).slice(0,40));
 const row=await rt.read({id:'x',tool:'codex',directory:dir},{},{quota:false});
 assert.match(row.reason,/Không đọc được/);
});
test('API aggregation rejects unknown quota fields and arbitrary session text',()=>{
 const row=aggregate([{id:'x',tool:'codex',limits:{session:{percent:20,resetAt:123,access_token:'SECRET'},weekly:null,secret:'SECRET'},events:[{at:1,total:4,session:'SECRET-PROMPT'}]}],{now:100}).accounts[0];
 assert.ok(!JSON.stringify(row).includes('SECRET'));
});
test('Claude copied message IDs across logs are counted once',async t=>{
 const dir=fixture(t,'claude');for(const name of ['one','copy'])fs.writeFileSync(path.join(dir,'projects',name+'.jsonl'),JSON.stringify(claude())+'\n');
 const row=await rt.read({id:'a',tool:'claude',directory:dir},{},{quota:false});assert.equal(row.buckets.reduce((n,e)=>n+e.total,0),20);
});
test('remote reader runs on its host and persists only sanitized incremental state', {skip:process.platform==='win32' ? 'SSH reader harness requires /bin/sh and POSIX uid/private cache permissions' : false},async t=>{
 const {readBackend}=require('../lib/tokens'),{execFileSync}=require('child_process');
 const dir=fixture(t,'codex');fs.writeFileSync(path.join(dir,'sessions','a.jsonl'),JSON.stringify(codex(20))+'\n');
 fs.writeFileSync(path.join(dir,'auth.json'),JSON.stringify({tokens:{id_token:'fixture.'+Buffer.from(JSON.stringify({email:'remote@example.com',secret:'SECRET-CLAIM'})).toString('base64url')+'.fixture',refresh_token:'SECRET-REFRESH'}}));
 const backend={cfg:{local:false},ready:true,exec:async command=>({code:0,out:execFileSync('/bin/sh',['-c',command],{timeout:3000,encoding:'utf8',env:{...process.env,TMPDIR:dir}})})};
 const rows=await readBackend(backend,[{id:'remote',tool:'codex',directory:dir}]);assert.equal(rows[0].email,'remote@example.com');assert.equal(rows[0].id,'remote');
 const cacheDir=path.join(dir,'tmux-dev-usage-'+process.getuid()),files=fs.readdirSync(cacheDir);assert.equal(files.length,1);
 const raw=fs.readFileSync(path.join(cacheDir,files[0]),'utf8');assert.ok(!raw.includes('SECRET'));assert.ok(!JSON.stringify(rows).includes('SECRET'));
});
test('Monday boundary differs across viewer zones and survives DST',()=>{
 const events=[{at:Date.parse('2026-11-02T00:30:00Z'),session:'s',total:7}];
 const now=Date.parse('2026-11-02T12:00:00Z');
 assert.equal(aggregate([{events}],{zone:'UTC',now}).accounts[0].week,7);
 assert.equal(aggregate([{events}],{zone:'America/Los_Angeles',now}).accounts[0].week,0);
});
test('explicit resumed Codex UUID links to tmux without exposing command arguments',()=>{
 const {parsePoll}=require('../lib/parse');
 const id='22222222-2222-4222-8222-222222222222';
 const snap=parsePoll('@@PS\n11 10 4 codex resume '+id+' SECRET-PROMPT\n@@PSOK\n1\n@@FOREGROUND\n11 11 11\n@@SESS\n$0|~|agent|~|0|~|10|~|20|~|codex|~|/work\n@@DETAIL\n$0|~|10|~|0|~|\n@@END',21);
 assert.equal(snap.sessions[0].aiSessionId,id);assert.equal(snap.sessions[0].aiTool,'codex');assert.ok(!JSON.stringify(snap).includes('SECRET'));
});
test('Claude subscription plan is allowlisted from transient CLI credential metadata',async()=>{
 const q=await rt.claudeQuota('/fixture',{credential:async()=>({accessToken:'SECRET-ACCESS',subscriptionType:'max',refreshToken:'SECRET-REFRESH'}),request:async token=>{assert.equal(token,'SECRET-ACCESS');return {five_hour:{utilization:40,resets_at:'2099-01-01T00:00:00Z'},seven_day:{utilization:20,resets_at:'2099-01-02T00:00:00Z'}};}});
 assert.equal(q.plan,'max');assert.equal(q.session.percent,40);assert.ok(!JSON.stringify(q).includes('SECRET'));
});
test('an unavailable host leaves other accounts usable and API errors redact secrets',async t=>{
 const {tokenState}=require('../lib/tokens');const dir=fixture(t,'codex');fs.writeFileSync(path.join(dir,'sessions','a.jsonl'),JSON.stringify(codex(20))+'\n');
 const good={cfg:{id:'local',local:true},ready:true,mode:'native',publicView:()=>({name:'Fixture'})};
 const bad={cfg:{id:'ssh',local:false},ready:true,exec:async()=>{throw Error('SECRET-FAILURE');},publicView:()=>({name:'Unavailable'})};
 const result=await tokenState([bad,good],[{id:'bad',hostId:'ssh',tool:'claude',directory:'/fixture',nickname:'',threshold:null},{id:'good',hostId:'local',tool:'codex',directory:dir,nickname:'',threshold:null}],{zone:'UTC',now:Date.parse('2026-11-01T12:00:00Z'),home:dir,env:{},quota:false});
 assert.equal(result.hosts.length,1);assert.equal(result.accounts[0].today,25);assert.ok(!JSON.stringify(result).includes('SECRET'));
});
test('remote host lock refuses a concurrent scan instead of overlapping after SSH timeout', {skip:process.platform==='win32' ? 'SSH lock harness requires /bin/sh and POSIX uid/private cache permissions' : false},async t=>{
 const {readBackend}=require('../lib/tokens'),{execFile}=require('child_process'),{promisify}=require('util');const run=promisify(execFile);
 const dir=fixture(t,'codex');const cacheDir=path.join(dir,'tmux-dev-usage-'+process.getuid());fs.mkdirSync(cacheDir,{mode:0o700});fs.writeFileSync(path.join(cacheDir,'scan.lock'),String(process.pid),{mode:0o600});
 const backend={cfg:{local:false},ready:true,exec:async command=>{try{const r=await run('/bin/sh',['-c',command],{timeout:3000,env:{...process.env,TMPDIR:dir}});return {code:0,out:r.stdout};}catch{return {code:1,out:''};}}};
 const rows=await readBackend(backend,[{id:'remote',tool:'codex',directory:dir}],{quota:false});assert.match(rows[0].reason,/Không đọc được/);assert.equal(fs.readFileSync(path.join(cacheDir,'scan.lock'),'utf8'),String(process.pid));
});

test('copied Codex logs union cumulative token ranges and retain project metadata',async t=>{
 const dir=fixture(t,'codex'),session='22222222-2222-4222-8222-222222222222';
 const meta={type:'session_meta',payload:{id:session,cwd:'/fixture/project-folder'}};
 for(const [name,total] of [['original',20],['copy',30]])fs.writeFileSync(path.join(dir,'sessions',name+'.jsonl'),[meta,codex(total)].map(v=>JSON.stringify(v)).join('\n')+'\n');
 const a=await rt.read({id:'a',tool:'codex',directory:dir},{},{quota:false});assert.equal(a.buckets[0].total,35);assert.equal(a.buckets[0].project,'project-folder');assert.deepEqual(a.buckets[0].ranges,[[0,35]]);
});
