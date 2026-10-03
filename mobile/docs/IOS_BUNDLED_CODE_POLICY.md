# iOS installed-code policy

BaristaMatch ships its executable JavaScript inside the App Store binary. Account,
job, message, media and verified billing data continue to use the existing APIs.
There is no downloadable app-code update engine or remote-control product feature.

## Native dependencies

`plugins/with-ios-bundled-code.cjs` applies version- and SHA-256-pinned changes
during **iOS** prebuild. It validates all six native files before writing, supports
repeat prebuilds, and fails visibly on unexpected dependency source or versions.
The dependency lock and versions are unchanged.

- React Native 0.81.5 is compiled from source. Its Release JavaScript loader has
  the network loading branch compiled out. Both synchronous and asynchronous
  entry points require a regular file inside the installed app bundle, after
  resolving symlinks and path components. Legacy and new-architecture executable
  segments receive the same boundary check. Local Metro development remains
  under the existing `RCT_DEV` compile-time condition.
- React Native Screens 4.16.0 no longer looks up internal UIKit content/back-button
  classes. Its two nullable utility methods return the existing absent-view result;
  their callers keep their fallback measurements. BaristaMatch's visible headers
  are implemented by the app; all native stack headers are hidden. Native back
  gestures and main-tab behavior require simulator and signed-build verification.
- ReactNativeDependencies and the Hermes engine remain at their existing versions.
  The engine runs packaged app code. A JavaScript runtime or normal API networking
  alone is not evidence of downloaded code execution.

The rejected submission was build 21. Build 25 removed Expo Updates, but the audit
of that exact archive still found React's generic network loader and the private
UIKit lookups. Apple did not identify the responsible component. These changes
address the observed capabilities without claiming that Apple confirmed their cause.

## Checks

- `tests/approved-update/ios-source-policy.test.mjs` covers dependency drift,
  atomic preparation, repeat application and source-build integration. On macOS
  it compiles and runs the real Foundation URL policy against packaged files,
  remote URLs, cached files, directory traversal and escaping symlinks.
- `scripts/verify-ios-bundled-code.py` inspects the main executable **and every
  packaged Mach-O**, requires the embedded bundle and compiled policy, and rejects
  the known updater, remote-loader and private-UI markers. Fixture tests include
  violations inside an embedded framework. This targeted gate is not a complete
  proof of security or an Apple approval guarantee.
- Inspect the exact signed IPA, native library load commands and Release loading
  behavior before upload. Retest startup, review-mode restart, navigation/back,
  authentication, and native billing on the replacement build. Reuse prior billing
  lifecycle evidence only where the relevant implementation has not changed.

The plugin does not edit Android sources, login/UI code, backend endpoints, website
checkout, plan pricing, account rules, or user records. App updates require a new
store build. App Review test mode only changes between the two fixed data services;
it restarts the same installed bundle.

On this Mac, Xcode 27 requires a local build override of
`IPHONEOS_DEPLOYMENT_TARGET=15.1` because an existing resource pod declares 13.4.
The app's supported minimum remains 15.1; the configured EAS builder remains
Xcode 26.0. No dependency was upgraded to accommodate the local toolchain.
