'use strict';
// composer applier: delegates to lib/backup/composer.js apply() so backup, apply and restore share one
// implementation (apply gate, this run's snapshot required, path-scoped lockfile commits).
const impl = require('../backup/composer');

module.exports = { name: 'composer', apply: (targets, ctx) => impl.apply(targets, ctx) };
