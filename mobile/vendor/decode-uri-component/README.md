# decode-uri-component CommonJS compatibility build

Source: https://github.com/SamVerschueren/decode-uri-component/tree/v0.5.0
Published package: https://registry.npmjs.org/decode-uri-component/-/decode-uri-component-0.5.0.tgz

This contains the upstream 0.5.0 linear malformed-UTF-8 decoding fix for GHSA-vcc3-ghjq-m6fr. The only code changes are a strict-mode directive and converting the default ESM export to `module.exports`, preserving the callable CommonJS API required by query-string 7 and React Navigation on Expo SDK 54. The decoding algorithm is unchanged. The upstream MIT license is retained.

Upstream `index.js` SHA-256: `9401353df38f8010ad7035fe8d666bce6a4902bc1cff809afc4ab23fa2e0bdaa`.

Remove this compatibility copy when the Expo-supported navigation stack accepts the upstream module format. Do not replace it with an older decode-uri-component release. Regression coverage is in `tests/native-dependency-security.test.mjs`.
