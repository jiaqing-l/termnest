// Injected only into the main webview; Rust also enforces the exact local origin.
(() => {
  if (window.top !== window || location.origin !== window.__TMUX_DESKTOP_ORIGIN) return;
  const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
  const stage = label => invoke('desktop_stage', {stage: label}).catch(() => {});
  stage('bridge');
  const report = error => alert('Không thực hiện được: ' + error);
  window.TW_DESKTOP = {
    ready: () => invoke('desktop_ready'),
    copy: text => invoke('plugin:clipboard-manager|write_text', {text}),
    paste: () => invoke('plugin:clipboard-manager|read_text'),
    save: (name, text) => invoke('save_export', {name, data: Array.from(new TextEncoder().encode(text))})
  };
  class DesktopNotification {
    static permission = 'default';
    static async requestPermission() {
      return this.permission = await invoke('plugin:notification|request_permission');
    }
    constructor(title, options = {}) {
      invoke('plugin:notification|notify', {options: {title, body: options.body || ''}}).catch(report);
    }
    close() {}
  }
  invoke('plugin:notification|is_permission_granted').then(granted => {
    DesktopNotification.permission = granted ? 'granted' : 'default';
  }).catch(() => {});
  window.Notification = DesktopNotification;
  const download = (url, name) => fetch(url)
    .then(r => { if (!r.ok) throw new Error('Không tải được tệp'); return r.arrayBuffer(); })
    .then(data => invoke('save_export', {name, data: Array.from(new Uint8Array(data))})).catch(report);
  const open = url => {
    const target = new URL(url, location.href);
    if (target.protocol === 'blob:' && target.origin === location.origin) download(target.href, 'download.txt');
    else if (target.origin === location.origin) location.assign(target.href);
    else invoke('open_external', {url: target.href}).catch(report);
    return null;
  };
  window.open = url => open(url || location.href);
  const anchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.hasAttribute('download')) {
      const url = new URL(this.href, location.href);
      if (url.origin !== location.origin) return report('Địa chỉ tải xuống không hợp lệ.');
      download(url.href, this.download || 'download.txt');
    } else anchorClick.call(this);
  };
  document.addEventListener('click', event => {
    const link = event.target.closest && event.target.closest('a[href]');
    if (!link) return;
    if (link.hasAttribute('download')) {
      event.preventDefault();
      const url = new URL(link.href, location.href);
      if (url.origin !== location.origin) return report('Địa chỉ tải xuống không hợp lệ.');
      download(url, link.download || 'download.txt');
    } else if (link.target === '_blank' || new URL(link.href).origin !== location.origin) {
      event.preventDefault(); open(link.href);
    }
  }, true);
  window.addEventListener('DOMContentLoaded', async () => {
    try {
      stage('dom');
      await document.fonts.ready;
      stage('fonts');
      const response = await fetch('/api/status');
      if (!response.ok || !document.querySelector('#app') || !window.Terminal) throw new Error('Trang chưa sẵn sàng');
      stage('status');
      if (await invoke('desktop_smoke')) {
        // Exercise xterm against the actual system WebView, not a browser mock.
        stage('terminal-open');
        const host = document.createElement('div');
        host.style.cssText = 'width:640px;height:320px;position:fixed;inset:0;background:#101527;z-index:99999';
        document.body.append(host);
        const term = new window.Terminal({fontFamily: '"JetBrains Mono",monospace'});
        const fit = new window.FitAddon.FitAddon(); term.loadAddon(fit); term.open(host); fit.fit();
        stage('terminal-write');
        await new Promise(resolve => term.write('Tiếng Việt: đang chờ bạn', resolve));
        if (!term.buffer.active.getLine(0).translateToString(true).includes('Tiếng Việt')) throw new Error('Unicode terminal render failed');
        stage('terminal-paste');
        let input = ''; term.onData(text => input += text); term.paste('xin chào');
        if (input !== 'xin chào') throw new Error('Terminal paste failed');
        stage('terminal-resize');
        const cols = term.cols; host.style.width = '320px'; fit.fit();
        if (term.cols >= cols) throw new Error('Terminal resize failed');
        term.dispose(); host.remove(); stage('terminal');
      }
      stage('ready');
      await window.TW_DESKTOP.ready();
    } catch (error) { await stage('failed'); report(error); }
  });
})();
