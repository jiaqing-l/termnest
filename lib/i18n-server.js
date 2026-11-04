'use strict';
// Server-side texts (error messages, warnings, guidance) in the language of the request. The words are the same public/locales/*.json files the
// browser uses; the language comes from the X-TW-Lang header the page sends, and travels with the request through async code (AsyncLocalStorage).
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const FALLBACK = 'vi', DIR = path.join(__dirname, '..', 'public', 'locales'), store = new AsyncLocalStorage();
let cache = { stamp: '', locales: {} };
function locales() {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
  const stamp = files.map((f) => f + fs.statSync(path.join(DIR, f)).mtimeMs).join('|');
  if (stamp !== cache.stamp) {
    const all = {};
    for (const f of files) { try { all[f.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { /* skip a broken file */ } }
    cache = { stamp, locales: all };
  }
  return cache.locales;
}
function langOf(req) {
  const asked = String((req && req.headers && req.headers['x-tw-lang']) || '').toLowerCase();
  return /^[a-z]{2,8}$/.test(asked) && locales()[asked] ? asked : FALLBACK;
}
function tr(key, params, lang) {
  const all = locales(), use = lang || (store.getStore() || {}).lang || FALLBACK, table = all[use] || {};
  let msg = table[key];
  if (params && params[0] === 1 && table[key + '_one'] !== undefined) msg = table[key + '_one'];
  if (msg === undefined) msg = (all[FALLBACK] || {})[key];
  if (msg === undefined) return key;
  if (params === undefined || params === null) return msg;
  return msg.replace(/\{(\w+)\}/g, (m, k) => (params[k] === undefined || params[k] === null ? m : String(params[k])));
}
const withLang = (lang, fn) => store.run({ lang }, fn);
// For the top of a request handler: everything that request does afterwards (awaits, callbacks) keeps this language.
const setLang = (lang) => store.enterWith({ lang });
module.exports = { tr, langOf, withLang, setLang, locales };
