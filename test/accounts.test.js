'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {tokenRuntime}=require('../lib/token-source');
const {aggregate,tokenState}=require('../lib/tokens');
function fixture(t){const home=fs.mkdtempSync(path.join(os.tmpdir(),'accounts-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));return home;}
test('discovers default, custom and environment directories, deduplicates manual aliases',async t=>{
 const home=fixture(t);for(const dir of ['.claude','.claude-tech2','.claude-empty','.codex'])fs.mkdirSync(path.join(home,dir));fs.mkdirSync(path.join(home,'.claude-tech2','projects'));
 fs.writeFileSync(path.join(home,'.claude-tech2','.claude.json'),JSON.stringify({oauthAccount:{emailAddress:'tech2@example.com'}}));
 const rt=tokenRuntime(),rows=await rt.discover('local',[{id:'manual',hostId:'local',tool:'claude',directory:'~/.claude',nickname:'Mine',threshold:null}],{home,env:{CLAUDE_CONFIG_DIR:path.join(home,'.claude-tech2'),CODEX_HOME:path.join(home,'.codex')}});
 assert.equal(rows.length,3);assert.equal(rows.find(r=>r.id==='manual').nickname,'Mine');assert.equal(rows.find(r=>r.directory.endsWith('tech2')).nickname,'');
});
test('directory credential lookup uses isolated Keychain service and never default fallback',async t=>{
 const home=fixture(t),dir=path.join(home,'.claude-tech2');fs.mkdirSync(dir);const calls=[];
 const rt=tokenRuntime(),options={home,platform:'darwin',execFile:(file,args,opts,cb)=>{calls.push(args);cb(null,JSON.stringify({claudeAiOauth:{accessToken:'fixture-token'}}));}};
 assert.equal((await rt.credential(dir,options)).accessToken,'fixture-token');
 assert.equal(calls[0][2],'Claude Code-credentials-'+require('crypto').createHash('sha256').update(dir).digest('hex').slice(0,8));
 await rt.credential(path.join(home,'.claude'),options);assert.equal(calls[1][2],'Claude Code-credentials');
});
test('independent Codex windows match minutes even when reversed',()=>{
 const rt=tokenRuntime(),reset=Date.now()+100000;
 const q=rt.quota({secondary:{used_percent:22,window_minutes:300,resets_at:reset/1000}},'codex');
 assert.equal(q.session.percent,22);assert.equal(q.weekly,null);
 const a=aggregate([{id:'x',limits:q}],{}).accounts[0];assert.equal(a.limits.session.percent,22);assert.ok(a.limits.reasons.weekly);
});
test('partial malformed logs retain totals and count errors; expired windows retain observed usage',async t=>{
 const dir=fixture(t);fs.mkdirSync(path.join(dir,'sessions'));fs.writeFileSync(path.join(dir,'sessions','a.jsonl'),'broken\n'+JSON.stringify({type:'event_msg',timestamp:new Date().toISOString(),payload:{type:'token_count',info:{total_token_usage:{total_tokens:98000}},rate_limits:{primary:{used_percent:85,window_minutes:300,resets_at:1}}}})+'\n');
 const row=await tokenRuntime().read({id:'x',tool:'codex',directory:dir},{},{quota:false});
 const a=aggregate([row]).accounts[0];assert.equal(a.today,98000);assert.equal(a.reason,'Bỏ qua 1 dòng log lỗi');assert.equal(a.limits.session.percent,85);assert.equal(a.limits.session.reset,undefined);
});
test('Claude failure is classified, keeps last good sample and waits five minutes',async t=>{
 const dir=fixture(t);fs.mkdirSync(path.join(dir,'projects'));let now=Date.now(),calls=0,fail=false;const cache={};
 const options={now:()=>now,credential:async()=>({accessToken:'SECRET'}),request:async()=>{calls++;if(fail)throw Object.assign(Error('SECRET'),{status:429});return {five_hour:{utilization:40,resets_at:new Date(now+3600000).toISOString()}};}};
 const rt=tokenRuntime(),cfg={id:'a',tool:'claude',directory:dir};await rt.read(cfg,cache,options);fail=true;now+=330001;
 let row=await rt.read(cfg,cache,options);assert.equal(row.limits.session.percent,40);assert.equal(row.limits.error,'rate_limited');assert.ok(row.limits.observedAt);now+=61000;await rt.read(cfg,cache,options);assert.equal(calls,2);assert.ok(!JSON.stringify(cache).includes('SECRET'));
});
test('unreachable backend produces one compact host row',async()=>{
 const b={cfg:{id:'remote'},ready:false,publicView:()=>({name:'demo-server'})};const result=await tokenState([b],[],{zone:'UTC'});assert.equal(result.accounts.length,0);assert.equal(result.hosts.length,1);assert.match(result.hosts[0].reason,/kết nối/);
});
test('macOS CPU and memory use argument arrays and measured percentages',async()=>{
 const {darwinMetrics}=require('../lib/local');const calls=[];
 const sys=await darwinMetrics(async(file,args)=>{calls.push([file,args]);return {code:0,out:file.endsWith('sysctl')?'8589934592\n4\n':file.endsWith('vm_stat')?'Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages active: 100000.\nPages wired down: 200000.\nPages occupied by compressor: 100000.\n':'100.0\n100.0\n'};});
 assert.equal(sys.cpu,50);assert.equal(sys.ram,400000*4096/8589934592*100);assert.ok(calls.every(c=>Array.isArray(c[1])));
});

test('persisted aggregate is private, sanitized, and immediately visible after restart',async t=>{
 const {TokenCache}=require('../lib/token-cache'),{EventEmitter}=require('events');const dataDir=fixture(t);
 class Worker extends EventEmitter {postMessage(m){this.m=m;} async terminate(){}}
 let worker;const cache=new TokenCache({dataDir,createWorker:()=>worker=new Worker()});cache.get([],[]);
 worker.emit('message',{key:worker.m.views[0].key,value:JSON.stringify({accounts:[{id:'x',tool:'codex',today:98000,prompt:'SECRET-PROMPT',credentials:'SECRET-TOKEN',limits:{},days:[],weeks:[],sessions:[]}],updatedAt:123,scanning:false})});worker.emit('message',{done:true});await cache.close();
 const file=path.join(dataDir,'token-aggregates.json');
 // Windows stat mode bits do not represent NTFS ACLs.
 if(process.platform!=='win32')assert.equal(fs.statSync(file).mode&0o777,0o600);
 assert.doesNotMatch(fs.readFileSync(file,'utf8'),/SECRET|prompt|credentials/);
 const next=new TokenCache({dataDir,createWorker:()=>new Worker()});const value=JSON.parse(next.get([],[]));assert.equal(value.accounts[0].today,98000);assert.equal(value.scanning,true);await next.close();
});
test('Claude source errors are fixed categories with no provider text',async()=>{
 for(const [status,error] of [[401,'expired'],[403,'denied'],[429,'rate_limited'],[500,'network']]){
 const q=await tokenRuntime().claudeQuota('/fixture',{credential:async()=>({accessToken:'SECRET'}),request:async()=>{throw Object.assign(Error('SECRET provider body'),{status});}});
 assert.equal(q.error,error);assert.doesNotMatch(JSON.stringify(q),/SECRET/);
 }
});
test('same-size log replacement invalidates totals using mtime',async t=>{
 const dir=fixture(t);fs.mkdirSync(path.join(dir,'sessions'));const file=path.join(dir,'sessions','a.jsonl');const row=n=>JSON.stringify({type:'event_msg',timestamp:new Date().toISOString(),payload:{type:'token_count',info:{total_token_usage:{total_tokens:n}}}})+'\n';
 fs.writeFileSync(file,row(10));const cfg={id:'x',tool:'codex',directory:dir},cache={},rt=tokenRuntime();await rt.read(cfg,cache,{quota:false});fs.writeFileSync(file,row(20));fs.utimesSync(file,new Date(),new Date(Date.now()+2000));
 assert.equal((await rt.read(cfg,cache,{quota:false})).buckets[0].total,20);
});
test('Python fallback reads fixture logs, discovers accounts and persists no prompt or credential', {skip:process.platform==='win32' ? 'SSH fallback runs on POSIX hosts and requires fcntl, Unix ownership and file modes' : false},async t=>{
 const home=fixture(t),dir=path.join(home,'.codex');fs.mkdirSync(path.join(dir,'sessions'),{recursive:true});
 fs.writeFileSync(path.join(dir,'auth.json'),JSON.stringify({tokens:{id_token:'fixture.'+Buffer.from(JSON.stringify({email:'python@example.com',secret:'SECRET'})).toString('base64url')+'.fixture'}}));
 const log=path.join(dir,'sessions','usage.jsonl');fs.writeFileSync(log,'broken\n'+JSON.stringify({type:'event_msg',timestamp:new Date().toISOString(),payload:{type:'token_count',info:{total_token_usage:{total_tokens:98000}},rate_limits:{secondary:{window_minutes:300,used_percent:33,resets_at:Date.now()/1000+3600}},prompt:'SECRET-PROMPT'}})+'\n');
 const {execFileSync}=require('child_process'),script=path.join(__dirname,'../lib/token-fallback.py');
 const run=p=>JSON.parse(execFileSync('python3',[script,JSON.stringify(p)],{encoding:'utf8',env:{...process.env,HOME:home,CLAUDE_CONFIG_DIR:'',CODEX_HOME:''}}));
 const accounts=run({action:'discover',hostId:'ssh',manual:[]});assert.equal(accounts.length,1);
 const payload={action:'read',config:accounts[0],options:{zone:'UTC',quota:false}},a=run(payload);
 assert.equal(a.email,'python@example.com');assert.equal(a.buckets[0].total,98000);assert.equal(a.limits.session.percent,33);assert.equal(a.reason,'Bỏ qua 1 dòng log lỗi');
 assert.deepEqual(run(payload),a);const cache=path.join(home,'.cache','tmux-dev-usage');for(const f of fs.readdirSync(cache)){assert.equal(fs.statSync(path.join(cache,f)).mode&0o777,0o600);assert.doesNotMatch(fs.readFileSync(path.join(cache,f),'utf8'),/SECRET|prompt|id_token/);}
 fs.writeFileSync(log,'');assert.equal(run(payload).buckets.length,0);
});
test('remote launcher quotes payloads, probes common Node installs and falls back to python3 without sudo',()=>{
 const command=require('../lib/tokens').remoteCommand('process.exit(0)',{action:'discover',manual:[],hostId:'fixture'});
 for(const path of ['/opt/homebrew/bin/node','.nvm/versions/node','command -v python3','exit 127'])assert.ok(command.includes(path));
 assert.doesNotMatch(command,/sudo |su -/);
});

test('persisted quota keeps only last-good windows and timestamp, never retry errors or provider fields',async t=>{
 const {TokenCache}=require('../lib/token-cache'),{EventEmitter}=require('events');const dataDir=fixture(t);
 class Worker extends EventEmitter{postMessage(m){this.m=m;}async terminate(){}}
 let worker;const cache=new TokenCache({dataDir,createWorker:()=>worker=new Worker()});cache.get([],[]);
 worker.emit('message',{key:worker.m.views[0].key,value:JSON.stringify({accounts:[{id:'x',tool:'claude',email:'fixture@example.com',hasGoodQuota:true,limits:{session:{percent:42,resetAt:900000,secret:'SECRET'},weekly:null,observedAt:100000,error:'rate_limited',reason:'temporary',stale:true,access_token:'SECRET'},days:[],weeks:[],sessions:[]}],updatedAt:100000})});
 worker.emit('message',{done:true});
 const disk=JSON.parse(fs.readFileSync(path.join(dataDir,'token-aggregates.json'),'utf8'));const q=JSON.parse(disk.values[0][1]).accounts[0].limits;
 assert.deepEqual(Object.keys(q).sort(),['observedAt','reason','session','weekly']);assert.equal(q.session.percent,42);assert.doesNotMatch(JSON.stringify(q),/SECRET|error|rate_limited|stale|access_token/);await cache.close();
});
