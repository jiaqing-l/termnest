'use strict';
// Falling / rising / drifting / bursting particles over the page (Settings → Hiệu ứng). Pure decoration: the layer ignores the pointer.
(function (root) {
  var KINDS = {
    noel: { img: ['snow', 'snow', 'ball', 'gift'], n: 30, mode: 'fall', d: 10 },
    phaohoa: { img: [], n: 5, mode: 'burst', d: 2.6 }
  };
  var COLORS = ['#ff3d6e', '#ffb300', '#1fb6ff', '#2ecc71', '#b05cff', '#ff7a1a'];
  function r(a, b) { return a + Math.random() * (b - a); }
  function render(layer, kind, amount, narrow) {
    layer.textContent = ''; layer.className = ''; var cfg = KINDS[kind]; if (!cfg) return 0;
    var n = Math.max(3, Math.round(cfg.n * (amount || 1) * (narrow ? 0.5 : 1))); layer.className = cfg.mode; layer.setAttribute('data-k', kind);
    for (var k = 0; k < n; k++) {
      var p = document.createElement('i'), sz = cfg.size ? r(cfg.size[0], cfg.size[1]) : cfg.mode === 'rain' ? r(14, 30) : cfg.mode === 'twinkle' ? r(6, 18) : r(12, 26);
      var img = cfg.img.length ? cfg.img[Math.floor(Math.random() * cfg.img.length)] : '';
      p.style.cssText = (img ? '--img:var(--img-' + img + ');' : '') + '--x:' + r(0, 100).toFixed(1) + '%;--y:' + r(4, 90).toFixed(1) + '%;--s:' + sz.toFixed(0) + 'px;--o:' + r(0.55, 0.95).toFixed(2) + ';--d:' + (cfg.d * r(0.7, 1.5)).toFixed(1) + 's;--dl:-' + r(0, cfg.d).toFixed(1) + 's;--dx:' + r(-90, 90).toFixed(0) + 'px;--rot:' + r(180, 720).toFixed(0) + 'deg';
      if (cfg.mode === 'burst') {
        p.style.setProperty('--x', r(8, 92).toFixed(1) + '%'); p.style.setProperty('--y', r(8, 55).toFixed(1) + '%');
        var col = COLORS[Math.floor(Math.random() * COLORS.length)], radius = r(60, 130), sparks = 18;
        for (var q = 0; q < sparks; q++) {
          var b = document.createElement('b'), a = (q / sparks) * Math.PI * 2;
          b.style.cssText = '--c:' + col + ';--s:6px;--tx:' + (Math.cos(a) * radius).toFixed(0) + 'px;--ty:' + (Math.sin(a) * radius + 18).toFixed(0) + 'px;--d:2.2s;--dl:' + (-r(0, cfg.d)).toFixed(1) + 's';
          p.append(b);
        }
        p.style.left = 'var(--x)';
      }
      layer.append(p);
    }
    return n;
  }
  root.TwFx = { KINDS: KINDS, render: render };
})(window);
