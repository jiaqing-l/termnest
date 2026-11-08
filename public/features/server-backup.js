'use strict';
(function () {
  // Parse only human conversation content. Response items take precedence over duplicate event messages.
  function chatMessages(source) {
    var entries = [];
    function content(value) {
      if (typeof value === 'string') return value;
      return Array.isArray(value) ? value.filter(function (b) { return b && ['text', 'input_text', 'output_text'].indexOf(b.type) >= 0; }).map(function (b) { return typeof b.text === 'string' ? b.text : ''; }).filter(Boolean).join('\n') : '';
    }
    String(source || '').split('\n').forEach(function (line) {
      var record; try { record = JSON.parse(line); } catch (_) { return; }
      if (!record || typeof record !== 'object') return;
      var item = record.type === 'response_item' ? record.payload : record.message;
      if (item && ['user', 'assistant'].indexOf(item.role) >= 0) {
        var body = content(item.content); if (body) entries.push({ role: item.role, text: body, event: false });
      } else if (record.type === 'event_msg' && record.payload && ['user_message', 'agent_message'].indexOf(record.payload.type) >= 0) {
        var event = record.payload; var value = content(event.message);
        if (value) entries.push({ role: event.type === 'user_message' ? 'user' : 'assistant', text: value, event: true });
      }
    });
    var seen = new Set(entries.filter(function (m) { return !m.event; }).map(function (m) { return m.role + '\0' + m.text; }));
    return entries.filter(function (m) {
      if (!m.event) return true;
      var key = m.role + '\0' + m.text;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }).map(function (m) { return { role: m.role, text: m.text }; });
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { chatMessages: chatMessages };
  if (typeof window === 'undefined' || !window.TW) return;
  var TW = window.TW, el = TW.el, base = '/api/features/server-backup', card, rows, settings, destination, status = null, unavailable = false, pending = false, fetching = false;
  var storageDetails = null, drafts = Object.create(null), runPending = Object.create(null), queued = Object.create(null), dialog = null, viewRevision = 0;
  function t(key, args) { return i18n('backup.' + key, args); }
  function button(key, fn) { var b = el('button', 'btn', t(key)); b.type = 'button'; b.onclick = fn; return b; }
  function api(method, path, body) { return TW.api(method, base + path, body); }
  function url(path, server, snapshot, file) {
    var q = new URLSearchParams({ server: server, snapshot: snapshot }); if (file) q.set('file', file);
    return base + path + '?' + q.toString();
  }
  function link(key, href) { var a = el('a', 'btn', t(key)); a.href = href; a.download = ''; return a; }
  function reason(code) { var key = 'backup.reason_' + code, label = i18n(key); return label === key ? t('reason_unknown') : label; }
  function stamp(at) { return at ? new Date(at).toLocaleString(window.TW_I18N ? window.TW_I18N.lang() : undefined, { dateStyle: 'short', timeStyle: 'short' }) : t('never'); }
  function valid(r) { return r && typeof r.enabled === 'boolean' && Array.isArray(r.servers) && r.servers.every(function (s) { return s && typeof s.id === 'string' && typeof s.name === 'string' && typeof s.online === 'boolean' && typeof s.hasSnapshot === 'boolean' && typeof s.includeChats === 'boolean' && Array.isArray(s.roots) && s.roots.every(function (root) { return typeof root === 'string'; }); }) && r.storage && typeof r.storage.host === 'string' && typeof r.storage.path === 'string'; }
  async function refresh() {
    if (fetching || pending) return;
    fetching = true;
    try { var r = await api('GET', '/status'); if (!valid(r)) throw Error(); status = r; unavailable = false; }
    catch (_) { unavailable = true; }
    finally { fetching = false; render(); TW.emit('server-backup-updated'); }
  }
  async function control(body, confirms) {
    if (pending || fetching || unavailable || !status) return;
    pending = true; render();
    try {
      await api('POST', '/control', body);
      var r = await api('GET', '/status'); if (!valid(r) || !confirms(r)) throw Error();
      status = r; unavailable = false;
    } catch (_) { unavailable = true; }
    finally { pending = false; render(); }
  }
  function scope(server) {
    if (!drafts[server.id]) drafts[server.id] = { roots: server.roots.slice(), includeChats: server.includeChats === true, dirty: false };
    var draft = drafts[server.id], box = el('details', 'backup-scope');
    box.append(el('summary', '', t('folders')));
    var roots = el('div', 'backup-roots'), unsaved = el('p', 'backup-warning');
    function renderRoots() {
      roots.textContent = ''; unsaved.textContent = draft.dirty ? t('unsaved') : '';
      draft.roots.forEach(function (root) {
        var row = el('div'); row.append(el('span', '', root), button('remove', function () { draft.roots = draft.roots.filter(function (v) { return v !== root; }); draft.dirty = true; renderRoots(); })); roots.append(row);
      });
    }
    renderRoots(); box.append(roots, unsaved);
    var pick = button('choose', function () {
      var current = status && status.servers.find(function (s) { return s.id === server.id; });
      if (pending || unavailable || !current || !current.online) return;
      TW.app().browseDir(server.id, draft.roots[0] || '', function (path) {
        if (typeof path !== 'string' || path[0] !== '/' || pending) return;
        if (draft.roots.indexOf(path) < 0) draft.roots.push(path); draft.dirty = true; renderRoots();
      });
    }); pick.disabled = pending || unavailable || !server.online;
    var chats = el('input'); chats.type = 'checkbox'; chats.checked = draft.includeChats; chats.disabled = pending || unavailable;
    chats.onchange = function () { draft.includeChats = chats.checked; draft.dirty = true; renderRoots(); };
    var label = el('label'); label.append(chats, document.createTextNode(t('chats')));
    var save = button('save', function () {
      // Complete latest server configuration, replacing only the explicitly edited server.
      var config = status.servers.map(function (s) { return { serverId: s.id, roots: s.id === server.id ? draft.roots.slice() : s.roots.slice(), includeChats: s.id === server.id ? draft.includeChats : s.includeChats }; });
      control({ servers: config, enabled: status.enabled }, function (r) {
        var saved = r.servers.find(function (s) { return s.id === server.id; });
        if (!saved || saved.includeChats !== draft.includeChats || JSON.stringify(saved.roots.slice().sort()) !== JSON.stringify(draft.roots.slice().sort())) return false;
        draft.dirty = false; renderRoots(); return true;
      });
    }); save.disabled = pending || unavailable;
    box.append(pick, label, save);
    box.syncBackupScope = function (current) {
      if (draft.dirty) return;
      draft.roots = current.roots.slice(); draft.includeChats = current.includeChats; chats.checked = draft.includeChats; renderRoots();
    };
    return box;
  }
  function render() {
    if (!card) return;
    // Preserve scope control values and open state through polling and failed writes.
    var focused = document.activeElement;
    var scopes = Object.create(null); rows.querySelectorAll('[data-server]').forEach(function (row) { var s = row.querySelector('.backup-scope'); if (s) scopes[row.dataset.server] = s; });
    rows.textContent = ''; settings.textContent = '';
    if (unavailable) rows.append(el('p', 'backup-warning', t(status ? 'prior' : 'unavailable')), button('retry', refresh));
    if (pending) rows.append(el('p', '', t('saving')));
    if (!status) return;
    destination.textContent = t('destination', [status.storage.host]);
    var toggle = button(status.enabled ? 'pause' : 'enable', function () { var enabled = !status.enabled; control({ enabled: enabled }, function (r) { return r.enabled === enabled; }); });
    toggle.disabled = pending || unavailable; settings.append(toggle, el('span', '', pending ? t('saving') : t(status.enabled && !unavailable ? 'automatic' : unavailable ? 'unavailable' : 'paused')));
    if (!storageDetails) { storageDetails = el('details', 'backup-storage'); storageDetails.append(el('summary', '', t('storage_details')), el('p', 'backup-storage-path')); }
    storageDetails.querySelector('p').textContent = t('storage_path', [status.storage.path]); settings.append(storageDetails);
    status.servers.forEach(function (s) {
      var row = el('article', 'backup-row'); row.dataset.server = s.id;
      row.append(el('h4', '', s.name), el('span', 'backup-connection', t(s.online ? 'online' : 'offline')));
      if (queued[s.id] && (s.phase === 'running' || s.lastAttemptAt !== queued[s.id].attempt)) delete queued[s.id];
      row.append(el('p', '', s.hasSnapshot ? (s.lastSuccessAt ? t('latest', [stamp(s.lastSuccessAt)]) : t('saved_partial')) : t('never')));
      row.append(el('p', '', s.roots.length ? t(s.includeChats ? 'coverage' : 'files_coverage', [s.roots.length]) : t(s.includeChats ? 'chats_only' : 'no_scope')));
      if (s.phase === 'partial' || s.phase === 'error') row.append(el('p', 'backup-warning', t('attempt', [stamp(s.lastAttemptAt), reason(s.reason)])));
      if (s.phase === 'running' || queued[s.id]) row.append(el('p', '', t('running')));
      var actions = el('div', 'backup-actions');
      var run = button('run', async function () {
        if (runPending[s.id] || queued[s.id]) return; runPending[s.id] = true; render();
        try { var r = await api('POST', '/run', { serverId: s.id }); if (r && r.queued === true) queued[s.id] = { attempt: s.lastAttemptAt }; else throw Error(); }
        catch (_) { TW.app().say(t('run_failed'), false, 4000); }
        finally { runPending[s.id] = false; render(); refresh(); }
      }); run.disabled = pending || unavailable || !s.online || s.phase === 'running' || !!runPending[s.id] || !!queued[s.id];
      var chat = button('view_chat', function () { browse(s, true); }), files = button('files', function () { browse(s, false); });
      chat.disabled = files.disabled = !s.hasSnapshot;
      actions.append(run, chat, files);
      var folders = scopes[s.id] || scope(s); folders.syncBackupScope(s); row.append(actions, folders);
      row.querySelectorAll('.backup-scope button,.backup-scope input').forEach(function (c) { c.disabled = pending || unavailable || (!s.online && c.textContent === t('choose')); });
      rows.append(row);
    });
    if (focused && focused.isConnected && focused.closest('.backup-scope') && !focused.disabled) focused.focus({ preventScroll: true });
  }
  async function browse(server, chatsOnly) {
    if (dialog) dialog.close();
    var revision = ++viewRevision, box = el('dialog', 'backup-dialog'); dialog = box;
    var returnFocus = document.activeElement;
    box.addEventListener('keydown', function (event) { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); box.close(); } });
    box.addEventListener('cancel', function (event) { event.preventDefault(); event.stopPropagation(); box.close(); });
    box.addEventListener('close', function () { box.remove(); if (dialog === box) { viewRevision++; dialog = null; var target = returnFocus && returnFocus.isConnected ? returnFocus : document.querySelector('#dlg-set[open] .set-tab[aria-selected=true]'); if (target) target.focus(); } });
    box.append(el('h3', '', server.name), button('close', function () { box.close(); }));
    var note = el('p'), versions = el('select'), search = el('input'), list = el('div', 'backup-file-list'), preview = el('div', 'backup-preview'), exports = el('div');
    search.type = 'search'; search.placeholder = t('search'); search.setAttribute('aria-label', t('search')); versions.setAttribute('aria-label', t('snapshots'));
    var more = button('more', function () { loadFiles(true); }), cursor = null, fileRevision = 0;
    box.append(note, versions, exports, search, list, more, preview); document.body.append(box); box.showModal();
    async function loadFiles(append) {
      var request = ++fileRevision, snapshot = versions.value;
      if (!snapshot) return;
      more.disabled = true;
      if (!append) { cursor = null; list.textContent = ''; preview.textContent = ''; }
      try {
        var query = url('/files', server.id, snapshot) + '&search=' + encodeURIComponent(search.value) + (append && cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
        var r = await api('GET', query.slice(base.length));
        if (revision !== viewRevision || request !== fileRevision) return;
        if (!r || !Array.isArray(r.files)) throw Error();
        note.textContent = '';
        r.files.filter(function (f) { return !chatsOnly || f.kind === 'chat'; }).forEach(function (f) {
          var b = button('preview', async function () {
            var current = ++fileRevision, savedContent = el('div'); preview.textContent = '';
            preview.append(el('h4', '', f.path), link('original', url('/download', server.id, snapshot, f.id)), savedContent); savedContent.textContent = t('loading');
            try {
              var p = await api('GET', url('/preview', server.id, snapshot, f.id).slice(base.length));
              if (current !== fileRevision || revision !== viewRevision) return;
              savedContent.textContent = '';
              if (p.truncated) savedContent.append(el('p', 'backup-warning', t('truncated')));
              if (p.binary) { savedContent.append(el('p', '', t('binary'))); return; }
              if (typeof p.text !== 'string') throw Error();
              if (p.kind === 'chat') {
                var messages = chatMessages(p.text);
                if (!messages.length) savedContent.append(el('p', '', t('no_messages')));
                messages.forEach(function (m) { savedContent.append(el('b', '', t(m.role)), el('pre', '', m.text)); });
              } else savedContent.append(el('pre', '', p.text));
            } catch (_) { if (revision === viewRevision && current === fileRevision) savedContent.textContent = t('read_failed'); }
          }); b.textContent = f.path; list.append(b);
        });
        cursor = r.nextCursor; more.hidden = !cursor;
        if (!list.children.length) note.textContent = t('empty');
      } catch (_) { if (revision === viewRevision && request === fileRevision) note.textContent = t('read_failed'); }
      finally { more.disabled = false; }
    }
    versions.onchange = function () { exports.textContent = ''; exports.append(link('export', url('/export', server.id, versions.value))); loadFiles(false); };
    var timer; search.oninput = function () { clearTimeout(timer); fileRevision++; timer = setTimeout(function () { loadFiles(false); }, 200); };
    try {
      note.textContent = t('loading'); var result = await api('GET', '/snapshots?server=' + encodeURIComponent(server.id));
      if (revision !== viewRevision) return;
      if (!result || !Array.isArray(result.snapshots)) throw Error();
      result.snapshots.forEach(function (s) { var o = el('option', '', stamp(s.at) + ' · ' + t(s.complete ? 'complete' : 'partial')); o.value = s.id; versions.append(o); });
      if (!versions.options.length) { note.textContent = t('never'); return; }
      versions.onchange();
    } catch (_) { if (revision === viewRevision) note.textContent = t('read_failed'); }
  }
  TW.serverBackupCard = function () {
    if (!card) {
      card = el('section', 'ops-card backup-card'); destination = el('p', 'backup-destination'); card.append(el('h3', '', t('title')), destination);
      settings = el('details', 'backup-settings'); settings.append(el('summary', '', t('settings')));
      // Settings summary is persistent; render into a child.
      var content = el('div'); settings.append(content); card.append(settings); settings = content;
      rows = el('div'); rows.setAttribute('aria-live', 'polite'); rows.append(el('p', '', t('loading'))); card.append(rows); refresh();
    }
    return card;
  };
  function mountSettings() {
    var mount = document.getElementById('server-backup-settings-mount');
    if (mount && !mount.contains(TW.serverBackupCard())) mount.append(TW.serverBackupCard());
  }
  TW.serverBackupIssue = function (boardServers) {
    var failed = status && status.servers.some(function (s) { return s.online && (!boardServers || boardServers.some(function (v) { return v.id === s.id && v.online === true; })) && (s.phase === 'error' || s.phase === 'partial'); });
    if (!failed && !unavailable) return null;
    var b = button('review_issue', function () { TW.app().openSettings('backup'); }); b.classList.add('backup-issue'); return b;
  };
  TW.on('ready', mountSettings); mountSettings();
  setInterval(function () { if (!document.hidden) refresh(); }, 10000);
})();
