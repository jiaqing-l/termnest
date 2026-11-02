'use strict';
const {Worker}=require('worker_threads');
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const cacheKey=key=>crypto.createHash('sha256').update(key).digest('hex');
const {accountKey}=require('./token-quota');
// Legacy summaries cannot recover message identities. Collapse conservatively by
// taking the largest known total, never adding potentially replicated usage.
function mergedAccounts(accounts=[]) {
 const groups=new Map();
 for(const a of accounts){const key=accountKey(a);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(a);}
 return [...groups.values()].map(group=>{
  const base=group[0],best=group.slice().sort((a,b)=>Number(!!b.hasGoodQuota)-Number(!!a.hasGoodQuota)||(b.limits?.observedAt||0)-(a.limits?.observedAt||0))[0];
  const union=(field,key)=>{const rows=new Map();for(const a of group)for(const r of a[field]||[]){const old=rows.get(r[key]);if(!old||old.total<r.total)rows.set(r[key],r);}return [...rows.values()].sort((a,b)=>String(a[key]).localeCompare(String(b[key])));};
  const maximum=field=>{const values=group.map(a=>a[field]).filter(v=>v!=null);return values.length?Math.max(...values):null;};
  return {...base,email:base.email?.trim().toLowerCase()||null,plan:group.find(a=>a.plan)?.plan||group.find(a=>a.limits?.plan)?.limits.plan||null,
   limits:best.limits,hasGoodQuota:group.some(a=>a.hasGoodQuota),today:maximum('today'),week:maximum('week'),
   hostIds:[...new Set(group.flatMap(a=>a.hostIds||[a.hostId]))],hostName:[...new Set(group.flatMap(a=>(a.hostName||'').split(', ')))].filter(Boolean).join(', '),
   sourceWarnings:[...new Set(group.flatMap(a=>a.sourceWarnings||[]))],days:union('days','day'),weeks:union('weeks','day'),sessions:union('sessions','id')};
 }).sort((a,b)=>a.tool.localeCompare(b.tool)||(a.email||'').localeCompare(b.email||'')||accountKey(a).localeCompare(accountKey(b)));
}
function sanitized(text) {
 const v=JSON.parse(text),pick=(o,keys)=>Object.fromEntries(keys.filter(k=>o[k]!==undefined).map(k=>[k,o[k]]));
 return JSON.stringify({...pick(v,['zone','at','updatedAt','scanning']),hosts:(v.hosts||[]).map(h=>pick(h,['hostId','hostName','reason','state'])),accounts:mergedAccounts(v.accounts).map(a=>({...pick(a,['id','tool','email','plan','reason','observedAt','today','week','hostId','hostName','nickname','threshold','directory','hostIds','sourceWarnings','hasGoodQuota','stale']),limits:require('./tokens').aggregate([{limits:a.limits}]).accounts[0].limits,days:(a.days||[]).map(d=>pick(d,['day','total'])),weeks:(a.weeks||[]).map(d=>pick(d,['day','total'])),sessions:(a.sessions||[]).map(d=>pick(d,['id','total','today','week','lastAt','tmuxName','state','name','hostId','hostName']))}))});
}
// Demand-driven: no timer keeps scanning after the last browser poll.
class TokenCache {
 constructor({dataDir=null,readOptions={},now=Date.now,createWorker=()=>new Worker(require.resolve('./token-worker')),logger=console}={}){this.createWorker=createWorker;this.logger=logger;this.error=null;this.closing=false;this.readOptions=readOptions;this.now=now;this.values=new Map();this.complete=new Set();this.staging=new Map();this.demands=new Map();this.lastScan=-Infinity;this.scanCount=0;this.pending=null;this.file=dataDir?path.join(dataDir,'token-aggregates.json'):null;this.persisted=new Map();try{const saved=JSON.parse(fs.readFileSync(this.file,'utf8'));if(saved.version===1||saved.version===2)this.persisted=new Map(saved.values.filter(([,v])=>{const value=JSON.parse(v),accounts=value.accounts||[];return !value.scanning&&(saved.version===2||new Set(accounts.map(accountKey)).size===accounts.length);}).map(([k,v])=>[k,sanitized(v)]));}catch{} }
 save(){if(!this.file)return;try{fs.mkdirSync(path.dirname(this.file),{recursive:true,mode:0o700});const temp=this.file+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify({version:2,values:[...this.persisted]}),{mode:0o600,flag:'w'});fs.chmodSync(temp,0o600);fs.renameSync(temp,this.file);}catch{this.logger.error('[tokens] Không lưu được tổng hợp.');}}
 get(backends,configs,{zone='UTC'}={}){
  const key=JSON.stringify([zone,configs]);
  const topology=JSON.stringify(backends.map(b=>[b.cfg.id,b.ready,b.mode]));
  if(!this.values.has(key)&&this.persisted.has(cacheKey(key))){this.values.set(key,this.persisted.get(cacheKey(key)));this.complete.add(key);}
  this.demands.set(key,{key,zone,at:this.now()});
  for(const [id,demand] of this.demands)if(this.now()-demand.at>90000 || JSON.stringify(JSON.parse(id)[1])!==JSON.stringify(configs))this.demands.delete(id);
  while(this.demands.size>4)this.demands.delete(this.demands.keys().next().value);
  if(!this.pending && (this.now()-this.lastScan>=60000 || this.lastConfigs!==JSON.stringify(configs) || this.lastTopology!==topology)){
   this.lastConfigs=JSON.stringify(configs);this.lastTopology=topology;
   this.lastScan=this.now();this.scanCount++;this.error=null;
   this.pending=new Promise(resolve=>this.resolve=resolve);
   try {
   if(!this.worker){
    const worker=this.worker=this.createWorker();
    worker.on('error',()=>{if(this.worker===worker)this.fail('Token worker gặp lỗi.');});
    worker.on('exit',()=>{if(this.worker!==worker)return;this.worker=null;if(this.pending&&!this.closing)this.fail('Token worker đã dừng trước khi quét xong.');});
    worker.on('message',async m=>{
     if(this.worker!==worker)return;
     if(m.rpc){try{const backend=this.backends.find(b=>b.cfg.id===m.host);const result=await backend.exec(m.command,m.timeout);this.worker?.postMessage({rpc:m.rpc,result});}catch{this.worker?.postMessage({rpc:m.rpc,error:true});}return;}
     if(m.value){
      const incoming=JSON.parse(sanitized(m.value));
      this.staging.set(m.key,incoming);
      // First visit may show progress. Established views remain untouched.
      if(!this.complete.has(m.key))this.values.set(m.key,JSON.stringify(incoming));
     }
     if(m.error)this.fail('Không thể hoàn tất quét log AI.');else if(m.done)this.finish(true);
    });
   }
   this.backends=backends;this.key=key;
   this.worker.postMessage({cachedAccounts:[...this.values.values()].flatMap(v=>JSON.parse(v).accounts || []),backends:backends.map(b=>({cfg:{id:b.cfg.id,local:!!b.cfg.local},mode:b.mode,ready:b.ready,name:b.publicView().name,snapshot:{sessions:(b.snapshot?.sessions||[]).map(s=>({name:s.name,path:s.path,state:s.state,aiTool:s.aiTool,aiSessionId:s.aiSessionId}))}})),configs,views:[...this.demands.values()],options:{...this.readOptions,zone,now:this.now()}});
   }catch{this.fail('Không thể khởi động worker quét log AI.');}
  }
  const value=this.values.get(key);
  if(value&&!this.pending&&!this.error)return value;
  return JSON.stringify({...(value?JSON.parse(value):{accounts:[],hosts:backends.map(b=>({hostId:b.cfg.id,hostName:b.publicView().name,state:'reading',reason:''})),zone,updatedAt:null,at:null}),scanning:!this.error&&(!!this.pending||!value),...(this.complete.has(key)&&this.pending?{refreshing:true}:{}),...(this.error?{error:this.error}:{})});
 }
 // Fixed reasons only: worker exceptions may contain credentials, paths or prompt text.
 fail(reason){if(this.closing||this.error)return;this.error=reason;this.logger.error('[tokens] '+reason);this.finish();}
 finish(publish=false){
  if(publish){
   for(const [key,incoming] of this.staging){
    if(incoming.scanning)continue;
    const previous=JSON.parse(this.values.get(key)||'{"accounts":[]}');
    const failed=new Set((incoming.hosts||[]).filter(h=>h.state==='failed').map(h=>h.hostId));
    const retained=previous.accounts.filter(a=>(a.hostIds||[a.hostId]).some(id=>failed.has(id))).map(a=>({...a,stale:true,observedAt:a.observedAt||a.limits?.observedAt||previous.updatedAt}));
    incoming.accounts=mergedAccounts([...incoming.accounts,...retained]);
    for(const a of incoming.accounts){
     const old=previous.accounts.find(p=>accountKey(p)===accountKey(a));
     if(!a.hasGoodQuota&&old?.hasGoodQuota){a.limits={...old.limits,stale:true};a.hasGoodQuota=true;}
     if(retained.some(p=>accountKey(p)===accountKey(a))){a.stale=true;a.observedAt=old.observedAt||old.limits?.observedAt||previous.updatedAt;}
    }
    const safe=sanitized(JSON.stringify(incoming));this.values.set(key,safe);this.complete.add(key);
    const disk=JSON.parse(safe);for(const a of disk.accounts){const q=a.limits;a.limits=(a.hasGoodQuota||(!q.error&&!q.reason))?{session:q.session,weekly:q.weekly,observedAt:q.observedAt,reason:''}:{session:null,weekly:null,reason:'Không đọc được: chưa có quota đã lưu'};}
    this.persisted.set(cacheKey(key),JSON.stringify(disk));
   }
   while(this.persisted.size>4)this.persisted.delete(this.persisted.keys().next().value);
   while(this.values.size>4){const key=this.values.keys().next().value;this.values.delete(key);this.complete.delete(key);}
   this.save();
  }
  this.staging.clear();this.resolve?.();this.resolve=null;this.pending=null;
 }
 async close(){this.closing=true;if(this.worker)await this.worker.terminate();this.finish();}
}
module.exports={TokenCache};
