# Native dependency security maintenance

Initial review: 2026-09-07. Build-tool advisory review updated 2026-10-17 against the locked dependency graph, primary advisories and actual callers. Expo remains on SDK 54, React Native on 0.81.5, and Expo Router on 6.

| Dependency | Resolution | Compatibility evidence |
| --- | --- | --- |
| decode-uri-component | Local CommonJS build of upstream 0.5.0, MIT license and source hash retained in `vendor/decode-uri-component` | query-string 7 requires a callable CommonJS export. The upstream 0.5 package is ESM-only. Its fixed algorithm is unchanged; the wrapper only changes the export format. Ordinary Unicode, plus signs, arrays, and a 120 KB malformed query complete in regression tests. |
| postcss | Exact override 8.5.23 | Expo's `postcss.default(plugins).process` interface remains available; automatic source map loading without `from` is rejected. |
| uuid | Exact override 11.1.1 | Version 11 retains a CommonJS entry point. Xcode uses only `uuid.v4()`; project identifier generation is covered. |
| image-size | Existing 1.2.1 retained, affected parser formats disabled in Metro main process and transform workers | Buffer and synchronous filename APIs used by Metro remain intact. Crafted ICNS, JXL and HEIF assets are rejected before dimension calculation. PNG asset buffer/path handling and Metro asset metadata are covered. |

The decoder is a direct local file dependency referenced by the npm override (`$decode-uri-component`). This ensures a clean npm 10 installation resolves the same root package for nested navigation consumers; a bare nested `file:` override created a broken relative link. Commit the vendor files with the lockfile. Both `npm install` and a clean `npm ci` were verified.

The September review found no patched image-size release. The advisories now identify 2.0.3 as patched, but Metro requests the existing 1.x API. This candidate retains guarded 1.2.1; upgrading its major version requires a separate Metro API compatibility review. npm audit still reports this locked version and aggregate paths. Disabling the affected formats is a build-path mitigation, not a patched-version or general parser-safety claim. App photos and videos uploaded or fetched at runtime do not enter Metro's source-asset parser. Bundled ICNS, JXL and HEIF files are deliberately unsupported; use PNG/JPEG/WebP for bundled assets. The guard checks the reviewed image-size version, so dependency updates require revalidation rather than silently retaining an untested mitigation.

Run `node --test tests/native-dependency-security.test.mjs` from the repository root after installing mobile dependencies. Also run native typechecking and both iOS/Android production bundle exports. Do not use `npm audit fix --force`, which proposed an unrelated Expo major upgrade and Router downgrade for this tree.

## Compatible build-tool patches, 2026-10-17

The Android release branch pins shell-quote 1.11.0, compression 1.8.2, source-map-js 1.2.2 and undici 6.28.1. It retains each existing major of brace-expansion (1.1.21, 2.1.7, 5.0.12) and js-yaml (3.15.2, 4.3.2), rather than forcing one major on every consumer. No Expo, React Native, Router, native SDK or application API upgrade is included. These package and lock changes require a subsequent Android compile; they are not in already-started build 12.

The lock calls Expo CLI, Metro and Jest production dependencies because Expo/React Native declare them that way. This does not establish that their Node-only parsers, shell functions or development server are exposed by the release phone app. Direct parents and runtime gates are recorded in the separate audit evidence. In particular React Native loads react-devtools-core inside `__DEV__`, while CLI HTTP/compression and Metro source-asset parsing execute in tooling. Source inspection found no app-source imports of the advisory leaves; that is not proof of absence from a compiled bundle.

Four advisory-bearing libraries remain: braces 3.0.3, node-forge 1.4.0, sprintf-js 1.0.3, and guarded image-size 1.2.1. The first three advisories currently list no published patched version; maintainer disputes for braces/sprintf do not justify silently declaring the audit clean. Keep build patterns/config/assets trusted. The forge finding concerns RSA verification, not ordinary certificate generation alone; its CLI callers still warrant tracking. No reviewed phone-runtime exploit path was established.

A clean isolated npm installation with scripts disabled passed CLI startup, Metro setup, existing dependency security regressions, new advisory behavior tests, TypeScript and store-toolchain validation. Run `node --test tests/native-build-tool-security.test.mjs tests/native-dependency-security.test.mjs` with the patched lock installed. The Android screen-removal postinstall workaround must still run in the new dependency installation before a native build.

Primary patch references: [shell-quote](https://github.com/ljharb/shell-quote/security/advisories/GHSA-pqg4-j6r4-53mv), [brace-expansion](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr), [compression](https://github.com/expressjs/compression/security/advisories/GHSA-vc2v-76pw-4v95), [source-map-js](https://github.com/7rulnik/source-map-js/releases/tag/v1.2.2), [js-yaml](https://github.com/advisories/GHSA-2883-xcg3-v3hh), [undici](https://github.com/nodejs/undici/security/advisories/GHSA-rfgv-xxqx-mfg5).

Sources:
- [decode-uri-component 0.5.0 source](https://github.com/SamVerschueren/decode-uri-component/tree/v0.5.0)
- [PostCSS 8.5.23 release](https://github.com/postcss/postcss/releases/tag/8.5.23)
- [uuid 11.1.1 security backport](https://github.com/uuidjs/uuid/releases/tag/v11.1.1)
- [ICNS advisory](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr)
- [JXL/HEIF advisory](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq)
