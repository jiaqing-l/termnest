"""SSH-user-only fallback. Output/cache contain allowlisted aggregates, never raw logs."""
import os, sys, json, hashlib, time, datetime, pathlib, base64, urllib.request, urllib.error, math, re, fcntl

def digest(s):
    return hashlib.sha256(s.encode()).hexdigest()[:24]

def load(p):
    with open(p, encoding='utf-8') as f:
        return json.load(f)

def plan(p):
    return p if p in ('free','pro','plus','max','team','business','enterprise','edu','pro_plus') else None

def email(e):
    import re
    return e if isinstance(e,str) and len(e)<=254 and re.fullmatch(r'[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+',e) else None

def stamp(s):
    return datetime.datetime.fromisoformat(s.replace('Z','+00:00')).timestamp()*1000

def quota(raw,tool):
    out={'session':None,'weekly':None,'reasons':{},'reason':''}
    for key,minutes,field in [('session',300,'five_hour'),('weekly',10080,'seven_day')]:
        w=raw.get(field) if tool=='claude' else next((v for v in [raw.get('primary'),raw.get('secondary')] if isinstance(v,dict) and v.get('window_minutes')==minutes),None)
        try:
            percent=w['utilization' if tool=='claude' else 'used_percent']
            reset=stamp(w['resets_at']) if tool=='claude' else w['resets_at']*1000
            if type(percent) not in (int,float) or not 0<=percent<=100 or not math.isfinite(reset) or reset<=0: raise ValueError()
            out[key]={'percent':percent,'resetAt':reset}
        except Exception:
            out['reasons'][key]='Chưa có phiên' if key=='session' else 'Chưa có dữ liệu tuần'
    return out

def discover(p):
    home=pathlib.Path.home()
    dirs=[(t,home/('.'+t)) for t in ('claude','codex') if (home/('.'+t)).is_dir()]
    dirs += [('claude',d) for d in sorted(home.glob('.claude-*')) if d.is_dir() and ((d/'.claude.json').exists() or (d/'projects').exists())]
    for tool,env in [('claude','CLAUDE_CONFIG_DIR'),('codex','CODEX_HOME')]:
        if os.environ.get(env): dirs.append((tool,pathlib.Path(os.environ[env]).expanduser()))
    rows=list(p['manual']);seen=set();out=[]
    for tool,d in dirs:
        d=str(d.absolute()); name=pathlib.Path(d).name
        rows.append(dict(id=p['hostId']+'_'+tool+'_'+digest(d)[:10],hostId=p['hostId'],tool=tool,directory=d,nickname='',threshold=None))
    for a in rows:
        d=os.path.abspath(os.path.expanduser(a['directory']));key=a['tool']+os.path.realpath(d)
        if key not in seen: out.append(dict(a,directory=d));seen.add(key)
    return out

def read(p):
    cfg=p['config'];tool=cfg['tool'];directory=pathlib.Path(cfg['directory']).expanduser();now=time.time()*1000
    zone=p.get('options',{}).get('zone','UTC')
    from zoneinfo import ZoneInfo
    tz=ZoneInfo(zone)
    # Cache only normalized per-file aggregates, invalidated on size or mtime change.
    root=pathlib.Path.home()/'.cache'/'tmux-dev-usage'
    root.mkdir(parents=True,exist_ok=True,mode=0o700)
    if root.is_symlink() or root.stat().st_uid!=os.getuid() or root.stat().st_mode & 0o077: raise ValueError()
    target=root/(digest(str(directory)+tool+zone)+'.json')
    try:
        cache=load(target)
        if cache.get('version')!=2: cache={}
    except Exception: cache={}
    files={};buckets={};seen={};bad=0;latest=0;limits=quota({},tool);subscription=None;reason=''
    logroot=directory/('projects' if tool=='claude' else 'sessions')
    if not logroot.is_dir(): reason='Không đọc được thư mục log'
    for file in logroot.rglob('*.jsonl'):
        stat=file.stat();signature=[stat.st_size,stat.st_mtime_ns];entry=cache.get('files',{}).get(str(file),{})
        if entry.get('signature')!=signature:
            entry=dict(signature=signature,buckets={},seen={},bad=0,at=0,limits=quota({},tool),plan=None)
            total=0;session=digest(str(file));project=''
            with file.open(encoding='utf-8') as f:
                for text in f:
                    if not text.endswith('\n'): continue
                    try:
                        row=json.loads(text)
                        cwd=row.get('cwd') or row.get('payload',{}).get('cwd')
                        if isinstance(cwd,str): project=pathlib.Path(cwd).name[:160]
                        if tool=='codex' and row.get('type')=='session_meta': session=row.get('payload',{}).get('id','');session=session if re.fullmatch(r'[\da-fA-F-]{36}',session) else digest(str(file));continue
                        if tool=='claude':
                            if row.get('type')!='assistant': continue
                            at=stamp(row['timestamp']);u=row['message']['usage'];values=[u[k] for k in ['input_tokens','output_tokens','cache_read_input_tokens','cache_creation_input_tokens']]
                            if any(type(v)!=int or v<0 for v in values): raise ValueError()
                            sid=row.get('sessionId','');sid=sid if re.fullmatch(r'[\da-fA-F-]{36}',sid) else session
                            entry['seen'][digest(row['message']['id'])]=[at,sid,sum(values),project]
                        else:
                            payload=row.get('payload',{})
                            if row.get('type')!='event_msg' or payload.get('type')!='token_count': continue
                            at=stamp(row['timestamp'])
                            if payload.get('rate_limits') and at>=entry['at']:
                                entry.update(at=at,limits=quota(payload['rate_limits'],tool),plan=plan(payload['rate_limits'].get('plan_type')))
                            if payload.get('info') is None: continue
                            n=payload['info']['total_token_usage']['total_tokens']
                            if type(n)!=int or n<total: raise ValueError()
                            day=datetime.datetime.fromtimestamp(at/1000,tz).date().isoformat();key=day+'/'+session
                            b=entry['buckets'].setdefault(key,dict(day=day,session=session,total=0,lastAt=0));b['total']+=n-total;b['lastAt']=max(at,b['lastAt']);b['project']=project
                            ranges=b.setdefault('ranges',[])
                            if ranges and ranges[-1][1]==total: ranges[-1][1]=n
                            else: ranges.append([total,n])
                            total=n
                    except Exception: entry['bad']+=1
        files[str(file)]=entry;bad+=entry['bad']
        if entry['at']>=latest: latest=entry['at'];limits=entry['limits'];subscription=entry['plan']
        for k,v in entry['seen'].items():
            if k not in seen or v[0]>=seen[k][0]: seen[k]=v
        for k,b in entry['buckets'].items():
            dst=buckets.setdefault(k,dict(b,total=0,ranges=[]));dst['lastAt']=max(dst['lastAt'],b['lastAt'])
            union=[]
            for lo,hi in sorted(dst['ranges']+b.get('ranges',[])):
                if union and union[-1][1]>=lo: union[-1][1]=max(union[-1][1],hi)
                else: union.append([lo,hi])
            dst['ranges']=union;dst['total']=sum(hi-lo for lo,hi in union)
    for at,session,total,project in seen.values():
        day=datetime.datetime.fromtimestamp(at/1000,tz).date().isoformat();key=day+'/'+session
        b=buckets.setdefault(key,dict(day=day,session=session,total=0,lastAt=0,project=project));b['total']+=total;b['lastAt']=max(at,b['lastAt'])
    who=None
    try:
        if tool=='claude':
            identity=directory/'.claude.json'
            if directory==pathlib.Path.home()/'.claude' and not identity.exists(): identity=pathlib.Path.home()/'.claude.json'
            auth=load(identity)['oauthAccount'];who=email(auth.get('emailAddress'));subscription=plan(auth.get('subscriptionType')) or subscription
        else:
            token=load(directory/'auth.json')['tokens']['id_token'].split('.')[1];claims=json.loads(base64.urlsafe_b64decode(token+'='*(-len(token)%4)))
            who=email(claims.get('email'));subscription=plan(claims.get('https://api.openai.com/auth',{}).get('chatgpt_plan_type')) or subscription
    except Exception: pass
    if tool=='claude':
        limits=cache.get('lastGood',dict(session=None,weekly=None,reason='Không đọc được: chưa có quota đã lưu'))
        if p.get('options',{}).get('quota') is not False and now>=cache.get('quotaNext',0):
            fresh=read_quota(p)
            cache['quotaNext']=now+max(330000,fresh.get('retryAfter',0))
            if not fresh.get('error'): cache['lastGood']=fresh
            limits=dict(cache.get('lastGood',fresh),**({'stale':True,'error':fresh['error'],'reason':fresh['reason']} if fresh.get('error') else {}))
    cache['files']=files;cache['version']=2
    temp=target.with_suffix('.tmp')
    fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    try:
        with os.fdopen(fd,'w') as f: json.dump(cache,f)
        os.replace(temp,target)
    finally:
        if temp.exists(): temp.unlink()
    limits=dict(limits)
    if bad: reason='Bỏ qua '+str(bad)+' dòng log lỗi'
    if not buckets and not reason: reason='Chưa có bản ghi usage'
    return dict(id=cfg['id'],tool=tool,email=who,plan=subscription,buckets=list(buckets.values()),messages=list(seen.items()) if tool=='claude' else None,limits=limits,reason=reason,observedAt=latest or None)

def read_quota(p):
    directory=pathlib.Path(p['config']['directory']).expanduser()
    try: token=load(directory/'.credentials.json')['claudeAiOauth']['accessToken']
    except Exception: return dict(session=None,weekly=None,error='expired',reason='Không đọc được: cần đăng nhập Claude')
    retry=0
    try:
        request=urllib.request.Request('https://api.anthropic.com/api/oauth/usage',headers={'Authorization':'Bearer '+token,'anthropic-beta':'oauth-2025-04-20'})
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self,*args,**kwargs): return None
        with urllib.request.build_opener(NoRedirect).open(request,timeout=5) as response: value=quota(json.load(response),'claude')
        return dict(value,observedAt=time.time()*1000)
    except urllib.error.HTTPError as e:
        error={401:'expired',403:'denied',429:'rate_limited'}.get(e.code,'network')
        raw=e.headers.get('Retry-After','0')
        try: retry=float(raw)*1000
        except ValueError:
            from email.utils import parsedate_to_datetime
            try: retry=max(0,(parsedate_to_datetime(raw).timestamp()-time.time())*1000)
            except Exception: pass
    except Exception: error='network'
    return dict(session=None,weekly=None,error=error,retryAfter=retry,reason='Không đọc được: '+{'expired':'đăng nhập đã hết hạn','denied':'không có quyền đọc quota','rate_limited':'nguồn đang giới hạn lượt đọc','network':'không kết nối được nguồn quota'}[error])

def locked_read(payload):
    root=pathlib.Path.home()/'.cache'/'tmux-dev-usage'
    root.mkdir(parents=True,exist_ok=True,mode=0o700)
    if root.is_symlink() or root.stat().st_uid!=os.getuid() or root.stat().st_mode & 0o077: raise ValueError()
    fd=os.open(root/'scan.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'w') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        return read(payload)

try:
    payload=json.loads(sys.argv[1]);print(json.dumps(discover(payload) if payload['action']=='discover' else read_quota(payload) if payload['action']=='quota' else locked_read(payload)))
except Exception:
    sys.exit(1)
