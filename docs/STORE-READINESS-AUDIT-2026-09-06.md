# BaristaMatch store-readiness audit — September 6, 2026

> Current execution status and remaining gates: [Launch checklist](LAUNCH-CHECKLIST.md). This preparation/audit record is not itself proof of store approval.

## Verdict

**Public App Store and Google Play release: HOLD.** This repair batch addresses confirmed code and configuration problems. It is not a legal certification, store approval or a complete device/binary audit. The owner has approved remediation but requires BaristaMatch LLC seller verification before public release.

Baseline: `djv3ndy-bit/baa` at `5f90c1dba73806314fb3b14e3d353656c3452066`. Source reads were pinned to this revision. Customer data was not deleted and billing settings, subscriptions, secrets, signing credentials and public store releases were not changed as part of the audit.

## Verified from connected systems

- Production Vercel deployment was READY. The live privacy page returned HTTP 200 with the September 2, 2026 policy, LLC operator and public support contact. A generic web search had an older cached policy; the connected live fetch resolved that discrepancy.
- The proposed dedicated external deletion URL returned HTTP 404 before this repair.
- Supabase project status was ACTIVE_HEALTHY and its security advisor returned no current findings. This is a scoped advisor result, not a comprehensive security certification.
- Read-only database inspection confirmed cascading account/profile relationships, private demographic row-level policies, blocked-member checks and message-content checks on message insertion. Those controls were preserved.
- The app uses Expo SDK 54 / React Native 0.81.5. Expo's documented defaults already target API 36; a speculative SDK upgrade was unnecessary.
- The current native subscription screen prevents new purchases. Earlier preparation notes saying all billing was disabled were too broad; website billing depends on separate production configuration.

## Implemented repair batch

1. **Safer account deletion.** A failed or malformed profile lookup no longer falls through to account-identity deletion. Inventory and removal errors fail closed. Cleanup enumerates both upload buckets, including replaced uploads, nested folders and pagination; validates ownership paths; uses the Storage API; and verifies removal before deleting the identity. Requests remain authenticated and explicitly confirmed. Listing and request limits bound the operation.
2. **External account-deletion resource.** Added a public, script-free page with in-app instructions, email/support request paths for people without the app installed, identity-verification guidance and retention/subscription notices.
3. **Android edge-to-edge protection.** The root layout now applies safe-area-context system-bar/cutout insets on Android. Existing per-screen iOS inset behavior is preserved. Physical-device layout testing remains necessary.
4. **Build requirements made explicit.** Production uses a documented Xcode 26 image and Android App Bundle output. A build hook rejects old Xcode/iPhoneOS SDKs for production iOS. Configuration checks detect mismatched identifiers/versions, old SDK baselines, lower target overrides and accidental production APKs.
5. **Regression coverage and CI.** Added 39 new deletion/configuration tests and an independent read-only CI workflow for the full server suite, mobile type checking and separate iOS/Android JavaScript exports. JS exports are not signed native builds.
6. **Store preparation records corrected.** Updated Apple preparation notes and added a Google Play record. No private business verification IDs or credentials are recorded in these public-source documents.

## Test evidence

The 39 new tests passed in the local Node 22 environment with mocked upstream requests. No real user account, uploaded file, Stripe charge or email was used as a test side effect. The local environment could not clone/install the entire repository over the network, so full-suite/native results must be taken from the actual GitHub CI run, not inferred from this partial local test result. Record the PR and final CI result in the execution report.

## Remaining release blockers / checks

- **Organization identity:** verify Apple's completed seller conversion and the actual Google developer-account organization status in their consoles. A corrected D&B submission reported by the owner does not establish that either conversion has finished.
- **Apple authorization revocation:** the inspected deletion backend does not revoke Sign in with Apple provider authorization. Supabase account deletion alone is not proof of this. A secure implementation, correctly configured Apple credentials and an end-to-end test are still required. Do not expose provider tokens or Apple client secrets in logs, source or review notes.
- **Deletion lifecycle beyond media:** verify provider-held data, support/diagnostic retention and paid-subscription cancellation. This batch deliberately does not issue refunds or cancel live subscriptions. Confirm upload/deletion concurrency under real storage policies before certifying full deletion.
- **Demographic minimization:** mandatory gender selection for aggregate reporting is a review risk under Apple's data-minimization rule. Reconcile the necessity/optionality consistently across website, mobile app, backend and disclosures; privacy of a field does not make mandatory collection automatically appropriate.
- **Signed artifacts and devices:** inspect final IPA/AAB SDK levels, SDK privacy manifests, required-reason APIs, Android 16 KB compatibility, permissions and signing. Run the complete café/barista flow on physical iPhone and Android devices, including cancel/error/expired-link states.
- **Console submission assets:** privacy/Data Safety declarations, age/content ratings, actual reviewer accounts, screenshots/graphics, agreements and applicable account-testing prerequisites remain console/device tasks, not proved by source code.
- **Repository governance:** main was unprotected at audit time. The new workflow adds checks but does not itself make them mandatory branch-protection rules.

## Policy basis reviewed

- Apple App Review Guidelines: https://developer.apple.com/app-store/review/guidelines/
- Apple upload SDK requirements: https://developer.apple.com/app-store/submitting/
- Apple account deletion: https://developer.apple.com/support/offering-account-deletion-in-your-app/
- Google target API requirements: https://support.google.com/googleplay/android-developer/answer/11926878?hl=en
- Google external deletion resource: https://support.google.com/googleplay/android-developer/answer/13327111?hl=en
- Expo SDK 54 defaults: https://docs.expo.dev/versions/v54.0.0/
- EAS build images: https://docs.expo.dev/build-reference/infrastructure/
- Storage deletion: https://supabase.com/docs/guides/storage/management/delete-objects

Only validated, tested changes should merge. Do not equate a healthy website, passing source tests, or an uploaded test build with permission to publish to either store.
