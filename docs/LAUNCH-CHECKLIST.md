# BaristaMatch — App Store and Google Play launch checklist

Updated September 6, 2026. Owner-approved remediation; **PUBLIC RELEASE: HOLD**.

This is the current execution checklist. The dated audit reports and store-specific submission records remain evidence/preparation documents. Do not turn an entire item green because code exists, a website is healthy, or a JavaScript bundle passes. Every native change still needs a signed release build and device verification.

## Evidence and completed implementation

- [x] Original store-readiness repair batch merged in PR #43 (`3fb5a58a1f3e7e9d01d1f16c2c9b0608a234de3f`). Its production deployment and external deletion page were verified in the PR's post-merge record.
- [x] Apple no-retained-token fallback and deletion completion/session handling merged in PR #44 (`6d4bdff315d11aa984a59b8fc7e597eca93e8829`). Its production completion page/script and read-only API response were verified. This is **manual Apple disconnect guidance, not automatic revocation**.
- [x] Complete repository tests, authentication checks, mobile typechecking and iOS/Android JavaScript exports passed on PR #44. Evidence: Store readiness run 34044902652 and Authentication reliability run 34044902516. These are historical results; require fresh checks for every new head.
- [x] Current remediation changes optional gender consistently in web and native source. Female/Male choices remain available; unprovided/withdrawn selection is NULL, not a fabricated gender. Gender no longer gates profile saving or visibility. Date-of-birth eligibility and private storage remain.
- [x] Read-only production schema inspection confirms gender is nullable, its allowed values are Female/Male or NULL, and the database visibility function does not require gender. No production data rewrite or schema migration is needed for this repair. Existing selections are not erased by deployment.
- [x] Current remediation removes unnecessary library-permission prompts for Android media and iOS photos, preserves the SDK 54 original-video permission flow on iOS, blocks unused Android media/camera/microphone permissions, and handles cancel/empty results.
- [x] Public privacy wording and external deletion link updated alongside the source changes. Do not conflate this with completing store privacy questionnaires.
- [x] A real merged Android release-manifest validation job and regression tests have been added. The job checks the actual manifest target/package/permissions. Its passing result must be attached to the final PR; adding the job is not a passing result.
- [x] Corrected D&B business form sent by the owner; sent-email attachment confirmed in the connected mailbox. **Submission is not D&B approval, an issued D-U-N-S record, or an Apple/Google organization conversion.** Private case and contact details stay in Owner HQ, not this public repository.

## Required evidence before release

| ID | Item | Current status | Responsible party / evidence to close |
| --- | --- | --- | --- |
| R01 | Final source checks and production web deployment | Fresh result required for each repair | Engineering: record exact merged SHA, passing Store readiness and auth jobs, deployed SHA and live URL results. Check the new Android manifest job as well. |
| R02 | Apple seller: BaristaMatch LLC | BLOCKED — not verified in Apple account | Owner + Apple: completed organization conversion, correct seller and bundle/app record, applicable agreements. Do not change personal name as a substitute. |
| R03 | Google organization identity | BLOCKED — Play Console not inspected | Owner + Google: verify legal identity/D-U-N-S where required, organization account, contact and developer-account prerequisites. |
| R04 | Signed iOS build | NOT VERIFIED | Release: build exact approved main via the guarded EAS workflow, record build ID/version/source SHA, actual Xcode 26+/iOS 26+ SDK, signing and App Store Connect processing. |
| R05 | Signed Android AAB | NOT VERIFIED | Release: record package, version code, signing and Play App Signing, artifact target API 36+, native-library 16 KB compatibility and actual merged permissions. Manifest-only CI is not an AAB. |
| R06 | Physical iPhone and Android QA | NOT RUN in this session | QA + owner: execute both role matrices below on the intended signed builds and record evidence. |
| R07 | Apple credential lifecycle | PARTIAL — manual fallback implemented | Auth: test deletion/manual disconnect/local sign-out on signed builds. Automatic provider-token capture, secure storage, revocation and provider-notification handling are not implemented by PR #44 or this repair. Complete/validate the future-account integration before marking this gate complete. |
| R08 | Complete account-deletion lifecycle | PARTIAL — cleanup and client tests exist | Engineering + privacy: validate real storage/account cascades, upload/deletion races, related records, providers, support/diagnostics/backup retention and paid-subscription lifecycle using designated test accounts only. |
| R09 | Minimal data collection on installed clients | SOURCE FIXED; BUILD TEST PENDING | QA: blank/cleared gender saves and remains discoverable when other requirements pass; demographics never shown to other members; permission denial leaves core app usable. |
| R10 | App Privacy / Data Safety / SDK disclosures | NOT SUBMITTED OR VERIFIED | Owner + engineering: reconcile actual collection, linkage, purposes, sharing/tracking definitions, optionality and retention with the intended signed app and all SDKs; inspect merged Apple privacy manifests/required-reason APIs. |
| R11 | UGC safety and support operation | CODE EXISTS; OPERATIONAL TEST PENDING | Support + QA: report and block a test user/message, verify restricted access, owner receives and can review reports, moderation/response process works and applicable child-safety declarations are completed. |
| R12 | Billing compliance and account closure | NOT CERTIFIED | Billing + owner: verify actual web billing separately, native purchase/portal behavior, applicable storefront-region policy, entitlements and cancellation when deleting a paying account. No automatic refund/cancellation is authorized by this checklist. |
| R13 | Store assets, ratings and reviewer access | CONSOLE WORK PENDING | Owner + release: accurate name/descriptions, screenshots/graphics from intended app, category, questionnaires, support/privacy/deletion links, export compliance, ads/content rights, private barista and café reviewer credentials. No passwords in source. |
| R14 | Mandatory branch checks | BLOCKED — main is unprotected | Repository administrator: require pull requests and the actual successful check contexts; block force pushes/deletion. The connected GitHub app does not provide administration-write access; do not bypass this with workflow credentials. |
| R15 | Internal testing and release authorization | HOLD | Owner: review TestFlight and Play internal/prelaunch results, any applicable account testing requirement, all rows above, then approve the exact final revision/artifacts. Public submission/release is not authorized by remediation approval. |

## Device acceptance matrix — run for both roles on both platforms

Record device/OS, build ID, exact source SHA, tester, timestamp and result for each row. Do not mark untested rows passed.

- [ ] Email signup, verification (cold/open app), resend, duplicate account and expired/invalid links.
- [ ] Existing-account login, invalid password, Google/Apple sign-in, cancellation, private relay email and returning identities.
- [ ] Forgot/reset password and login with the replacement password; logout, restart and session persistence.
- [ ] Barista profile saves with Female, Male and no gender; existing choice can be cleared; DOB eligibility remains enforced.
- [ ] Café profile and job posting; barista discovery/application; café applicant review; mutual match.
- [ ] Messages, notifications, permission denial, report/block, blocked-user messaging prevention and report review.
- [ ] Photo/video pick, cancel, permission denial/limited access, upload, unsupported/oversized files and slow/offline retry.
- [ ] iPhone keyboard/larger text; Android cutouts, gesture/three-button navigation and keyboard; no clipped controls.
- [ ] Test-account deletion: own media/associated rows removed, another user's data unchanged, accurate confirmation, local auth removed, Apple follow-up and provider lifecycle verified.
- [ ] Café subscription/portal behavior matches review notes and applicable platform/storefront rules; no accidental payment in testing.
- [ ] Signed binary and store processing checks, crash/error review, private review credentials and all public URLs.

## Scope of the current checklist repair

Starting source: `6d4bdff315d11aa984a59b8fc7e597eca93e8829`. Current code work: optional/private demographics, permission minimization, generated Android manifest verification and consolidation of checklist evidence. Tests use mocked accounts and dummy configuration; native manifest generation uses no production/signing credentials. No real accounts/media, subscriptions, provider tokens, billing settings, signing keys, developer identities or store releases were changed as part of this repair.

The final PR/deployment evidence determines what has actually shipped. Web/backend deployments and installed mobile-build status must always be reported separately. A checklist does not schedule background work or provide a store/legal certification.

## Primary references reviewed for this repair

- Apple data minimization and completeness: https://developer.apple.com/app-store/review/guidelines/
- Apple no-token fallback and new-account credential flow: https://developer.apple.com/documentation/technotes/tn3194-handling-account-deletions-and-revoking-tokens-for-sign-in-with-apple
- Apple upload SDK requirements: https://developer.apple.com/app-store/submitting/
- Google target API: https://support.google.com/googleplay/android-developer/answer/11926878?hl=en
- Expo SDK 54 image/video permission behavior: https://docs.expo.dev/versions/v54.0.0/sdk/imagepicker/

Store policies are external requirements; repository/CI observations are implementation evidence. Do not use one as proof of the other.
