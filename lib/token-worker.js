'use strict';
const {parentPort}=require('worker_threads');
const {tokenState}=require('./tokens');
const backends=new Map(), requests=new Map();let next=0;
parentPort.on('message',async message=>{
 if(message.rpc){const pending=requests.get(message.rpc);if(pending){requests.delete(message.rpc);message.error?pending.reject(Error()):pending.resolve(message.result);}return;}
 try {
  const live=new Set(message.backends.map(b=>b.cfg.id));for(const id of backends.keys())if(!live.has(id))backends.delete(id);
  const list=message.backends.map(b=>{
   const old=backends.get(b.cfg.id)||{};Object.assign(old,b);old.publicView=()=>({name:b.name});
   old.exec=(command,timeout)=>new Promise((resolve,reject)=>{const rpc=++next;requests.set(rpc,{resolve,reject});parentPort.postMessage({rpc,host:b.cfg.id,command,timeout});});
   backends.set(b.cfg.id,old);return old;
  });
  for (const view of message.views) {
   const result=await tokenState(list,message.configs,{...message.options,zone:view.zone,cachedAccounts:message.cachedAccounts,onProgress:value=>parentPort.postMessage({key:view.key,value:JSON.stringify(value)})});
   result.updatedAt=Date.now();result.scanning=false;
   parentPort.postMessage({key:view.key,value:JSON.stringify(result)});
  }
  parentPort.postMessage({done:true});
 }catch{parentPort.postMessage({error:true});}
});
