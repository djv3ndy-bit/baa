# Native HTTPS security regression

Run after building the debug mobile app with the isolated test backend and the `baristamatch-network` local module. Requires existing Android SDK/Java (`ANDROID_HOME`, `JAVA_HOME`), build tools 36.0.0, Android 36 compile SDK, and dedicated emulators. No paid tooling or new dependencies.

```
python3 tests/native/android-network/run.py \
  --device emulator-5556 \
  --app-apk /absolute/path/to/app-debug.apk \
  --debug-keystore /absolute/path/to/debug.keystore \
  --output /absolute/path/to/android24-security.txt
```

Repeat on a current Android emulator. The runner rejects non-emulator device IDs and non-debug/wrong-package APKs. It installs without clearing synthetic app data. The standard Android debug keystore password is intentionally public; do not pass a release signing key.

The separate instrumentation APK runs in the target app context, using its packaged network security configuration and platform TLS implementation. Checks cover the valid public test endpoint, OS-specific resource selection, certificate-chain and hostname validation, unrelated-host trust isolation on Android 7, and rejection of self-signed/expired/wrong-host endpoints. It never reads or sends account credentials, creates a payment, changes trust stores, or disables TLS validation. The external invalid-certificate test endpoints are public `badssl.com` fixtures and receive no sensitive data. Internet access is required.

This does not replace native purchase lifecycle or user-journey tests. Current evidence is in `review/evidence/native-https/`. Original failures are retained alongside passing retests.
