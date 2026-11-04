'use strict';
const {test}=require('node:test'), assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path'),vm=require('vm');
const {fileRuntime,readSessionFile}=require('../lib/file-viewer');
const ui=require('../public/file-viewer');
test('paths, line suffixes, wrapped xterm lines and unicode columns',()=>{
 assert.deepEqual(ui.detect('see Implementation/Foo/13-BAR.md:12 and /tmp/a.txt').map(x=>x.path),['Implementation/Foo/13-BAR.md','/tmp/a.txt']);
 assert.equal(ui.detect('https://site/a.md').length,0);
 const lines=['see Implementation/Foo/','13-BAR.md'];
 const term={cols:23,buffer:{active:{length:2,getLine:i=>i<2?{isWrapped:i===1,translateToString:()=>lines[i]}:undefined}}};
 let links;ui.provider(term,()=>{}).provideLinks(2,v=>links=v);assert.equal(links[0].text,'Implementation/Foo/13-BAR.md');assert.equal(links[0].range.end.y,2);
});
test('markdown escapes HTML and iframe has scripts only sandbox',()=>{
 const html=ui.markdown('# Hello\n<script>alert(1)</script>\n[evil](javascript:alert(1))');
 assert.ok(html.includes('<h1>Hello</h1>'));assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;script&gt;'));
 const attrs={};const frame=ui.htmlFrame({createElement:()=>({setAttribute:(k,v)=>attrs[k]=v})},'<h1>x</h1>');
 assert.equal(attrs.sandbox,'allow-scripts');assert.equal(frame.srcdoc,'<h1>x</h1>');
});
test('file reader resolves paths, rejects traversal/symlink escape, binary, missing and oversized',async t=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'tw-files-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 const dir=path.join(tmp,'session');fs.mkdirSync(dir);fs.mkdirSync(path.join(tmp,'session-sibling'));fs.writeFileSync(path.join(tmp,'outside.md'),'SECRET');fs.writeFileSync(path.join(tmp,'session-sibling','outside.md'),'SECRET');
 fs.mkdirSync(path.join(dir,'sub'));fs.writeFileSync(path.join(dir,'a.md'),'# Xin chào');fs.writeFileSync(path.join(dir,'binary.txt'),Buffer.from([0,1]));fs.writeFileSync(path.join(dir,'big.txt'),Buffer.alloc(5*1024*1024+1));
 // Directory junctions require no Windows symlink privilege and exercise realpath containment.
 fs.symlinkSync(tmp,path.join(dir,'escape'),process.platform==='win32'?'junction':'dir');
 // Windows async realpath expands 8.3 names; the sync implementation may preserve them.
 const read=fileRuntime();assert.equal((await read({cwd:dir,path:'sub/../a.md'})).path,await fs.promises.realpath(path.join(dir,'a.md')));
 assert.equal((await read({cwd:dir,path:path.join(dir,'a.md')})).text,'# Xin chào');
 for(const file of ['../outside.md','escape/outside.md',path.join(tmp,'outside.md'),path.join(tmp,'session-sibling','outside.md')])assert.match((await read({cwd:dir,path:file})).error,/ngoài thư mục/,file);
 for(const file of ['binary.txt','big.txt','missing.txt'])assert.ok((await read({cwd:dir,path:file})).error,file);
 const alias=path.join(tmp,'alias');fs.symlinkSync(dir,alias,process.platform==='win32'?'junction':'dir');
 assert.equal((await read({cwd:alias,path:fs.realpathSync(path.join(dir,'a.md'))})).text,'# Xin chào');
 const backend={cfg:{local:true},mode:'native',ready:true,exec:async()=>({code:0,out:dir+'\n'}),snapshot:{sessions:[{name:'a',path:dir}]}};
 assert.equal((await readSessionFile(backend,'a','a.md')).text,'# Xin chào');
 await assert.rejects(()=>readSessionFile(backend,'unknown','a.md'));
});
test('Windows file containment handles drive, UNC and short-name aliases',async()=>{
 const win=path.win32;
 for(const [base,root] of [
  [String.raw`C:\Users\RUNNER~1\session`,String.raw`C:\Users\runneradmin\session`],
  [String.raw`\\server\share\session`,String.raw`\\server\share\session`]
 ]){
  const file=win.join(root,'a.md'),outside=win.join(win.dirname(root),'outside.md');let opened=0;
  const disk={constants:{O_RDONLY:0},promises:{
   realpath:async p=>p.toLowerCase()===base.toLowerCase()?root:p.toLowerCase()===win.join(base,'a.md').toLowerCase()?file:p.toLowerCase()===win.join(base,'escape','outside.md').toLowerCase()?outside:p,
   open:async p=>{assert.equal(p,file);opened++;return {stat:async()=>({isFile:()=>true,size:2}),read:async(buffer,offset,length,position)=>{const data=Buffer.from('ok').subarray(position,position+length);data.copy(buffer,offset);return {bytesRead:data.length};},close:async()=>{}};}
  }};
  const read=vm.runInNewContext('('+fileRuntime.toString()+')()',{
   require:name=>name==='fs'?disk:win,Buffer,TextDecoder
  });
  for(const requested of ['a.md',file,win.join(base,'a.md')])assert.equal((await read({cwd:base,path:requested})).text,'ok');
  for(const requested of [String.raw`..\outside.md`,String.raw`escape\outside.md`,outside,win.join(root+'-sibling','outside.md'),String.raw`D:\outside.md`,String.raw`\\other\share\outside.md`])
   assert.match((await read({cwd:base,path:requested})).error,/ngoài thư mục/,requested);
  assert.equal(opened,3);
 }
});
test('already-focused pointer does not rerender and details use a content signature',()=>{
 const src=fs.readFileSync(require.resolve('../public/app.js'),'utf8');
 const body=src.slice(src.indexOf('  function focusPane('),src.indexOf('  function ensureTerm('));let renders=0;
 const cur={id:'a',name:'s'},context={focusedPane:0,cur,panes:[{cur,term:{focus:()=>{}},node:{classList:{toggle:()=>{}}}}],renderTabs:()=>renders++,renderDetail:()=>renders++,renderBar:()=>renders++};
 vm.runInNewContext(body+';focusPane(0,false);',context);assert.equal(renders,0);
 assert.match(src,/detailSignature/);
});
test('tokens use a separate 5 second tick with throttling and visibility guard',()=>{
 const app=fs.readFileSync(require.resolve('../public/app.js'),'utf8'),ui=fs.readFileSync(require.resolve('../public/token-ui.js'),'utf8');
 assert.match(app,/setInterval\(function\(\)\s*\{\s*tokens.poll\(\);?\s*\},\s*5000\)/);
 assert.match(ui,/document.hidden/);assert.match(ui,/30000/);assert.doesNotMatch(app,/refresh\(\);tokens.poll\(\)/);
});
test('remote read quotes hostile paths, obtains live cwd and supports the complete 5 MB limit', {skip:process.platform==='win32' ? 'SSH reader harness executes remote POSIX commands through /bin/sh' : false},async t=>{
 const {execFile}=require('child_process'),{promisify}=require('util');const run=promisify(execFile);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tw-remote-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const name="it's $(echo nope).txt";fs.writeFileSync(path.join(dir,name),'Việt '.repeat(600000));
 const backend={cfg:{local:false},ready:true,snapshot:{sessions:[{name:'s',path:'/stale'}]},exec:async(command,timeout,maxBuffer)=>{
  if(command.startsWith('tmux display-message'))return {code:0,out:dir+'\n'};
  const result=await run('/bin/sh',['-c',command],{timeout,maxBuffer});return {code:0,out:result.stdout};
 }};
 const file=await readSessionFile(backend,'s',name);assert.ok(!file.error);assert.equal(file.text,'Việt '.repeat(600000));assert.equal(file.path,fs.realpathSync(path.join(dir,name)));
 fs.writeFileSync(path.join(dir,'exact.txt'),Buffer.alloc(5*1024*1024,65));assert.equal((await readSessionFile(backend,'s','exact.txt')).text.length,5*1024*1024);
});
test('xterm provider maps wide characters and does not open a selected link',()=>{
 const text='中 Implementation/Foo/a.md',cells=[];
 for(const c of text){cells.push({getChars:()=>c,getWidth:()=>c==='中'?2:1});if(c==='中')cells.push({getChars:()=>'',getWidth:()=>0});}
 let opens=0,links;const term={cols:cells.length,getSelection:()=> 'selected',buffer:{active:{length:1,getLine:()=>({isWrapped:false,getCell:i=>cells[i]})}}};
 ui.provider(term,()=>opens++).provideLinks(1,v=>links=v);assert.equal(links[0].range.start.x,4);links[0].activate({preventDefault:()=>{}});assert.equal(opens,0);
});

test('an absolute path with spaces in its name is one link, not just its last word', () => {
  const text = 'saved /Users/admin/Documents/Screenshots/Screenshot 2026-11-04 at 21.20.47.png ok';
  assert.deepEqual(ui.detect(text).map((x) => x.path), ['/Users/admin/Documents/Screenshots/Screenshot 2026-11-04 at 21.20.47.png']);
  const found = ui.detect(text)[0];
  assert.equal(text.slice(found.start, found.end), found.path);
});

test('spaced paths do not swallow ordinary sentences or break plain paths', () => {
  assert.deepEqual(ui.detect('see Implementation/Foo/13-BAR.md:12 and /tmp/a.txt').map((x) => x.path), ['Implementation/Foo/13-BAR.md', '/tmp/a.txt']);
  assert.deepEqual(ui.detect('open /tmp/a.txt then check b.png now').map((x) => x.path), ['/tmp/a.txt', 'b.png']);
});
