'use strict';
const os = require('os');
const { Remote } = require('./remote');
const { Local } = require('./local');
const LOCAL_ID = '00000000-0000-4000-8000-000000000001';
function localConfig() { return { id: LOCAL_ID, local: true, host: os.hostname(), user: os.userInfo().username, auth: 'local' }; }
function createBackend(cfg, onLearn, onPoll) { return cfg.local ? new Local(cfg, onLearn, onPoll) : new Remote(cfg, onLearn, onPoll); }
module.exports = { LOCAL_ID, localConfig, createBackend };
