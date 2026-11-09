'use strict';
const goodQuota = q => !!q && !q.error && !q.reason;
const accountKey = a => a.tool+':'+(a.email?.trim().toLowerCase() || a.hostId+':'+a.id);
// One coordinator owns provider calls, regardless of source host or viewer timezone.
class QuotaPool {
 constructor({now=Date.now,random=Math.random}={}) {this.now=now;this.random=random;this.entries=new Map();}
 seed(accounts=[]) {
  for(const a of accounts) {
   const q=a.limits;if(!q?.observedAt || !(goodQuota(q)||q.stale))continue;
   const key=accountKey(a),old=this.entries.get(key);
   if(!old || (old.good?.observedAt||0)<q.observedAt)this.entries.set(key,{...old,value:undefined,good:{session:q.session,weekly:q.weekly,...(q.noSession?{noSession:true}:{}),reason:'',observedAt:q.observedAt},next:Math.max(old?.next || 0,q.observedAt+330000)});
  }
 }
 async get(key,read) {
  const entry=this.entries.get(key)||{next:0};this.entries.set(key,entry);
  if(entry.pending)return entry.pending;
  if(this.now()<entry.next)return entry.value || entry.good;
  entry.next=this.now()+300000+Math.floor(this.random()*30000);
  entry.pending=(async()=>{
   let fresh;try{fresh=await read();}catch{fresh={error:'network',reason:'Không đọc được: không kết nối được nguồn quota'};}
   if(goodQuota(fresh))entry.good={...fresh,observedAt:this.now()};
   if(fresh.retryAfter)entry.next=Math.max(entry.next,this.now()+fresh.retryAfter);
   entry.value=goodQuota(fresh)?entry.good:entry.good?{...entry.good,stale:true,error:fresh.error,reason:fresh.reason}:fresh;
   return entry.value;
  })();
  try{return await entry.pending;}finally{entry.pending=null;}
 }
}
module.exports={QuotaPool,goodQuota,accountKey};
