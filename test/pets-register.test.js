'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const kinds = require('../lib/pet-kinds');
const { cleanPrefs } = require('../lib/parse');

function load(file) { const window = {}; vm.runInNewContext(fs.readFileSync(require.resolve(file), 'utf8'), { window }); return window; }

test('every animal in the picker is drawn, and the automatic pool is unchanged', () => {
  const { PetArt } = load('../public/pets.js');
  assert.deepEqual([...PetArt.ORDER], ['cat', 'fox', 'bunny', 'owl', 'penguin', 'frog']);
  for (const k of kinds.ANIMALS) { assert.ok(PetArt.PETS[k], k); assert.match(PetArt.pet(k, 'run'), /^<svg/); assert.ok(PetArt.LABELS[k]); }
  assert.deepEqual([...PetArt.GROUPS.animals].sort(), [...kinds.ANIMALS].sort());
});

test('register adds pets from a pack, rejects unsafe ids and keeps groups unique', () => {
  const { PetArt } = load('../public/pets.js');
  assert.equal(PetArt.register('dora', { c: '#fff', body: '#fff', ears: '', face: '' }, 'Dora', 'characters'), true);
  assert.equal(PetArt.register('dora', { c: '#000', body: '#000', ears: '', face: '' }, 'Dora', 'characters'), true);
  assert.deepEqual([...PetArt.GROUPS.characters], ['dora']);
  for (const bad of ['', 'A', '../x', 'x y', '1abc', 'a'.repeat(30)]) assert.equal(PetArt.register(bad, { c: '#fff' }, 'x', 'characters'), false);
  assert.equal(PetArt.register('ok', null, 'x', 'characters'), false);
  assert.match(PetArt.pet('dora', 'wait'), /^<svg/);
});

test('the local cartoon pack registers every character id the server accepts', () => {
  const p = '../public/features/pets-cartoon.js';
  let exists = true; try { require.resolve(p); } catch { exists = false; }
  if (!exists) return; // the pack is local-only; CI and installers never have it
  const win = load('../public/pets.js'); win.PetArt = win.PetArt;
  vm.runInNewContext(fs.readFileSync(require.resolve(p), 'utf8'), { window: win });
  assert.deepEqual([...win.PetArt.GROUPS.characters].sort(), [...kinds.CHARACTERS].sort());
});

test('the server accepts every known kind and still rejects anything else', () => {
  const key = '00000000-0000-4000-8000-000000000001/work';
  for (const kind of kinds.ALL) assert.equal(cleanPrefs({ pets: { [key]: { name: 'N', kind, hat: '' } } }, {}).pets[key].kind, kind);
  for (const kind of ['script', 'DORA', 'dora ', '../x', 'shinchan']) assert.throws(() => cleanPrefs({ pets: { [key]: { name: 'N', kind, hat: '' } } }, {}), /Invalid pet/);
});
