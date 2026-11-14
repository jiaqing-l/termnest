'use strict';
const {shq}=require('./parse');
const {tr}=require('./i18n-server');
// An error that tells the caller what kind of failure it was ('no-node': the host has no Node.js), so the page can offer a fix.
class HostError extends Error{constructor(code,message){super(message);this.code=code;}}
// Self-contained to run on the selected SSH/WSL host, without transferring credentials.
function fileRuntime(){
 const fs=require('fs'),path=require('path');const LIMIT=5*1024*1024;
 return async function read({cwd,path:requested,noSearch}){
  const error=message=>({error:message});
  if(typeof cwd!=='string'||typeof requested!=='string'||!requested||requested.length>4096||/[\x00-\x1f\x7f]/.test(requested))return error('Đường dẫn tệp không hợp lệ.');
  try{
   const base=path.resolve(cwd),root=await fs.promises.realpath(base),target=path.resolve(base,requested);
   const inside=(base,p)=>{const rel=path.relative(base,p);return rel!==''&&!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel);};
   // Absolute paths may use a different alias for cwd (Windows short names or a
   // symlink). Check their canonical target below, rather than rejecting the alias.
   if(!path.isAbsolute(requested)&&!inside(base,target))return error('Không được mở tệp ngoài thư mục của phiên.');
   const real=await fs.promises.realpath(target);
   if(!inside(root,real))return error('Không được mở tệp ngoài thư mục của phiên.');
   if(!/\.(md|markdown|html?|txt|log|json|jsonl|ya?ml|csv|tsv|xml|css|js|mjs|cjs|ts|tsx|jsx|sh|bash|zsh|py|rb|go|rs|c|h|cpp|cs|razor|sql|toml|ini|conf|config|properties|svg|png|jpe?g|gif|webp)$/i.test(real)&&!/(^|[/\\])(README|LICENSE|Makefile|Dockerfile|\.gitignore)$/i.test(real))return error('Chỉ hỗ trợ tệp văn bản.');
   const handle=await fs.promises.open(real,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0)|(fs.constants.O_NONBLOCK||0));
   try{
    const stat=await handle.stat();if(!stat.isFile())return error('Chỉ hỗ trợ tệp văn bản thông thường.');
    if(stat.size>LIMIT)return error('Tệp quá lớn (tối đa 5 MB).');
    const buffer=Buffer.alloc(Math.min(stat.size+1,LIMIT+1));let size=0;
    while(size<buffer.length){const r=await handle.read(buffer,size,buffer.length-size,size);if(!r.bytesRead)break;size+=r.bytesRead;}
    if(size>LIMIT||size>stat.size)return error('Tệp quá lớn hoặc đang thay đổi. Hãy thử lại.');
    const data=buffer.subarray(0,size);
    // Images are accepted by their real signature, never by extension alone. SVG stays text: it can carry script.
    const sig=(()=>{const at=(i,...b)=>b.every((v,k)=>data[i+k]===v);
     if(at(0,0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a))return 'image/png';if(at(0,0xff,0xd8,0xff))return 'image/jpeg';if(at(0,0x47,0x49,0x46,0x38))return 'image/gif';
     if(at(0,0x52,0x49,0x46,0x46)&&at(8,0x57,0x45,0x42,0x50))return 'image/webp';return '';})();
    if(sig&&/\.(png|jpe?g|gif|webp)$/i.test(real))return {path:real,kind:'image',mime:sig,base64:data.toString('base64'),size};
    if(data.some(byte=>byte<9 || byte>10 && byte<13 || byte>13 && byte<32 || byte===127))return error('Không hỗ trợ tệp nhị phân.');
    let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(data);}catch{return error('Không hỗ trợ tệp nhị phân hoặc văn bản không phải UTF-8.');}
    return {path:real,text,kind:/\.md$|\.markdown$/i.test(real)?'markdown':/\.html?$/i.test(real)?'html':'text'};
   }finally{await handle.close();}
  }catch(e){
   // A bare name printed by an AI ("12-MASTER-PLAN-MVP.md") usually lives in a sub-folder of the session's folder: offer the
   // files with that name instead of a dead end. Bounded in depth, count and time; never follows symlinks.
   // The caller looks the name up in its own index first; it asks for the slow search only when that misses.
   if(noSearch&&e&&e.code==='ENOENT')return {error:'Không tìm thấy tệp hoặc không có quyền đọc.',notFound:true};
   if(e&&e.code==='ENOENT'&&!path.isAbsolute(requested)){
    try{
     const base=path.resolve(cwd),name=path.basename(requested),tail=requested.replace(/^\.\//,'').split('\\').join('/');
     // A big workspace (dozens of repos) is too wide for the walk below to reach a file buried a few folders down, so ask find first:
     // it prunes the heavy folders, never follows symlinks and answers in well under a second. Where find is missing, the walk takes over.
     const viaFind=await new Promise(resolve=>{
      let cp;try{cp=require('child_process');}catch{return resolve(null);}
      const glob=tail.replace(/[\\*?\[\]]/g,m=>'\\'+m),heavy=['node_modules','.git','obj','bin','dist','target','.next','__pycache__','.venv','venv','_archive'];
      const args=[base,'-maxdepth','12','(',...heavy.flatMap((n,i)=>i?['-o','-name',n]:['-name',n]),')','-prune','-o','-type','f','-path','*/'+glob,'-print'];
      if(process.platform==='win32')return resolve(null);   // find.exe there is a text-search tool, not the file finder
      try{cp.execFile('find',args,{timeout:8000,maxBuffer:1<<20},(err,out)=>{
       if(err&&!out)return resolve(null);
       resolve(String(out).split('\n').filter(f=>f.startsWith(base+path.sep)).slice(0,40).map(f=>path.relative(base,f).split(path.sep).join('/')));
      });}catch{resolve(null);}
     });
     if(viaFind){
      const dated=await Promise.all(viaFind.map(async rel=>({rel,at:(await fs.promises.stat(path.join(base,...rel.split('/'))).catch(()=>null))?.mtimeMs||0})));
      const found=dated.sort((x,y)=>y.at-x.at).slice(0,12).map(x=>x.rel);
      if(found.length)return {error:'Không thấy tệp ở thư mục của phiên, nhưng có '+found.length+' tệp trùng tên.',candidates:found};
      return error('Không tìm thấy tệp hoặc không có quyền đọc.');
     }
     const skip=new Set(['node_modules','.git','bin','obj','dist','target','.next','__pycache__','.venv','venv','_archive']);
     const found=[],queue=[[base,0]],stop=Date.now()+2500;let visited=0;
     while(queue.length&&found.length<12&&visited<8000&&Date.now()<stop){
      const [dir,depth]=queue.shift();let entries;try{entries=await fs.promises.readdir(dir,{withFileTypes:true});}catch{continue;}
      for(const entry of entries){
       visited++;
       if(entry.isSymbolicLink())continue;
       if(entry.isDirectory()){if(depth<8&&!skip.has(entry.name))queue.push([path.join(dir,entry.name),depth+1]);}
       else if(entry.name===name){const rel=path.relative(base,path.join(dir,entry.name)).split(path.sep).join('/');if(rel.endsWith(tail.split('\\').join('/')))found.push(rel);}
      }
     }
     // The file an AI just wrote is the one being asked about: newest first.
     const dated=await Promise.all(found.map(async rel=>({rel,at:(await fs.promises.stat(path.join(base,...rel.split('/'))).catch(()=>null))?.mtimeMs||0})));
     found.splice(0,found.length,...dated.sort((x,y)=>y.at-x.at).map(x=>x.rel));
     if(found.length)return {error:'Không thấy tệp ở thư mục của phiên, nhưng có '+found.length+' tệp trùng tên.',candidates:found};
    }catch{/* fall through to the plain message */}
   }
   return error('Không tìm thấy tệp hoặc không có quyền đọc.');
  }
 };
}
// Reads one whole file (any type, up to `max` bytes) from below the session's folder and returns it as base64: the source half of
// "take a file from another server". Same containment as the viewer: the real path must stay inside the folder, regular files only.
function transferReadRuntime(){
 const fs=require('fs'),path=require('path');
 return async function read({cwd,path:requested,max}){
  const code=c=>({code:c});
  if(typeof cwd!=='string'||typeof requested!=='string'||!requested||requested.length>4096||/[\x00-\x1f\x7f]/.test(requested))return code('invalid');
  try{
   const base=path.resolve(cwd),root=await fs.promises.realpath(base);
   const real=await fs.promises.realpath(path.resolve(base,requested));
   const rel=path.relative(root,real);
   if(rel===''||rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))return code('outside');
   const handle=await fs.promises.open(real,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0)|(fs.constants.O_NONBLOCK||0));
   try{
    const stat=await handle.stat();if(!stat.isFile())return code('notfile');
    if(stat.size>max)return code('toolarge');
    const buffer=Buffer.alloc(stat.size);let got=0;
    while(got<buffer.length){const r=await handle.read(buffer,got,buffer.length-got,got);if(!r.bytesRead)break;got+=r.bytesRead;}
    return {name:path.basename(real),size:got,b64:buffer.subarray(0,got).toString('base64')};
   }finally{await handle.close();}
  }catch(e){return code(e&&e.code==='ENOENT'?'notfound':'failed');}
 };
}
async function sessionCwd(backend,name){
 const session=backend?.snapshot?.sessions?.find(s=>s.name===name);
 if(!backend?.ready||!session)throw Error(tr('srv.file.khong_thay_phien'));
 let cwd=session.path;
 if(backend.mode!=='powershell'){
  const result=await backend.exec('tmux display-message -p -t '+shq('='+name+':')+' '+shq('#{pane_current_path}'));
  if(result.code!==0||!result.out.trim())throw Error(tr('srv.file.khong_doc_thu_muc_phien'));
  cwd=result.out.trimEnd();
 }
 return cwd;
}
// Node.js on a POSIX host: PATH first, then per-user installs that need no sudo. A non-login SSH command reads neither
// ~/.profile nor the nvm lines of ~/.bashrc (and on macOS not /opt/homebrew/bin), so a Node unpacked into ~/.local/node (or nvm/volta/fnm) is found here.
const NODE_FIND='N=$(command -v node 2>/dev/null);[ -n "$N" ]||for c in /usr/local/bin/node /opt/homebrew/bin/node "$HOME/.local/node/bin/node" "$HOME/.local/bin/node" "$HOME/.volta/bin/node" "$HOME"/.nvm/versions/node/*/bin/node "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node "$HOME"/.fnm/node-versions/*/installation/bin/node;do [ -x "$c" ]&&N=$c;done;[ -n "$N" ]||exit 127;exec "$N" "$@"';
// The command that starts Node on that host, followed by its own arguments (" -e <code>").
function hostNode(backend){return backend&&backend.cfg&&backend.cfg.local&&backend.mode!=='wsl'?shq(process.execPath):'sh -c '+shq(NODE_FIND)+' node';}
// Runs a self-contained runtime (see fileRuntime) on the session's own host, locally or over SSH.
async function runOnHost(backend,runtime,config,limits){
 if(backend.cfg.local&&backend.mode!=='wsl')return runtime()(config);
 const code=`(${runtime.toString()})()(${JSON.stringify(config)}).then(v=>process.stdout.write(JSON.stringify(v))).catch(()=>process.exit(1));`;
 const node=hostNode(backend);
 const result=await backend.exec(node+' -e '+shq(code),(limits&&limits.timeout)||15000,(limits&&limits.maxBuffer)||32*1024*1024,null,true);
 if(result.code!==0){
  // 127 / "not found": there is no node on that machine (sh could not run it). Anything else is a read problem.
  const missing=result.code===127||/node.*(not found|no such file)|command not found|is not recognized/i.test(String(result.err||''));
  throw new HostError(missing?'no-node':'host',tr(missing?'srv.file.can_node':'srv.file.khong_doc_duoc_tep'));
 }
 try{return JSON.parse(result.out);}catch{throw new HostError('host',tr('srv.file.khong_doc_day_du'));}
}
// The reader runs on the host and answers in Vietnamese; the page gets the same message in the language it chose.
const FILE_MESSAGES={'Đường dẫn tệp không hợp lệ.':'srv.file.duong_dan_khong_hop_le','Không được mở tệp ngoài thư mục của phiên.':'srv.file.ngoai_thu_muc','Chỉ hỗ trợ tệp văn bản thông thường.':'srv.file.chi_van_ban','Chỉ hỗ trợ tệp văn bản.':'srv.file.chi_van_ban','Không hỗ trợ tệp nhị phân hoặc văn bản không phải UTF-8.':'srv.file.khong_utf8','Không hỗ trợ tệp nhị phân.':'srv.file.nhi_phan','Không tìm thấy tệp hoặc không có quyền đọc.':'srv.file.khong_thay','Tệp quá lớn (tối đa 5 MB).':'srv.file.qua_lon','Tệp quá lớn hoặc đang thay đổi. Hãy thử lại.':'srv.file.qua_lon_thay_doi'};
function localizeFileError(message){
 if(typeof message!=='string')return message;
 if(FILE_MESSAGES[message])return tr(FILE_MESSAGES[message]);
 const m=message.match(/^Không thấy tệp ở thư mục của phiên, nhưng có (\d+) tệp trùng tên\.$/);
 return m?tr('srv.file.trung_ten',[m[1]]):message;
}
// Extra fields for the error answer, so the page can show how to fix a missing Node.js for that machine's system.
function hostErrorExtra(error,backend){
 return error&&error.code==='no-node'?{code:'no-node',os:String(backend&&backend.snapshot&&backend.snapshot.sys&&backend.snapshot.sys.os||'')}:undefined;
}
// Bare names printed by an AI ("05-PLAN.md", "shot-1.png") used to trigger a full `find` of the session folder on every click: seconds on a
// large workspace. Instead each (machine, folder) keeps an index of its document files, built once on the host, reused for 10
// minutes and refreshed in the background. Only names missing from the index fall back to the live search.
const DOC=/\.(md|markdown|html?|txt|log|csv|tsv|png|jpe?g|gif|webp|svg|pdf)$/i, INDEX_TTL=10*60000, indexes=new Map(), hits=new Map();
function indexRuntime(){
 return async function list({base}){
  // Parallel readdir: several times faster than a single-threaded `find` on a large tree, and the same on every OS.
  const fs=require('fs'),path=require('path');
  const heavy=new Set(['node_modules','.git','obj','bin','dist','target','.next','__pycache__','.venv','venv','_archive','.dart_tool','Pods','.gradle','.cache','.pub-cache']);
  const doc=/\.(md|markdown|html?|txt|log|csv|tsv|png|jpe?g|gif|webp|svg|pdf)$/i,files=[],queue=[[base,0]],stop=Date.now()+25000;let active=0,complete=true;
  await new Promise(done=>{
   const pump=()=>{
    if(Date.now()>stop||files.length>=200000){complete=false;queue.length=0;}
    while(active<16&&queue.length){
     const [dir,depth]=queue.pop();active++;
     fs.promises.readdir(dir,{withFileTypes:true}).then(entries=>{
      for(const e of entries){
       if(e.isDirectory()){if(depth<12&&!heavy.has(e.name)&&!e.name.startsWith('_wt-'))queue.push([path.join(dir,e.name),depth+1]);}
       else if(e.isFile()&&doc.test(e.name))files.push(path.relative(base,path.join(dir,e.name)).split(path.sep).join('/'));
      }
     }).catch(()=>{}).finally(()=>{active--;if(!queue.length&&!active)done();else pump();});
    }
    if(!queue.length&&!active)done();
   };pump();
  });
  return {files,complete};
 };
}
function statRuntime(){
 return async function stat({base,files}){
  const fs=require('fs'),path=require('path');
  return {at:await Promise.all(files.map(async rel=>(await fs.promises.stat(path.join(base,...rel.split('/'))).catch(()=>null))?.mtimeMs||0))};
 };
}
function indexKey(backend,cwd){return String(backend&&backend.cfg&&backend.cfg.id)+'\0'+cwd;}
function buildIndex(backend,cwd){
 const key=indexKey(backend,cwd),entry=indexes.get(key)||{};
 if(entry.building)return entry.building;
 entry.building=runOnHost(backend,indexRuntime,{base:cwd},{timeout:35000,maxBuffer:64<<20})
  .then(v=>{if(Array.isArray(v&&v.files)){entry.files=v.files;entry.complete=v.complete!==false;entry.at=Date.now();}return entry.files||null;})
  .catch(()=>entry.files||null).finally(()=>{entry.building=null;});
 indexes.set(key,entry);
 if(indexes.size>64)indexes.delete(indexes.keys().next().value);
 return entry.building;
}
// Fresh: use it. Stale: use it now and refresh in the background. None yet: build it (about as long as one search used to take).
async function indexFor(backend,cwd){
 const entry=indexes.get(indexKey(backend,cwd));
 if(entry&&entry.files){if(Date.now()-entry.at>INDEX_TTL)buildIndex(backend,cwd);return entry.files;}
 return buildIndex(backend,cwd);
}
function prewarm(backend,name){
 if(!backend||!backend.ready||backend.mode==='powershell')return;
 sessionCwd(backend,name).then(cwd=>{const e=indexes.get(indexKey(backend,cwd));if(!e||!e.files||Date.now()-e.at>INDEX_TTL)buildIndex(backend,cwd);}).catch(()=>{});
}
function localized(value){if(value&&value.error)value.error=localizeFileError(value.error);return value;}
// Many files of one session folder in ONE host call (one SSH channel, one Node start) instead of one call each: the
// pictures of an HTML report. Same reader as a single file (fileRuntime), each path checked by it; a total size cap.
const MANY_SRC='function manyRuntime(){const one=('+fileRuntime.toString()+')();return async function many(a){const out=[];let total=0;for(const p of (Array.isArray(a.paths)?a.paths:[]).slice(0,80)){let v;try{v=await one({cwd:a.cwd,path:p,noSearch:true});}catch(e){v={error:"failed"};}const n=v&&(v.base64||v.text||"").length||0;if(total+n>a.max){out.push({error:"toolarge"});continue;}total+=n;out.push(v);}return out;};}';
const manyRuntime=new Function('require','return ('+MANY_SRC+')')(require);
manyRuntime.toString=()=>MANY_SRC;
async function readSessionFiles(backend,name,paths,max=12*1024*1024){
 const cwd=await sessionCwd(backend,name);
 const out=await runOnHost(backend,manyRuntime,{cwd,paths,max},{timeout:60000,maxBuffer:Math.ceil(max*1.5)+1048576});
 return Array.isArray(out)?out:[];
}
async function readSessionFile(backend,name,requested){
 const cwd=await sessionCwd(backend,name);
 const bare=typeof requested==='string'&&!/^([/\\]|[A-Za-z]:)/.test(requested)&&DOC.test(requested)&&backend.mode!=='powershell';
 if(!bare){
  const value=await runOnHost(backend,fileRuntime,{cwd,path:requested});
  // One match from the live search: open it now rather than making the page ask a second time.
  if(value&&Array.isArray(value.candidates)&&value.candidates.length===1){const one=await runOnHost(backend,fileRuntime,{cwd,path:value.candidates[0],noSearch:true});if(one&&!one.error)return one;}
  return localized(value);
 }
 const read=rel=>runOnHost(backend,fileRuntime,{cwd,path:rel,noSearch:true});
 let value=await read(requested);
 if(!value||!value.notFound)return localized(value);
 const tail=requested.replace(/^\.\//,'').split('\\').join('/'),hk=indexKey(backend,cwd)+'\0'+tail;
 if(hits.has(hk)){value=await read(hits.get(hk));if(value&&!value.error)return value;hits.delete(hk);}
 const files=await indexFor(backend,cwd);
 let matches=Array.isArray(files)?files.filter(f=>f===tail||f.endsWith('/'+tail)).slice(0,40):[];
 const entry=indexes.get(indexKey(backend,cwd));
 if(!matches.length&&entry&&entry.files&&Date.now()-entry.at>10000){
  // Possibly written after the index was built: rebuild once (about a second) and look again.
  const again=await buildIndex(backend,cwd);
  matches=Array.isArray(again)?again.filter(f=>f===tail||f.endsWith('/'+tail)).slice(0,40):[];
 }
 if(!matches.length){
  // No usable index (or a cut-short one): the original live search. A complete, fresh index that misses means: not there.
  if(Array.isArray(files)&&entry&&entry.complete)return localized({error:'Không tìm thấy tệp hoặc không có quyền đọc.'});
  value=await runOnHost(backend,fileRuntime,{cwd,path:requested});
  matches=value&&Array.isArray(value.candidates)?value.candidates:[];
  if(matches.length!==1)return localized(value);
 }
 if(matches.length===1){
  // One match: open it in this same request instead of making the page ask again.
  value=await read(matches[0]);
  if(value&&!value.error){hits.set(hk,matches[0]);if(hits.size>500)hits.delete(hits.keys().next().value);return value;}
  return localized(value);
 }
 // Several: newest first, as before (the file an AI just wrote is the one being asked about).
 let at=[];try{at=(await runOnHost(backend,statRuntime,{base:cwd,files:matches})).at||[];}catch{/* order as listed */}
 const found=matches.map((rel,i)=>({rel,at:at[i]||0})).sort((x,y)=>y.at-x.at).slice(0,12).map(x=>x.rel);
 return localized({error:'Không thấy tệp ở thư mục của phiên, nhưng có '+found.length+' tệp trùng tên.',candidates:found});
}
// A file "Send file" stored on a machine (its private temp folder): read with the same reader, the temp folder as its root.
async function readTempFile(backend,requested){
 if(typeof requested!=='string'||!/^[A-Za-z0-9._-]{1,120}$/.test(requested))return {error:localizeFileError('Đường dẫn tệp không hợp lệ.')};
 const listed=await runOnHost(backend,require('./features/browse').tempRuntime,{op:'list'});
 if(!listed||typeof listed.dir!=='string')throw new HostError('host',tr('srv.file.khong_doc_duoc_tep'));
 const value=await runOnHost(backend,fileRuntime,{cwd:listed.dir,path:requested});
 if(value&&value.error)value.error=localizeFileError(value.error);
 return value;
}
module.exports={readSessionFiles,manyRuntime,hostNode,NODE_FIND,fileRuntime,transferReadRuntime,readSessionFile,prewarm,indexRuntime,readTempFile,sessionCwd,runOnHost,HostError,hostErrorExtra,localizeFileError};
