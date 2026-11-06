'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

// Small DOM/event harness, like ime-input.test.js. Capture, bubbling and
// pointer capture matter here; no server, browser or extra dependency needed.
class Element {
 constructor(tagName='') { this.tagName=tagName.toUpperCase();this.children=[];this.listeners=[];this.style={};this.captures=new Set(); }
 append(...nodes) { for(const node of nodes){node.parentNode=this;this.children.push(node);} }
 setAttribute() {}
 removeAttribute() {}
 contains(node) { return node===this||this.children.some(child=>child.contains(node)); }
 closest(selector) { return selector.split(',').includes(this.tagName.toLowerCase())?this:this.parentNode?.closest(selector)||null; }
 addEventListener(type,fn,capture=false) { this.listeners.push({type,fn,capture}); }
 setPointerCapture(id) { this.captures.add(id); }
 hasPointerCapture(id) { return this.captures.has(id); }
 releasePointerCapture(id) { this.captures.delete(id); }
}
function fixture() {
 const doc=new Element(),win=new Element(),timers=[];
 doc.body=new Element('body');doc.append(doc.body);doc.createElement=tag=>new Element(tag);
 doc.querySelector=selector=>selector==='dialog[open]'?(doc.dialogOpen?{}:null):(doc.menuOpen?{}:null);
 const context={document:doc,window:win,innerWidth:1400,localStorage:{getItem:()=>null},setTimeout:fn=>timers.push(fn)};
 vm.createContext(context);vm.runInContext(fs.readFileSync(require.resolve('../public/file-viewer'),'utf8'),context);
 const viewer=win.FileViewer.create(async(_method,url)=>({path:new URL(url,'https://test').searchParams.get('path'),kind:'text',text:'preview'}));
 const panel=doc.body.children[0],handle=panel.children[0],head=panel.children[1],terminal=new Element('div'),outside=new Element('button');
 doc.body.append(terminal,outside);
 function event(type,target,props={}) {
  const e={type,target,pointerId:1,isPrimary:true,button:0,clientX:100,clientY:100,defaultPrevented:false,
   preventDefault(){this.defaultPrevented=true;},stopPropagation(){this.stopped=true;},...props};
  const path=[];for(let node=target;node;node=node.parentNode)path.unshift(node);
  for(const node of path){for(const l of node.listeners)if(l.type===type&&l.capture)l.fn(e);if(e.stopped)return e;}
  for(const node of path.reverse()){
   node['on'+type]?.(e);
   for(const l of node.listeners)if(l.type===type&&!l.capture)l.fn(e);
   if(e.stopped)break;
  }
  return e;
 }
 const flush=()=>{while(timers.length)timers.shift()();};
 const click=(target,props={})=>{event('pointerdown',target,props);event('pointerup',target,props);event('mouseup',target,props);event('click',target,props);flush();};
 return {doc,win,viewer,panel,handle,head,terminal,outside,event,flush,click,open:()=>viewer.open('host','session','a.txt')};
}

test('outside mouse click and touch tap close the viewer',async()=>{
 for(const pointerType of ['mouse','touch']){
  const f=fixture();await f.open();assert.equal(f.panel.hidden,false);
  f.click(f.outside,{pointerType});assert.equal(f.panel.hidden,true);
 }
});
test('terminal click closes without swallowing focus or terminal events',async()=>{
 const f=fixture();await f.open();const seen=[];
 for(const type of ['pointerdown','pointerup','mouseup','click'])f.terminal.addEventListener(type,e=>{
  seen.push(type);assert.equal(e.defaultPrevented,false);e.stopPropagation();
  if(type==='pointerdown')f.doc.activeElement=f.terminal;
 });
 f.click(f.terminal);assert.equal(f.panel.hidden,true);assert.equal(f.doc.activeElement,f.terminal);
 assert.deepEqual(seen,['pointerdown','pointerup','mouseup','click']);
});
test('inside interactions and pointerdown inside followed by release outside stay open',async()=>{
 const f=fixture();await f.open();
 f.click(f.head.children[0]);assert.equal(f.panel.hidden,false);
 f.event('pointerdown',f.head);f.event('pointerup',f.outside);f.flush();assert.equal(f.panel.hidden,false);
});
test('resize drag released outside stays open and still resizes',async()=>{
 const f=fixture();await f.open();
 f.event('pointerdown',f.handle);
 f.event('pointermove',f.handle,{clientX:500});assert.equal(f.panel.style.width,'900px');
 // never wider than the window minus 480px for the sidebar and terminal (1400 - 480)
 f.event('pointermove',f.handle,{clientX:10});assert.equal(f.panel.style.width,'920px');
 // Browsers retarget captured pointerup to the resize handle.
 f.event('pointerup',f.handle,{clientX:400});f.flush();assert.equal(f.panel.hidden,false);
 assert.equal(f.handle.hasPointerCapture(1),false);
 f.event('pointerdown',f.handle);f.event('pointerup',f.outside);f.flush();assert.equal(f.panel.hidden,false);
});
test('terminal selection drags stay open, including returning to the starting point',async()=>{
 for(const endX of [100,200]){
  const f=fixture();await f.open();
  f.event('pointerdown',f.terminal);f.event('pointermove',f.terminal,{clientX:200});
  f.event('pointerup',f.terminal,{clientX:endX});f.event('click',f.terminal);f.flush();assert.equal(f.panel.hidden,false);
 }
 const f=fixture();await f.open();
 f.event('pointerdown',f.terminal);f.event('pointerup',f.terminal,{clientX:200});f.flush();assert.equal(f.panel.hidden,false);
});
test('terminal file link activation on mouseup or click replaces content without closing',async()=>{
 for(const activationEvent of ['mouseup','click']){
  const f=fixture();await f.open();let links,request;
  const line='next.txt',term={cols:line.length,getSelection:()=>'',buffer:{active:{length:1,getLine:()=>({translateToString:()=>line})}}};
  f.win.FileViewer.provider(term,path=>{request=f.viewer.open('host','session',path);}).provideLinks(1,result=>links=result);
  f.terminal.addEventListener(activationEvent,e=>{links[0].activate(e);e.stopPropagation();});
  f.click(f.terminal);await request;
  assert.equal(f.panel.hidden,false);assert.equal(f.head.children[0].title,'next.txt');
  assert.equal(f.panel.children[2].children.at(-1).textContent,'preview');
 }
});
test('dialog and native popover already open or opened during the click prevent dismissal',async()=>{
 for(const state of ['dialogOpen','menuOpen'])for(const alreadyOpen of [true,false]){
  const f=fixture();await f.open();
  if(alreadyOpen)f.doc[state]=true;
  else f.outside.addEventListener('click',()=>{f.doc[state]=true;});
  f.click(f.outside);assert.equal(f.panel.hidden,false);
 }
});
test('a dialog open on pointerdown still protects the viewer if closed during pointerup',async()=>{
 const f=fixture();await f.open();f.doc.dialogOpen=true;
 f.event('pointerdown',f.outside);f.doc.dialogOpen=false;f.event('pointerup',f.outside);f.flush();assert.equal(f.panel.hidden,false);
});
test('select menus and right clicks do not dismiss',async()=>{
 const f=fixture();await f.open();const select=f.doc.createElement('select');f.doc.body.append(select);
 f.click(select);assert.equal(f.panel.hidden,false);
 f.click(f.terminal,{button:2});assert.equal(f.panel.hidden,false);
});
test('different targets, pointer cancellation, context menus, blur and multiple pointers do not dismiss',async()=>{
 for(const action of ['different target','pointercancel','contextmenu','blur','second pointer','wrong pointer']){
  const f=fixture();await f.open();f.event('pointerdown',f.terminal);
  if(action==='blur')f.event('blur',f.win);
  else if(action==='second pointer')f.event('pointerdown',f.outside,{pointerId:2,isPrimary:false});
  else if(action==='pointercancel'||action==='contextmenu')f.event(action,f.terminal);
  f.event('pointerup',action==='different target'?f.outside:f.terminal,{pointerId:action==='wrong pointer'?2:1});
  f.flush();assert.equal(f.panel.hidden,false,action);
 }
});
test('a contextmenu after pointerup cancels pending dismissal',async()=>{
 const f=fixture();await f.open();f.event('pointerdown',f.terminal);f.event('pointerup',f.terminal);
 f.event('contextmenu',f.terminal);f.flush();assert.equal(f.panel.hidden,false);
});
test('Escape and the close button still close',async()=>{
 const f=fixture();await f.open();
 const e=f.event('keydown',f.doc,{key:'Escape'});assert.equal(e.defaultPrevented,true);assert.equal(f.panel.hidden,true);
 await f.open();f.click(f.head.children[4]);assert.equal(f.panel.hidden,true);   // title, back, insert, more, close
});
