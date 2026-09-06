# BaristaMatch App Store submission record

> Current execution status and remaining gates: [Launch checklist](docs/LAUNCH-CHECKLIST.md). This preparation/audit record is not itself proof of store approval.

Reviewed September 6, 2026 for version 1.0.3. This is a preparation record, not confirmation that any console form, signed build, or Apple review has passed.

## Legal and listing identity

- App name: BaristaMatch
- Bundle ID: `com.baristajobmatch.app`
- App Store Connect app ID: `6807117736`
- Legal operator: BaristaMatch LLC (Florida)
- Privacy Policy URL: `https://www.baristajobmatch.com/privacy.html`
- Support URL: `https://www.baristajobmatch.com/support.html`
- External account deletion: `https://www.baristajobmatch.com/delete-account.html`
- Marketing URL: `https://www.baristajobmatch.com/`
- Contact email: `hello@baristajobmatch.com`
- Suggested primary category: Business
- Minimum service eligibility: 16; under-18 users must have guardian permission.
- Complete Apple's current age-rating questionnaire accurately. Service eligibility is not itself a content-rating result.

The owner requires the seller to be BaristaMatch LLC before public release. Verify the completed Individual-to-Organization conversion in Apple's account, not just the company name in this file. Do not put EINs, signing credentials, reviewer passwords or private verification documents in source control or public metadata.

## App Review notes — verify before copying into the console

BaristaMatch is an employment marketplace connecting cafés and baristas. Users can create profiles, discover opportunities, apply, match and message. BaristaMatch is not an employer or staffing agency. Reviewers need separate working barista and café credentials in the private App Review Information fields.

The native plan screen currently displays pricing information but does not initiate new purchases or link to checkout. Existing Pro access can sync from the same café account. Website billing is controlled separately by production configuration; do not tell reviewers that all billing is disabled unless that has actually been verified. No payment settings or customer subscriptions were changed by the September 6 store-audit repair batch. Any future native purchase or external-purchase path needs a fresh storefront-specific policy assessment.

Email/password, Google and Apple sign-in are implemented. Verify provider configuration, callback routes, canceled login, returning accounts, email verification and password-reset flows on the exact release build. The presence of a button is not evidence that provider sign-in works.

Account Settings includes permanent account deletion. The backend must finish storage cleanup before removing the account identity. Blocking and reporting controls and server-side message policies exist; test them with two distinct accounts. The current integration does not retain Apple provider credentials for automatic revocation. The September 6 follow-up implements the no-token fallback in Apple TN3194: complete account deletion, clear the local session, and show Apple disconnect instructions. This is not automatic token revocation. Verify the fallback on the signed build; secure provider-token capture/revocation for future sign-ins remains follow-up work, not deployed functionality.

## App Privacy — candidate inventory, not submitted answers

| Candidate category | Source behavior to reconcile with the signed build |
| --- | --- |
| Contact information | Name/café name and email address |
| User content | Profile text, jobs, photos, videos, messages and support requests |
| Identifiers | Account IDs and push tokens; check each SDK's definitions |
| Location | User-entered city/general location; assess Coarse Location, not only Other Data |
| Usage data | Page/route activity, profile views, applications, matches and notifications |
| Diagnostics | Failure details and device/browser information actually transmitted |
| Other personal data | Private date of birth and gender; evaluate minimization and correct taxonomy |
| Purchases | Café subscription status and billing records where actually processed |

Determine linkage, purposes, optionality, tracking and third-party SDK behavior from actual collection. A no-sale policy is not proof of no sharing or no tracking. Current policy states no sale and no third-party targeted advertising. Check the compiled app's SDK inventory and merged privacy manifests before submitting that answer. An empty `NSPrivacyAccessedAPITypes` list in app.json is not evidence that the final binary has no required-reason API declarations.

Gender is optional in the updated web/native source and is stored as NULL when unprovided. The production database already permits NULL and its visibility rule does not require gender. Profile visibility and saving no longer depend on gender in the updated clients. Keep demographics private; verify this behavior on the signed release build before submitting disclosures. Older installed builds do not receive these changes merely because source was merged.

## Release checklist

- [ ] Organization seller identity verified; agreements, tax and banking completed where applicable by the authorized account holder.
- [ ] Exact intended build/source revision recorded; production signing and bundle IDs verified.
- [ ] iOS binary built with Xcode 26+ and iOS 26+ SDK; build logs and final binary inspected.
- [ ] Apple deletion behavior verified on a signed build: current no-token fallback must show disconnect instructions and remove local auth. Automatic provider-token revocation is not enabled.
- [ ] Full deletion lifecycle tested, including all uploads, related rows, residual diagnostics/support retention and any paid subscription.
- [ ] Actual collection reconciled with App Privacy; required-reason API manifests and SDK signatures checked.
- [ ] Appropriate age-rating, content rights, UGC reporting/blocking and moderation operations verified.
- [ ] Barista and café review accounts work and are provided privately.
- [ ] Final screenshots reflect the actual interface and all required device sizes.
- [ ] Physical iPhone tests pass for signup, verification, all login methods, reset, onboarding, posting, discovery, applications, matching, messages, reports/blocks, media, notifications, logout and deletion.
- [ ] TestFlight build selected after crash/error review; seller gate remains satisfied.

## Validation available in the repository

`npm test` runs repository checks. In `mobile`, run `npm run typecheck` and `npm run release:verify-stores`. The EAS production iOS pre-install hook also checks actual Xcode and iPhoneOS SDK versions. These checks do not replace signed-binary inspection, physical-device testing or Apple's review.

## Primary policy references

- https://developer.apple.com/app-store/review/guidelines/
- https://developer.apple.com/app-store/submitting/
- https://developer.apple.com/support/offering-account-deletion-in-your-app/
- https://docs.expo.dev/versions/v54.0.0/
- https://docs.expo.dev/build-reference/infrastructure/

### Apple deletion policy clarification — September 6 follow-up

Apple TN3194 explicitly documents fulfilling account deletion and directing manual Apple revocation when no provider credentials are available. Do not reject or postpone those deletion requests simply because no token is stored. Do not tell reviewers that manual guidance is automatic revocation. For future integrations, securely capture and validate Apple credentials server-side, implement revocation/notifications, and test with configured credentials. Reference: https://developer.apple.com/documentation/technotes/tn3194-handling-account-deletions-and-revoking-tokens-for-sign-in-with-apple
