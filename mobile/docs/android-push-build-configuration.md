# Android push configuration

Production Android builds require the real Firebase Android client configuration for package `com.baristajobmatch.app`. In the existing Firebase project, download that app's `google-services.json` and supply it as the EAS production **file** variable `GOOGLE_SERVICES_JSON`, or use a reviewed `mobile/google-services.json`. The dynamic Expo configuration verifies the package and required client fields; missing or mismatched files stop a production Android build. iOS builds and unconfigured local checks remain available.

The client configuration contains public Firebase identifiers. A Firebase service account private key is a different file: upload that credential through EAS credential management for FCM V1 delivery, never as `GOOGLE_SERVICES_JSON`, `EXPO_PUBLIC_*`, or Expo `extra`. Both the client configuration and the FCM V1 server credential are needed before Android push delivery can be verified. No Firebase project or credential is created by this check.

See the [official Expo Android push setup](https://docs.expo.dev/push-notifications/fcm-credentials/). Complete a signed Android device test after the real configuration and credential are supplied.
