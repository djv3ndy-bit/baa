# Android release optimization

The Android-only `with-android-release-optimization.cjs` config plugin enables the Expo54 release properties for R8 minification and resource shrinking, and replaces the template's `proguard-android.txt` default with `proguard-android-optimize.txt`. Debug builds keep their existing settings. The existing app rules, React Native/Expo/Firebase/OpenIAP consumer rules, signing, Hermes/native packaging and all iOS configuration are preserved. No dependency upgrade or blanket library-package keep is added.

Metro images are resolved by name at runtime, so a release-only resource keep file preserves `@drawable/assets_*` and `@drawable/node_modules_*`. These are the actual app/navigation image prefixes in the previous AAB. It does not keep every Android/Firebase drawable or discard resources. Changing the Metro naming convention requires reviewing this keep file.

The installed React Native0.81.5 and Expo modules core declare consumer rules, and the pinned OpenIAP3.5.0 Maven AAR contains `proguard.txt` for its public API/models/listeners. Firebase supplies its library rules; do not add `-keep class com.google.**`, disable shrinking, or suppress missing-class errors to make a build pass. Investigate a real release compiler error before adding a narrow rule. The installed Expo app template's existing TurboModule keep remains intact.

## Required release acceptance

Config/mod tests are not a completed R8 release build. Before publishing a new binary:

1. Compile the exact release variant; investigate R8 warnings/missing classes. Retain `mapping.txt`, `configuration.txt`, `usage.txt` and `resources.txt` when generated, and verify the AAB's obfuscation mapping metadata. A successful compile is not proof that Play's optimization percentage/deadline warning has cleared.
2. Exercise launch, Google sign-in/callback, saved-session restart, all bundled app/navigation images, media selection, Google catalog/restore/test sheet, FCM registration/background/tap/logout, and account settings on the optimized binary. Preserve the existing test/production environment separation and avoid real charges.
3. Compare DEX/resource sizes and Play's calculated optimization result after an authorized upload. No percentage reduction is promised by this source change.

## Edge-to-edge and large screens

Expo54's installed prebuild code enables edge-to-edge by default (`android.edgeToEdgeEnabled !== false`), and Android16/target36 does not permit opting out on Android16. The application already uses safe-area insets. The Play warning also names deprecated status/navigation-bar calls in installed React Native and react-native-screens. Setting the same config flag does not remove those compiled framework calls; this candidate does not patch vendor libraries or claim the warning cleared. Verify status/navigation bars, display cutouts, keyboard and gesture/three-button navigation on Android15/16. A dependency upgrade or narrowly reviewed native patch is separate work if a real incompatibility is found.

The shared app config currently requests portrait orientation. Android16 ignores orientation/resizability restrictions on displays with smallest width>=600dp. Removing the orientation setting globally would also alter iOS; changing only Android to unrestricted rotation still requires layout/state acceptance. This candidate leaves orientation and tablet policy unchanged and does not add a temporary compatibility opt-out or claim tablet/foldable support. Verify rotated/resized windows, split screen, keyboard and draft/chat state on a large-screen Android device before marking that recommendation resolved.

Primary references, checked October17,2026:

- [Android R8 configuration](https://developer.android.com/topic/performance/app-optimization/enable-app-optimization)
- [Android resource keep rules](https://developer.android.com/topic/performance/app-optimization/customize-which-resources-to-keep)
- [Expo54 template release configuration](https://github.com/expo/expo/blob/sdk-54/templates/expo-template-bare-minimum/android/app/build.gradle)
- [Expo54 Android build property implementation](https://github.com/expo/expo/blob/sdk-54/packages/expo-build-properties/src/android.ts)
- [Android16 edge-to-edge and large-screen changes](https://developer.android.com/about/versions/16/behavior-changes-16)
