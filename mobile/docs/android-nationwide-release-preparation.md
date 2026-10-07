# Android nationwide release preparation

Prepared from main `6fedc77d7ebb899528cea924054cb0b75c4b4f0d` on October 7, 2026.
This is a review branch, not a released Android build.

## Scope

- Native signup, home/profile state, independent barista work state, job editor,
  exact city/state matching and exact ZIP matching support the 50 states and DC.
- Existing city-only Florida records remain readable without a data rewrite.
- Profile edits preserve a stored ZIP when city/state stay unchanged. Structured
  work cities such as Port Washington, West New York and Santa Fe are preserved.
- Unknown/conflicting states fail validation. No radius search or geocoding is
  implied by matching; city/state and optionally ZIP must match exactly.
- Existing layouts, authentication, private demographics, visibility choices,
  job entitlements and billing behavior are retained. No PR #80 section-memory,
  job-expiration, iOS native-loader or billing changes are included.
- Both Vercel project configurations disable automatic deployment for this exact
  branch. Keep those guards if the branch is renamed or reused.

## Local verification

- Complete repository suite: 836 passed, zero failed/skipped.
- Existing approved-update suites: 295 passed, zero failed/skipped.
- JS-only launch-workflow suite: 236 passed without adding mobile dependencies.
- TypeScript, store-configuration verification and `git diff --check` passed.
- Android JavaScript export passed using synthetic backend configuration.
- Screen-harness tests exercise signup and profile save for both roles in every
  state/DC (204 combinations), plus 51 job-publishing states. Edge cases include
  failed save/retry, Cancel/reopen, named cities, ZIP retention, auth replay and
  paused-job edits preserving identity, pay and schedules.

These are source/JavaScript checks, not a signed AAB, emulator or physical-device
acceptance. Local Node was 24.19.0; project CI and EAS pin Node 22.

## Release prerequisites

1. Verify the intended backend already accepts nationwide signup, profile and
   job locations. The deployed website rollout uses nationwide rules, while
   main's historical migrations still contain Florida-only validators. A fresh
   database made from this branch alone must not be assumed nationwide-ready.
   No database migration or production write is performed by this branch.
2. Finish the separate Google Play billing work. Owner-approved launch is paid
   Café Pro at $9.99/month, free baristas, no annual plan. This geography change
   does not enable a product or modify the existing entitlement policy.
3. Verify Play Console organization/app ownership, package
   `com.baristajobmatch.app`, existing signing/upload key, Play App Signing state,
   version-code history, and access to the existing EAS project. EAS remote
   versioning is authoritative; source versionCode 2 is not a release estimate.
4. Verify real Firebase Android client configuration and FCM V1 delivery setup
   using the existing [Android push configuration guide](android-push-build-configuration.md).
   Account credentials and private keys must stay outside source control.
5. After review and explicit release approval, build only Android from the exact
   approved commit. Production EAS output is an app bundle. Do not publish an
   Expo update to the shared production OTA channel or start an iOS build.
6. Inspect the signed AAB's package, version, target SDK, signing and 16 KB native
   library compatibility. Test both roles, nationwide save/matching, Android Back,
   login/email callbacks, payments/restore, messages, notifications, media,
   accessibility and account deletion on the actual signed Android artifact.
7. Complete accurate Play Data Safety, subscription disclosures, review access,
   screenshots and required testing before upload/release approval.

Current iPhone artifacts are unchanged. Shared React Native source could affect
any future iOS build/update that incorporates this branch; isolation is achieved
by not merging, deploying, publishing OTA or producing iOS artifacts here.
