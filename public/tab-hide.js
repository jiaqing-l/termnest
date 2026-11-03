'use strict';
// Closing a tab only hides it from the tab strip; the tmux session keeps running and stays in the sidebar and overview.
(function (root, factory) { if (typeof module === 'object') module.exports = factory(); else root.TabHide = factory(); })(typeof window === 'object' ? window : this, function () {
  var KEY = 'termnest.hiddenTabs', MAX = 200;
  function read(storage) {
    try { var v = JSON.parse(storage.getItem(KEY) || '[]'); return Array.isArray(v) ? v.filter(function (s) { return typeof s === 'string' && s.length < 300; }).slice(0, MAX) : []; }
    catch (e) { return []; }
  }
  function create(storage) {
    var hidden = read(storage);
    function save() { try { storage.setItem(KEY, JSON.stringify(hidden)); } catch (e) { /* private mode: stays in memory */ } }
    return {
      key: function (hostId, name) { return hostId + '/' + name; },
      isHidden: function (key) { return hidden.indexOf(key) >= 0; },
      hide: function (key) { if (hidden.indexOf(key) < 0) { hidden.unshift(key); hidden = hidden.slice(0, MAX); save(); } },
      show: function (key) { var i = hidden.indexOf(key); if (i >= 0) { hidden.splice(i, 1); save(); } },
      showAll: function () { hidden = []; save(); },
      list: function () { return hidden.slice(); },
      // keep(key) decides which hidden keys still matter; the caller must not drop keys for sessions it has not loaded yet.
      prune: function (keep) { var next = hidden.filter(keep); if (next.length !== hidden.length) { hidden = next; save(); } },
    };
  }
  return { create: create, KEY: KEY };
});
