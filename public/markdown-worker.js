'use strict';
importScripts('/vendor/markdown-it.js','/file-viewer.js');
self.onmessage=event=>{
 // Split at complete top-level blocks; parsing stays off the terminal's UI thread.
 const html=self.FileViewer.markdown(event.data);
 // markdown-it closes top-level blocks with newlines. Keep nested structures intact.
 const chunks=[];let start=0,depth=0,chunk='';
 const tags=/<\/?(?:div|table|thead|tbody|tr|td|th|ul|ol|li|blockquote|pre|p|h[1-6])\b[^>]*>/g;
 let match;
 while((match=tags.exec(html))){
  depth+=match[0][1]==='/'?-1:1;
  if(depth===0&&tags.lastIndex-start>=32768){chunks.push(html.slice(start,tags.lastIndex));start=tags.lastIndex;}
 }
 chunk=html.slice(start);if(chunk)chunks.push(chunk);
 self.postMessage({chunks});
};
