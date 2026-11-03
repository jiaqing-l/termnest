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
     const check=new state.Token('html_inline','',0);check.content='<input type="checkbox" disabled'+(match[1]!==' '?' checked':'')+' aria-label="Trạng thái công việc"> ';
     token.children.unshift(check);
    });
   });
  }
  return renderer.render(text);
 }
 function detect(text){
  const found=[];
  const re=/(?:[A-Za-z]:[\\/]|\/|\.\.?\/)?[\p{L}\p{N}_.@~+\-]+(?:[\\/][\p{L}\p{N}_.@~+\-]+)*\.(?:md|markdown|html?|txt|log|jsonl?|ya?ml|csv|xml|css|[cm]?js|tsx?|jsx|sh|py|cs|razor|sql|toml|ini|conf)(?::\d+(?::\d+)?)?/giu;
  let m;while((m=re.exec(text))){const start=m.index;const prefix=text.slice(0,start);if(/(?:https?:\/\/|[\w]+:\/\/)[^\s]*$/.test(prefix)||/[\w/\\]/.test(text[start-1]||''))continue;
   const file=m[0].replace(/:\d+(?::\d+)?$/,'');found.push({path:file,start,end:start+file.length});
  }return found;
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
 function htmlFrame(doc,text){const frame=doc.createElement('iframe');frame.setAttribute('sandbox','allow-scripts');frame.setAttribute('referrerpolicy','no-referrer');frame.setAttribute('title','Nội dung HTML');frame.srcdoc=text;return frame;}
 function create(api){
  const doc=document,panel=doc.createElement('aside');panel.className='file-viewer';panel.hidden=true;panel.setAttribute('aria-label','Xem tệp');
  const handle=doc.createElement('div');handle.className='viewer-resize';handle.tabIndex=0;handle.setAttribute('role','separator');handle.setAttribute('aria-orientation','vertical');handle.setAttribute('aria-label','Đổi chiều rộng bản xem trước');
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
  const copy=doc.createElement('button'),download=doc.createElement('button'),close=doc.createElement('button'),reload=doc.createElement('button');
  [copy,download,close,reload].forEach(b=>{b.className='btn';b.type='button';});
  copy.textContent='Sao chép đường dẫn';download.textContent='Tải xuống';close.textContent='Đóng';reload.textContent='Tải lại';
  head.append(title,copy,download,close,reload);panel.append(handle,head,body);doc.body.append(panel);
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
  copy.onclick=async()=>{if(current)try{await (window.TW_DESKTOP ? window.TW_DESKTOP.copy(current.path) : navigator.clipboard.writeText(current.path));}catch{const note=doc.createElement('p');note.textContent='Không sao chép được. Đường dẫn đầy đủ: '+current.path;body.prepend(note);}};
  download.onclick=()=>{if(!current)return;
    // The desktop webview cannot fetch a blob: URL (connect-src 'self'), so hand the text straight to the native save dialog.
    if(doc.defaultView&&doc.defaultView.TW_DESKTOP){const label=download.textContent,name=current.path.split(/[\\/]/).pop();
      Promise.resolve(doc.defaultView.TW_DESKTOP.save(name,current.text)).then(()=>{download.textContent=label;},()=>{download.textContent='Không lưu được';setTimeout(()=>{download.textContent=label;},3000);});return;}
    const url=URL.createObjectURL(new Blob([current.text],{type:'text/plain;charset=utf-8'})),a=doc.createElement('a');a.href=url;a.download=current.path.split(/[\\/]/).pop();a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  const setTitle=path=>{title.textContent=path.length>80?'…/'+path.split(/[\\/]/).slice(-2).join('/'):path;title.title=path;};
  async function open(host,session,path){
   const request=++generation;cancel();location=[host,session,path];current=null;panel.hidden=false;setTitle(path);body.textContent='Đang đọc tệp…';copy.disabled=download.disabled=reload.disabled=true;
   try{
    const query='server='+encodeURIComponent(host)+'&session='+encodeURIComponent(session)+'&path='+encodeURIComponent(path);
    const file=await api('GET','/api/file?'+query);if(request!==generation)return;
    if(file.error)throw Error(file.error);current=file;setTitle(file.path);body.textContent='';copy.disabled=download.disabled=reload.disabled=false;
    if(file.kind==='html'){
     const note=doc.createElement('p');note.className='viewer-note';note.textContent='Bản HTML chạy trong khung cách ly. Ảnh, CSS và script ngoài tệp (kể cả đường dẫn tương đối) không được tải; CSS và script nội tuyến vẫn hoạt động.';body.append(note);
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
     worker.onerror=()=>{if(request===generation){body.textContent='Không dựng được Markdown. Hãy tải xuống hoặc tải lại.';cancel();}};
     worker.postMessage(file.text);
    }else{
     const content=doc.createElement('pre'),preview=file.text.slice(0,200000).split('\n').slice(0,2000).join('\n');
     if(preview.length<file.text.length){const note=doc.createElement('p');note.textContent='Bản xem trước văn bản tối đa 200.000 ký tự / 2.000 dòng. Tải xuống để xem toàn bộ tệp (tối đa 5 MB).';body.append(note);}
     content.textContent=preview;body.append(content);
    }
   }catch(e){if(request===generation){body.textContent=e.message;reload.disabled=false;}}
  }
  reload.onclick=()=>{if(location)open(...location);};
  return {open,close:()=>close.onclick()};
 }
 return {detect,provider,markdown,htmlFrame,create};
});
