'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const fs=require('node:fs'),vm=require('node:vm');
const {TokenCache}=require('../lib/token-cache');
class Worker extends EventEmitter { postMessage(message){this.message=message;} async terminate(){this.emit('exit',1);} }
function cacheFixture(t){let now=100000,worker;const logs=[];const cache=new TokenCache({now:()=>now,createWorker:()=>worker=new Worker(),logger:{error:line=>logs.push(line)}});t.after(()=>cache.close());return {cache,get worker(){return worker;},logs,advance:()=>now+=60000,get:()=>JSON.parse(cache.get([],[],{zone:'UTC'}))};}
test('cache distinguishes first scan, ready data and background refresh',t=>{
 const f=cacheFixture(t);assert.equal(f.get().scanning,true);assert.equal(f.get().updatedAt,null);
 const key=f.worker.message.views[0].key;
 f.worker.emit('message',{key,value:JSON.stringify({accounts:[],updatedAt:100000,scanning:false})});f.worker.emit('message',{done:true});
 assert.equal(f.get().scanning,false);assert.equal(f.get().updatedAt,100000);
 f.advance();assert.equal(f.get().scanning,true);assert.equal(f.get().updatedAt,100000);
});
for(const event of ['error','exit','scan'])test('cache reports sanitized '+event+' failure and can recover',t=>{
 const f=cacheFixture(t);f.get();
 if(event==='error'){f.worker.emit('error',Error('SECRET-PROMPT SECRET-TOKEN'));f.worker.emit('exit',1);}
 else if(event==='exit')f.worker.emit('exit',7);
 else f.worker.emit('message',{error:true,detail:'SECRET-PROMPT SECRET-TOKEN'});
 const data=f.get();assert.equal(data.scanning,false);assert.match(data.error,/worker|quét/i);assert.equal(f.cache.pending,null);
 assert.equal(f.logs.length,1);assert.doesNotMatch(JSON.stringify([data,f.logs]),/SECRET/);
 f.advance();assert.equal(f.get().scanning,true);
 f.worker.emit('message',{key:f.worker.message.views[0].key,value:JSON.stringify({accounts:[],updatedAt:160000,scanning:false})});f.worker.emit('message',{done:true});
 assert.equal(f.get().scanning,false);assert.equal(f.get().error,undefined);
});
// Minimal DOM fixture exercises the production renderer/poll logic without external services.
function uiFixture(){
 class Node {constructor(tag,text=''){this.tag=tag;this.children=[];this._text=text;this.style={setProperty(){}};this.dataset={};const classes=new Set();this.classList={contains:k=>classes.has(k),add:k=>classes.add(k),toggle:(k,on)=>on?classes.add(k):classes.delete(k)};}set textContent(v){this._text=v;this.children=[];}get textContent(){return this._text+this.children.map(c=>c.textContent).join('');}append(...nodes){this.children.push(...nodes);}after(n){this.next=n;}before(n){this.previous=n;}setAttribute(){}getClientRects(){return [1];}querySelectorAll(){return this.children.filter(c=>c.tag==='button');}}
 const nodes={},seg=new Node('div'),right=new Node('div');nodes['v-focus']=new Node('section');
 const document={hidden:false,createElement:tag=>new Node(tag),getElementById:id=>nodes[id],querySelector:s=>s.includes('main-top')?seg:right};
 let now=100000,calls=0,response={accounts:[],updatedAt:null,scanning:true};const window={};
 vm.runInNewContext(fs.readFileSync(require.resolve('../public/token-ui.js'),'utf8'),{window,document,Intl,Date:class extends Date{static now(){return now;}}});
 const ui=window.TokenUI({scope:()=> 'all',view(){},updated(){},api:async()=>{calls++;return response;}});
 return {ui,section:nodes['v-focus'].next,mini:right.previous,tab:seg.children[0],document,get calls(){return calls;},set response(v){response=v;},advance:n=>now+=n};
}
test('initial scan renders loading without errors, polls at 5 seconds, then 30 seconds with update time',async()=>{
 const f=uiFixture();await f.ui.poll(true);
 assert.match(f.section.textContent,/Đang đọc log AI lần đầu, có thể mất khoảng 1 phút…/);f.ui.render();assert.match(f.section.textContent,/Đang đọc log AI lần đầu, có thể mất khoảng 1 phút…/);
 assert.doesNotMatch(f.section.textContent,/Không đọc được/);assert.equal(f.mini.textContent,'Token AI · Đang đọc…');assert.doesNotMatch(f.mini.title,/Không đọc được|Chưa có nguồn/);
 f.advance(4999);await f.ui.poll();assert.equal(f.calls,1);
 f.advance(1);await f.ui.poll();assert.equal(f.calls,2);
 f.response={accounts:[],updatedAt:Date.parse('2026-11-01T12:34:00Z'),scanning:false};f.advance(5000);await f.ui.poll();assert.equal(f.calls,3);
 assert.match(f.section.textContent,/Cập nhật lúc \d{2}:\d{2}/);
 f.advance(5000);await f.ui.poll();assert.equal(f.calls,3);
 f.advance(25000);await f.ui.poll();assert.equal(f.calls,4);
});
test('scan failure leaves loading and renders its reason',async()=>{
 const f=uiFixture();f.response={accounts:[],updatedAt:null,scanning:false,error:'Token worker đã dừng.'};await f.ui.poll(true);
 assert.match(f.section.textContent,/Token worker đã dừng/);assert.doesNotMatch(f.section.textContent,/Đang đọc log/);assert.equal(f.mini.textContent,'Token AI · Không đọc được');
});

test('worker startup failure returns a safe reason immediately',()=>{
 const logs=[];const cache=new TokenCache({createWorker:()=>{throw Error('SECRET-PATH');},logger:{error:line=>logs.push(line)}});
 const data=JSON.parse(cache.get([],[]));assert.equal(data.scanning,false);assert.match(data.error,/khởi động/);assert.equal(cache.pending,null);assert.equal(logs.length,1);assert.doesNotMatch(JSON.stringify([data,logs]),/SECRET/);
});
test('hidden document suppresses polling and clear restores initial loading',async()=>{
 const f=uiFixture();f.document.hidden=true;await f.ui.poll(true);assert.equal(f.calls,0);
 f.document.hidden=false;f.response={accounts:[],updatedAt:null,scanning:false,error:'Token worker đã dừng.'};await f.ui.poll(true);
 f.ui.clear();assert.match(f.section.textContent,/Đang đọc log AI lần đầu/);assert.doesNotMatch(f.section.textContent,/Không đọc được|worker đã dừng/);
});

test('changing account settings refreshes immediately while reusing worker source caches',t=>{
 const f=cacheFixture(t);f.get();f.worker.emit('message',{done:true});
 f.cache.get([],[{id:'new',hostId:'host',tool:'codex',directory:'/fixture',nickname:'Work',threshold:null}]);
 assert.equal(f.cache.scanCount,2);assert.equal(f.worker.message.configs[0].nickname,'Work');
});

test('successful inactive window has no warning; sources still reading are not failures',async()=>{
 const f=uiFixture(),{mergeSources}=require('../lib/tokens');
 const accounts=mergeSources([{id:'a',tool:'claude',email:'work@example.com',hostId:'local',hostName:'Máy này',limits:{session:null,weekly:null,reason:'',observedAt:100000},buckets:[]}],{now:100000});
 f.response={accounts,hosts:[{hostId:'remote',hostName:'demo-server',state:'reading',reason:''}],scanning:true,updatedAt:100000};await f.ui.poll(true);
 assert.match(f.section.textContent,/Claude · work/);assert.match(f.section.textContent,/Chưa có phiên/);assert.match(f.section.textContent,/demo-server: đang đọc…/);
 assert.doesNotMatch(f.section.textContent,/Không đọc được quota|chưa đọc được/);assert.match(f.section.textContent,/—/);
});
test('session table starts at ten heaviest and expands, labels folder and closed state with UUID title',async()=>{
 const f=uiFixture(),{mergeSources}=require('../lib/tokens');const now=Date.now();
 const accounts=mergeSources([{id:'a',tool:'claude',hostId:'local',email:'work@example.com',hostName:'Máy này',limits:{reason:''},buckets:Array.from({length:12},(_,i)=>({session:'11111111-1111-4111-8111-'+String(i).padStart(12,'0'),total:i+1,lastAt:now,project:'project-'+i}))}],{now});
 f.response={accounts,scanning:false,updatedAt:now};await f.ui.poll(true);
 const walk=n=>[n,...n.children.flatMap(walk)];let nodes=walk(f.section);let body=nodes.find(n=>n.tag==='tbody');assert.equal(body.children.length,10);assert.equal(body.children[0].children[0].textContent,'project-11');assert.match(body.children[0].children[0].title,/11111111/);assert.match(body.textContent,/Đã đóng/);assert.doesNotMatch(body.textContent,/Không đọc được/);
 nodes.find(n=>n.tag==='button'&&n.textContent==='Xem thêm').onclick();body=walk(f.section).find(n=>n.tag==='tbody');assert.equal(body.children.length,12);
});

test('progressive scan keeps existing cache while other sources are pending',t=>{
 const f=cacheFixture(t);f.get();const key=f.worker.message.views[0].key;
 const a={id:'a',tool:'claude',email:'a@example.com',limits:{session:{percent:42,resetAt:900000},reason:'',observedAt:100000},hasGoodQuota:true,days:[],weeks:[],sessions:[]};
 f.worker.emit('message',{key,value:JSON.stringify({accounts:[a],scanning:false,updatedAt:100000})});f.worker.emit('message',{done:true});f.advance();f.get();
 f.worker.emit('message',{key,value:JSON.stringify({accounts:[],hosts:[{hostId:'remote',hostName:'Remote',state:'reading'}],scanning:true})});
 const value=f.get();assert.equal(value.accounts.length,1);assert.equal(value.accounts[0].limits.session.percent,42);assert.deepEqual(value.hosts,[]);assert.equal(value.updatedAt,100000);
});

test('unchanged payload and tab return preserve nodes and scroll without a scan',async()=>{
 const f=uiFixture(),{mergeSources}=require('../lib/tokens');
 f.response={accounts:mergeSources([{id:'a',tool:'claude',hostId:'local',hostName:'A very long host list',email:'work@example.com',limits:{reason:''},buckets:[]}]),hosts:[],updatedAt:100000,scanning:false};await f.ui.poll(true);
 const cards=f.section.children[0].children[2],card=cards.children[0];f.section.scrollTop=213;
 await f.ui.poll(true);assert.equal(cards.children[0],card);f.ui.render();assert.equal(cards.children[0],card);
 f.ui.setView('over');f.advance(60000);const calls=f.calls;f.ui.setView('token');f.ui.render();assert.equal(f.calls,calls);assert.equal(cards.children[0],card);assert.equal(f.section.scrollTop,213);
 assert.doesNotMatch(card.textContent,/Gói Không đọc được/);
});
test('background refresh only changes inline status and fetch failure preserves cards',async()=>{
 const f=uiFixture(),{mergeSources}=require('../lib/tokens');
 const accounts=mergeSources([{id:'a',tool:'claude',email:'work@example.com',hostId:'local',hostName:'Local',limits:{reason:''},buckets:[]}]);
 f.response={accounts,hosts:[],updatedAt:100000,scanning:false};await f.ui.poll(true);
 const cards=f.section.children[0].children[2],card=cards.children[0];
 f.response={accounts,hosts:[{hostId:'remote',hostName:'Remote',state:'reading',reason:''}],updatedAt:100000,scanning:true};await f.ui.poll(true);
 assert.equal(cards.children[0],card);assert.equal(cards.children.length,1);assert.match(f.section.textContent,/Cập nhật lúc .*Đang cập nhật…/);assert.doesNotMatch(f.section.textContent,/Remote:|Không đọc được quota/);
 f.response=null;await f.ui.poll(true);assert.equal(cards.children[0],card);
});
test('first browser response from a refreshing persisted view has only inline status',async()=>{
 const f=uiFixture(),{mergeSources}=require('../lib/tokens');
 const accounts=mergeSources([{id:'a',tool:'claude',email:'work@example.com',hostId:'local',hostName:'Local',limits:{reason:'quota unavailable'},buckets:[]}]);
 f.response={accounts,hosts:[{hostId:'remote',hostName:'Remote',state:'failed',reason:'offline'}],updatedAt:100000,scanning:true,refreshing:true};await f.ui.poll(true);
 assert.match(f.section.textContent,/Cập nhật lúc .*Đang cập nhật…/);assert.doesNotMatch(f.section.textContent,/Remote:|Không đọc được quota/);
});
test('retained host data shows age which advances without rebuilding the card',async()=>{
 const f=uiFixture(),{mergeSources}=require('../lib/tokens');
 const accounts=mergeSources([{id:'a',tool:'claude',email:'work@example.com',hostId:'local',hostName:'Local',limits:{reason:''},buckets:[]}]).map(a=>({...a,stale:true,observedAt:40000}));
 f.response={accounts,hosts:[{hostId:'local',hostName:'Local',state:'failed',reason:'offline'}],updatedAt:100000,scanning:false};await f.ui.poll(true);
 const cards=f.section.children[0].children[2],card=cards.children[0];assert.match(card.textContent,/Dữ liệu đã lưu · 1 phút trước/);assert.equal(cards.children.length,1);
 f.advance(60000);f.ui.render();assert.match(card.textContent,/Dữ liệu đã lưu · 2 phút trước/);assert.equal(cards.children[0],card);
});
