'use strict';
// Node 22's `node --test <dir>` treats a directory argument as a module path (positional
// args are globs/files, not dirs), so `node --test tests/` resolves to
// this index.js. Load every *.test.js here so that command runs the whole suite.
const fs = require('fs');
const path = require('path');

for (const f of fs.readdirSync(__dirname).filter((n) => n.endsWith('.test.js')).sort()) {
  require(path.join(__dirname, f));
}
