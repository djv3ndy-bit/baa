# Native dependency security maintenance

Reviewed 2026-09-07 against the published npm packages and the app's actual callers. Expo remains on SDK 54, React Native on 0.81.5, and Expo Router on 6.

| Dependency | Resolution | Compatibility evidence |
| --- | --- | --- |
| decode-uri-component | Local CommonJS build of upstream 0.5.0, MIT license and source hash retained in `vendor/decode-uri-component` | query-string 7 requires a callable CommonJS export. The upstream 0.5 package is ESM-only. Its fixed algorithm is unchanged; the wrapper only changes the export format. Ordinary Unicode, plus signs, arrays, and a 120 KB malformed query complete in regression tests. |
| postcss | Exact override 8.5.23 | Expo's `postcss.default(plugins).process` interface remains available; automatic source map loading without `from` is rejected. |
| uuid | Exact override 11.1.1 | Version 11 retains a CommonJS entry point. Xcode uses only `uuid.v4()`; project identifier generation is covered. |
| image-size | Existing 1.2.1 retained, affected parser formats disabled in Metro main process and transform workers | Buffer and synchronous filename APIs used by Metro remain intact. Crafted ICNS, JXL and HEIF assets are rejected before dimension calculation. PNG asset buffer/path handling and Metro asset metadata are covered. |

The decoder is a direct local file dependency referenced by the npm override (`$decode-uri-component`). This ensures a clean npm 10 installation resolves the same root package for nested navigation consumers; a bare nested `file:` override created a broken relative link. Commit the vendor files with the lockfile. Both `npm install` and a clean `npm ci` were verified.

There is **no published patched image-size release** at this review date: npm's latest is 2.0.2 and both advisories list no patched version. npm audit therefore still reports image-size and its affected dependency paths (8 high findings in the reviewed tree). This is a build-path mitigation, not a claim that the dependency itself is patched. App photos and videos uploaded or fetched at runtime do not enter Metro's source-asset parser. Bundled ICNS, JXL and HEIF files are deliberately unsupported; use PNG/JPEG/WebP for bundled assets. The guard checks the reviewed image-size version, so dependency updates require revalidation rather than silently retaining an untested mitigation.

Run `node --test tests/native-dependency-security.test.mjs` from the repository root after installing mobile dependencies. Also run native typechecking and both iOS/Android production bundle exports. Do not use `npm audit fix --force`, which proposed an unrelated Expo major upgrade and Router downgrade for this tree.

Sources:
- [decode-uri-component 0.5.0 source](https://github.com/SamVerschueren/decode-uri-component/tree/v0.5.0)
- [PostCSS 8.5.23 release](https://github.com/postcss/postcss/releases/tag/8.5.23)
- [uuid 11.1.1 security backport](https://github.com/uuidjs/uuid/releases/tag/v11.1.1)
- [ICNS advisory](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr)
- [JXL/HEIF advisory](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq)
