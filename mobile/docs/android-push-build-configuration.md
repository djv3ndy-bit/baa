# Android push configuration

Production Android builds require the real Firebase Android client configuration for package `com.baristajobmatch.app`. In the existing Firebase project, download that app's `google-services.json` and supply it as the EAS production **file** variable `GOOGLE_SERVICES_JSON`, or use a reviewed `mobile/google-services.json`. The dynamic Expo configuration verifies the package and required client fields; missing or mismatched files stop a production Android build. iOS builds and unconfigured local checks remain available.

The client configuration contains public Firebase identifiers. For the existing Expo Push Service path, a Firebase service account private key is a different file: upload that credential through EAS credential management for FCM V1 delivery, never as `GOOGLE_SERVICES_JSON`, `EXPO_PUBLIC_*`, or Expo `extra`. The isolated Android payment-review direct-FCM candidate instead uses native tokens and a dedicated keyless WIF sender. It remains disabled on the server until its dedicated IAM, database and runtime setup is approved. No Firebase project or credential is created by this build check.

See the [official Expo Android push setup](https://docs.expo.dev/push-notifications/fcm-credentials/). Complete a signed Android device test after the selected transport's client configuration and server authentication are ready.
