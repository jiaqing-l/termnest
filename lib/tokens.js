'use strict';
const {QuotaPool,goodQuota,accountKey}=require('./token-quota');
const quotaPool=new QuotaPool();
const { tokenRuntime } = require('./token-source');
const { shq, claudeSessionId } = require('./parse');
function cleanAccounts(value) {
  if (!Array.isArray(value) || value.length > 30) throw Error('Invalid AI accounts');
  const ids = new Set();
  return value.map(a => {
    if (!a || !/^[a-zA-Z0-9_-]{1,64}$/.test(a.id) || ids.has(a.id) || typeof a.hostId !== 'string' || !/^[\w-]{1,64}$/.test(a.hostId) ||
      !['claude','codex'].includes(a.tool) || typeof a.directory !== 'string' || a.directory.length > 1024 || /[\x00-\x1f]/.test(a.directory) ||
      !/^(~\/|\/|[A-Za-z]:[\\/])/.test(a.directory) || typeof a.nickname !== 'string' || a.nickname.length > 40 || /[\x00-\x1f]/.test(a.nickname) ||
      (a.threshold !== null && (!Number.isSafeInteger(a.threshold) || a.threshold <= 0))) throw Error('Invalid AI account');
    ids.add(a.id); return { id:a.id, hostId:a.hostId, tool:a.tool, directory:a.directory, nickname:a.nickname, threshold:a.threshold };
  });
}
const dateFormatters=new Map();
function dateKey(at, zone) {
  if(!dateFormatters.has(zone))dateFormatters.set(zone,new Intl.DateTimeFormat('en-CA',{ timeZone:zone, year:'numeric',month:'2-digit',day:'2-digit' }));
  const parts = dateFormatters.get(zone).formatToParts(at);
  return ['year','month','day'].map(k=>parts.find(p=>p.type===k).value).join('-');
}
function weekKey(day) { const d=new Date(day+'T12:00:00Z'); d.setUTCDate(d.getUTCDate()-(d.getUTCDay()+6)%7); return d.toISOString().slice(0,10); }
function publicLimits(value) {
  const out = {session:null, weekly:null, reason:value?.reason || '', reasons:{}, error:value?.error || null, stale:!!value?.stale, observedAt:value?.observedAt || null};
  for (const key of ['session','weekly']) {
    const w=value?.[key];
    if (Number.isFinite(w?.percent) && w.percent>=0 && w.percent<=100 && Number.isFinite(w.resetAt) && w.resetAt>0) out[key]={percent:w.percent,resetAt:w.resetAt,...(w.reset?{reset:true}:{})};
    if(!out[key])out.reasons[key]=value?.reason || value?.reasons?.[key] || (key==='session'&&!value?.error&&!value?.reason?'Chưa có phiên':'Chưa có dữ liệu');
  }
  return out;
}
function aggregate(accounts, { zone='UTC', now=Date.now() } = {}) {
  const today=dateKey(now,zone), week=weekKey(today);
  return { zone, at:now, accounts:accounts.map(a=>{
    const days=new Map(), weeks=new Map(), sessions=new Map();
    for (const e of a.buckets || a.events || []) {
      const at = e.lastAt ?? e.at;
      if (!Number.isFinite(at) || at > now || !Number.isSafeInteger(e.total) || e.total < 0) continue;
      const day=e.day || dateKey(at,zone), w=weekKey(day);
      days.set(day,(days.get(day)||0)+e.total); weeks.set(w,(weeks.get(w)||0)+e.total);
      const session = /^[a-f\d-]{24,36}$/i.test(e.session) ? e.session : 'unmapped';
      const s=sessions.get(session)||{id:session,total:0,today:0,week:0,lastAt:0,name:e.project || 'Dự án chưa rõ',state:'closed'};
      s.total+=e.total; if(day===today)s.today+=e.total;if(w===week)s.week+=e.total;s.lastAt=Math.max(s.lastAt,at);sessions.set(session,s);
    }
    return { id:a.id, tool:a.tool, email:a.email || null, plan:a.plan || null, reason:a.reason || '', limits:publicLimits(a.limits),
      observedAt:a.observedAt || null, today:a.reason&&!days.size?null:(days.get(today)||0),week:a.reason&&!days.size?null:(weeks.get(week)||0),
      days:[...days].sort().map(([day,total])=>({day,total})),weeks:[...weeks].sort().map(([day,total])=>({day,total})),
      sessions:[...sessions.values()].sort((a,b)=>b.lastAt-a.lastAt) };
  }) };
}
// Merge raw sources before totals: Claude message hashes are global; Codex buckets
// are cumulative per session/day, so replicated transcripts contribute only once.
function mergeSources(sources, options={}) {
 const groups=new Map();
 for(const source of sources){const key=accountKey(source);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(source);}
 return [...groups.values()].map(group=>{
  group.sort((a,b)=>Number(!!b.local)-Number(!!a.local));
  const base=group.find(a=>a.nickname)||group[0], unique=new Map(), fallback=new Map();
  for(const a of group){
   if(a.messages?.length)for(const [id,e] of a.messages){const old=unique.get(id);if(!old||old[0]<e[0]||(old[0]===e[0]&&old[2]<e[2]))unique.set(id,e);}
   else if(a.records?.length)for(const e of a.records){const old=unique.get(e.id);if(!old||old[0]<e.at||(old[0]===e.at&&old[2]<e.total))unique.set(e.id,[e.at,e.session,e.total,e.project]);}
   else for(const e of a.buckets || a.events || []){
    const key=(e.session || a.hostId+':'+a.id)+':'+(e.day || dateKey(e.at || e.lastAt,options.zone || 'UTC'));
    const old=fallback.get(key);
    if(e.ranges?.length){
     const ranges=[...(old?.ranges || []),...e.ranges].sort((a,b)=>a[0]-b[0]),union=[];
     for(const r of ranges){const last=union[union.length-1];if(last&&last[1]>=r[0])last[1]=Math.max(last[1],r[1]);else union.push([...r]);}
     fallback.set(key,{...e,ranges:union,total:union.reduce((n,r)=>n+r[1]-r[0],0)});
    }else if(!old||old.total<e.total)fallback.set(key,e);
   }
  }
  const available=group.filter(a=>goodQuota(a.limits)||a.limits?.stale);
  const newest=(available.length?available:group).slice().sort((a,b)=>(b.limits?.observedAt||b.observedAt||0)-(a.limits?.observedAt||a.observedAt||0))[0];
  const limits={...newest.limits,observedAt:newest.limits?.observedAt || newest.observedAt || null};
  if(available.length){limits.error=null;limits.reason='';}
  const compact=new Map(),dates=new Map();
  for(const [at,session,total,project] of unique.values()){
   if(!dates.has(at))dates.set(at,dateKey(at,options.zone || 'UTC'));
   const day=dates.get(at),key=day+'/'+session,b=compact.get(key)||{day,session,total:0,lastAt:0,project};
   b.total+=total;b.lastAt=Math.max(b.lastAt,at);compact.set(key,b);
  }
  const row=aggregate([{...base,plan:group.find(a=>a.plan)?.plan || group.find(a=>a.limits?.plan)?.limits.plan,buckets:[...compact.values(),...fallback.values()],limits}],options).accounts[0];
  const hostIds=[...new Set(group.map(a=>a.hostId))];
  Object.assign(row,{hostId:base.hostId,hostIds,hostName:[...new Set(group.map(a=>a.hostName))].join(', '),nickname:base.nickname || '',directory:base.directory,threshold:base.threshold,email:base.email?.trim().toLowerCase() || null,
   sourceWarnings:group.flatMap(a=>[a.reason,a.limits?.reason,...(a.quotaWarnings || [])].filter(Boolean).map(reason=>a.hostName+': '+reason)),
   hasGoodQuota:available.length>0});
  if(available.length)row.reason='';
  for(const session of row.sessions){
   const source=group.find(a=>(a.buckets || a.events || a.records || []).some(e=>e.session===session.id)) || base;
   const tmux=group.flatMap(a=>(a.liveSessions||[]).map(t=>({t,a}))).find(({t})=>(t.aiTool===base.tool&&t.aiSessionId===session.id)||(base.tool==='claude'&&claudeSessionId(t.path,t.name)===session.id));
   session.hostId=tmux?.a.hostId || source.hostId;session.hostName=tmux?.a.hostName || source.hostName;
   session.tmuxName=tmux?.t.name || null;session.state=tmux?.t.state || 'closed';
   if(tmux?.t.path)session.name=require('path').basename(tmux.t.path);
  }
  return row;
 }).sort((a,b)=>a.tool.localeCompare(b.tool)||(a.email||'').localeCompare(b.email||'')||accountKey(a).localeCompare(accountKey(b)));
}
// A host-wide process lock also prevents overlap if an SSH channel times out while
// its Node process is still finishing. Stale locks are reclaimed only for dead PIDs.
async function remoteRead(rt,cfg,options) {
  const fs=require('fs'),os=require('os'),p=require('path'),crypto=require('crypto');
  const root=p.join(os.tmpdir(),'tmux-dev-usage-'+process.getuid());
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  const st=fs.lstatSync(root);
  if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid()||(st.mode&63))throw Error();
  const lock=p.join(root,'scan.lock');
  try { fs.writeFileSync(lock,String(process.pid),{mode:0o600,flag:'wx'}); }
  catch {
    const pid=Number(fs.readFileSync(lock,'utf8'));
    if(!Number.isSafeInteger(pid)||pid<=0)throw Error();
    try { process.kill(pid,0); throw Error(); }
    catch(e) { if(e.code!=='ESRCH')throw e; }
    fs.unlinkSync(lock);fs.writeFileSync(lock,String(process.pid),{mode:0o600,flag:'wx'});
  }
  try {
    const file=p.join(root,crypto.createHash('sha256').update(cfg.tool+cfg.directory+(options.zone||'UTC')).digest('hex')+'.json');
    let cache={};try { cache=JSON.parse(fs.readFileSync(file,'utf8')); } catch {}
    const value=await rt.read(cfg,cache,options),tmp=file+'.'+process.pid;
    fs.writeFileSync(tmp,JSON.stringify(cache),{mode:0o600,flag:'wx'});fs.renameSync(tmp,file);
    return value;
  } finally { fs.unlinkSync(lock); }
}
const runtime=tokenRuntime();
async function readBackend(backend, accounts, options = {}) {
  backend.tokenCaches ||= new Map();
  const rows=[];
  for (const config of accounts) rows.push(await readOne(config));
  return rows;
  async function readOne(config) {
    const key=JSON.stringify([config.tool,config.directory,options.zone || 'UTC']);
    const old=backend.tokenCaches.get(key);
    if(old?.pending)return old.pending.then(result=>({...result,id:config.id}));
    if(old && Date.now()-old.at<60000)return {...old.value,id:config.id};
    const entry=old||{cache:{}};
    entry.pending=(async()=>{
      try {
        if(!backend.ready)throw Error();
        let value;
        if(backend.cfg.local && backend.mode!=='wsl') value=await runtime.read(config,entry.cache,options);
        else {
          // Sanitized incremental cache lives on the host holding the login. Credentials never
          // cross SSH. Only usage/identity/quota allowlists are printed by this program.
          const code=`(${remoteRead.toString()})((${tokenRuntime.toString()})(),${JSON.stringify(config)},${JSON.stringify(options)}).then(value=>process.stdout.write(JSON.stringify(value))).catch(()=>process.exit(1));`;
          const result=await backend.exec(remoteCommand(code,{action:'read',config,options}),60000);
          if(result.code!==0)throw Object.assign(Error(),{missingRuntime:result.code===127}); value=JSON.parse(result.out);
        }
        entry.value=value;entry.at=Date.now();return value;
      } catch(e) { const value={id:config.id,tool:config.tool,email:null,plan:null,buckets:[],sourceFailed:true,reason:e.missingRuntime?'thiếu Node.js và python3':'Không đọc được: máy chưa kết nối hoặc không đọc được nguồn'};entry.value=value;entry.at=Date.now();return value; }
      finally { entry.pending=null; }
    })();
    backend.tokenCaches.set(key,entry);while(backend.tokenCaches.size>120)backend.tokenCaches.delete(backend.tokenCaches.keys().next().value);return entry.pending.then(result=>({...result,id:config.id}));
  }
}
async function tokenState(backends, configs, options={}) {
 const rows=[],hosts=backends.map(b=>({hostId:b.cfg.id,hostName:b.publicView().name,state:'reading',reason:''}));
 let dirty=true,merged=[];
 const snapshot=()=>{if(dirty){merged=mergeSources(rows,options);dirty=false;}return {accounts:merged,hosts:hosts.filter(h=>h.state!=='ready'),at:Date.now(),zone:options.zone};};
 const publish=()=>options.onProgress?.({...snapshot(),scanning:true,updatedAt:rows.length?Date.now():null});
 const pool=options.quotaPool || quotaPool;pool.seed(options.cachedAccounts);
 publish();
 // Local discovery starts first, independently of slow remote hosts.
 await Promise.all([...backends].sort((a,b)=>Number(!!b.cfg.local)-Number(!!a.cfg.local)).map(async backend=>{
  const host=hosts.find(h=>h.hostId===backend.cfg.id),declared=configs.filter(a=>a.hostId===backend.cfg.id);
  let accounts=declared;
  try {
   if(!backend.ready)throw Error();
   if(backend.cfg.local && backend.mode!=='wsl')accounts=await runtime.discover(backend.cfg.id,declared,options);
   else {
    const code=`(${tokenRuntime.toString()})().discover(${JSON.stringify(backend.cfg.id)},${JSON.stringify(declared)}).then(v=>process.stdout.write(JSON.stringify(v))).catch(()=>process.exit(1));`;
    const result=await backend.exec(remoteCommand(code,{action:'discover',hostId:backend.cfg.id,manual:declared}),60000);
    if(result.code!==0)throw Object.assign(Error(),{missingRuntime:result.code===127});
    accounts=JSON.parse(result.out);if(!Array.isArray(accounts))throw Error();
   }
   for(const cfg of accounts){
    const readOptions={zone:options.zone,now:options.now,home:options.home,env:options.env,quota:false};
    const [a]=await readBackend(backend,[cfg],readOptions);
    if(a.sourceFailed){host.state='failed';host.reason=a.reason;continue;}
    Object.assign(a,{local:!!backend.cfg.local,hostId:backend.cfg.id,hostName:host.hostName,nickname:cfg.nickname,threshold:cfg.threshold,directory:cfg.directory,liveSessions:backend.snapshot?.sessions || []});
    a.quotaWarnings=a.limits?.error?[a.limits.reason]:[];
    const cached=pool.entries.get(accountKey(a))?.good;
    if(cfg.tool==='claude'&&cached&&!goodQuota(a.limits))a.limits=cached;
    rows.push(a);dirty=true;publish();
    if(cfg.tool==='claude' && options.quota!==false){
     // Seed genuine provider readings returned by a source before consulting the shared gate.
     if(goodQuota(a.limits))pool.seed([a]);
     a.limits=await pool.get(accountKey(a),async()=>{
      if(backend.cfg.local&&backend.mode!=='wsl')return runtime.claudeQuota(cfg.directory);
      const code=`(${tokenRuntime.toString()})().claudeQuota(${JSON.stringify(cfg.directory)}).then(v=>process.stdout.write(JSON.stringify(v))).catch(()=>process.exit(1));`;
      const result=await backend.exec(remoteCommand(code,{action:'quota',config:cfg}),15000);
      if(result.code!==0)throw Error();return JSON.parse(result.out);
     });dirty=true;publish();
    }
   }
   if(host.state!=='failed'){host.state=accounts.length?'ready':'empty';host.reason=accounts.length?'':'chưa có dữ liệu';}
  }catch(e){host.state='failed';host.reason=e.missingRuntime?'thiếu Node.js và python3':'Không đọc được: máy chưa kết nối hoặc không đọc được nguồn';}
  publish();
 }));
 return snapshot();
}
function remoteCommand(code, payload) {
  const python=require('fs').readFileSync(require('path').join(__dirname,'token-fallback.py'),'utf8');
  // Resolve runtimes as the SSH user; no sudo, login shell or dotfile execution.
  return `node_bin=$(command -v node 2>/dev/null); if [ -z "$node_bin" ]; then for p in /usr/local/bin/node /opt/homebrew/bin/node /usr/bin/node "$HOME"/.local/bin/node "$HOME"/.volta/bin/node "$HOME"/.nvm/versions/node/*/bin/node; do if [ -x "$p" ]; then node_bin="$p"; fi; done; fi; if [ -n "$node_bin" ]; then "$node_bin" -e ${shq(code)}; elif command -v python3 >/dev/null 2>&1; then python3 -c ${shq(python)} ${shq(JSON.stringify(payload))}; else exit 127; fi`;
}
module.exports={cleanAccounts,aggregate,mergeSources,readBackend,tokenState,remoteCommand};
