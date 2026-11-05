'use strict';
const {shq}=require('./parse');
const {tr}=require('./i18n-server');
// An error that tells the caller what kind of failure it was ('no-node': the host has no Node.js), so the page can offer a fix.
class HostError extends Error{constructor(code,message){super(message);this.code=code;}}
// Self-contained to run on the selected SSH/WSL host, without transferring credentials.
function fileRuntime(){
 const fs=require('fs'),path=require('path');const LIMIT=5*1024*1024;
 return async function read({cwd,path:requested}){
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
// Runs a self-contained runtime (see fileRuntime) on the session's own host, locally or over SSH.
async function runOnHost(backend,runtime,config){
 if(backend.cfg.local&&backend.mode!=='wsl')return runtime()(config);
 const code=`(${runtime.toString()})()(${JSON.stringify(config)}).then(v=>process.stdout.write(JSON.stringify(v))).catch(()=>process.exit(1));`;
 const result=await backend.exec('node -e '+shq(code),15000,32*1024*1024);
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
async function readSessionFile(backend,name,requested){
 const value=await runOnHost(backend,fileRuntime,{cwd:await sessionCwd(backend,name),path:requested});
 if(value&&value.error)value.error=localizeFileError(value.error);
 return value;
}
module.exports={fileRuntime,readSessionFile,sessionCwd,runOnHost,HostError,hostErrorExtra,localizeFileError};
