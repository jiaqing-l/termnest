// Interface scale (Cài đặt → Giao diện). External file: the page's CSP forbids inline scripts.
(function(){var z=100;try{var v=parseInt(localStorage.getItem('tw-zoom'),10);if([70,80,90,100].indexOf(v)>-1)z=v}catch(e){}
function ap(n){var r=document.documentElement;r.style.setProperty('--ui-z',String(n/100));
 // CSS zoom is ignored by some WebViews (the packaged app), so any scale other than 100% uses a transform on <body>, which every engine honours.
 r.classList.toggle('z-tf',n!==100)}
ap(z);window.TW_setZoom=function(n){n=parseInt(n,10);if([70,80,90,100].indexOf(n)<0)n=100;try{localStorage.setItem('tw-zoom',String(n))}catch(e){}ap(n);return n}})();
