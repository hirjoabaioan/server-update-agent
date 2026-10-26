'use strict';
// npm applier: delegates to lib/backup/npm.js apply() so backup, apply and restore share one
// implementation (apply gate, this run's snapshot required, path-scoped lockfile commits).
const impl = require('../backup/npm');

module.exports = { name: 'npm', apply: (targets, ctx) => impl.apply(targets, ctx) };
