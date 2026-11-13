// Interface scale (Cài đặt → Giao diện). External file: the page's CSP forbids inline scripts.
(function(){var z=100;try{var v=parseInt(localStorage.getItem('tw-zoom2'),10);if([70,80,90,100].indexOf(v)>-1)z=v}catch(e){}
function ap(n){var r=document.documentElement;r.style.setProperty('--ui-z',String(n/100));
 // Scale = CSS zoom on <body>. (A transform scale was tried: it broke the terminal mouse mapping, selecting the wrong line.)
 r.classList.remove('z-tf')}
ap(z);window.TW_setZoom=function(n){n=parseInt(n,10);if([70,80,90,100].indexOf(n)<0)n=100;try{localStorage.setItem('tw-zoom2',String(n))}catch(e){}ap(n);return n}})();
