'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {mergeSources,aggregate,tokenState}=require('../lib/tokens');
const {QuotaPool}=require('../lib/token-quota');
const now=Date.parse('2026-11-01T12:00:00Z'),id='11111111-1111-4111-8111-111111111111';
const source=(host,email=' User@Example.com ')=>({id:host,hostId:host,hostName:host,tool:'claude',email,buckets:[{day:'2026-11-01',lastAt:now,session:id,total:10}],limits:{session:null,weekly:null,reason:'',observedAt:now}});
test('merge normalized logins across hosts and directories without counting copied messages twice',()=>{
 const a=source('local'),b=source('remote','user@example.com');
 a.records=[{id:'a',at:now,session:id,total:10}];b.records=[{id:'a',at:now,session:id,total:10},{id:'b',at:now,session:id,total:20}];
 const rows=mergeSources([a,b,{...b,id:'alias'},source('other','other@example.com')],{now});
 assert.equal(rows.length,2);const merged=rows.find(a=>a.email==='user@example.com');assert.equal(merged.today,30);assert.deepEqual(merged.hostIds,['local','remote']);
 assert.equal(mergeSources([source('local',null),source('remote',null)],{now}).length,2);
});
test('newest successful quota wins over newer errors; successful null windows are valid',()=>{
 const a=source('local'),b=source('remote');a.limits={session:{percent:42,resetAt:now+900000},observedAt:now-100,reason:''};b.limits={reason:'Không đọc được',error:'expired',observedAt:now};
 let row=mergeSources([a,b],{now})[0];assert.equal(row.limits.session.percent,42);assert.equal(row.limits.error,null);assert.match(row.sourceWarnings.join(),/Không đọc được/);
 b.limits={session:null,weekly:null,reason:'',observedAt:now};row=mergeSources([a,b],{now})[0];assert.equal(row.limits.session,null);assert.equal(row.limits.reasons.session,'Chưa có phiên');
});
test('shared quota promise, minimum five minutes plus jitter, Retry-After and last good retention',async()=>{
 let time=now,calls=0,resolve;const pool=new QuotaPool({now:()=>time,random:()=>0.5});
 const read=()=>{calls++;return new Promise(r=>resolve=r);};
 const one=pool.get('claude:user@example.com',read),two=pool.get('claude:user@example.com',read);
 await Promise.resolve();resolve({session:{percent:42,resetAt:now+900000},reason:''});
 assert.equal((await one).session.percent,42);await two;assert.equal(calls,1);
 time+=300000;await pool.get('claude:user@example.com',read);assert.equal(calls,1);
 time+=30001;let value=await pool.get('claude:user@example.com',async()=>{calls++;return {error:'rate_limited',reason:'Không đọc được',retryAfter:600000};});assert.equal(value.session.percent,42);assert.equal(value.stale,true);
 time+=599999;await pool.get('claude:user@example.com',read);assert.equal(calls,2);
});
test('project folder labels survive aggregation and unlinked sessions are closed',()=>{
 const row=aggregate([{...source('local'),buckets:[{session:id,total:10,lastAt:now,project:'tmux-web'}]}],{now}).accounts[0];
 assert.equal(row.sessions[0].name,'tmux-web');assert.equal(row.sessions[0].state,'closed');
});
test('progressive local publication precedes delayed remote result',async()=>{
 let release;const waiting=new Promise(r=>release=r),updates=[];
 const local={cfg:{id:'local',local:true},ready:true,publicView:()=>({name:'Máy này'})};
 const remote={cfg:{id:'remote'},ready:true,publicView:()=>({name:'demo-server'}),exec:async()=>{await waiting;return {code:0,out:'[]'};}};
 const run=tokenState([remote,local],[],{zone:'UTC',home:'/nonexistent-fixture',env:{},quota:false,onProgress:v=>updates.push(v)});
 for(let i=0;i<30&&!updates.some(v=>v.hosts.some(h=>h.hostId==='local'&&h.state!=='reading'));i++)await new Promise(r=>setTimeout(r,5));
 assert.ok(updates.some(v=>v.hosts.some(h=>h.hostId==='remote'&&h.state==='reading')));release();await run;
});

test('Codex overlapping and disjoint cumulative ranges union across hosts',()=>{
 const a={...source('local'),tool:'codex',buckets:[{lastAt:now,session:id,total:60,ranges:[[0,60]]}]};
 const b={...source('remote'),tool:'codex',buckets:[{lastAt:now,session:id,total:50,ranges:[[40,90]]}]};
 assert.equal(mergeSources([a,b],{now})[0].today,90);
});
test('seven source fixture produces exactly three real accounts',()=>{
 const f=require('./token-seven-fixture')(now);assert.equal(f.sources.length,7);assert.equal(f.accounts.length,3);assert.deepEqual(f.accounts.map(a=>a.today),[54000,98000,21000]);
});
test('HTTP Retry-After seconds and dates survive provider error normalization',async t=>{
 const {tokenRuntime}=require('../lib/token-source');const rt=tokenRuntime();
 for(const value of ['600',new Date(Date.now()+600000).toUTCString()]){
  const mock=t.mock.method(globalThis,'fetch',async()=>({ok:false,status:429,headers:{get:()=>value}}));
  const q=await rt.claudeQuota('/fixture',{credential:async()=>({accessToken:'fixture'})});assert.equal(q.error,'rate_limited');assert.ok(q.retryAfter>590000);mock.mock.restore();
 }
});
test('coordinator shares quota across two source hosts and later scans',async()=>{
 let calls=0;const pool=new QuotaPool({now:()=>now,random:()=>0});
 const backends=['local-fixture','remote-fixture'].map(host=>({cfg:{id:host},ready:true,publicView:()=>({name:host}),exec:async command=>{
  if(command.includes(')().discover('))return {code:0,out:JSON.stringify([{id:host,tool:'claude',hostId:host,directory:'/fixture',nickname:''}])};
  if(command.includes(')().claudeQuota(')){calls++;return {code:0,out:JSON.stringify({session:null,weekly:null,reason:''})};}
  return {code:0,out:JSON.stringify({...source(host),limits:{reason:'Không đọc được: chưa có quota'}})};
 }}));
 let result=await tokenState(backends,[],{zone:'UTC',now,quotaPool:pool});assert.equal(result.accounts.length,1);assert.equal(calls,1);assert.equal(result.accounts[0].hasGoodQuota,true);
 await tokenState(backends,[],{zone:'UTC',now,quotaPool:pool});assert.equal(calls,1);
});
test('linked live tmux status and project take precedence over closed log sessions',()=>{
 const a=source('local');a.liveSessions=[{aiTool:'claude',aiSessionId:id,path:'/work/tmux-web',name:'worker',state:'wait'}];
 const s=mergeSources([a],{now})[0].sessions[0];assert.equal(s.name,'tmux-web');assert.equal(s.state,'wait');assert.equal(s.tmuxName,'worker');
});
