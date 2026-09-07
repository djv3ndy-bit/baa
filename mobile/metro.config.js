const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
require('./scripts/restrict-build-image-types.cjs')();
config.transformerPath = require.resolve('./scripts/safe-metro-transformer.cjs');

module.exports = config;
