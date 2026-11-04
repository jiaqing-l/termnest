'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const i18n = require('../public/i18n');
const dir = path.join(__dirname, '../public/locales');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
const locale = (code) => JSON.parse(fs.readFileSync(path.join(dir, code + '.json'), 'utf8'));
const holes = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join(',');

test('every language file has the same keys and the same placeholders as Vietnamese', () => {
  const vi = locale('vi');
  assert.ok(files.length >= 2, 'at least Vietnamese and English');
  for (const f of files) {
    const other = locale(f.slice(0, -5));
    assert.deepEqual(Object.keys(vi).filter((k) => !(k in other)), [], f + ' is missing keys');
    assert.deepEqual(Object.keys(other).filter((k) => !(k in vi) && !(/_one$/.test(k) && k.slice(0, -4) in vi)), [], f + ' has keys Vietnamese does not');
    for (const k of Object.keys(vi)) assert.equal(holes(other[k]), holes(vi[k]), f + ': placeholders of ' + k);
    for (const k of Object.keys(other).filter((x) => /_one$/.test(x))) assert.equal(holes(other[k]), holes(other[k.slice(0, -4)]), f + ': placeholders of ' + k);
    assert.ok(other['lang.name'], f + ' names itself');
    assert.match(other['lang.flag'], /^<svg[\s\S]*<\/svg>$/, f + ' brings its own flag (an inline SVG shows on every system)');
    assert.ok(!/<script|on\w+=/i.test(other['lang.flag']), f + ' flag is plain artwork');
  }
});

test('English values contain no Vietnamese letters', () => {
  const VI = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;
  const bad = Object.entries(locale('en')).filter(([k, v]) => k !== 'lang.name' && VI.test(v)).map(([k]) => k);
  assert.deepEqual(bad, []);
});

test('every key used in the scripts and in index.html exists', () => {
  const vi = locale('vi'), used = new Set();
  const pub = path.join(__dirname, '../public');
  const scripts = fs.readdirSync(pub).filter((f) => f.endsWith('.js')).map((f) => path.join(pub, f)).concat(fs.readdirSync(path.join(pub, 'features')).map((f) => path.join(pub, 'features', f)));
  for (const f of scripts) for (const m of fs.readFileSync(f, 'utf8').matchAll(/\bi18n\((['"])([a-z0-9]+\.[a-z0-9_]*[a-z0-9])\1/g)) used.add(m[2]);
  const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  for (const m of html.matchAll(/data-i18n="([^"]+)"/g)) used.add(m[1]);
  for (const m of html.matchAll(/data-i18n-attrs="([^"]+)"/g)) m[1].split(';').forEach((p) => used.add(p.slice(p.indexOf(':') + 1)));
  // alerts.cat_<name> is built from a list in app.js
  for (const c of ['ask', 'quiet', 'load', 'service', 'restart', 'offline']) used.add('alerts.cat_' + c);
  assert.deepEqual([...used].filter((k) => !(k in vi)), []);
});

test('t fills {0} by position and {name} by name, falls back to Vietnamese, then to the key', () => {
  assert.equal(i18n.t('app.phut_truoc', [5]), '5 phút trước');
  assert.equal(i18n.t('app.gio_phut', [2, 30]), '2 giờ 30 phút');
  assert.equal(i18n.t('no.such.key'), 'no.such.key');
  assert.equal(i18n.t('app.phut_truoc'), '{0} phút trước', 'a missing parameter leaves the hole visible');
  assert.equal(i18n.lang(), 'vi');
  assert.deepEqual(i18n.languages().map((l) => l.code).sort(), files.map((f) => f.slice(0, -5)).sort());
});

test('the language runtime picks the stored language in a browser and applies data-i18n to the page', () => {
  const vm = require('node:vm');
  const attrs = {}, nodes = [{ attrs: { 'data-i18n': 'app.dang_chay' }, textContent: '' }, { attrs: { 'data-i18n-attrs': 'placeholder:html.tim_phien_theo_ten_thu;title:html.canh_bao' }, set: {} }];
  const mk = (n) => Object.assign(n, { getAttribute: (k) => n.attrs[k], setAttribute: (k, v) => { n.set = n.set || {}; n.set[k] = v; } });
  nodes.forEach(mk);
  const document = { readyState: 'complete', addEventListener() {}, documentElement: mk({ attrs: {} }), querySelectorAll: (sel) => nodes.filter((n) => n.attrs[sel.slice(1, -1)] !== undefined) };
  const window = { TW_LOCALES: { vi: locale('vi'), en: locale('en') }, localStorage: { getItem: () => 'en', setItem() {} }, document };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/i18n.js'), 'utf8'), window);
  assert.equal(window.i18n('app.dang_chay'), 'Running');
  assert.equal(nodes[0].textContent, 'Running');
  assert.equal(nodes[1].set.placeholder, 'Search sessions by name, folder, screen content');
  assert.equal(document.documentElement.set.lang, 'en');
});

test('the desktop splash words are generated from the language files and are up to date', () => {
  const { build } = require('../scripts/build-splash-locales');
  assert.equal(fs.readFileSync(path.join(__dirname, '../desktop/ui/locales.js'), 'utf8').replace(/\r\n/g, '\n'), build(), 'run: npm run build:splash');   // a Windows checkout turns LF into CRLF
  const splash = fs.readFileSync(path.join(__dirname, '../desktop/ui/index.html'), 'utf8');
  for (const k of ['splash.opening', 'splash.first_run', 'html.tagline']) assert.match(splash, new RegExp('data-i18n="' + k.replace('.', '\\.') + '"'));
  assert.doesNotMatch(splash, /Every session|Đang mở/, 'no words hard-coded in the splash');
});

test('a singular form is used for exactly 1 and the plural otherwise', () => {
  const vm = require('node:vm');
  const window = { TW_LOCALES: { vi: locale('vi'), en: locale('en') }, localStorage: { getItem: () => 'en', setItem() {} } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/i18n.js'), 'utf8'), window);
  assert.equal(window.i18n('app.phien_2', [1]), '1 session');
  assert.equal(window.i18n('app.phien_2', [2]), '2 sessions');
  assert.equal(window.i18n('app.phien_2', [0]), '0 sessions');
  assert.equal(window.i18n('app.local_name'), 'This computer');
});

test('English locale contains no Vietnamese text', () => {
  const en = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'locales', 'en.json'), 'utf8'));
  const viChars = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i;
  const leaks = Object.keys(en).filter((k) => viChars.test(en[k]));
  assert.deepEqual(leaks, []);
});

test('first run follows the system language and falls back to English', () => {
  const fs2 = require('node:fs'), vm = require('node:vm');
  const src = fs2.readFileSync(path.join(__dirname, '..', 'public', 'i18n.js'), 'utf8');
  const locales = { vi: { 'lang.name': 'Tiếng Việt' }, en: { 'lang.name': 'English' } };
  const langFor = (navLang) => { const ctx = { TW_LOCALES: locales, navigator: { language: navLang }, localStorage: { getItem: () => null, setItem() {} } }; ctx.window = ctx; vm.runInNewContext(src, ctx); return ctx.TW_I18N.lang(); };
  assert.equal(langFor('vi-VN'), 'vi');
  assert.equal(langFor('fr-FR'), 'en');
  assert.equal(langFor(''), 'en');
});
