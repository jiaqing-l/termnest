'use strict';
// Every pet kind a session may be given. Characters are drawn by an optional local pack (public/features/pets-cartoon.js);
// the ids live here so a saved choice stays valid on machines without that pack (they fall back to an automatic pet).
const ANIMALS = ['cat', 'fox', 'bunny', 'owl', 'penguin', 'frog', 'dog', 'pig', 'cow', 'duck', 'wolf', 'capy'];
const CHARACTERS = ['dora', 'nobi', 'xuka', 'chaien', 'xeko', 'tom', 'jerry', 'shin'];
module.exports = { ANIMALS, CHARACTERS, ALL: ['', ...ANIMALS, ...CHARACTERS] };
