'use strict';
const {shq}=require('./parse');
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
     const base=path.resolve(cwd),name=path.basename(requested),tail=requested.replace(/^\.\//,''),skip=new Set(['node_modules','.git','bin','obj','dist','target','.next','__pycache__','.venv','venv','_archive']);
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
 if(!backend?.ready||!session)throw Error('Không tìm thấy phiên hoặc máy chưa kết nối.');
 let cwd=session.path;
 if(backend.mode!=='powershell'){
  const result=await backend.exec('tmux display-message -p -t '+shq('='+name+':')+' '+shq('#{pane_current_path}'));
  if(result.code!==0||!result.out.trim())throw Error('Không đọc được thư mục hiện tại của phiên.');
  cwd=result.out.trimEnd();
 }
 return cwd;
}
// Runs a self-contained runtime (see fileRuntime) on the session's own host, locally or over SSH.
async function runOnHost(backend,runtime,config){
 if(backend.cfg.local&&backend.mode!=='wsl')return runtime()(config);
 const code=`(${runtime.toString()})()(${JSON.stringify(config)}).then(v=>process.stdout.write(JSON.stringify(v))).catch(()=>process.exit(1));`;
 const result=await backend.exec('node -e '+shq(code),15000,32*1024*1024);
 if(result.code!==0)throw Error('Không đọc được tệp trên máy này; cần Node.js và quyền đọc.');
 try{return JSON.parse(result.out);}catch{throw Error('Không đọc được đầy đủ nội dung tệp.');}
}
async function readSessionFile(backend,name,requested){
 return runOnHost(backend,fileRuntime,{cwd:await sessionCwd(backend,name),path:requested});
}
module.exports={fileRuntime,readSessionFile,sessionCwd,runOnHost};
