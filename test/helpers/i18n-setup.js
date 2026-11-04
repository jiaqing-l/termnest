'use strict';
// The browser scripts call a global t(key). Tests read the real Vietnamese texts from public/locales/vi.json, so an assertion on a
// visible message still means something, and every VM context a test creates gets the same i18n().
const vm = require('node:vm');
// The product now follows the system language (English by default); the tests assert the Vietnamese texts, so pin the stored choice.
globalThis.localStorage = { getItem: (k) => (k === 'tw-lang' ? 'vi' : null), setItem() {} };
const i18n = require('../../public/i18n');
globalThis.i18n = i18n.t;
const withT = (ctx) => { if (ctx && typeof ctx === 'object' && !('i18n' in ctx)) ctx.i18n = i18n.t; return ctx; };
const runInNewContext = vm.runInNewContext, createContext = vm.createContext;
vm.runInNewContext = function (code, ctx, ...rest) { return runInNewContext.call(vm, code, withT(ctx === undefined ? {} : ctx), ...rest); };
vm.createContext = function (ctx, ...rest) { return createContext.call(vm, withT(ctx === undefined ? {} : ctx), ...rest); };
module.exports = i18n;
