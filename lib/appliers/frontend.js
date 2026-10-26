'use strict';
// frontend applier: delegates to lib/backup/frontend.js apply() so backup, apply and restore share one
// implementation (apply gate, this run's snapshot required, path-scoped lockfile commits).
const impl = require('../backup/frontend');

module.exports = { name: 'frontend', apply: (targets, ctx) => impl.apply(targets, ctx) };
