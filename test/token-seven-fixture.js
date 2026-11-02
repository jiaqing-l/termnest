'use strict';
const {mergeSources}=require('../lib/tokens');
module.exports=function fixture(now=Date.now()){
 const sources=[['local','claude','work'],['remote','claude','work'],['local','claude','work'],['local','claude','tech2'],['remote','claude','tech2'],['local','codex','code'],['remote','codex','code']].map(([host,tool,login],i)=>({
  id:'source_'+i,hostId:host,hostName:host==='local'?'Máy này':'demo-server',tool,email:login+'@example.com',nickname:'',plan:tool==='claude'?'max':'plus',directory:'/fixture/'+i,
  records:tool==='claude'?[{id:login+'-message',at:now,session:'11111111-1111-4111-8111-'+(login==='work'?'111111111111':'222222222222'),total:login==='work'?98000:54000,project:login==='work'?'termnest':'demo-project'}]:undefined,
  buckets:tool==='codex'?[{lastAt:now,session:'33333333-3333-4333-8333-333333333333',total:21000,project:'crew-tools'}]:[],
  limits:host==='remote'&&tool==='claude'?{error:'expired',reason:'Không đọc được: đăng nhập đã hết hạn'}:{session:login==='tech2'?null:{percent:login==='work'?42:28,resetAt:now+7200000},weekly:{percent:login==='work'?61:23,resetAt:now+250000000},reason:'',observedAt:now-60000}
 }));
 return {sources,accounts:mergeSources(sources,{now}),hosts:[],scanning:false,updatedAt:now};
};
