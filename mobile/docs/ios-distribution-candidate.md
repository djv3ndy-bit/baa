# iOS 1.0.5 candidate preparation

The isolated app config proposes iOS build **27**. The owner’s latest App Store
Connect read showed build26 as the highest completed upload; recheck immediately
before any future upload. This document does not reserve a build number or
authorize a paid build, signing change, upload, TestFlight submission or review.
Version1.0.5 and Android versionCode2 are preserved.

## Keep private material out of the source upload

Baseline `.git/info/exclude` contained only comments. The private-review policy
actually lived in `review/.gitignore`, with exceptions for curated historical
patches/SQL/status. EAS archive rules are explicit: the entire root/project
`review/`, `artifacts/`, `outputs/`, `build-tools/` and `ios-derived-data/` folders
are excluded regardless of Git curation. No private review contents were opened
for this change. These historical files are not native app build inputs.

Both archive layouts also exclude known local auth/tool state, Supabase local
project-link state and signing/private-key filenames. The verifier walks the
whole actual archive, including siblings of `mobile/`, without inspecting those
files' contents; it rejects matching private paths and escaping/broken symlinks.
Private-directory checks are case-insensitive and use the real selected project
path, so internal project aliases cannot hide review/evidence. Ambiguous archives
containing both root and mobile app manifests require explicit review and fail.
It must run on a source-only upload archive before dependency installation/CNG,
not on a local native build tree containing node_modules or generated ios/.

This is a filename/path gate, not a scan for arbitrary secrets hidden in normal
source files. Patterns intentionally reject signing fixtures with private-key
extensions, credentials.json, .npmrc/.netrc and service-account JSON even if a
future fixture is synthetic. If needed, such tooling needs a separately reviewed
safe fixture or environment-file injection; do not weaken the gate by default.
The .key rule also rejects a public key with that extension; known public CA
inputs use .cer/.pem and remain included.
Public .cer/.pem CA files, native module iOS/Android sources, ordinary auth routes,
review-mode source, .eas/workflows and the scene/bundled-code assets remain.
Some repository database tests reference the public SQL files under review/.
Run that full test suite before source-archive filtering; its complete fixture
set is not promised inside the native upload archive. Native build inputs remain.

## Generate the final native project through CNG

The canonical working directory can contain an old generated `mobile/ios/` from
local investigation. It is not the distribution input. Both mobile-project and
repository-root `.easignore`/`.gitignore` exclude only the app-level iOS tree.
Native module sources such as `modules/baristamatch-storefront/ios/` remain in
the archive. Android native directories and existing Android profiles remain.

EAS does not run Prebuild when a native project is included. Inspect the actual
source archive using the relevant Git/No-VCS workflow; in a monorepo, EAS uses
the repository-root `.easignore`, not a nested file. The `archive` inspection
stage does not start a build, but it requires an existing EAS login. Do not
install or authenticate a new CLI merely to run it without an approved step.

```sh
eas build:inspect --platform ios --profile ios-review-candidate --stage archive --output /path/to/new-archive-directory
node scripts/verify-ios-cng-archive.mjs /path/to/new-archive-directory
```

For a local Xcode route, make a fresh source-only copy under a path without
spaces, omit generated `ios/`, run the same archive verifier before generating
anything, then install/verify independent locked dependencies and run the
reviewed Expo prebuild. Never prebuild against shared dependency symlinks or
copy the stale generated project into the candidate. Preserve all six native
bundled-code patches and the scene lifecycle plugin. Verify the generated
scene manifest, scene target membership, production connection, native version
and complete packaging on the final artifact.

## Candidate profile and version ownership

`ios-review-candidate` is a store/Release, physical-iOS profile extending the
existing production tooling. It explicitly selects the primary production
database/API and native subscriptions, disables billing diagnostics and dotenv
fallback, and rejects an Android builder. The public Supabase client key must
come from the existing production environment; it is not hardcoded here. The
production connection/key guard applies to this profile as well as production.
Internal QA profiles continue to use their separate settings.

Global `cli.appVersionSource` stays `remote` to preserve Android behavior.
Expo documents this setting at CLI level, with no profile-level override.
Candidate `autoIncrement:false` prevents an automatic version increment; it
does **not** make EAS honor the local build27 instead of its remote iOS value.
Use direct local Xcode generation/archive to test local build27. Before a later
EAS build, inspect and deliberately reconcile only the iOS remote value under
the owner’s authorized workflow; do not change global version source or Android
version values. No remote version operation has been performed by these changes.

## Distribution gates still required

The earlier unsigned Release simulator build4 is not uploadable. Produce and
record a fresh arm64 device archive with version1.0.5/build27, source manifest,
toolchain, production settings, bundle ID, scene lifecycle and bundle-policy
scan. An unsigned device archive also needs separately verified distribution
signing/export before it is a submission artifact. Do not enable automatic
provisioning/portal changes or upload as a side effect of preparation.

Current EAS production tooling is pinned to Xcode26.0; local work used Xcode27.1.
Record and test the toolchain actually chosen for the final candidate. Source
tests, a simulator scan and successful reviewer sign-in in the older installed
app do not certify the new archive. Verify native launch, both ordinary reviewer
roles, cold/warm auth links, logout/session restore, scene transitions, report/
block and the actual enabled StoreKit paths on the intended candidate. Existing
App Review notes must describe verified behavior of that exact build.

Sources: [CNG](https://docs.expo.dev/workflow/continuous-native-generation/),
[archive exclusions](https://docs.expo.dev/build-reference/easignore/),
[version ownership](https://docs.expo.dev/build-reference/app-versions/),
[EAS configuration](https://docs.expo.dev/eas/json/).
