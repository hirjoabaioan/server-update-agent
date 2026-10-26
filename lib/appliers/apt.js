'use strict';
// apt applier: delegates to lib/backup/apt.js apply() so backup, apply and restore share one
// implementation (window check, repack verification, policy-rc.d, graceful reload, holds).
const apt = require('../backup/apt');

module.exports = { name: 'apt', apply: (targets, ctx) => apt.apply(targets, ctx) };
