'use strict';
// Usage views receive allowlisted data only; credentials never enter this module.
window.TokenUI = function (hooks) {
  const $ = id => document.getElementById(id);
  const node = (tag, cls, text) => { const n=document.createElement(tag);n.className=cls||'';if(text!=null)n.textContent=text;return n; };
  const fmt = n => n == null ? 'Không đọc được' : new Intl.NumberFormat('vi-VN',{notation:'compact',maximumFractionDigits:1}).format(n);
  let showAllSessions=false, rendered=null, completeView=false, ages=[];
  const ageText=at=>'Dữ liệu đã lưu · '+Math.max(0,Math.floor((Date.now()-at)/60000))+' phút trước';
  const label=a=>a.nickname || (a.tool==='claude'?'Claude':'Codex')+(a.email?' · '+a.email.split('@')[0]:'');
  let accounts=[], hosts=[], filter='all', period='days', busy=false, last=0, generation=0, scanning=true, updatedAt=null, scanError=null, readError='Chưa có nguồn dữ liệu từ máy.';
  const tab=node('button','','Token AI');tab.id='tab-token';tab.setAttribute('aria-pressed','false');tab.onclick=()=>hooks.view('token');document.querySelector('.main-top .seg').append(tab);
  const section=node('section','view');section.id='v-token';const box=node('div','token-page');section.append(box);$('v-focus').after(section);
  const head=node('div','token-heading');head.append(node('h1','','Token AI'));
  const filters=node('div','seg');
  [['days','Theo ngày'],['weeks','Theo tuần']].forEach(([key,label])=>{const b=node('button','',label);b.dataset.period=key;b.onclick=()=>{period=key;render();};filters.append(b);});
  const ai=node('select');ai.setAttribute('aria-label','Lọc AI');[['all','Tất cả AI'],['claude','Claude'],['codex','Codex']].forEach(([key,label])=>{const o=node('option','',label);o.value=key;ai.append(o);});ai.onchange=()=>{filter=ai.value;render();};
  const config=node('button','btn','Tài khoản');config.onclick=editAccounts;head.append(filters,ai,config);
  const note=node('p','token-note'), cards=node('div','token-accounts'), chart=node('section','token-panel'), sessions=node('section','token-panel');
  note.setAttribute('role','status');box.append(head,note,cards,chart,sessions,node('p','token-help','Ngưỡng do bạn tự đặt chỉ dùng để cảnh báo. Số token gồm đầu vào, đầu ra và cache theo log CLI.'));
  const mini=node('button','token-mini','Token AI · Đang đọc…');mini.id='token-mini';mini.onclick=()=>hooks.view('token');document.querySelector('.top .right').before(mini);
  function remaining(at) { const minutes=Math.max(0,Math.ceil((at-Date.now())/60000));return minutes>=1440?Math.floor(minutes/1440)+' ngày '+Math.floor(minutes%1440/60)+' giờ':Math.floor(minutes/60)+' giờ '+minutes%60+' phút'; }
  function ring(label,w,reason) {
    const row=node('div','token-window'), dial=node('div','token-ring',w?Math.round(w.percent)+'%':'—');
    dial.style.setProperty('--percent',w?w.percent:0);dial.setAttribute('aria-label',label+': '+(w?w.percent+'%':reason || 'Chưa có phiên'));
    if(w&&w.percent>=90)dial.classList.add('token-hot');
    const text=node('div','token-reset');text.append(node('b','',label));
    if(w){text.append(node('span','','Đặt lại: '+new Date(w.resetAt).toLocaleString('vi-VN',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'})),node('small','',w.reset?'Đã đặt lại': 'Còn '+remaining(w.resetAt)));}
    else text.append(node('small','',reason || 'Chưa có dữ liệu'));
    row.append(dial,text);return row;
  }
  function render() {
    filters.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',b.dataset.period===period));
    const rows=accounts.filter(a=>(filter==='all'||a.tool===filter)&&(hooks.scope()==='all'||(a.hostIds || [a.hostId]).includes(hooks.scope())));
    const visibleHosts=hosts.filter(h=>(hooks.scope()==='all'||h.hostId===hooks.scope())&&(!completeView||!accounts.length));
    const actions=accounts.filter(a=>!a.hasGoodQuota&&(a.limits.error||a.limits.reason));
    const visibleError=(!accounts.length||actions.length)?scanError:null;
    // Reserve the same status line while refreshing; only its text changes.
    if(scanning&&!accounts.length&&updatedAt==null){
      note.textContent='Đang đọc log AI lần đầu, có thể mất khoảng 1 phút…';note.className='token-note';
    }else if(completeView&&updatedAt!=null){
      note.textContent='Cập nhật lúc '+new Date(updatedAt).toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit',hour12:false})+(scanning?' · Đang cập nhật…':'');
      note.className='token-note';note.title=scanError||'';
    }else{
      note.textContent=visibleError||(actions.length?'Không đọc được quota: '+actions.map(a=>label(a)).join(', '):'');
      if(updatedAt!=null)note.textContent+=(note.textContent?' · ':'')+'Cập nhật lúc '+new Date(updatedAt).toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit',hour12:false});
      note.className='token-note'+(visibleError||actions.length?' token-action':'');
    }
    const signature=JSON.stringify([accounts,visibleHosts,filter,period,hooks.scope(),!accounts.length&&scanning,!!scanError&&!accounts.length]);
    ages.forEach(({node,at})=>{const text=ageText(at);if(node.textContent!==text)node.textContent=text;});
    if(signature===rendered)return;
    rendered=signature;
    const scroll=section.scrollTop;
    cards.textContent='';ages=[];
    if(scanning && !accounts.length && updatedAt==null){
      note.textContent='Đang đọc log AI lần đầu, có thể mất khoảng 1 phút…';
      mini.textContent='Token AI · Đang đọc…';mini.title=note.textContent;tab.title=note.textContent;
      hosts.filter(h=>h.state==='reading').forEach(h=>cards.append(node('p','token-help',h.hostName+': đang đọc…')));
      chart.textContent='';sessions.textContent='';hooks.updated();return;
    }
    rows.forEach(a=>{
      const c=node('article','token-account'), h=node('div','token-account-head'), identity=node('div','token-identity');
      c.dataset.tool=a.tool;c.title=(a.sourceWarnings || []).join('\n');identity.append(node('b','', label(a)),node('span','token-email',a.email||'Không đọc được email'));const source=node('small','token-sources',(a.plan?'Gói '+a.plan+' · ':'')+a.hostName);source.title=a.hostName;identity.append(source);
      const mark=node('span','token-mark');if(window.PetArt)mark.innerHTML=window.PetArt.pet(a.tool==='claude'?'cat':'fox','run');h.append(mark);
      const rename=node('button','btn token-rename','Đổi tên');rename.onclick=()=>editAccounts(a);h.append(identity,rename);
      const windows=node('div','token-windows');windows.append(ring('Phiên 5 giờ',a.limits.session,a.limits.reasons?.session),ring('Tuần này',a.limits.weekly,a.limits.reasons?.weekly));
      const line=node('div','token-today');line.append(node('span','','Hôm nay '+fmt(a.today)+' token'+(a.threshold?' · ngưỡng '+fmt(a.threshold):'')));
      const bar=node('div','token-meter'), fill=node('i');fill.style.width=a.threshold&&a.today!=null?Math.min(100,a.today/a.threshold*100)+'%':'0';bar.append(fill);if(a.threshold)line.append(bar);
      c.append(h,windows,line);
      if(a.stale){const at=a.observedAt||a.limits.observedAt||updatedAt,age=node('p','token-help',ageText(at));ages.push({node:age,at});c.append(age);}
      if(a.reason)c.append(node('p','token-help',a.reason));
      if(a.limits.observedAt)c.append(node('p','token-help','Cập nhật '+new Date(a.limits.observedAt).toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit',hour12:false})));
      if(a.threshold&&a.today>=a.threshold){c.classList.add('token-hot');c.append(node('small','','Đã vượt ngưỡng hôm nay do bạn đặt'));}
      cards.append(c);
    });
    mini.textContent='';
    const readable=accounts.filter(a=>a.hasGoodQuota||a.today!=null||a.limits.session||a.limits.weekly);
    rows.filter(a=>readable.includes(a)).forEach(a=>{
      const w=a.limits.session || a.limits.weekly,chip=node('span','token-mini-item');
      chip.textContent=(label(a))+' '+(w?Math.round(w.percent)+'%':'—');mini.append(chip);
    });
    visibleHosts.forEach(h=>cards.append(node('div','token-host-unavailable',h.hostName+(h.state==='reading'?': đang đọc…':': chưa đọc được · '+h.reason.replace(/^Không đọc được: /,'')))));
    const reasons=accounts.map(a=>(a.tool==='claude'?'Claude':'Codex')+' · '+(a.email||a.hostName||'')+' · '+[a.reason,a.limits.reason,...(a.sourceWarnings || [])].filter(Boolean).join('; ')).join('\n')||readError;
    if(!readable.length)mini.textContent='Token AI · Không đọc được';
    mini.title=reasons;tab.title=reasons;
    drawChart(rows);drawSessions(rows);section.scrollTop=scroll;hooks.updated();
  }
  function drawChart(rows) {
    chart.textContent='';chart.append(node('h2','','Token theo thời gian'));
    const visibleDays=[...new Set(rows.flatMap(a=>a[period].map(d=>d.day)))].sort().slice(-7);
    const legend=node('div','token-legend');['claude','codex'].filter(k=>filter==='all'||filter===k).forEach(k=>{const n=node('span',k,(k==='claude'?'Claude':'Codex')+' '+fmt(rows.filter(a=>a.tool===k).reduce((n,a)=>n+a[period].filter(d=>visibleDays.includes(d.day)).reduce((m,d)=>m+d.total,0),0)));legend.append(n);});chart.append(legend);
    const days=visibleDays;
    if(!days.length){chart.append(node('p','','Không đọc được: chưa có số liệu trong log.'));return;}
    const groups=days.map(day=>({day,claude:rows.filter(a=>a.tool==='claude').reduce((n,a)=>n+(a[period].find(d=>d.day===day)?.total||0),0),codex:rows.filter(a=>a.tool==='codex').reduce((n,a)=>n+(a[period].find(d=>d.day===day)?.total||0),0)}));
    const max=Math.max(1,...groups.flatMap(d=>[d.claude,d.codex])), plot=node('div','token-chart');
    groups.forEach(d=>{const col=node('div','token-column');const stack=node('div','token-stack');
      ['claude','codex'].forEach(k=>{if(filter!=='all'&&filter!==k)return;const b=node('button','token-bar '+k);b.style.height=(d[k]/max*130)+'px';b.title=d.day+' · '+k+': '+new Intl.NumberFormat('vi-VN').format(d[k])+' token';b.setAttribute('aria-label',b.title);b.onfocus=b.onmouseenter=()=>{hint.textContent=b.title;};stack.append(b);});
      col.append(stack,node('small','',d.day.slice(5)));plot.append(col);});
    const hint=node('p','token-chart-hint','Di chuột hoặc chọn cột để xem số token.');hint.setAttribute('aria-live','polite');chart.append(plot,hint);
    if(rows.some(a=>a.reason))chart.append(node('small','','Biểu đồ gồm các dòng log đã đọc được.'));
  }
  function drawSessions(rows) {
    sessions.textContent='';sessions.append(node('h2','',period==='days'?'Phiên hôm nay':'Phiên tuần này'));
    const wrap=node('div','token-table-wrap'),table=node('table'),tr=node('tr');['Phiên','Công cụ','Máy','Tài khoản','Token','Trạng thái'].forEach(label=>tr.append(node('th','',label)));const th=node('thead');th.append(tr);table.append(th);
    const body=node('tbody');const all=rows.flatMap(a=>a.sessions.map(s=>({a,s}))).sort((x,y)=>y.s[period==='days'?'today':'week']-x.s[period==='days'?'today':'week']);all.slice(0,showAllSessions?all.length:10).forEach(({a,s})=>{
      const r=node('tr');[s.name,a.tool,s.hostName || a.hostName,a.email||'Không đọc được',fmt(s[period==='days'?'today':'week']),({run:'Đang chạy',wait:'Chờ bạn',idle:'Đang nghỉ'})[s.state]||'Đã đóng'].forEach((t,i)=>{const cell=node('td','',t);if(i===0)cell.title=s.id;r.append(cell);});body.append(r);
    });table.append(body);wrap.append(table);sessions.append(wrap);if(all.length>10){const more=node('button','btn',showAllSessions?'Thu gọn':'Xem thêm');more.onclick=()=>{showAllSessions=!showAllSessions;drawSessions(rows);};sessions.append(more);}if(!body.children.length)sessions.append(node('p','','Không đọc được: chưa có phiên với usage hợp lệ.'));
  }
  async function poll(force) {
    if(busy||document.hidden||(!section.classList.contains('on') && !mini.getClientRects().length)||(!force&&Date.now()-last<(scanning?5000:30000)))return;
    const current=generation;busy=true;last=Date.now();
    try{const data=await hooks.api('GET','/api/tokens?zone='+encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone));if(current!==generation)return;accounts=(data.accounts||[]).slice().sort((a,b)=>a.tool.localeCompare(b.tool)||(a.email||'').localeCompare(b.email||'')||a.id.localeCompare(b.id));hosts=data.hosts||[];if(!data.scanning||data.refreshing)completeView=true;scanning=!!data.scanning;updatedAt=data.updatedAt;scanError=data.error||null;readError=data.error||'Chưa có nguồn dữ liệu từ máy.';render();}
    catch(e){if(current!==generation)return;scanning=false;scanError=e.message;readError=e.message;render();}
    finally{busy=false;}
  }
  function editAccounts(selected) {
    const dlg=node('dialog','token-config'),form=node('form','f');form.append(node('h2','',selected?'Đổi tên tài khoản':'Thư mục tài khoản AI'));
    const existing=(hooks.prefs().aiAccounts||[]).map(a=>({...a}));
    if(selected&&!existing.some(a=>a.id===selected.id)) existing.push({id:selected.id,hostId:selected.hostId,tool:selected.tool,directory:selected.directory || '~/.'+selected.tool,nickname:selected.nickname||'',threshold:selected.threshold});
    const list=node('div','token-config-list');let configs=selected?existing.filter(a=>a.id===selected.id):existing;
    function add(a) {
      const row=node('fieldset');const values={};
      const fields=[['hostId','Máy',hooks.servers().map(v=>[v.id,v.name])],['tool','AI',[['claude','Claude'],['codex','Codex']]],['directory','Thư mục cấu hình'],['nickname','Tên gợi nhớ'],['threshold','Ngưỡng token/ngày']];
      fields.forEach(([key,label,options])=>{const l=node('label','',label),input=node(options?'select':'input');if(options)options.forEach(([value,text])=>{const o=node('option','',text);o.value=value;input.append(o);});input.value=a[key]??'';if(key==='threshold'){input.type='number';input.min='1';input.step='1';}if(key==='nickname')input.maxLength=40;if(key==='directory')input.placeholder='~/.claude-work';l.append(input);row.append(l);values[key]=input;});
      const remove=node('button','btn','Gỡ');remove.type='button';remove.onclick=()=>row.remove();row.append(remove);row.read=()=>({id:a.id,...Object.fromEntries(Object.entries(values).map(([k,v])=>[k,k==='threshold'?(v.value?Number(v.value):null):v.value]))});list.append(row);
    }
    configs.forEach(add);form.append(list);
    if(!selected){const addButton=node('button','btn','Thêm thư mục');addButton.type='button';addButton.onclick=()=>add({id:'ai_'+crypto.randomUUID(),hostId:hooks.servers()[0]?.id,tool:'claude',directory:'~/.claude',nickname:'',threshold:null});form.append(addButton);}
    const error=node('p','err'),actions=node('div','dlg-actions'),cancel=node('button','btn','Hủy'),save=node('button','btn primary','Lưu');cancel.type='button';cancel.onclick=()=>dlg.close();actions.append(cancel,save);form.append(node('p','token-help','Đọc trên máy đã chọn. Không nhập token đăng nhập. Chưa khai báo thư mục thì dùng ~/.claude và ~/.codex.'),error,actions);dlg.append(form);document.body.append(dlg);dlg.onclose=()=>dlg.remove();
    form.onsubmit=async e=>{e.preventDefault();save.disabled=true;try{const rows=[...list.children].map(r=>r.read());await hooks.save({aiAccounts:selected?existing.filter(a=>a.id!==selected.id).concat(rows):rows});dlg.close();await poll(true);}catch(e){error.textContent=e.message;}finally{save.disabled=false;}};dlg.showModal();
  }
  function session(host,name) {
    const rows=accounts.filter(a=>(a.hostIds || [a.hostId]).includes(host)).flatMap(a=>a.sessions.filter(s=>(s.hostId || a.hostId)===host&&s.tmuxName===name).map(s=>({a,s})));
    return rows.length?{total:rows.reduce((n,r)=>n+r.s.total,0),today:rows.reduce((n,r)=>n+r.s.today,0),email:rows.map(r=>r.a.email||'Không đọc được email').join(', ')}:null;
  }
  return {poll,render,session,fmt,setView:v=>{section.classList.toggle('on',v==='token');tab.setAttribute('aria-pressed',v==='token');},clear:()=>{generation++;rendered=null;completeView=false;accounts=[];hosts=[];last=0;scanning=true;updatedAt=null;scanError=null;readError='Chưa có nguồn dữ liệu từ máy.';render();}};
};
