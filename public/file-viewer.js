'use strict';
(function(root,factory){if(typeof module==='object')module.exports=factory();else root.FileViewer=factory();})(typeof window==='object'?window:this,function(){
 let renderer;
 function markdown(text){
  if(!renderer){
   const MarkdownIt=typeof require==='function'?require('markdown-it'):self.markdownit;
   renderer=new MarkdownIt({html:false,linkify:true});
   const validate=renderer.validateLink;
   renderer.validateLink=url=>validate(url)&&!/^\s*(?:javascript|data):/i.test(url);
   renderer.renderer.rules.link_open=(tokens,i,options,env,render)=>{
    tokens[i].attrSet('target','_blank');tokens[i].attrSet('rel','noopener noreferrer');
    return render.renderToken(tokens,i,options);
   };
   renderer.renderer.rules.table_open=()=>'<div class="document-table" tabindex="0"><table>\n';
   renderer.renderer.rules.table_close=()=>'</table></div>\n';
   renderer.core.ruler.after('inline','task_lists',state=>{
    state.tokens.forEach((token,i)=>{
     if(token.type!=='inline'||state.tokens[i-1]?.type!=='paragraph_open'||state.tokens[i-2]?.type!=='list_item_open')return;
     const first=token.children?.[0],match=first?.type==='text'&&first.content.match(/^\[([ xX])\] /);
     if(!match)return;
     first.content=first.content.slice(4);
     const check=new state.Token('html_inline','',0);check.content=i18n('fileviewer.input_type_checkbox_disabled_ari', [(match[1]!==' '?' checked':'')]);
     token.children.unshift(check);
    });
   });
  }
  return renderer.render(text);
 }
 function detect(text){
  const found=[];
  const ext='md|markdown|html?|txt|log|jsonl?|ya?ml|csv|xml|css|[cm]?js|tsx?|jsx|sh|py|cs|razor|sql|toml|ini|conf|png|jpe?g|gif|webp';
  const re=new RegExp('(?:[A-Za-z]:[\\\\/]|\\/|\\.\\.?\\/)?[\\p{L}\\p{N}_.@~+\\-]+(?:[\\\\/][\\p{L}\\p{N}_.@~+\\-]+)*\\.(?:'+ext+')(?::\\d+(?::\\d+)?)?','giu');
  let m;while((m=re.exec(text))){const start=m.index;const prefix=text.slice(0,start);if(/(?:https?:\/\/|[\w]+:\/\/)[^\s]*$/.test(prefix)||/[\w/\\]/.test(text[start-1]||''))continue;
   const file=m[0].replace(/:\d+(?::\d+)?$/,'');found.push({path:file,start,end:start+file.length});
  }
  // Absolute paths may contain single spaces inside a name ("Screenshot 2026-11-04 at 21.20.47.png"): the pass above would
  // only keep the last word. Take the longest absolute path, with spaces, and let it replace the pieces it covers.
  const word='[\\p{L}\\p{N}_.@~+\\-()\\[\\]]+',name=word+'(?: '+word+')*';
  const spaced=new RegExp('(?:[A-Za-z]:[\\\\/]|~?\\/)(?:'+name+'[\\\\/])*'+name+'\\.(?:'+ext+')(?![\\p{L}\\p{N}_])','giu');
  while((m=spaced.exec(text))){const start=m.index;if(/[\w/\\]/.test(text[start-1]||''))continue;
   const file=m[0];if(!file.includes(' '))continue;
   // A word inside the name that is itself a file ("a.txt then check b.png") means two paths in a sentence, not one name.
   const words=file.split(' ');if(words.length>8||words.slice(0,-1).some(w=>new RegExp('\\.(?:'+ext+')$','i').test(w))||words.slice(1).some(w=>/^(?:\.{1,2}[\\/]|[\\/]|~[\\/]|[A-Za-z]:[\\/])/.test(w)))continue;
   for(let i=found.length-1;i>=0;i--)if(found[i].start>=start&&found[i].end<=start+file.length)found.splice(i,1);
   found.push({path:file,start,end:start+file.length});
  }
  return found.sort((x,y)=>x.start-y.start);
 }
 function provider(term,open){return {provideLinks:function(y,callback){
  const buffer=term.buffer.active;let first=y-1,last=first;
  while(first>0&&buffer.getLine(first)?.isWrapped)first--;
  while(last+1<buffer.length&&buffer.getLine(last+1)?.isWrapped)last++;
  if((last-first+1)*term.cols>16384){callback([]);return;}
  let text='',positions=[];
  for(let row=first;row<=last;row++){
   const line=buffer.getLine(row);if(!line)continue;
   if(line.getCell){for(let col=0;col<term.cols;col++){const cell=line.getCell(col);if(!cell||cell.getWidth()===0)continue;const chars=cell.getChars()||' ';for(let n=0;n<chars.length;n++)positions.push({x:col+1,y:row+1,end:col+cell.getWidth()});text+=chars;}}
   else{const value=line.translateToString(row===last);for(let col=0;col<value.length;col++)positions.push({x:col+1,y:row+1,end:col+1});text+=value;}
  }
  callback(detect(text).map(link=>{const start=positions[link.start],end=positions[link.end-1];return {text:link.path,range:{start:{x:start.x,y:start.y},end:{x:end.end,y:end.y}},activate:(event)=>{if(term.getSelection&&term.getSelection())return;event.preventDefault();open(link.path);}};}).filter(link=>link.range.start.y<=y&&link.range.end.y>=y));
 }};}
 function htmlFrame(doc,text){const frame=doc.createElement('iframe');frame.setAttribute('sandbox','allow-scripts');frame.setAttribute('referrerpolicy','no-referrer');frame.setAttribute('title',i18n('fileviewer.noi_dung_html'));frame.srcdoc=text;return frame;}
 function create(api){
  const doc=document,panel=doc.createElement('aside');panel.className='file-viewer';panel.hidden=true;panel.setAttribute('aria-label',i18n('fileviewer.xem_tep'));
  const handle=doc.createElement('div');handle.className='viewer-resize';handle.tabIndex=0;handle.setAttribute('role','separator');handle.setAttribute('aria-orientation','vertical');handle.setAttribute('aria-label',i18n('fileviewer.doi_chieu_rong_ban_xem'));
  let width=840;
  try{const saved=Number(localStorage.getItem('file-viewer-width'));if(saved>=320&&saved<=2400)width=saved;}catch{}
  const resize=value=>{width=Math.max(320,Math.min(innerWidth,value));panel.style.width=width+'px';handle.setAttribute('aria-valuenow',Math.round(width));};
  resize(width);
  const saveWidth=()=>{try{localStorage.setItem('file-viewer-width',String(width));}catch{}};
  handle.onpointerdown=e=>{handle.setPointerCapture(e.pointerId);};
  handle.onpointermove=e=>{if(handle.hasPointerCapture(e.pointerId))resize(innerWidth-e.clientX);};
  handle.onpointerup=e=>{handle.releasePointerCapture(e.pointerId);saveWidth();};
  handle.onkeydown=e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();resize(width+(e.key==='ArrowLeft'?40:-40));saveWidth();}};
  const head=doc.createElement('header'),title=doc.createElement('strong'),body=doc.createElement('div');body.className='file-content';
  const copy=doc.createElement('button'),download=doc.createElement('button'),close=doc.createElement('button'),reload=doc.createElement('button'),back=doc.createElement('button');
  [copy,download,close,reload,back].forEach(b=>{b.className='btn';b.type='button';});
  copy.textContent=i18n('fileviewer.sao_chep_duong_dan');download.textContent=i18n('fileviewer.tai_xuong');close.textContent=i18n('fileviewer.dong');reload.textContent=i18n('fileviewer.tai_lai');back.textContent=i18n('fileviewer.quay_lai');back.hidden=true;back.className='btn viewer-back';
  head.append(title,copy,download,close,reload,back);panel.append(handle,head,body);doc.body.append(panel);
  let generation=0,current=null,worker=null,location=null;
  const cancel=()=>{if(worker){worker.terminate();worker=null;}};
  close.onclick=()=>{generation++;cancel();panel.hidden=true;body.textContent='';current=null;};
  doc.addEventListener('keydown',e=>{if(e.key==='Escape'&&!panel.hidden){e.preventDefault();close.onclick();}});
  let outside=null,dismissal=0;
  const nativeUIOpen=()=>{
   if(doc.querySelector('dialog[open]'))return true;
   // Older browsers do not understand the popover pseudo-class.
   try{return !!doc.querySelector(':popover-open');}catch{return false;}
  };
  const resetOutside=()=>{outside=null;dismissal++;};
  // Capture observes xterm gestures even when its handlers stop propagation.
  // Never cancel events: terminal focus, selection and input must still work.
  doc.addEventListener('pointerdown',e=>{
   resetOutside();
   if(panel.hidden||e.button!==0||e.isPrimary===false||panel.contains(e.target)||e.target.closest('select,option')||nativeUIOpen())return;
   outside={id:e.pointerId,target:e.target,x:e.clientX,y:e.clientY,generation};
  },true);
  const moved=e=>Math.hypot(e.clientX-outside.x,e.clientY-outside.y)>5;
  doc.addEventListener('pointermove',e=>{if(outside&&e.pointerId===outside.id&&moved(e))resetOutside();},true);
  doc.addEventListener('pointerup',e=>{
   const start=outside;
   if(!start||e.pointerId!==start.id)return;
   const valid=e.button===0&&e.target===start.target&&!moved(e)&&!nativeUIOpen();
   resetOutside();
   if(!valid)return;
   const ticket=dismissal;
   // xterm activates file links on mouseup, after pointerup. Let it (and
   // click handlers opening dialogs/menus) finish before deciding to close.
   setTimeout(()=>{
    if(ticket===dismissal&&generation===start.generation&&!panel.hidden&&!nativeUIOpen())close.onclick();
   },0);
  },true);
  doc.addEventListener('pointercancel',resetOutside,true);
  doc.addEventListener('contextmenu',resetOutside,true);
  window.addEventListener('blur',resetOutside);
  copy.onclick=async()=>{if(current)try{await (window.TW_DESKTOP ? window.TW_DESKTOP.copy(current.path) : navigator.clipboard.writeText(current.path));}catch{const note=doc.createElement('p');note.textContent=i18n('fileviewer.khong_sao_chep_duoc_duong', [current.path]);body.prepend(note);}};
  download.onclick=()=>{if(!current)return;
    if(current.kind==='image'){const name=current.path.split(/[\\/]/).pop(),bytes=Uint8Array.from(atob(current.base64),c=>c.charCodeAt(0));
     if(doc.defaultView&&doc.defaultView.TW_DESKTOP&&doc.defaultView.TW_DESKTOP.saveBytes){Promise.resolve(doc.defaultView.TW_DESKTOP.saveBytes(name,bytes)).catch(()=>{});return;}
     const url=URL.createObjectURL(new Blob([bytes],{type:current.mime})),a=doc.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return;}
    // The desktop webview cannot fetch a blob: URL (connect-src 'self'), so hand the text straight to the native save dialog.
    if(doc.defaultView&&doc.defaultView.TW_DESKTOP){const label=download.textContent,name=current.path.split(/[\\/]/).pop();
      Promise.resolve(doc.defaultView.TW_DESKTOP.save(name,current.text)).then(()=>{download.textContent=label;},()=>{download.textContent=i18n('fileviewer.khong_luu_duoc');setTimeout(()=>{download.textContent=label;},3000);});return;}
    const url=URL.createObjectURL(new Blob([current.text],{type:'text/plain;charset=utf-8'})),a=doc.createElement('a');a.href=url;a.download=current.path.split(/[\\/]/).pop();a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  const setTitle=path=>{title.textContent=path.length>80?'…/'+path.split(/[\\/]/).slice(-2).join('/'):path;title.title=path;};
  let gallery=null,browserState=null,backState=null;
  async function open(host,session,path,opts){
   if(!(opts&&opts.keepGallery))gallery=null;
   // Opened from the file browser (or its search): remember where to come back to. Opened any other way: nothing to go back to.
   if(opts&&opts.fromBrowser&&browserState)backState=Object.assign({},browserState);else if(!(opts&&(opts.keepGallery||opts.auto)))backState=null;
   back.hidden=!backState;
   const request=++generation;cancel();location=[host,session,path];current=null;panel.hidden=false;setTitle(path);body.textContent=i18n('fileviewer.dang_doc_tep');copy.disabled=download.disabled=reload.disabled=true;
   try{
    const query='server='+encodeURIComponent(host)+'&session='+encodeURIComponent(session)+'&path='+encodeURIComponent(path);
    const file=await api('GET','/api/file?'+query);if(request!==generation)return;
    // One file with that name below the session folder: it is the one meant (the path shown was relative to another folder), open it.
    if(file.candidates&&file.candidates.length===1&&!(opts&&opts.auto)){return open(host,session,file.candidates[0],Object.assign({},opts,{auto:true}));}
    if(file.candidates&&file.candidates.length){showCandidates(file,host,session,path);return;}
    if(file.error)throw Error(file.error);current=file;setTitle(file.path);body.textContent='';copy.disabled=download.disabled=reload.disabled=false;
    if(file.kind==='image'){showImage(file,host,session);return;}
    if(file.kind==='html'){
     const note=doc.createElement('p');note.className='viewer-note';note.textContent=i18n('fileviewer.ban_html_chay_trong_khung');body.append(note);
     const frame=htmlFrame(doc,'');frame.removeAttribute('srcdoc');frame.src='/api/file-preview?'+query;body.append(frame);
    }else if(file.kind==='markdown'){
     const content=doc.createElement('article');content.className='document';body.append(content);
     worker=new Worker('/markdown-worker.js');
     worker.onmessage=async e=>{
      const chunks=e.data.chunks;
      for(const chunk of chunks){
       if(request!==generation)return;
       const section=doc.createElement('section');section.className='document-chunk';section.innerHTML=chunk;content.append(section);
       await new Promise(resolve=>requestAnimationFrame(resolve));
      }
      if(request===generation)cancel();
     };
     worker.onerror=()=>{if(request===generation){body.textContent=i18n('fileviewer.khong_dung_duoc_markdown_hay');cancel();}};
     worker.postMessage(file.text);
    }else{
     const content=doc.createElement('pre'),preview=file.text.slice(0,200000).split('\n').slice(0,2000).join('\n');
     if(preview.length<file.text.length){const note=doc.createElement('p');note.textContent=i18n('fileviewer.ban_xem_truoc_van_ban');body.append(note);}
     content.textContent=preview;body.append(content);
    }
   }catch(e){if(request===generation){body.textContent=e.message;reload.disabled=false;pathForm(host,session);}}
  }
  // Not found in the session's folder: list same-named files found below it and let the path be edited.
  // No typed paths: a button opens a browser over the session's own folder (the only place the viewer can read from).
  function pathForm(host,session){
   const row=doc.createElement('div');row.className='viewer-path';
   const go=doc.createElement('button');go.type='button';go.className='btn primary';go.textContent=i18n('fileviewer.chon_tep_khac');go.onclick=()=>showBrowser(host,session,'');
   row.append(go);body.append(row);
  }
  function size(n){return n>=1048576?(n/1048576).toFixed(1)+' MB':n>=1024?Math.round(n/1024)+' KB':n+' B';}
  async function showBrowser(host,session,dir,query){
   browserState={host,session,dir:dir||'',query:query||''};back.hidden=true;backState=null;
   body.textContent='';const note=doc.createElement('p');note.className='viewer-note';note.textContent=i18n('fileviewer.dang_doc_thu_muc');body.append(note);
   try{
    const q='server='+encodeURIComponent(host)+'&session='+encodeURIComponent(session)+(dir?'&path='+encodeURIComponent(dir):'');
    const out=await api('GET','/api/features/browse/list?'+q);
    body.textContent='';
    // Search by name across the whole session folder: results replace the listing while there is text in the box.
    const find=doc.createElement('input');find.type='search';find.className='viewer-find';find.placeholder=i18n('fileviewer.tim_ten');find.setAttribute('aria-label',i18n('fileviewer.tim_ten'));find.autocomplete='off';body.append(find);
    const head=doc.createElement('p');head.className='viewer-note';head.textContent=i18n('fileviewer.chon_tep_de_mo_thu', [(out.rel?'/'+out.rel:'')]);body.append(head);
    const list=doc.createElement('div');list.className='viewer-browser';
    const sep=out.path.includes('\\')?'\\':'/',item=(icon,text,extra,fn)=>{const b=doc.createElement('button');b.type='button';b.className='btn viewer-entry';const t=doc.createElement('span');t.className='viewer-entry-name';t.textContent=icon+' '+text;b.append(t);if(extra){const e=doc.createElement('small');e.textContent=extra;b.append(e);}b.onclick=fn;list.append(b);};
    if(out.parent!==null)item('⬆',i18n('fileviewer.len_mot_cap'),'',()=>showBrowser(host,session,out.parent));
    out.dirs.forEach(name=>item('📁',name,'',()=>showBrowser(host,session,out.path+sep+name)));
    out.files.forEach(f=>item('📄',f.name,size(f.size),()=>open(host,session,out.path+sep+f.name,{fromBrowser:true})));
    if(!out.dirs.length&&!out.files.length){const empty=doc.createElement('p');empty.className='viewer-note';empty.textContent=i18n('fileviewer.thu_muc_nay_khong_co');list.append(empty);}
    if(out.truncated){const more=doc.createElement('p');more.className='viewer-note';more.textContent=i18n('fileviewer.chi_hien_thi_500_muc');list.append(more);}
    body.append(list);
    const results=doc.createElement('div');results.className='viewer-browser';results.hidden=true;body.append(results);
    let timer=null,seq=0;
    find.oninput=()=>{
     clearTimeout(timer);const text=find.value.trim();browserState.query=find.value;
     if(text.length<2){seq++;results.hidden=true;list.hidden=false;head.hidden=false;return;}
     timer=setTimeout(async()=>{
      const mine=++seq;results.hidden=false;list.hidden=true;head.hidden=true;results.textContent='';
      const wait=doc.createElement('p');wait.className='viewer-note';wait.textContent=i18n('fileviewer.dang_tim');results.append(wait);
      try{
       const r=await api('GET','/api/features/browse/search?server='+encodeURIComponent(host)+'&session='+encodeURIComponent(session)+'&q='+encodeURIComponent(text));
       if(mine!==seq)return;results.textContent='';
       r.files.forEach(f=>{const b=doc.createElement('button');b.type='button';b.className='btn viewer-entry';const t=doc.createElement('span');t.className='viewer-entry-name';t.textContent='📄 '+f.rel;t.title=f.rel;b.append(t);const e=doc.createElement('small');e.textContent=size(f.size);b.append(e);b.onclick=()=>open(host,session,r.root+sep+f.rel.split('/').join(sep),{fromBrowser:true});results.append(b);});
       if(!r.files.length){const n=doc.createElement('p');n.className='viewer-note';n.textContent=i18n('fileviewer.khong_khop');results.append(n);}
       if(r.more){const m=doc.createElement('p');m.className='viewer-note';m.textContent=i18n('fileviewer.chi_50_moi_nhat');results.append(m);}
      }catch(err){if(mine===seq){results.textContent='';const n=doc.createElement('p');n.className='viewer-note';n.textContent=err.message;results.append(n);}}
     },250);
    };
    if(query){find.value=query;find.oninput();}
    find.focus();
   }catch(e){body.textContent=e.message;pathForm(host,session);}
  }
  function showCandidates(file,host,session,path){
   body.textContent='';const note=doc.createElement('p');note.className='viewer-note';note.textContent=file.error;body.append(note);
   const list=doc.createElement('div');list.className='viewer-candidates';
   file.candidates.forEach(c=>{const b=doc.createElement('button');b.type='button';b.className='btn';b.textContent=c;b.title=c;b.onclick=()=>open(host,session,c);list.append(b);});
   body.append(list);pathForm(host,session);
  }
  function showImage(file,host,session){
   const bar=doc.createElement('div');bar.className='viewer-imgbar';
   const mk=(text,title,fn,dis)=>{const b=doc.createElement('button');b.className='btn';b.type='button';b.textContent=text;b.title=title;b.disabled=!!dis;b.onclick=fn;bar.append(b);return b;};
   const list=gallery&&gallery.list||[],index=list.indexOf(file.path)>=0?list.indexOf(file.path):list.findIndex(x=>file.path.endsWith(x.replace(/^\.?\//,'')));
   if(gallery&&gallery.back)mk(i18n('fileviewer.quay_lai_bao_cao'),i18n('fileviewer.mo_lai_bao_cao_html'),()=>open(...gallery.back));
   if(list.length>1){
    mk('◀',i18n('fileviewer.anh_truoc'),()=>open(host,session,list[(index+list.length-1)%list.length],{keepGallery:true}));
    const n=doc.createElement('span');n.className='viewer-imgcount';n.textContent=(index>=0?index+1:'?')+' / '+list.length;bar.append(n);
    mk('▶',i18n('fileviewer.anh_ke'),()=>open(host,session,list[(index+1)%list.length],{keepGallery:true}));
   }
   const img=doc.createElement('img');img.className='viewer-img fit';img.alt=file.path.split(/[\\/]/).pop();img.src='data:'+file.mime+';base64,'+file.base64;
   const info=doc.createElement('span');info.className='viewer-imgcount';
   img.onload=()=>{info.textContent=img.naturalWidth+' × '+img.naturalHeight+' · '+(file.size>1048576?(file.size/1048576).toFixed(1)+' MB':Math.ceil(file.size/1024)+' KB');};
   mk(i18n('fileviewer.kich_thuoc_that'),i18n('fileviewer.chuyen_giua_vua_khung_va'),()=>img.classList.toggle('fit'));bar.append(info);
   const stage=doc.createElement('div');stage.className='viewer-stage';stage.append(img);body.append(bar,stage);
   panel.onkeydown=e=>{if(!list.length||e.target.closest&&e.target.closest('button,input,textarea'))return;if(e.key==='ArrowLeft'){e.preventDefault();bar.children[gallery&&gallery.back?1:0].click();}if(e.key==='ArrowRight'){e.preventDefault();bar.querySelectorAll('button')[(gallery&&gallery.back?1:0)+1]&&bar.querySelectorAll('button')[(gallery&&gallery.back?1:0)+1].click();}};
   panel.tabIndex=-1;
  }
  // Image paths clicked inside the sandboxed HTML report arrive here; only the viewer's own frame is trusted.
  window.addEventListener('message',e=>{
   const d=e.data,frame=body.querySelector('iframe');
   if(!d||d.tw!=='open-image'||!frame||e.source!==frame.contentWindow||typeof d.path!=='string'||d.path.length>4096||!Array.isArray(d.list)||!location)return;
   const list=d.list.filter(x=>typeof x==='string'&&x.length<=4096).slice(0,500);
   gallery={list,back:location.slice()};open(location[0],location[1],d.path,{keepGallery:true});
  });
  reload.onclick=()=>{if(location)open(...location);};
  back.onclick=()=>{if(!backState)return;const b=backState;generation++;cancel();location=[b.host,b.session,''];current=null;setTitle(i18n('fileviewer.thu_muc_cua_phien'));copy.disabled=download.disabled=reload.disabled=true;showBrowser(b.host,b.session,b.dir,b.query);};
  // Open the viewer straight on the session's folder, without needing a path link in the terminal (phones have no easy link tap).
 function browse(host,session){generation++;cancel();location=[host,session,''];current=null;panel.hidden=false;setTitle(i18n('fileviewer.thu_muc_cua_phien'));copy.disabled=download.disabled=reload.disabled=true;return showBrowser(host,session,'');}
 return {open,browse,close:()=>close.onclick()};
 }
 return {detect,provider,markdown,htmlFrame,create};
});
