'use strict';
// Mascots: hand-built SVG, no external images.
(function(){
  var PETS={
    cat:{c:'#ffa63d',body:'#ffb95e',
      ears:'<path d="M14 26 12 8l15 9zM50 26l2-18-15 9z" fill="#ffb95e"/><path d="M16 20 15 13l7 4zM48 20l1-7-7 4z" fill="#ff8fa3"/>',
      face:'<path d="M32 14v7M25 15l1 5M39 15l-1 5" stroke="#e8842a" stroke-width="2.4" stroke-linecap="round"/><path d="M9 38h9M10 44l8-2M55 38h-9M54 44l-8-2" stroke="#7a4a1c" stroke-width="1.6" stroke-linecap="round"/>'},
    fox:{c:'#ff6b4a',body:'#ff7f5c',
      ears:'<path d="M12 28 10 6l19 12zM52 28l2-22-19 12z" fill="#ff7f5c"/><path d="M14 14l1 8 6-4zM50 14l-1 8-6-4z" fill="#5a2a1e"/>',
      face:'<path d="M12 40c6-4 14-3 20 10 6-13 14-14 20-10-3 11-11 18-20 18s-17-7-20-18z" fill="#fff"/>'},
    bunny:{c:'#ff7fb0',body:'#ffc2d8',
      ears:'<rect x="18" y="1" width="11" height="28" rx="5.5" fill="#ffc2d8"/><rect x="35" y="1" width="11" height="28" rx="5.5" fill="#ffc2d8"/><rect x="21" y="6" width="5" height="19" rx="2.5" fill="#ff8fb7"/><rect x="38" y="6" width="5" height="19" rx="2.5" fill="#ff8fb7"/>',
      face:''},
    owl:{c:'#8c6dff',body:'#a48cff',
      ears:'<path d="M14 18 13 7l11 6zM50 18l1-11-11 6z" fill="#a48cff"/>',
      face:'<circle cx="23" cy="34" r="10" fill="#fff"/><circle cx="41" cy="34" r="10" fill="#fff"/><path d="M28 50c3 3 5 4 4 4s1-1 4-4" stroke="#7a5be0" stroke-width="2" stroke-linecap="round" fill="none"/>',beak:'<path d="m32 39-4 3 4 5 4-5z" fill="#ffb020"/>'},
    penguin:{c:'#35a7ff',body:'#2c3a63',
      ears:'',face:'<path d="M32 22c7-7 19-1 19 16 0 13-9 20-19 20s-19-7-19-20c0-17 12-23 19-16z" fill="#fff"/>',beak:'<path d="m32 41-5 3 5 4 5-4z" fill="#ffa726"/>'},
    frog:{c:'#2fc68a',body:'#58d9a3',
      ears:'<circle cx="19" cy="20" r="10" fill="#58d9a3"/><circle cx="45" cy="20" r="10" fill="#58d9a3"/>',face:''}
  };
  var ORDER=['cat','fox','bunny','owl','penguin','frog'];
  function pet(kind,state,cls){
    var p=PETS[kind],closed=state==='idle',ey=kind==='frog'?20:kind==='owl'?34:36,ex=kind==='frog'?19:kind==='owl'?23:22,ex2=64-ex,r=kind==='owl'?4.6:3.6;
    var eyes=closed
      ?'<path d="M'+(ex-5)+' '+ey+'q5 4 10 0M'+(ex2-5)+' '+ey+'q5 4 10 0" stroke="#1d2340" stroke-width="2.6" fill="none" stroke-linecap="round"/>'
      :'<g class="eye"><circle cx="'+ex+'" cy="'+ey+'" r="'+r+'" fill="#1d2340"/><circle cx="'+(ex+1.4)+'" cy="'+(ey-1.5)+'" r="1.3" fill="#fff"/><circle cx="'+ex2+'" cy="'+ey+'" r="'+r+'" fill="#1d2340"/><circle cx="'+(ex2+1.4)+'" cy="'+(ey-1.5)+'" r="1.3" fill="#fff"/></g>';
    var mouth=kind==='owl'||kind==='penguin'?'':(state==='wait'
      ?'<ellipse cx="32" cy="48" rx="3" ry="3.6" fill="#7a2a3a"/>'
      :'<path d="M26 46q3 4 6 0q3 4 6 0" stroke="#7a2a3a" stroke-width="2.2" fill="none" stroke-linecap="round"/>');
    var nose=(kind==='cat'||kind==='bunny'||kind==='fox')?'<path d="m32 42-2.6-2.6h5.2z" fill="'+(kind==='fox'?'#40201a':'#ff6f91')+'"/>':'';
    var cheeks=kind==='penguin'||kind==='owl'?'':'<ellipse cx="14" cy="45" rx="4.4" ry="3" fill="#ff7f9c" opacity=".55"/><ellipse cx="50" cy="45" rx="4.4" ry="3" fill="#ff7f9c" opacity=".55"/>';
    var badge=state==='wait'?'<circle cx="54" cy="12" r="10" fill="#ffb020" stroke="#fff" stroke-width="2"/><path d="M54 6v7" stroke="#3b2500" stroke-width="3" stroke-linecap="round"/><circle cx="54" cy="17.5" r="1.8" fill="#3b2500"/>'
      :state==='idle'?'<text x="50" y="16" font-family="Nunito,sans-serif" font-weight="900" font-size="15" fill="#7c89a6">z</text>':'';
    var anim=state==='run'?' m-run':state==='wait'?' m-wait':'';
    return '<svg viewBox="0 0 64 64" class="pet-art '+(cls||'')+'" aria-hidden="true"><g class="m'+anim+'">'+p.ears+
      '<ellipse cx="32" cy="38" rx="23" ry="21" fill="'+p.body+'"/>'+p.face+cheeks+eyes+(p.beak||'')+nose+mouth+'</g>'+badge+'</svg>';
  }
  window.PetArt={pet:pet,PETS:PETS,ORDER:ORDER};
})();
