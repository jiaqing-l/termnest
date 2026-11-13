'use strict';
// Self-contained: also executed on the SSH host. Never return raw lines or credentials.
function tokenRuntime() {
  const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
  const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
  const unavailable = reason => ({ session: null, weekly: null, reason: 'Không đọc được: ' + reason });
  const empty = (zone = 'UTC') => ({ buckets: {}, seen: {}, zone, total: null, session: '', bad: false, badLines: 0, quota: unavailable('chưa có hạn mức trong log'), quotaAt: 0 });
  const formatters = new Map();
  let lastDayAt, lastDayZone, lastDay;
  function dayKey(at, zone) {
    if (at === lastDayAt && zone === lastDayZone) return lastDay;
    if (!formatters.has(zone)) formatters.set(zone, new Intl.DateTimeFormat('en-CA', {timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}));
    const parts = formatters.get(zone).formatToParts(at);
    lastDayAt=at;lastDayZone=zone;
    return lastDay=['year','month','day'].map(k=>parts.find(p=>p.type===k).value).join('-');
  }
  function add(buckets, day, session, total, at) {
    const key = day + '/' + session;
    const b = buckets[key] ||= {day,session,total:0,lastAt:0};
    b.total += total; b.lastAt = Math.max(b.lastAt,at);
  }
  const ASSISTANT = Buffer.from('"assistant"'), CWD = Buffer.from('"cwd"'), SESSION_META = Buffer.from('"session_meta"'), TOKEN_COUNT = Buffer.from('"token_count"');
  const count = n => Number.isSafeInteger(n) && n >= 0;
  function quota(raw, tool) {
    function window(value, minutes) {
      if (!value) return null;
      const percent = tool === 'claude' ? value.utilization : value.used_percent;
      const resetAt = tool === 'claude' ? Date.parse(value.resets_at) : value.resets_at * 1000;
      if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100 || !Number.isFinite(resetAt) || resetAt <= 0 ||
          (tool === 'codex' && value.window_minutes !== minutes)) return null;
      return { percent, resetAt };
    }
    const session = window(tool === 'claude' ? raw?.five_hour : [raw?.primary,raw?.secondary].find(w=>w?.window_minutes===300), 300);
    const weekly = window(tool === 'claude' ? raw?.seven_day : [raw?.primary,raw?.secondary].find(w=>w?.window_minutes===10080), 10080);
    // Plans without a 5-hour window: five_hour is null and the "limits" list names only weekly limits. Say "no such
    // limit" instead of "no session", so the card does not show an empty 5-hour dial forever.
    const noSession = !session && (tool === 'claude' ? Array.isArray(raw?.limits) && raw.limits.length > 0 && raw.limits.every(l => /weekly/i.test(String(l?.group || l?.kind || ''))) :
      !!weekly && ![raw?.primary, raw?.secondary].some(w => w && w.window_minutes !== 10080));
    return { session, weekly, ...(noSession ? { noSession: true } : {}), reasons: {session:session?'':noSession?'Không có giới hạn 5 giờ':'Chưa có phiên',weekly:weekly?'':'Chưa có dữ liệu tuần'}, reason: '' };
  }
  function line(row, tool, state) {
    const at = Date.parse(row.timestamp);
    const cwd=row.cwd || row.payload?.cwd;
    if(typeof cwd==='string')state.project=path.basename(cwd).slice(0,160);
    if (tool === 'claude') {
      if (row.type !== 'assistant') return;
      const u = row.message?.usage;
      if (!u || !row.message?.id || !Number.isFinite(at)) { state.bad = true; state.badLines = (state.badLines || 0) + 1; return; }
      const fields = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
      if (!fields.every(k => count(u[k]))) { state.bad = true; state.badLines = (state.badLines || 0) + 1; return; }
      const key = hash(row.message.id), session = /^[\da-f-]{36}$/i.test(row.sessionId) ? row.sessionId : state.session;
      // Streaming snapshots share a message ID. Replace, never add the same request twice.
      // Compact dedup index only: hashed ID -> [timestamp, session, token count].
      // Required for replacements and copied transcripts; no message/event bodies retained.
      state.sessionIds ||= {};
      const canonicalSession = state.sessionIds[session] ||= session;
      state.seen[key] = [at, canonicalSession, fields.reduce((n,k) => n + u[k], 0), state.project || ''];
    } else {
      if (row.type === 'session_meta') { state.session = /^[\da-f-]{36}$/i.test(row.payload?.id) ? row.payload.id : ''; return; }
      if (row.type !== 'event_msg' || row.payload?.type !== 'token_count') return;
      const p = row.payload;
      if (p.rate_limits && Number.isFinite(at) && at >= state.quotaAt) {
        state.quota = quota(p.rate_limits, 'codex'); state.quotaAt = at;
        state.plan = plan(p.rate_limits.plan_type);
      }
      if (p.info === null) return; // Rate-limit-only event, emitted by the CLI.
      const u = p.info?.total_token_usage;
      if (!u || !count(u.total_tokens) || !Number.isFinite(at)) { state.bad = true; state.badLines = (state.badLines || 0) + 1; return; }
      const previous = state.total ?? 0;
      if (u.total_tokens < previous) { state.bad = true; state.badLines = (state.badLines || 0) + 1; return; }
      const delta = u.total_tokens - previous; state.total = u.total_tokens;
      if (delta) {
        const day=dayKey(at,state.zone);add(state.buckets,day,state.session,delta,at);
        const b=state.buckets[day+'/'+state.session];b.project=state.project || '';b.ranges ||= [];
        const last=b.ranges[b.ranges.length-1];if(last&&last[1]===previous)last[1]=u.total_tokens;else b.ranges.push([previous,u.total_tokens]);
      }
    }
  }
  function plan(value) { return typeof value === 'string' && /^(free|pro|plus|max|team|business|enterprise|edu|pro_plus)$/i.test(value) ? value : null; }
  async function json(file) { return JSON.parse(await fs.promises.readFile(file, 'utf8')); }
  async function identity(dir, tool) {
    try {
      if (tool === 'claude') {
        let obj;
        try { obj = await json(path.join(dir, '.claude.json')); }
        catch { if (dir !== path.join(os.homedir(), '.claude')) throw Error(); obj = await json(path.join(os.homedir(), '.claude.json')); }
        const email = obj.oauthAccount?.emailAddress;
        return { email: emailValue(email), plan: plan(obj.oauthAccount?.subscriptionType) };
      }
      const auth = await json(path.join(dir, 'auth.json'));
      const token = auth.tokens?.id_token;
      if (typeof token !== 'string' || token.length > 65536) throw Error();
      const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
      return { email: emailValue(claims.email), plan: plan(claims['https://api.openai.com/auth']?.chatgpt_plan_type) };
    } catch { return { email: null, plan: null }; }
  }
  function emailValue(email) { return typeof email === 'string' && email.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ? email : null; }
  async function credential(dir, options = {}) {
    const home=options.home || os.homedir(); dir=path.resolve(dir);
    try { const obj = await json(path.join(dir, '.credentials.json')); return obj.claudeAiOauth; }
    catch {
      // macOS CLI keeps the default account in Keychain. Custom directories must never
      // accidentally borrow the default account's credentials.
      if ((options.platform || process.platform) !== 'darwin') return null;
      const service='Claude Code-credentials'+(dir===path.join(home,'.claude')?'':'-'+crypto.createHash('sha256').update(dir).digest('hex').slice(0,8));
      return new Promise(resolve => (options.execFile || require('child_process').execFile)('/usr/bin/security', ['find-generic-password', '-s', service, '-w'],
        { timeout: 3000, maxBuffer: 65536 }, (err, out) => { try { resolve(err ? null : JSON.parse(out).claudeAiOauth); } catch { resolve(null); } }));
    }
  }
  async function request(token) {
    const response = await fetch('https://api.anthropic.com/api/oauth/usage', { headers: { Authorization: 'Bearer ' + token, 'anthropic-beta': 'oauth-2025-04-20' }, redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!response.ok) {
      const raw=response.headers.get('retry-after');
      const retryAfter=raw==null?0:/^\d+(\.\d+)?$/.test(raw)?Number(raw)*1000:Math.max(0,Date.parse(raw)-Date.now());
      throw Object.assign(Error(),{status:response.status,retryAfter:Number.isFinite(retryAfter)?retryAfter:0});
    }
    return response.json();
  }
  async function claudeQuota(dir, options = {}) {
    let subscription=null;
    try {
      const login = await (options.credential || credential)(dir);
      const token = typeof login === 'string' ? login : login?.accessToken;
      subscription=plan(login?.subscriptionType);
      if (typeof token !== 'string' || !token || token.length>65536) return {...unavailable('cần đăng nhập Claude trên máy này'),error:'expired',plan:subscription};
      return {...quota(await (options.request || request)(token), 'claude'),plan:subscription};
    } catch(e) { const error=e.status===401?'expired':e.status===403?'denied':e.status===429?'rate_limited':'network';
      return {...unavailable({expired:'đăng nhập đã hết hạn',denied:'không có quyền đọc quota',rate_limited:'nguồn đang giới hạn lượt đọc',network:'không kết nối được nguồn quota'}[error]),error,retryAfter:e.retryAfter || 0,plan:subscription}; }
  }
  async function read(config, cache = {}, options = {}) {
    const dir = config.directory === '~' ? os.homedir() : config.directory.startsWith('~/') ? path.join(os.homedir(), config.directory.slice(2)) : config.directory;
    cache.files ||= {}; cache.bytes ||= 0;
    const zone = options.zone || 'UTC';
    if (cache.zone !== zone || cache.version !== 4) { cache.files = {}; cache.zone = zone; cache.version = 4; }
    const chunk = Buffer.allocUnsafe(1<<20), files = [], unique = new Map(), buckets = {}, root = path.join(dir, config.tool === 'claude' ? 'projects' : 'sessions');
    let badLines=0; const now=typeof options.now==='function'?options.now():options.now || Date.now();
    let reason = '', latest = { at: 0, quota: unavailable('chưa có hạn mức trong log'), plan: null };
    async function walk(folder, depth = 0) {
      if (depth > 20) throw Error();
      for (const e of await fs.promises.readdir(folder, { withFileTypes: true })) {
        if (e.isDirectory()) await walk(path.join(folder, e.name), depth + 1);
        else if (e.isFile() && e.name.endsWith('.jsonl')) files.push(path.join(folder,e.name));
      }
    }
    try { await walk(root); } catch { reason = 'Không đọc được: thiếu quyền hoặc thư mục log không tồn tại'; }
    const live = new Set(files);
    for (const key of Object.keys(cache.files)) if (!live.has(key)) delete cache.files[key];
    for (const key of Object.keys(cache.failed || {})) if (!live.has(key)) delete cache.failed[key];
    for (const file of files) {
      try {
        const stat = await fs.promises.stat(file); let entry = cache.files[file];
        // A file that failed to read (a single line over 16 MB) used to be re-read from byte 0 on every scan. Remember the failure for
        // as long as the file is unchanged; the reported totals stay exactly what they were.
        const failed = cache.failed?.[file];
        if (failed && failed.ino === stat.ino && failed.size === stat.size && failed.mtime === stat.mtimeMs) { reason = 'Không đọc được: không thể đọc đầy đủ log'; continue; }
        if (failed) delete cache.failed[file];
        if (!entry || entry.ino !== stat.ino || stat.size < entry.offset || (stat.size === entry.size && stat.mtimeMs !== entry.mtime)) entry = { ino: stat.ino, offset: 0, state: empty(zone) };
        const fd = await fs.promises.open(file, 'r');
        try {
          // Read complete lines through one reusable 1 MB buffer; only a line that spans chunks is copied. Lines that cannot hold usage
          // (no assistant/token_count/session_meta/cwd marker) are skipped as bytes, never decoded or JSON-parsed. Raw text (which can
          // contain prompts/secrets) is never retained in the cache.
          let parts = [], partLen = 0, position = entry.offset;
          const wanted = config.tool === 'claude' ? [ASSISTANT, CWD] : [SESSION_META, TOKEN_COUNT, CWD];
          const handle = buf => {
            if (!buf.length || (buf.length > 4096 && buf[0] === 123 && buf[buf.length-1] === 125 && !wanted.some(m => buf.includes(m)))) return; // short lines are parsed so a malformed one is still counted
            const text = buf.toString('utf8'); if (!text.trim()) return;
            try { line(JSON.parse(text), config.tool, entry.state); } catch { entry.state.bad = true; entry.state.badLines = (entry.state.badLines || 0) + 1; }
          };
          while (position < stat.size) {
            const { bytesRead } = await fd.read(chunk, 0, Math.min(chunk.length, stat.size-position), position); if (!bytesRead) break;
            position += bytesRead; cache.bytes += bytesRead;
            const view = chunk.subarray(0, bytesRead); let start = 0, end;
            while ((end = view.indexOf(10, start)) >= 0) {
              let buf;
              if (parts.length) { parts.push(view.subarray(start, end)); buf = Buffer.concat(parts); parts = []; partLen = 0; } else buf = view.subarray(start, end);
              entry.offset += buf.length + 1; handle(buf); start = end + 1;
            }
            if (start < bytesRead) { parts.push(Buffer.from(view.subarray(start))); partLen += bytesRead - start; }
            if (partLen > 16*1024*1024) throw Error();
          }
          if (partLen) reason = 'Không đọc được: log đang ghi dở, chờ dòng hoàn chỉnh';
        } finally { await fd.close(); }
        entry.size = stat.size; entry.mtime = stat.mtimeMs; cache.files[file] = entry;
        badLines += entry.state.badLines || 0;
        if (config.tool === 'claude') {
          for (const id in entry.state.seen) {
            const item = entry.state.seen[id];
            if (!unique.has(id) || unique.get(id)[0] <= item[0]) unique.set(id, item);
          }
        } else {
          for (const b of Object.values(entry.state.buckets)) { add(buckets,b.day,b.session || hash(file),b.total,b.lastAt); const dst=buckets[b.day+'/'+(b.session || hash(file))];dst.project=b.project || entry.state.project || 'Dự án chưa rõ';
            const sorted=[...(dst.ranges || []),...(b.ranges || [])].sort((a,b)=>a[0]-b[0]),union=[];
            for(const range of sorted){const last=union[union.length-1];if(last&&last[1]>=range[0])last[1]=Math.max(last[1],range[1]);else union.push([...range]);}
            dst.ranges=union;dst.total=union.reduce((n,r)=>n+r[1]-r[0],0); }
        }
        if (entry.state.quotaAt > latest.at) latest = { at:entry.state.quotaAt, quota:entry.state.quota, plan:entry.state.plan };
      } catch { reason = 'Không đọc được: không thể đọc đầy đủ log'; try { const st = await fs.promises.stat(file); (cache.failed ||= {})[file] = { ino: st.ino, size: st.size, mtime: st.mtimeMs }; } catch {} }
    }
    for (const item of unique.values()) add(buckets,dayKey(item[0],zone),item[1] || 'unmapped',item[2],item[0]);
    const usage = Object.values(buckets);
    const messages=config.tool==='claude'?[...unique]:undefined;
    if (badLines) reason = 'Bỏ qua '+badLines+' dòng log lỗi';
    if (!usage.length && !reason) reason = 'Không đọc được: chưa có bản ghi usage được hỗ trợ';
    const who = await identity(dir, config.tool);
    let limits = latest.quota;
    if (config.tool === 'claude') {
      if (options.quota === false) limits = cache.lastGoodQuota || unavailable('chưa có quota đã đọc');
      else {
        if (!cache.quotaAt || now - cache.quotaAt >= (cache.quotaDelay || 330000)) {
          const fresh=await claudeQuota(dir, options);
          if(!fresh.error) { fresh.observedAt=now; cache.lastGoodQuota=fresh; }
          cache.quota=fresh.error && cache.lastGoodQuota ? {...cache.lastGoodQuota,error:fresh.error,reason:fresh.reason,stale:true} : fresh; cache.quotaAt=now; cache.quotaDelay=Math.max(300000+Math.floor(Math.random()*30000),fresh.retryAfter || 0);
        }
        limits = cache.quota;
      }
    }
    limits = { ...limits };
    // A past reset does not prove current usage is zero. Keep the observed percentage.
    return { id:config.id, tool:config.tool, email:who.email, plan:who.plan || limits.plan || latest.plan || null, reason, buckets:usage, messages, limits, observedAt: latest.at || null };
  }
  async function discover(hostId, manual=[], options={}) {
    const home=options.home || os.homedir(), env=options.env || process.env;
    const resolve=d=>path.resolve(d==='~'?home:d.startsWith('~/')?path.join(home,d.slice(2)):d);
    const dirs=[];for(const tool of ['claude','codex']) {const d=path.join(home,'.'+tool);if(await fs.promises.stat(d).catch(()=>null))dirs.push([tool,d]);}
    try { for(const e of await fs.promises.readdir(home,{withFileTypes:true})) {
      if(!e.isDirectory() || !e.name.startsWith('.claude-'))continue;
      const d=path.join(home,e.name);
      if(await fs.promises.stat(path.join(d,'.claude.json')).catch(()=>null) || await fs.promises.stat(path.join(d,'projects')).catch(()=>null))dirs.push(['claude',d]);
    }} catch {}
    if(env.CLAUDE_CONFIG_DIR)dirs.push(['claude',resolve(env.CLAUDE_CONFIG_DIR)]);
    if(env.CODEX_HOME)dirs.push(['codex',resolve(env.CODEX_HOME)]);
    const seen=new Set(),out=[];
    for(const a of [...manual,...dirs.map(([tool,directory])=>({id:hostId+'_'+tool+'_'+hash(directory).slice(0,10),hostId,tool,directory,nickname:'',threshold:null}))]) {
      const directory=resolve(a.directory);let canonical=directory;try{canonical=await fs.promises.realpath(directory);}catch{}
      const key=a.tool+':'+canonical;if(seen.has(key))continue;seen.add(key);out.push({...a,directory});
    }
    return out;
  }
  return { read, line, empty, quota, claudeQuota, credential, discover };
}
module.exports = { tokenRuntime };
