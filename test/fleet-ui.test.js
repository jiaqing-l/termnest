'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm');
const { spawnSync } = require('child_process');
const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const functions = app.slice(app.indexOf('  function hot('), app.indexOf('  function alerts('));
test('server capacities round to at most one decimal, including missing data', () => {
  const ctx = {};
  vm.runInNewContext(app.slice(app.indexOf('  function compactNumber('), app.indexOf('  function ring(')) + ';globalThis.format=compactNumber;', ctx);
  assert.equal(ctx.format(1.16), 1.2); assert.equal(ctx.format(31.34), 31.3);
  assert.equal(ctx.format(62.25), 62.3); assert.equal(ctx.format(96.73), 96.7);
  assert.equal(ctx.format(10), 10); assert.equal(ctx.format(null), '—');
});
const chrome = process.env.CHROME_BIN || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => fs.existsSync(p));
test('Chrome: fleet labels, integer rings, equal heights, compact brand and reboot confirmation', { skip: !chrome }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-fleet-ui-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const index = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const header = index.match(/<header class="top">[\s\S]*?<\/header>/)[0].replace(/\/termnest-[^\"']+\.svg/g, src => 'data:image/svg+xml;base64,' + fs.readFileSync(path.join(__dirname, '../public', path.basename(src))).toString('base64'));
  const dialog = index.match(/<dialog id="dlg-reboot"[\s\S]*?<\/dialog>/)[0];
  const fixture = `<style>${fs.readFileSync(path.join(__dirname, '../public/app.css'), 'utf8')}</style><div id="app">${header}<div id="fleet"></div></div>${dialog}<pre id="result"></pre><script>
  var $=id=>document.getElementById(id),el=(tag,cls,txt)=>{var e=document.createElement(tag);e.className=cls||'';if(txt!=null)e.textContent=txt;return e;};
  var HP={cpu:['CPU','#ff5c7a'],ram:['RAM','#8c6dff'],disk:['Disk','#0fb5ae']},prefs={limits:{cpu:95,ram:90,disk:90}},rebootTarget=null,rebootBusy=false;
  var sample={id:'fake',name:'demo-server',on:true,cpu:13.23,ram:100,disk:64.35,sessions:[{state:'run'},{state:'wait'}],workers:[],sys:{ramUsedGb:1.16,ramTotalGb:31.34,disks:[{mount:'/',usedGb:62.25,totalGb:96.73}],rebootRequired:true,net:[]}};
  var list=[sample,{...sample,id:'fake2',name:'long-server-name',sys:{...sample.sys,rebootRequired:false}}];
  var scoped=()=>list,openDetail=()=>{},span=()=>'',sparkSVG=()=>'',refresh=()=>Promise.resolve(),api=()=>Promise.resolve();
  ${functions}
  var failures=[],checks=0;function check(v,msg){checks++;if(!v)failures.push(msg);}
  try{
    for(var width of [1280,1440,420])for(var theme of ['', 'dark']){
      document.documentElement.setAttribute('data-theme',theme);$('app').style.cssText='flex:none;width:'+width+'px';$('app').classList.toggle('compact',width<760);
      $('fleet').style.cssText='width:'+(width-(width<760?28:244))+'px;margin:14px';renderFleet();
      var cards=Array.from(document.querySelectorAll('.fc'));check(cards.length===2,'cards loaded');check(Math.abs(cards[0].offsetHeight-cards[1].offsetHeight)<1,'equal card heights '+width);
      for(var label of document.querySelectorAll('.rg-name,.rg-value,.rg i')){var r=label.getBoundingClientRect(),card=label.closest('.fc').getBoundingClientRect();check(r.left>=card.left&&r.right<=card.right&&r.bottom<=card.bottom,'inside card '+width);check(label.scrollWidth<=label.clientWidth+1,'no label overflow '+label.textContent+' '+width);}
      check(document.querySelector('.rg i').textContent==='13%','integer percent');check(document.querySelectorAll('.rg i')[1].textContent==='100%','100 percent fits');
      var labels=document.querySelectorAll('.rg-value');check(labels[1].textContent==='1.2/31.3G','RAM value');check(labels[2].textContent==='62.3/96.7G','disk value');
      var ringName=document.querySelector('.rg-name').getBoundingClientRect(),value=labels[0].getBoundingClientRect();check(value.top>=ringName.bottom-0.5,'separate label lines');
      var activeBrand=Array.from(document.querySelectorAll('#brand img')).find(function(img){return getComputedStyle(img).display!=='none';});check($('brand').getBoundingClientRect().width>=56,'brand visible '+width);check(activeBrand&&activeBrand.getBoundingClientRect().height===44,'44px brand image '+width);check(activeBrand&&activeBrand.classList.contains(width<760?'brand-mark':theme==='dark'?'brand-dark':'brand-light'),'responsive theme brand '+width+' '+theme);
      check($('brand').getBoundingClientRect().bottom<=document.querySelector('.top').getBoundingClientRect().bottom,'mark fits header');
      check(document.querySelectorAll('.reboot').length===1,'button only when needed');check(!document.querySelector('button button'),'no nested buttons');
    }
    document.querySelector('.reboot').click();check($('dlg-reboot').open,'dialog opens');check($('reboot-warning').textContent.includes('demo-server')&&$('reboot-warning').textContent.includes('2 phiên tmux'),'name and session warning');check($('reboot-ok').disabled,'initial disabled');
    for(var text of ['demo','demo-server ','DEMO-SERVER','demo-server']){$('reboot-name').value=text;$('reboot-name').oninput();check($('reboot-ok').disabled===(text!=='demo-server'),'exact name '+text);}
    $('dlg-reboot').close();sample.rebooting=true;renderFleet();check(document.querySelector('.reboot').disabled,'pending disabled');check(document.querySelector('.fc').textContent.includes('Đang khởi động lại'),'pending visible');
  }catch(e){failures.push(e.stack);}
  $('result').textContent=JSON.stringify({checks,failures});
  </script>`;
  const file = path.join(dir, 'fixture.html');fs.writeFileSync(file, fixture);
  const run = spawnSync(chrome, ['--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-background-networking', '--user-data-dir='+path.join(dir,'profile'), '--dump-dom', 'file://'+file], { encoding:'utf8', timeout:30000, maxBuffer:4*1024*1024 });
  assert.equal(run.status,0,run.error?.message||run.stderr.slice(-1000));
  const match = run.stdout.match(/<pre id="result">([^<]+)<\/pre>/);assert.ok(match,run.stdout.slice(-2000));
  const result=JSON.parse(match[1].replace(/&gt;/g,'>').replace(/&lt;/g,'<').replace(/&amp;/g,'&'));
  assert.ok(result.checks>150);assert.deepEqual(result.failures,[]);
});

test('tab and install icons use the Termnest brand', () => {
  const index = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.match(index, /<link rel="icon" type="image\/svg\+xml" href="\/termnest-icon.svg">/);
  assert.match(index, /<link rel="apple-touch-icon" href="\/icon-180.png">/);
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../public/manifest.webmanifest'), 'utf8'));
  assert.deepEqual(manifest.icons.map(icon => icon.src), ['/icon-192.png', '/icon-512.png']);
});
