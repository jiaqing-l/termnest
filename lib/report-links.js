'use strict';
// The HTML report runs in a sandboxed, script-only frame that cannot load files. This tiny script turns image
// paths found in its text into clickable links and asks the parent viewer (postMessage) to open them.
// First thing in the page: refuse every navigation of the frame itself (location.href = 'https://…?' + data). The Navigation API is
// cancelable for script-driven navigations; the CSP already blocks fetch, forms and sub-resources.
const GUARD = `<script>(function(){try{if(window.navigation&&navigation.addEventListener)navigation.addEventListener('navigate',function(e){if(e.cancelable&&!e.hashChange&&e.navigationType!=='reload')e.preventDefault();});}catch(_){}})();</script>`;
const SCRIPT = `<style>.twimg{cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px;border-radius:4px}.twimg:hover{background:rgba(47,128,237,.18);text-decoration:underline}</style>
<script>(function(){
var re=/(?:[A-Za-z]:[\\\\/]|\\/)?[\\p{L}\\p{N}_.@~+\\-]+(?:[\\\\/][\\p{L}\\p{N}_.@~+\\-]+)*\\.(?:png|jpe?g|gif|webp)(?![\\p{L}\\p{N}])/giu,paths=[];
var walker=document.createTreeWalker(document.body||document.documentElement,NodeFilter.SHOW_TEXT,{acceptNode:function(n){var p=n.parentNode&&n.parentNode.nodeName;return /^(SCRIPT|STYLE|A|TEXTAREA)$/.test(p)?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT;}}),nodes=[];
while(walker.nextNode())nodes.push(walker.currentNode);
nodes.forEach(function(node){var text=node.nodeValue,m,last=0,frag=null;re.lastIndex=0;
 while((m=re.exec(text))){if(!frag)frag=document.createDocumentFragment();if(m.index>last)frag.appendChild(document.createTextNode(text.slice(last,m.index)));
  var s=document.createElement('span');s.className='twimg';s.title='Bấm để xem ảnh';s.setAttribute('data-p',m[0]);s.textContent=m[0];frag.appendChild(s);if(paths.indexOf(m[0])<0)paths.push(m[0]);last=m.index+m[0].length;}
 if(frag){if(last<text.length)frag.appendChild(document.createTextNode(text.slice(last)));node.parentNode.replaceChild(frag,node);}});
// The viewer's A-/A+ zoom the page content (like browser zoom); the frame itself always fills the viewer.
addEventListener('message',function(e){if(e.source!==parent||!e.data||e.data.tw!=='zoom')return;var z=Number(e.data.scale);if(z>=0.5&&z<=2)document.documentElement.style.zoom=String(z);});
document.addEventListener('click',function(e){var t=e.target.closest&&e.target.closest('.twimg');if(!t)return;e.preventDefault();parent.postMessage({tw:'open-image',path:t.getAttribute('data-p'),list:paths.slice(0,500)},'*');});
})();</script>`;
function injectReportLinks(html) {
  // <meta http-equiv=refresh> is a navigation that needs no script: drop it.
  let text = String(html).replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi, '');
  // Inserted after <head> / the doctype, never before it: text ahead of a doctype would switch the report to quirks mode.
  const head = /<head\b[^>]*>/i.exec(text) || /<html\b[^>]*>/i.exec(text) || /^\s*<!doctype[^>]*>/i.exec(text);
  text = head ? text.slice(0, head.index + head[0].length) + GUARD + text.slice(head.index + head[0].length) : GUARD + text;
  const at = text.toLowerCase().lastIndexOf('</body>');
  return at < 0 ? text + SCRIPT : text.slice(0, at) + SCRIPT + text.slice(at);
}
module.exports = { injectReportLinks, SCRIPT, GUARD };
