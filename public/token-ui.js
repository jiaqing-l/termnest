'use strict';
// Usage views receive allowlisted data only; credentials never enter this module.
window.TokenUI = function (hooks) {
  const $ = id => document.getElementById(id);
  const node = (tag, cls, text) => { const n=document.createElement(tag);n.className=cls||'';if(text!=null)n.textContent=text;return n; };
  // The server (token modules) sends a few reasons in Vietnamese: show them in the chosen language.
  const REASONS={'Chưa có phiên':'tokenui.chua_co_phien','Chưa có dữ liệu tuần':'tokenui.chua_co_du_lieu_tuan','Chưa có dữ liệu':'tokenui.chua_co_du_lieu','Chưa có bản ghi usage':'tokenui.chua_co_ban_ghi_usage'};
  const reasonText=r=>REASONS[r]?i18n(REASONS[r]):r;
  const fmt = n => n == null ? i18n('tokenui.khong_doc_duoc') : new Intl.NumberFormat(i18n('lang.locale'),{notation:'compact',maximumFractionDigits:1}).format(n);
  let showAllSessions=false, rendered=null, completeView=false, ages=[];
  const ageText=at=>i18n('tokenui.du_lieu_da_luu_phut', [Math.max(0,Math.floor((Date.now()-at)/60000))]);
  const label=a=>a.nickname || (a.tool==='claude'?'Claude':'Codex')+(a.email?' · '+a.email.split('@')[0]:'');
  let accounts=[], hosts=[], filter='all', period='days', busy=false, last=0, generation=0, scanning=true, updatedAt=null, scanError=null, readError=i18n('tokenui.chua_co_nguon_du_lieu');
  const tab=node('button','',i18n('tokenui.title'));tab.id='tab-token';tab.setAttribute('aria-pressed','false');tab.onclick=()=>hooks.view('token');document.querySelector('.main-top .seg').append(tab);
  const section=node('section','view');section.id='v-token';const box=node('div','token-page');section.append(box);$('v-focus').after(section);
  const head=node('div','token-heading token-hero'),heroSub=node('p','token-hero-sub',i18n('tokenui.dang_doc')),heroCopy=node('div','token-hero-copy');
  heroCopy.append(node('h1','',i18n('tokenui.title')),heroSub);head.append(node('div','token-mascots','🦊🐰🐼'),heroCopy);
  const filters=node('div','seg');
  [['days',i18n('tokenui.theo_ngay')],['weeks',i18n('tokenui.theo_tuan')]].forEach(([key,label])=>{const b=node('button','',label);b.dataset.period=key;b.onclick=()=>{period=key;render();};filters.append(b);});
  const ai=node('select');ai.setAttribute('aria-label',i18n('tokenui.loc_ai'));[['all',i18n('tokenui.tat_ca_ai')],['claude','Claude'],['codex','Codex']].forEach(([key,label])=>{const o=node('option','',label);o.value=key;ai.append(o);});ai.onchange=()=>{filter=ai.value;render();usage.render();};
  const config=node('button','btn',i18n('tokenui.tai_khoan'));config.onclick=()=>editAccounts();   // not editAccounts itself: the click event would arrive as `selected` and the dialog would only offer a rename
  const refreshBtn=node('button','btn token-refresh');refreshBtn.type='button';refreshBtn.title=i18n('tokenui.doc_lai_log_va_bao');
  refreshBtn.append(node('span','token-spin'),node('span','token-refresh-ico','↻'),node('span','',i18n('tokenui.lam_moi')));
  async function refreshAll(){if(refreshBtn.classList.contains('busy'))return;refreshBtn.classList.add('busy');try{await Promise.all([poll(true),usage.reload(true)]);}finally{refreshBtn.classList.remove('busy');}}
  refreshBtn.onclick=refreshAll;head.append(filters,ai,config,refreshBtn);
  const note=node('p','token-note'), cards=node('div','token-accounts'), chart=node('section','token-panel'), sessions=node('section','token-panel');
  note.setAttribute('role','status');
  let usageAt=null;
  // Optional module: without it the page keeps the quota cards and the session list.
  const noUsage={root:node('div'),render(){},reload:async()=>{},ensure(){}};
  const usage=!window.UsageUI?noUsage:window.UsageUI({api:hooks.api,tool:()=>filter,scope:()=>hooks.scope(),
    view:v=>{chart.hidden=sessions.hidden=filters.hidden=v==='day';},
    loaded:at=>{usageAt=at;heroSub.textContent=at?i18n('tokenui.bao_cao_cap_nhat_luc', [new Date(at).toLocaleTimeString(i18n('lang.locale'),{hour:'2-digit',minute:'2-digit',hour12:false})]):i18n('tokenui.chua_co_bao_cao');},
    summary:()=>{}});
  box.append(head,note,cards,usage.root,chart,sessions,node('p','token-help',i18n('tokenui.nguong_do_ban_tu_dat')));
  const mini=node('button','token-mini',i18n('tokenui.token_ai_dang_doc'));mini.id='token-mini';mini.onclick=()=>hooks.view('token');document.querySelector('.top .right').before(mini);
  function remaining(at) { const minutes=Math.max(0,Math.ceil((at-Date.now())/60000));return minutes>=1440?i18n('tokenui.ngay_gio', [Math.floor(minutes/1440), Math.floor(minutes%1440/60)]):i18n('app.gio_phut', [Math.floor(minutes/60), minutes%60]); }
  function ring(label,w,reason) {
    const row=node('div','token-window'), dial=node('div','token-ring',w?Math.round(w.percent)+'%':'—');
    dial.style.setProperty('--percent',w?w.percent:0);dial.setAttribute('aria-label',label+': '+(w?w.percent+'%':reasonText(reason) || i18n('tokenui.chua_co_phien')));
    if(w&&w.percent>=90)dial.classList.add('token-hot');
    const text=node('div','token-reset');text.append(node('b','',label));
    if(w){text.append(node('span','',i18n('tokenui.dat_lai', [new Date(w.resetAt).toLocaleString(i18n('lang.locale'),{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'})])),node('small','',w.reset?i18n('tokenui.da_dat_lai'): i18n('tokenui.con', [remaining(w.resetAt)])));}
    else text.append(node('small','',reasonText(reason) || i18n('tokenui.chua_co_du_lieu')));
    row.append(dial,text);return row;
  }
  function render() {
    filters.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',b.dataset.period===period));
    const scoped=accounts.filter(a=>(filter==='all'||a.tool===filter)&&(hooks.scope()==='all'||(a.hostIds || [a.hostId]).includes(hooks.scope())));
    // A profile folder that exists but was never signed in or used (e.g. the default ~/.claude on a machine where another
    // profile is used) has nothing to show: list it on one line instead of a card that reads "could not read email".
    const emptyProfile=a=>!a.email&&!a.nickname&&!(a.today>0)&&!(a.sessions&&a.sessions.length);
    const rows=scoped.filter(a=>!emptyProfile(a)), empties=scoped.filter(emptyProfile);
    const visibleHosts=hosts.filter(h=>(hooks.scope()==='all'||h.hostId===hooks.scope())&&(!completeView||!accounts.length));
    const actions=accounts.filter(a=>!a.hasGoodQuota&&(a.limits.error||a.limits.reason));
    const visibleError=(!accounts.length||actions.length)?scanError:null;
    // Reserve the same status line while refreshing; only its text changes.
    if(scanning&&!accounts.length&&updatedAt==null){
      note.textContent=i18n('tokenui.dang_doc_log_ai_lan');note.className='token-note';
    }else if(completeView&&updatedAt!=null){
      note.textContent=i18n('tokenui.cap_nhat_luc', [new Date(updatedAt).toLocaleTimeString(i18n('lang.locale'),{hour:'2-digit',minute:'2-digit',hour12:false}), (scanning?i18n('tokenui.dang_cap_nhat'):'')]);
      note.className='token-note';note.title=scanError||'';
    }else{
      note.textContent=visibleError||(actions.length?i18n('tokenui.khong_doc_duoc_quota', [actions.map(a=>label(a)).join(', ')]):'');
      if(updatedAt!=null)note.textContent+=i18n('tokenui.cap_nhat_luc_2', [(note.textContent?' · ':''), new Date(updatedAt).toLocaleTimeString(i18n('lang.locale'),{hour:'2-digit',minute:'2-digit',hour12:false})]);
      note.className='token-note'+(visibleError||actions.length?' token-action':'');
    }
    const signature=JSON.stringify([accounts,visibleHosts,filter,period,hooks.scope(),!accounts.length&&scanning,!!scanError&&!accounts.length]);
    ages.forEach(({node,at})=>{const text=ageText(at);if(node.textContent!==text)node.textContent=text;});
    if(signature===rendered)return;
    rendered=signature;
    const scroll=section.scrollTop;
    cards.textContent='';ages=[];
    if(scanning && !accounts.length && updatedAt==null){
      note.textContent=i18n('tokenui.dang_doc_log_ai_lan');
      mini.textContent=i18n('tokenui.token_ai_dang_doc');mini.title=note.textContent;tab.title=note.textContent;
      hosts.filter(h=>h.state==='reading').forEach(h=>cards.append(node('p','token-help',i18n('tokenui.dang_doc_2', [h.hostName]))));
      chart.textContent='';sessions.textContent='';hooks.updated();return;
    }
    if(empties.length){const e=node('p','token-help token-empty-profiles',i18n('tokenui.ho_so_trong',[empties.length,empties.map(a=>(a.tool==='codex'?'Codex':'Claude')+' · '+a.hostName).join(', ')]));e.title=i18n('tokenui.ho_so_trong_goi_y');cards.append(e);}
    rows.forEach(a=>{
      const c=node('article','token-account'), h=node('div','token-account-head'), identity=node('div','token-identity');
      c.dataset.tool=a.tool;c.title=(a.sourceWarnings || []).join('\n');identity.append(node('b','', label(a)),node('span','token-email',a.email||i18n('tokenui.khong_doc_duoc_email')));const source=node('small','token-sources',(a.plan?i18n('tokenui.goi', [a.plan]):'')+a.hostName);source.title=a.hostName;identity.append(source);
      const mark=node('span','token-mark');if(window.PetArt)mark.innerHTML=window.PetArt.pet(a.tool==='claude'?'cat':'fox','run');h.append(mark);
      const rename=node('button','btn token-rename',i18n('tokenui.doi_ten'));rename.onclick=()=>editAccounts(a);h.append(identity,rename);
      const windows=node('div','token-windows');windows.append(ring(i18n('tokenui.phien_5_gio'),a.limits.session,a.limits.reasons?.session),ring(i18n('tokenui.tuan_nay'),a.limits.weekly,a.limits.reasons?.weekly));
      const line=node('div','token-today');line.append(node('span','',i18n('tokenui.hom_nay_token', [fmt(a.today), (a.threshold?i18n('tokenui.nguong', [fmt(a.threshold)]):'')])));
      const bar=node('div','token-meter'), fill=node('i');fill.style.width=a.threshold&&a.today!=null?Math.min(100,a.today/a.threshold*100)+'%':'0';bar.append(fill);if(a.threshold)line.append(bar);
      c.append(h,windows,line);
      if(a.stale){const at=a.observedAt||a.limits.observedAt||updatedAt,age=node('p','token-help',ageText(at));ages.push({node:age,at});c.append(age);}
      if(a.reason)c.append(node('p','token-help',reasonText(a.reason)));
      // Every card says when this refresh ran; the quota's own time is shown only when it is older, with the reason.
      // Claude's quota is asked at most once per 5 minutes, and Codex only records it while a session runs.
      const clock=t=>new Date(t).toLocaleTimeString(i18n('lang.locale'),{hour:'2-digit',minute:'2-digit',hour12:false});
      // One quiet line per card: when it was checked, with the technical notes (when quota was recorded and why) behind ⓘ.
      if(updatedAt!=null){
        const line=node('p','token-help token-checked',i18n('tokenui.da_kiem_tra_luc', [clock(updatedAt)]));
        if(a.limits.observedAt&&(updatedAt==null||updatedAt-a.limits.observedAt>120000)){
          const more=i18n('tokenui.quota_ghi_nhan_luc', [clock(a.limits.observedAt), (a.tool==='codex'?i18n('tokenui.codex_chi_ghi_quota_khi'):i18n('tokenui.quota_claude_chi_hoi_lai'))]);
          const info=node('button','token-info','ⓘ');info.type='button';info.title=more;info.setAttribute('aria-label',more);
          const tip=node('span','token-tip',more);tip.hidden=true;info.onclick=()=>{tip.hidden=!tip.hidden;};line.append(' ',info,tip);
        }
        c.append(line);
      }
      if(a.threshold&&a.today>=a.threshold){c.classList.add('token-hot');c.append(node('small','',i18n('tokenui.da_vuot_nguong_hom_nay')));}
      cards.append(c);
    });
    mini.textContent='';
    const readable=accounts.filter(a=>a.hasGoodQuota||a.today!=null||a.limits.session||a.limits.weekly);
    rows.filter(a=>readable.includes(a)).forEach(a=>{
      // A short chip: a dot coloured by how much is used, the account's short name and the percentage (full label on hover).
      const w=a.limits.session || a.limits.weekly,chip=node('span','token-mini-item'),pct=w?Math.round(w.percent):null;
      const short=(a.nickname||'').trim()||String(a.email||'').split('@')[0]||label(a);
      chip.dataset.level=pct==null?'none':pct>=95?'hot':pct>=80?'warm':'ok';chip.title=label(a);
      chip.append(node('i','token-dot'),node('b','',(a.tool==='codex'?'Codex · ':'')+short),node('span','',pct==null?'—':pct+'%'));mini.append(chip);
    });
    visibleHosts.forEach(h=>cards.append(node('div','token-host-unavailable',h.hostName+(h.state==='reading'?i18n('tokenui.dang_doc_3'):i18n('tokenui.chua_doc_duoc', [h.reason.replace(/^Không đọc được: /,'')])))));
    const reasons=accounts.map(a=>(a.tool==='claude'?'Claude':'Codex')+' · '+(a.email||a.hostName||'')+' · '+[a.reason,a.limits.reason,...(a.sourceWarnings || [])].filter(Boolean).join('; ')).join('\n')||readError;
    if(!readable.length)mini.textContent=i18n('tokenui.token_ai_khong_doc_duoc');
    mini.title=reasons;tab.title=reasons;
    drawChart(rows);drawSessions(rows);section.scrollTop=scroll;hooks.updated();
  }
  function drawChart(rows) {
    chart.textContent='';chart.append(node('h2','',i18n('tokenui.token_theo_thoi_gian')));
    const visibleDays=[...new Set(rows.flatMap(a=>a[period].map(d=>d.day)))].sort().slice(-7);
    const legend=node('div','token-legend');['claude','codex'].filter(k=>filter==='all'||filter===k).forEach(k=>{const n=node('span',k,(k==='claude'?'Claude':'Codex')+' '+fmt(rows.filter(a=>a.tool===k).reduce((n,a)=>n+a[period].filter(d=>visibleDays.includes(d.day)).reduce((m,d)=>m+d.total,0),0)));legend.append(n);});chart.append(legend);
    const days=visibleDays;
    if(!days.length){chart.append(node('p','',i18n('tokenui.khong_doc_duoc_chua_co')));return;}
    const groups=days.map(day=>({day,claude:rows.filter(a=>a.tool==='claude').reduce((n,a)=>n+(a[period].find(d=>d.day===day)?.total||0),0),codex:rows.filter(a=>a.tool==='codex').reduce((n,a)=>n+(a[period].find(d=>d.day===day)?.total||0),0)}));
    const max=Math.max(1,...groups.flatMap(d=>[d.claude,d.codex])), plot=node('div','token-chart');
    groups.forEach(d=>{const col=node('div','token-column');const stack=node('div','token-stack');
      ['claude','codex'].forEach(k=>{if(filter!=='all'&&filter!==k)return;const b=node('button','token-bar '+k);b.style.height=(d[k]/max*130)+'px';b.title=d.day+' · '+k+': '+new Intl.NumberFormat(i18n('lang.locale')).format(d[k])+' token';b.setAttribute('aria-label',b.title);b.onfocus=b.onmouseenter=()=>{hint.textContent=b.title;};stack.append(b);});
      col.append(stack,node('small','',d.day.slice(5)));plot.append(col);});
    const hint=node('p','token-chart-hint',i18n('tokenui.di_chuot_hoac_chon_cot'));hint.setAttribute('aria-live','polite');chart.append(plot,hint);
    if(rows.some(a=>a.reason))chart.append(node('small','',i18n('tokenui.bieu_do_gom_cac_dong')));
  }
  function drawSessions(rows) {
    sessions.textContent='';sessions.append(node('h2','',period==='days'?i18n('tokenui.phien_hom_nay'):i18n('tokenui.phien_tuan_nay')));
    const wrap=node('div','token-table-wrap'),table=node('table'),tr=node('tr');[i18n('tokenui.phien'),i18n('tokenui.cong_cu'),i18n('tokenui.may'),i18n('tokenui.tai_khoan'),'Token',i18n('tokenui.trang_thai')].forEach(label=>tr.append(node('th','',label)));const th=node('thead');th.append(tr);table.append(th);
    const body=node('tbody');const all=rows.flatMap(a=>a.sessions.map(s=>({a,s}))).sort((x,y)=>y.s[period==='days'?'today':'week']-x.s[period==='days'?'today':'week']);all.slice(0,showAllSessions?all.length:10).forEach(({a,s})=>{
      const r=node('tr');[s.name,a.tool,s.hostName || a.hostName,a.email||i18n('tokenui.khong_doc_duoc'),fmt(s[period==='days'?'today':'week']),({run:i18n('app.dang_chay'),wait:i18n('app.cho_ban'),idle:i18n('app.dang_nghi')})[s.state]||i18n('tokenui.da_dong')].forEach((t,i)=>{const cell=node('td','',t);if(i===0)cell.title=s.id;r.append(cell);});body.append(r);
    });table.append(body);wrap.append(table);sessions.append(wrap);if(all.length>10){const more=node('button','btn',showAllSessions?i18n('tokenui.thu_gon'):i18n('tokenui.xem_them'));more.onclick=()=>{showAllSessions=!showAllSessions;drawSessions(rows);};sessions.append(more);}if(!body.children.length)sessions.append(node('p','',i18n('tokenui.khong_doc_duoc_chua_co_2')));
  }
  async function poll(force) {
    if(busy||document.hidden||(!section.classList.contains('on') && !mini.getClientRects().length)||(!force&&Date.now()-last<(scanning?5000:30000)))return;
    const current=generation;busy=true;last=Date.now();
    try{const data=await hooks.api('GET','/api/tokens?zone='+encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone));if(current!==generation)return;accounts=(data.accounts||[]).slice().sort((a,b)=>a.tool.localeCompare(b.tool)||(a.email||'').localeCompare(b.email||'')||a.id.localeCompare(b.id));hosts=data.hosts||[];if(!data.scanning||data.refreshing)completeView=true;scanning=!!data.scanning;updatedAt=data.updatedAt;scanError=data.error||null;readError=data.error||i18n('tokenui.chua_co_nguon_du_lieu');render();}
    catch(e){if(current!==generation)return;scanning=false;scanError=e.message;readError=e.message;render();}
    finally{busy=false;}
  }
  // AI accounts: one summary line per account (AI · machine · folder · name) with Edit and Remove; only the row being edited
  // shows its fields. "Add account" sits in the header. Same data as before: each row reads back {id,hostId,tool,directory,nickname,threshold}.
  function editAccounts(selected) {
    if(selected&&typeof selected.id!=='string')selected=null;   // an event or anything that is not an account means "add", not "rename"
    const dlg=node('dialog','token-config'),form=node('form','f acc-form');
    const head=node('div','dlg-h acc-head'),title=node('h2','',selected?i18n('tokenui.doi_ten_tai_khoan'):i18n('tokenui.tai_khoan_ai'));head.append(title);
    const existing=(hooks.prefs().aiAccounts||[]).map(a=>({...a}));
    if(selected&&!existing.some(a=>a.id===selected.id)) existing.push({id:selected.id,hostId:selected.hostId,tool:selected.tool,directory:selected.directory || '~/.'+selected.tool,nickname:selected.nickname||'',threshold:selected.threshold});
    const list=node('div','acc-list');let configs=selected?existing.filter(a=>a.id===selected.id):existing;
    const empty=node('p','acc-empty',i18n('tokenui.chua_co_tai_khoan'));
    const hostName=id=>(hooks.servers().find(v=>v.id===id)||{}).name||id||'';
    const refreshEmpty=()=>{empty.hidden=!!list.children.length;};
    function add(a,open) {
      const row=node('div','acc');const values={};
      const sum=node('div','acc-sum'),badge=node('span','acc-tool'),text=node('div','acc-text'),main=node('b'),sub=node('small');text.append(main,sub);
      const edit=node('button','btn sm',i18n('tokenui.sua'));edit.type='button';
      const remove=node('button','btn sm danger',i18n('app.go'));remove.type='button';remove.onclick=()=>{row.remove();refreshEmpty();};
      sum.append(badge,text,edit,remove);
      const fields=node('div','acc-fields');
      const spec=[['tool','AI',[['claude','Claude'],['codex','Codex']]],['hostId',i18n('tokenui.may'),hooks.servers().map(v=>[v.id,v.name])],['directory',i18n('tokenui.thu_muc_cau_hinh')],['nickname',i18n('tokenui.ten_goi_nho')],['threshold',i18n('tokenui.nguong_token_ngay')]];
      spec.forEach(([key,label,options])=>{const l=node('label','acc-f accf-'+key),cap=node('span','',label),input=node(options?'select':'input');if(options)options.forEach(([value,txt])=>{const o=node('option','',txt);o.value=value;input.append(o);});input.value=a[key]??'';if(key==='threshold'){input.type='number';input.min='1';input.step='1';input.placeholder=i18n('tokenui.khong_gioi_han');}if(key==='nickname'){input.maxLength=40;input.placeholder=i18n('tokenui.vi_du_cong_viec');}if(key==='directory')input.placeholder='~/.claude-work';l.append(cap,input);fields.append(l);values[key]=input;});
      // Same folder browser as "Phiên mới", opened on the machine picked in this row; a path can still be typed.
      const known=(selected&&selected.dirs)||{},dirInput=values.directory,browse=node('button','btn',i18n('tokenui.chon'));browse.type='button';
      const wrap=node('div','dir-input');dirInput.parentNode.insertBefore(wrap,dirInput);wrap.append(dirInput,browse);
      browse.onclick=()=>hooks.browse(values.hostId.value,dirInput.value.startsWith('/')?dirInput.value:'',p=>{dirInput.value=p;paint();});
      // The same account can live in a different folder on each machine: switching machine shows that machine's folder.
      values.hostId.onchange=()=>{dirInput.value=known[values.hostId.value]||'';paint();};
      values.tool.onchange=()=>{if(!known[values.hostId.value])dirInput.value='';paint();};
      const paint=()=>{const tool=values.tool.value;badge.textContent=tool==='codex'?'Codex':'Claude';badge.className='acc-tool '+tool;
        main.textContent=values.nickname.value.trim()||(dirInput.value.trim()||'~/.'+tool);
        sub.textContent=[hostName(values.hostId.value),values.nickname.value.trim()?(dirInput.value.trim()||'~/.'+tool):'',values.threshold.value?i18n('tokenui.nguong_ngan',[values.threshold.value]):''].filter(Boolean).join(' · ');};
      ['input','change'].forEach(ev=>fields.addEventListener(ev,paint));
      const setOpen=on=>{row.classList.toggle('open',on);fields.hidden=!on;edit.textContent=on?i18n('tokenui.xong'):i18n('tokenui.sua');};
      edit.onclick=()=>setOpen(fields.hidden);
      row.append(sum,fields);paint();setOpen(!!open);
      row.read=()=>({id:a.id,...Object.fromEntries(Object.entries(values).map(([k,v])=>[k,k==='threshold'?(v.value?Number(v.value):null):v.value]))});
      list.append(row);refreshEmpty();
      if(open)setTimeout(()=>values.nickname.focus(),0);
    }
    if(!selected){const addButton=node('button','btn primary sm','+ '+i18n('tokenui.them_tai_khoan'));addButton.type='button';addButton.onclick=()=>{add({id:'ai_'+crypto.randomUUID(),hostId:hooks.servers()[0]?.id,tool:'claude',directory:'~/.claude',nickname:'',threshold:null},true);list.lastChild.scrollIntoView({block:'nearest'});};head.append(addButton);}
    const close=node('button','btn',i18n('fileviewer.dong'));close.type='button';close.onclick=()=>dlg.close();head.append(close);
    const body=node('div','acc-body');
    configs.forEach(a=>add(a,!!selected));body.append(list,empty,node('p','token-help',i18n('tokenui.doc_tren_may_da_chon')));
    const error=node('p','err'),actions=node('div','dlg-actions acc-actions'),cancel=node('button','btn',i18n('tokenui.huy')),save=node('button','btn primary',i18n('tokenui.luu'));cancel.type='button';cancel.onclick=()=>dlg.close();actions.append(error,cancel,save);
    form.append(head,body,actions);refreshEmpty();
    form.onsubmit=async e=>{e.preventDefault();save.disabled=true;try{const rows=[...list.children].map(r=>r.read());await hooks.save({aiAccounts:selected?existing.filter(a=>a.id!==selected.id).concat(rows):rows});dlg.close();await poll(true);}catch(e){error.textContent=e.message;}finally{save.disabled=false;}};
    dlg.append(form);document.body.append(dlg);dlg.onclose=()=>dlg.remove();dlg.showModal();
  }
  function session(host,name) {
    const rows=accounts.filter(a=>(a.hostIds || [a.hostId]).includes(host)).flatMap(a=>a.sessions.filter(s=>(s.hostId || a.hostId)===host&&s.tmuxName===name).map(s=>({a,s})));
    return rows.length?{total:rows.reduce((n,r)=>n+r.s.total,0),today:rows.reduce((n,r)=>n+r.s.today,0),email:rows.map(r=>r.a.email||i18n('tokenui.khong_doc_duoc_email')).join(', ')}:null;
  }
  return {poll,render:()=>{render();usage.render();},session,fmt,setView:v=>{section.classList.toggle('on',v==='token');tab.setAttribute('aria-pressed',v==='token');if(v==='token')usage.ensure();},clear:()=>{generation++;rendered=null;completeView=false;accounts=[];hosts=[];last=0;scanning=true;updatedAt=null;scanError=null;readError=i18n('tokenui.chua_co_nguon_du_lieu');render();}};
};
