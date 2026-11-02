'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {TokenCache}=require('../lib/token-cache');
const {mergeSources}=require('../lib/tokens');
const now=100000;
function account(host='local',email='work@example.com',plan=null){return mergeSources([{id:host,tool:'claude',hostId:host,hostName:host,email,plan,limits:{session:{percent:42,resetAt:900000},reason:'',observedAt:now},buckets:[]}],{now})[0];}
function fixture(t,dataDir){let time=now;class Worker extends EventEmitter{postMessage(m){this.message=m;}async terminate(){}}
 const worker=new Worker(),cache=new TokenCache({dataDir,now:()=>time,createWorker:()=>worker});t.after(()=>cache.close());
 const get=()=>JSON.parse(cache.get([],[]));get();const key=worker.message.views[0].key;
 return {cache,worker,key,get,advance:()=>time+=60000,emit:(accounts,scanning=false,hosts=[])=>worker.emit('message',{key,value:JSON.stringify({accounts,hosts,scanning,updatedAt:time})}),done:()=>worker.emit('message',{done:true})};}
test('refresh stages every partial result and commits the complete view atomically',t=>{
 const f=fixture(t);f.emit([account()]);f.done();const before=f.get();const published=()=>{const {refreshing,...value}=f.get();return {...value,scanning:false};};f.advance();f.get();
 f.emit([account('remote','other@example.com')],true,[{hostId:'local',state:'reading'}]);
 assert.deepEqual(published(),before);f.done();assert.deepEqual(published(),before);
 f.advance();f.get();f.emit([account('remote','other@example.com')]);assert.deepEqual(f.get().accounts,before.accounts);f.done();assert.equal(f.get().accounts[0].email,'other@example.com');
});
test('failed host retains last good usage and its observation age',t=>{
 const f=fixture(t);f.emit([account()]);f.done();f.advance();f.get();f.emit([],false,[{hostId:'local',hostName:'local',state:'failed',reason:'unreachable'}]);f.done();
 const value=f.get();assert.equal(value.accounts.length,1);assert.equal(value.accounts[0].limits.session.percent,42);assert.equal(value.accounts[0].observedAt,now);assert.equal(value.accounts[0].stale,true);
});
test('legacy duplicate cache is discarded before serving and progress is merged',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tw-stability-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const key=crypto.createHash('sha256').update(JSON.stringify(['UTC',[]])).digest('hex');
 fs.writeFileSync(path.join(dir,'token-aggregates.json'),JSON.stringify({version:1,values:[[key,JSON.stringify({accounts:[account(),account('remote')],scanning:false,updatedAt:now})]]}));
 const f=fixture(t,dir);assert.equal(f.get().accounts.length,0);f.emit([account(),account('remote')],true);assert.equal(f.get().accounts.length,1);
});
test('merged plan uses any source and account order is tool then normalized email',()=>{
 const sources=[['codex','z@x',null],['claude','z@x',null],['claude','a@x',null],['claude','z@x','Pro']].map(([tool,email,plan],i)=>({id:String(i),hostId:String(i),hostName:String(i),tool,email,plan,limits:{reason:''},buckets:[]}));
 const rows=mergeSources(sources,{now});assert.deepEqual(rows.map(a=>a.tool+':'+a.email),['claude:a@x','claude:z@x','codex:z@x']);assert.equal(rows[1].plan,'Pro');
});
test('persisted complete snapshot survives partial scans and restart without publishing staging',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tw-stability-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const f=fixture(t,dir);f.emit([account()]);f.done();const saved=fs.readFileSync(path.join(dir,'token-aggregates.json'),'utf8');
 f.advance();f.get();f.emit([account('remote','other@example.com')],true);
 assert.equal(fs.readFileSync(path.join(dir,'token-aggregates.json'),'utf8'),saved);
 const restarted=fixture(t,dir);assert.equal(restarted.get().accounts[0].email,'work@example.com');assert.equal(restarted.get().refreshing,true);
 f.worker.emit('message',{error:true});assert.equal(f.get().accounts[0].email,'work@example.com');assert.equal(fs.readFileSync(path.join(dir,'token-aggregates.json'),'utf8'),saved);
});
test('transport failure after discovery is a failed host rather than an empty replacement account',async()=>{
 const {tokenState}=require('../lib/tokens');
 const backend={cfg:{id:'remote'},ready:true,publicView:()=>({name:'Remote'}),exec:async command=>command.includes(')().discover(')?{code:0,out:JSON.stringify([{id:'remote',hostId:'remote',tool:'claude',directory:'/fixture'}])}:{code:1,out:''}};
 const result=await tokenState([backend],[],{now,quota:false});assert.equal(result.hosts[0]?.state,'failed');assert.equal(result.accounts.length,0);
});
