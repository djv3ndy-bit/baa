'use strict';

// image-size has no published fix for the ICNS/JXL/HEIF parser advisories.
// Disable those unused build asset formats before either Metro process reads
// image headers. Runtime photos/videos fetched from URLs never enter Metro.
const { createRequire } = require('node:module');
module.exports = function restrictBuildImageTypes() {
  // Resolve through Metro's actual Expo consumer; pnpm need not hoist Metro.
  const expoRequire = createRequire(require.resolve('expo/package.json'));
  const configRequire = createRequire(expoRequire.resolve('@expo/metro-config/package.json'));
  const metroRequire = createRequire(configRequire.resolve('metro/package.json'));
  if (metroRequire('image-size/package.json').version !== '1.2.1') {
    throw new Error('Review the image-size build mitigation before changing its version.');
  }
  const imageSize = metroRequire('image-size');
  imageSize.disableTypes(['icns', 'jxl', 'heif']);
};
