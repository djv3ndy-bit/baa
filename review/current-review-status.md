# BaristaMatch release review — September 14, 2026

**Not ready for public release sign-off.** The owner approved one isolated internal TestFlight testing build and a consolidated work-branch commit/push while the documented checks remain open. Native production payments remain disabled. This is the source-freeze record before the authorized push/build; upload and processing results must be verified separately. Public release and production OTA are not authorized.

The two account-specific dashboards and native café subscription flow are implemented. The approved U.S. price is $9.99/month. Existing website Stripe checkout, subscribers, free first-job access, hiring rules and original photo login are preserved. Patches01–22 are approved and applied. The isolated test preview is Ready; its15 deployment checks passed.

## Verified results

| Check | Result | Actual scope |
|---|---|---|
| Existing-source preservation | Passed | All443 baseline files match the baseline plus approved patches01–22;25 changed files,418 unchanged; no unexplained differences |
| Repository and focused checks | Passed |649 repository tests and230 focused tests; 420 authentication release checks, TypeScript, launch check and diff check; prior400 integrated layout checks retained |
| Core hiring and messaging | Passed in recorded scope | Isolated café/barista profiles, first free job, editing/pausing/reopening, interest versus match, mutual matching, two-way messages and duplicate guards on native iPhone/Android |
| Original login and keyboard | Passed in recorded scope | iPhone SE3 and17ProMax simulators/iOS26.5; physical iPhone17Pro/iOS27.0; small Android7/API24 and large Android16/API36. No new external OAuth sign-in claimed |
| Native layout fixes | Passed in recorded scope | Approved message-label, Android live text-size, chat keyboard and job-form keyboard corrections; no unrelated redesign |
| Apple Sandbox purchase and shared access | Passed in recorded scope | Physical iPhone17Pro/iOS27.0; verified purchase, renewals, cancel-at-period-end and access shared with the website |
| Restore | Passed in recorded scope | Active/expired purchases, existing website subscriber and same-device uninstall/reinstall restoration. Different-device restoration not tested |
| Latest subscription expiry | Passed at API level | Both test APIs returned verified Pro at15:07UTC and Free after the15:11:58UTC expiry; no pending checkout. Latest signed history contains delivered subscription/renewal events, not a new refund/expiry callback |
| Test preview access protection | Passed |15 deployed checks cover isolated database, role/anonymous denial, Apple/Stripe access, duplicate-checkout rejection and correct billing management |
| Android notifications and video | Passed in recorded scope | Match destination, repeated mark-read, refresh/reopen; video cancel/replacement/repeat-save/cold restart; exact saved bytes and café-authorized readback; native oversize rejection observed |
| Android safety-dialog cancellation | Passed in recorded scope | Report/block Cancel and matched-chat return/reopen; independent test records confirmed no report or block created |
| Account lifecycle | Passed in recorded scope | Native password changes and deletion of disposable barista accounts; server verification and signed-out restart |
| Subscription artwork | Saved in App Store Connect | Existing coffee-cup logo; phone rendering and store review remain unverified |

## Remaining release gates and retained failures

- Apple approved/declined refunds and revoked access are not verified. Apple's refund sheet repeatedly returned “Cannot Connect,” including the latest diagnostic retry; no refund is claimed and the cause remains unconfirmed. The exact updated-terms interruption and genuine approval-pending purchase paths remain incomplete. Apple-management renewal recovered a test purchase, but does not establish every interrupted-checkout scenario.
- A second physical phone is unavailable. Simulator tests do not establish restoration of the real Sandbox purchase on another device; same-device reinstall restoration passed.
- Minimum supported iOS15.1 has not been exercised. Full push delivery, email verification/reset delivery, remaining upload failure cases, report/block enforcement and all other journey branches are not certified.
- The owner declined separate test OAuth setup. Production sign-in source/settings are preserved and the owner reports it works; this is not a newly completed external Google/Apple sign-in test.
- Two isolated billing reads returned503 before recovering; their upstream cause remains unconfirmed. A bounded GET-status retry is tested and deployed only to the isolated preview. Payment writes are not retried by it.
- Existing development warnings and a SpringBoard/XCTAutomationSession cleanup crash remain recorded. Failed test expectations were retained, including Android system Back leaving the existing safety modal open; explicit Cancel works. No checks or errors were disabled.
- Android video playback remains unverified because the emulator browser stopped at first-use setup. Café authorization and exact video-byte readback passed separately.
- Production database/provider activation and Apple store-review configuration remain incomplete. Google Play billing and submission configuration are absent. No native cloud-build credits were used for this checkpoint.

## Build and repository state

Branch: `codex/approved-dashboards-native-billing`. Preserved baseline: `357a8a92efbc4f2d99c8a5baa128907195f025e3`. Remote main and work branch were checked at that baseline. The consolidated implementation is prepared for the owner-authorized commit and draft PR; the resulting SHA and PR are recorded separately after push verification.

Regular physical test app:1.0.5(8), isolated endpoints, OTA disabled; reinstalled and Café plans visually confirmed after the latest diagnostic. Both test status APIs again returned verified Free after expiry, with no pending checkout. Temporary refund-only build1.0.5(9) is kept separately and must never be uploaded. The approved payment-review TestFlight profile uses the isolated backend; it is not the public-release candidate.

Latest isolated preview: `dpl_8eHEiqstsatBpbuhQde1qJWeQpsM`, Ready, with `testing.baristajobmatch.com` assigned. Only the preview was deployed; existing production payments remain unchanged.

This repository is public. Detailed owner review, screenshots, raw diagnostics, failures and machine-readable evidence are preserved locally under `review/`, including `current-review-details-sept14.md`, `feature-preservation.md`, `interaction-inventory.json` and `evidence/`. They are excluded from public Git history. Required SQL fixtures and the exact approved patches remain included so code checks and preservation review are reproducible. No evidence was deleted.

The owner approved the one-build internal TestFlight testing exception. It permits a work-branch push and one testing build using existing included credits after local and archive checks. The existing main-only release workflow remains on HOLD. This exception does not waive the final public-release checks above.

Final local test invocation initially omitted the existing AUTH_CALLBACK_MODULE prerequisite and failed. Compiling the unchanged callback and supplying that documented fixture produced649 passes; no test or assertion was changed. The failed invocation is retained in the private evidence.

The approved unified-diff archives retain their exact context-line spaces. They are validated by replay against the baseline rather than interpreted as ordinary source whitespace. Source/SQL whitespace checks pass; an unused draft patch and all private diagnostic material remain local.
