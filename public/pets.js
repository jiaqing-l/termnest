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

    ,dog:{c:'#c58b5a',body:'#d9a273',
      ears:'<path d="M10 22c-6 8-4 22 2 26l8-14zM54 22c6 8 4 22-2 26l-8-14z" fill="#8a5a36"/>',
      face:'<ellipse cx="32" cy="46" rx="11" ry="8" fill="#f6dcc0"/><ellipse cx="32" cy="41" rx="4" ry="3" fill="#2a1d1a"/>'},
    pig:{c:'#ff8fb0',body:'#ffb3c8',
      ears:'<path d="M14 24 11 8l14 8zM50 24l3-16-14 8z" fill="#ff9db8"/>',
      face:'<ellipse cx="32" cy="44" rx="10" ry="8" fill="#ff8fb0"/><circle cx="28" cy="44" r="1.8" fill="#9a3358"/><circle cx="36" cy="44" r="1.8" fill="#9a3358"/>'},
    cow:{c:'#6b7280',body:'#fff',
      ears:'<path d="M8 24c-6-2-6-9-1-10 3 0 6 3 8 8zM56 24c6-2 6-9 1-10-3 0-6 3-8 8z" fill="#f2c9a0"/><path d="M18 18 16 6M46 18l2-12" stroke="#d8c8b0" stroke-width="4" stroke-linecap="round"/>',
      face:'<path d="M12 28c4-8 12-8 14-2-2 8-10 10-14 2zM40 30c6-8 14-6 12 2-4 8-10 6-12-2z" fill="#3a3a44"/><ellipse cx="32" cy="46" rx="12" ry="8" fill="#ffc9d6"/><circle cx="28" cy="46" r="1.7" fill="#9a3358"/><circle cx="36" cy="46" r="1.7" fill="#9a3358"/>'},
    duck:{c:'#ffc61a',body:'#ffd84d',
      ears:'<path d="M32 8c-4 0-6 4-4 7 4 0 6-3 4-7z" fill="#ffd84d"/>',face:'',
      beak:'<path d="M22 44c4-4 16-4 20 0-2 5-18 5-20 0z" fill="#ff9a1f"/>'},
    wolf:{c:'#7c8aa5',body:'#9aa7bf',
      ears:'<path d="M10 28 8 4l18 12zM54 28l2-24-18 12z" fill="#7c8aa5"/><path d="M13 18 13 10l7 5zM51 18l0-8-7 5z" fill="#ffb3c1"/>',
      face:'<path d="M14 42c6-6 12-5 18 6 6-11 12-12 18-6-3 10-9 14-18 14s-15-4-18-14z" fill="#e8edf6"/><ellipse cx="32" cy="43" rx="4" ry="3" fill="#232a3f"/>'},
    capy:{c:'#b7864b',body:'#c9985c',
      ears:'<circle cx="16" cy="20" r="6" fill="#a8763e"/><circle cx="48" cy="20" r="6" fill="#a8763e"/>',
      face:'<ellipse cx="32" cy="45" rx="13" ry="9" fill="#a8763e"/><ellipse cx="28" cy="44" rx="1.8" ry="2.4" fill="#2a1d1a"/><ellipse cx="36" cy="44" rx="1.8" ry="2.4" fill="#2a1d1a"/>'}
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
  // ORDER is the automatic pool (changing it would change every existing session's default pet); GROUPS feed the picker.
  var LABELS={cat:'Mèo',fox:'Cáo',bunny:'Thỏ',owl:'Cú',penguin:'Cánh cụt',frog:'Ếch',dog:'Chó',pig:'Heo',cow:'Bò',duck:'Vịt',wolf:'Sói',capy:'Capybara'};
  var GROUPS={animals:['cat','dog','pig','cow','duck','wolf','capy','fox','bunny','owl','penguin','frog'],characters:[]};
  function register(kind,def,label,group){
    if(!/^[a-z][a-z0-9-]{1,23}$/.test(kind)||!def||typeof def!=='object')return false;
    PETS[kind]=def;LABELS[kind]=String(label||kind).slice(0,24);var g=GROUPS[group]||(GROUPS[group]=[]);if(g.indexOf(kind)<0)g.push(kind);return true;
  }
  window.PetArt={pet:pet,PETS:PETS,ORDER:ORDER,GROUPS:GROUPS,LABELS:LABELS,register:register};
})();
