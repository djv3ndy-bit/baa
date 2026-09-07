'use strict';

// Metro's worker processes have separate module caches. Apply the same guard
// here rather than relying on main-process Metro configuration alone.
require('./restrict-build-image-types.cjs')();
const { createRequire } = require('node:module');
const expoRequire = createRequire(require.resolve('expo/metro-config'));
module.exports = expoRequire('@expo/metro-config/build/transform-worker/transform-worker');
