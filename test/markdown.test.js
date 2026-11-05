'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs');
const ui=require('../public/file-viewer');
test('reading fixture renders structures, alignment, task lists and multiline emphasis',()=>{
 const html=ui.markdown(fs.readFileSync(__dirname+'/fixtures/reading.md','utf8'));
 for(const tag of ['table','thead','tbody','h1','h2','hr','ul','ol','blockquote','pre','code'])assert.match(html,new RegExp('<'+tag+'[ >/]'),tag);
 assert.match(html,/text-align:center/);assert.match(html,/<strong>in đậm qua\nhai dòng<\/strong>/);
 assert.match(html,/type="checkbox"[^>]*disabled/);assert.doesNotMatch(html,/\|:---/);
 assert.match(html,/target="_blank"/);assert.match(html,/rel="noopener noreferrer"/);
 assert.doesNotMatch(html,/(?:href|src)="(?:javascript|data):/i);assert.doesNotMatch(html,/<script>/);
});
test('all unsafe URL spellings are rejected and automatic links remain enabled',()=>{
 const html=ui.markdown('[a](JaVaScRiPt:alert(1)) [b](data:image/png;base64,AAA) [c](javascript&#58;alert(1)) https://example.org');
 assert.doesNotMatch(html,/(?:href|src)="(?:javascript|data):/i);assert.match(html,/href="https:\/\/example.org"/);
});
test('worker preserves complete structures when dividing a long document into chunks',()=>{
 const vm=require('vm'),source=fs.readFileSync(require.resolve('../public/markdown-worker.js'),'utf8');
 const text=fs.readFileSync(__dirname+'/fixtures/reading.md','utf8').repeat(150);
 let result;const self={FileViewer:ui,postMessage:value=>result=value};
 vm.runInNewContext(source,{self,importScripts:()=>{}});self.onmessage({data:text});
 assert.ok(result.chunks.length>1);assert.equal(result.chunks.join(''),ui.markdown(text));
 for(const chunk of result.chunks){
  for(const tag of ['div','table','ul','ol','blockquote','pre']){
   assert.equal((chunk.match(new RegExp('<'+tag+'[ >]','g'))||[]).length,(chunk.match(new RegExp('</'+tag+'>','g'))||[]).length,tag);
  }
 }
});

test('task lists render inside the Markdown worker, where there is no i18n',()=>{
 const ui=require('../public/file-viewer'),saved=globalThis.i18n;
 try{delete globalThis.i18n;
  const html=ui.markdown('- [x] done\n- [ ] todo\n');
  assert.match(html,/<input type="checkbox" disabled checked aria-label="Task status">/);
  assert.match(html,/<input type="checkbox" disabled aria-label="Task status"> todo/);
 }finally{globalThis.i18n=saved;}
});
