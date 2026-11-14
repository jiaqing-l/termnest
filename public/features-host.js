'use strict';
// Browser half of the feature host. Features live in public/features/<name>.js (+ .css) and use window.TW only;
// app.js calls the render hooks below, so a feature never needs to edit app.js or index.html.
window.TW = (function () {
  var listeners = {}, detail = [], card = [], serverHead = [], views = [], appApi = null, bannerBox = null, banners = {};
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  // The page lists the content version of each feature file in <meta name="tw-assets"> (path -> hash), so the browser can keep them for good.
  function assetVersions() { try { var m = document.querySelector('meta[name="tw-assets"]'); return (m && JSON.parse(m.getAttribute('content'))) || {}; } catch (e) { return {}; } }
  function safe(fn, a, b, c) { try { return fn(a, b, c); } catch (e) { if (window.console) console.error('[TW]', e); return undefined; } }
  var TW = {
    el: el,
    attach: function (api) { appApi = api; },
    app: function () { return appApi; },
    api: function (method, path, body) { return appApi.api(method, path, body); },
    on: function (name, fn) { (listeners[name] = listeners[name] || []).push(fn); },
    emit: function (name, payload) { (listeners[name] || []).forEach(function (fn) { safe(fn, payload); }); },
    // Session detail panel: fn(ctx{v,s}) returns a Node (or null) appended after the built-in sections.
    addDetailSection: function (fn) { detail.push(fn); },
    // Session cards and tabs: fn(node, v, s) may append badges or classes.
    addCardDecorator: function (fn) { card.push(fn); },
    // Server heading in the overview: fn(node, v).
    addServerDecorator: function (fn) { serverHead.push(fn); },
    renderDetail: function (box, x) { detail.forEach(function (fn) { var n = safe(fn, x); if (n) box.append(n); }); },
    decorateCard: function (node, v, s) { card.forEach(function (fn) { safe(fn, node, v, s); }); },
    decorateServer: function (node, v) { serverHead.forEach(function (fn) { safe(fn, node, v); }); },
    // A whole screen next to Tổng quan / Terminal / Token AI: { id, label, mount(container), onShow?() }.
    addView: function (def) {
      if (!/^[a-z][a-z0-9-]{1,31}$/.test(def.id)) throw new Error('bad view id');
      var seg = document.querySelector('.main-top .seg'), anchor = document.getElementById('v-token') || document.getElementById('v-focus');
      if (!seg || !anchor) return null;
      var tab = el('button', '', def.label); tab.id = 'tab-' + def.id; tab.setAttribute('aria-pressed', 'false');
      tab.onclick = function () { appApi.setView(def.id); }; seg.append(tab);
      var section = el('section', 'view'); section.id = 'v-' + def.id; var box = el('div', 'feature-page'); section.append(box);
      (views.length ? views[views.length - 1].section : anchor).after(section);
      def.mount(box); views.push({ def: def, tab: tab, section: section });
      return { tab: tab, section: section, box: box };
    },
    setView: function (name) {
      views.forEach(function (v) {
        var on = v.def.id === name; v.section.classList.toggle('on', on); v.tab.setAttribute('aria-pressed', String(on));
        if (on) v.tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        if (on && v.def.onShow) safe(v.def.onShow);
      });
    },
    // Banner area under the top bar for urgent messages: { id, level: urgent|warn|info, title, detail, actions:[{label, primary, onClick}] }.
    banner: {
      show: function (o) {
        if (!bannerBox) { bannerBox = el('div', 'tw-banners'); bannerBox.setAttribute('role', 'status'); document.body.append(bannerBox); }
        var old = banners[o.id], n = el('div', 'tw-banner ' + (o.level || 'info')); n.append(el('b', '', o.title || ''));
        if (o.detail) n.append(el('span', 'tw-banner-detail', o.detail));
        var row = el('div', 'tw-banner-actions');
        (o.actions || []).forEach(function (a) { var b = el('button', 'btn' + (a.primary ? ' primary' : ''), a.label); b.type = 'button'; b.onclick = function () { safe(a.onClick); }; row.append(b); });
        if (row.children.length) n.append(row);
        if (old) old.replaceWith(n); else bannerBox.append(n);
        banners[o.id] = n;
      },
      hide: function (id) { if (banners[id]) { banners[id].remove(); delete banners[id]; } },
    },
    // Load every feature module the server lists, then announce them. Safe to call once after login.
    loaded: false,
    load: function () {
      if (TW.loaded) return Promise.resolve();
      TW.loaded = true;
      return appApi.api('GET', '/api/features').then(function (r) {
        // Every file is requested at once (the server already told the browser to preload them); scripts inserted with async=false still
        // run one after the other in the order the server listed them, so the registration order is the same as when each waited for the previous.
        var versions = assetVersions();
        function url(path) { return versions[path] ? path + '?v=' + versions[path] : path; }
        return Promise.all((r.modules || []).map(function (m) {
          if (m.css) { var l = document.createElement('link'); l.rel = 'stylesheet'; l.href = url('/features/' + m.name + '.css'); document.head.append(l); }
          return new Promise(function (resolve) { var s = document.createElement('script'); s.async = false; s.src = url('/features/' + m.name + '.js'); s.onload = s.onerror = resolve; document.head.append(s); });
        }));
      }).then(function () { TW.emit('ready'); }).catch(function () { TW.loaded = false; });
    },
  };
  return TW;
})();
