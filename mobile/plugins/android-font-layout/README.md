# Android live text-size backport

This Android-only build addition keeps React Native 0.81.5 and Expo 54. It backports the upstream measurement correction for stale font scale, enables the existing Android feature flag, and requests layout when the native configuration changes. All five dependency files are checked against exact original and patched hashes before writing. No app startup override, React remount, draft reset, text-size cap or dependency-version upgrade is used.

Sources (React Native, MIT license):
- https://github.com/react/react-native/commit/45904c866882f136edde55df2fe453327057d387
- https://github.com/react/react-native/commit/686d14f1d16c2f02720104ddd395f7d27c908350
- https://github.com/react/react-native/commit/417e0682203d70bd5ca510f7999a7f6c6990566f
- https://reactnative.dev/contributing/how-to-build-from-source

The changed C++ layout metrics require building ReactAndroid and its native consumers from matching sources. Gradle substitutions also build the matching Hermes package. This increases cold Android build time; it does not add a service, change a plan, or start a cloud build.

Build iOS and Android from separate dependency installs, as EAS already does. The iOS check fails visibly if the install was previously patched for Android, preventing an ABI mismatch with precompiled iOS React Native. The iOS build applies no patch. Do not remove that guard to make a build pass.

When upgrading React Native, review whether upstream includes these changes and remove this backport only after native regression testing. Unknown source/version changes deliberately fail.
