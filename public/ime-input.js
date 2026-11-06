'use strict';
(function (root) {
  // xterm 5.5's keyboard-229 timer and insertText-only input handler cannot model
  // WebKit marked-text replacements. Capture on an ANCESTOR: xterm registers
  // its own capture listeners on the textarea before an addon can attach.
  function attach(term, send, options) {
    options = options || {};
    var area = term.textarea, host = term.element;
    var nav = root.navigator || {}, ua = nav.userAgent || '';
    // Every WebKit that is not Chromium: Safari/WKWebView on macOS and WebKitGTK (the Ubuntu desktop app), where IBus
    // (Unikey, Bamboo) rewrites the helper textarea and xterm alone would send the old and the new text both.
    var enabled = options.enabled !== undefined ? options.enabled :
      /AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg\//.test(ua);
    var composing = false, pending = null, timer = null, idleTimer = null, disposed = false, emitting = false;
    var shadow = area.value, draft = '', startValue = '', start = 0, end = 0;
    var listeners = [], claimed = new Set(), overlay = null, anchor = null;
    var segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

    function nfc(text) { return text.normalize('NFC'); }
    function chars(text) { return segmenter ? Array.from(segmenter.segment(text), function (s) { return s.segment; }) : Array.from(text); }
    function busy() { return composing || !!pending; }
    function idle() {
      // A queued responsive split may dispose this pane. Never do that halfway
      // through the input/keydown currently propagating to xterm.
      clearTimeout(idleTimer);
      idleTimer = setTimeout(function () { if (!disposed && !busy() && options.onIdle) options.onIdle(); }, 0);
    }
    function stop(event) { event.stopImmediatePropagation(); } // Keep the native edit/IME default action.
    function listen(type, handler, capture) {
      capture = capture !== false;
      var wrapped = function (event) { if (event.target === area) handler(event); };
      host.addEventListener(type, wrapped, capture); listeners.push([type, wrapped, capture]);
    }
    function hide() {
      if (overlay) overlay.hidden = true;
      area.classList.remove('tw-ime-marked');
    }
    function show(text) {
      if (!overlay) {
        overlay = area.ownerDocument.createElement('div');
        overlay.className = 'tw-ime-preview'; overlay.setAttribute('aria-hidden', 'true');
        area.parentNode.appendChild(overlay);
      }
      // Freeze the native candidate anchor for this composition. xterm's render
      // callback otherwise rewrites textarea coordinates when PTY output arrives.
      if (!area.classList.contains('tw-ime-marked')) {
        var screen = host.querySelector('.xterm-screen');
        anchor = null;
        if (screen) {
          var bounds = screen.getBoundingClientRect(), helperBounds = area.parentNode.getBoundingClientRect();
          var buffer = term.buffer.active, cellWidth = bounds.width / term.cols, cellHeight = bounds.height / term.rows;
          if (cellWidth > 0 && cellHeight > 0) {
            anchor = { left: Math.min(buffer.cursorX, term.cols - 1) * cellWidth + bounds.left - helperBounds.left,
              top: Math.max(0, Math.min(term.rows - 1, buffer.baseY + buffer.cursorY - buffer.viewportY)) * cellHeight + bounds.top - helperBounds.top,
              right: bounds.right - helperBounds.left };
            // The initial textarea can still be at -9999em before the first
            // PTY cursor movement. Derive a visible anchor from public APIs.
            area.style.left = anchor.left + 'px'; area.style.top = anchor.top + 'px';
            area.style.width = Math.max(1, cellWidth) + 'px'; area.style.height = Math.max(1, cellHeight) + 'px';
            overlay.style.maxWidth = bounds.width + 'px';
          }
        }
        ['left', 'top', 'height', 'width'].forEach(function (key) {
          area.style.setProperty('--tw-ime-' + key, area.style[key] || '1px');
          overlay.style[key] = area.style[key];
        });
        area.classList.add('tw-ime-marked');
        overlay.style.fontFamily = term.options.fontFamily;
        overlay.style.fontSize = term.options.fontSize + 'px';
      }
      overlay.textContent = text; overlay.hidden = false;
      if (anchor) overlay.style.left = Math.max(0, Math.min(anchor.left, anchor.right - overlay.getBoundingClientRect().width)) + 'px';
    }
    function reconcile(value) {
      // Only the suffix represented by shadow has ever reached the PTY. An
      // in-progress syllable is never part of shadow, so it cannot cause DELs.
      var oldText = chars(nfc(shadow)), newText = chars(nfc(value)), i = 0;
      while (i < oldText.length && i < newText.length && oldText[i] === newText[i]) i++;
      var data = '\x7f'.repeat(oldText.length - i) + newText.slice(i).join('');
      shadow = value;
      if (data) {
        // Use xterm's public input API so disableStdin, scrollOnUserInput and
        // clearing the terminal selection retain their normal semantics.
        emitting = true;
        try { term.input(data, true); } finally { emitting = false; }
      }
    }
    function flush(notify) {
      if (!pending) return;
      clearTimeout(timer); timer = null;
      var value = pending.value; pending = null;
      if (enabled) reconcile(value);
      hide(); if (notify !== false) idle();
    }
    function finish(value) {
      composing = false;
      pending = { value: value };
      clearTimeout(timer);
      timer = setTimeout(flush, 0);
    }
    function reset() {
      clearTimeout(timer); timer = null; composing = false; pending = null;
      shadow = ''; draft = ''; claimed.clear(); hide();
      if (enabled) area.value = '';
    }
    function preparePaste() {
      if (!enabled) return;
      if (composing) finish(area.value);
      flush(); reset();
    }

    listen('compositionstart', function (event) {
      flush(false); composing = true; draft = '';
      startValue = area.value; start = area.selectionStart; end = area.selectionEnd;
      if (enabled) { stop(event); show(''); }
    });
    listen('compositionupdate', function (event) {
      draft = event.data || '';
      if (enabled) { stop(event); show(draft); }
    });
    listen('compositionend', function (event) {
      if (enabled) stop(event);
      if (!composing) return; // A final input may have committed first.
      var value = area.value;
      if (enabled && event.data !== undefined && event.data !== null) {
        // WebKit may publish compositionend before applying the last DOM edit.
        // Prefer a whole-value replacement when it already contains the commit.
        if (!event.data || !(value.endsWith(event.data) || value.slice(start, start + event.data.length) === event.data)) value = startValue.slice(0, start) + event.data + startValue.slice(end);
      }
      finish(value);
      // Observe during bubbling so xterm's textarea listener queues its native
      // commit before our guard release, without needing a second timer turn.
    }, enabled);
    listen('beforeinput', function (event) {
      if (enabled) stop(event);
    });
    listen('input', function (event) {
      if (!enabled) return;
      stop(event);
      if (composing) {
        draft = event.data === null ? draft : (event.data || ''); show(draft);
        // Some WebKit IMEs supply a final input without compositionend. CJK
        // composition input with isComposing=true must stay entirely local.
        if (event.isComposing === false) { finish(area.value); flush(); }
        return;
      }
      if (pending) { pending.value = area.value; flush(); }
      else reconcile(area.value);
    });
    listen('keydown', function (event) {
      if (!enabled) return;
      // Selection/copy can replace the helper textarea with terminal output.
      // That text was never typed into the PTY and must not enter our ledger.
      if (!busy() && (area.value !== shadow || term.hasSelection())) reset();
      var shortcut = event.ctrlKey || event.metaKey;
      if (composing && shortcut && (event.key.toLowerCase() === 'v' || event.key.toLowerCase() === 'c' && term.getSelection())) return;
      if (composing && !shortcut || event.isComposing || event.keyCode === 229) {
        claimed.add(event.code || event.key); stop(event); return;
      }
      flush();
      var textKey = !shortcut && (event.key.length === 1 || event.key === 'Dead' || event.key === 'Process' || event.key === 'Backspace' && !!area.value);
      if (textKey) {
        claimed.add(event.code || event.key); stop(event); return;
      }
      // xterm still owns navigation, control/meta keys, Enter, and paste. They
      // end our editable suffix; a later IME deletion must not erase stale text.
      reset();
    });
    listen('keypress', function (event) {
      if (enabled && (composing || claimed.has(event.code || event.key))) stop(event);
    });
    listen('keyup', function (event) {
      if (enabled && (composing || claimed.delete(event.code || event.key))) stop(event);
    });
    listen('paste', function () {
      // Clipboard is xterm's responsibility (including bracketed paste).
      preparePaste();
    });
    listen('blur', function () {
      if (composing) finish(area.value);
      if (enabled) { flush(); reset(); }
    });

    return {
      isComposing: busy,
      reset: reset,
      preparePaste: preparePaste,
      // Called for xterm-owned onData (shortcuts, paste, mouse protocols, etc.).
      // Do not filter this stream: it also carries non-keyboard terminal data.
      onData: function (data) { if (enabled && !busy() && !emitting) { shadow = ''; area.value = ''; } send(data); },
      dispose: function () {
        disposed = true; clearTimeout(idleTimer); reset();
        listeners.forEach(function (entry) { host.removeEventListener(entry[0], entry[1], entry[2]); });
        if (overlay) overlay.remove();
      }
    };
  }
  root.TerminalIME = { attach: attach };
  if (typeof module === 'object' && module.exports) module.exports = root.TerminalIME;
})(typeof window === 'object' ? window : globalThis);
