# BaristaMatch App Store submission record

Use this record when completing App Store Connect for iOS version 1.0.3. Recheck every answer whenever application behavior changes.

## Legal and listing identity

- App name: BaristaMatch
- Bundle ID: `com.baristajobmatch.app`
- Legal operator: BaristaMatch LLC (Florida)
- Privacy Policy URL: `https://www.baristajobmatch.com/privacy.html`
- Support URL: `https://www.baristajobmatch.com/support.html`
- Marketing URL: `https://www.baristajobmatch.com/`
- Contact email: `hello@baristajobmatch.com`
- Suggested primary category: Business
- Suggested secondary category: Social Networking
- Suggested age rating: 16+ because the marketplace is limited to users age 16 or older and includes user-generated profiles and messaging.

Do not enter the EIN in application code, public metadata, review notes, or public legal pages. Provide tax identifiers only through Apple's protected tax and banking workflow.

## App Review notes

BaristaMatch is a Florida-focused employment marketplace connecting cafés with baristas. Baristas can create profiles, discover café opportunities, apply, match, and message. Cafés can create profiles, post jobs, review applicants, match, and message. BaristaMatch is not an employer or staffing agency.

Account creation is limited to users who confirm they are at least 16. Users under 18 must confirm parent or guardian permission. In-app Account Settings includes permanent account deletion. User-generated conversations include report and block controls. A functional review account for each role must be supplied in the secure App Review Information fields.

Barista accounts are free. Café billing is not active in this release: the plan screen is an informational preview and cannot initiate a charge. Café accounts receive complimentary access without entering a card. Existing billing-administration code is server-disabled by default. If paid café functionality is enabled in a future version, payment eligibility must be reviewed again against the then-current App Review Guidelines before release.

The app uses Sign in with Apple and Google as optional authentication methods alongside email/password. Sign in with Apple must remain configured for the production bundle identifier and its tokens must be revoked during account deletion if Apple authorization was used.

## App Privacy answers to verify in App Store Connect

The application currently processes the following categories. Mark them as linked to the user's identity unless App Store Connect guidance clearly indicates otherwise.

| Data category | Examples in BaristaMatch | Purpose |
| --- | --- | --- |
| Contact info | Email address | App functionality, account management, support |
| User content | Profile text, job posts, images, coffee videos, messages | App functionality |
| Identifiers | User ID, device push token | App functionality, security, notifications |
| Usage data | Profile views, applications, matches, notification activity | App functionality, analytics |
| Diagnostics | Error details, page or route, device/browser details | App functionality, diagnostics |
| Other data | General location entered by the user, skills, experience, availability, desired pay, optional age range and gender | App functionality, matching, aggregate analytics |
| Purchases | Café subscription status if billing is enabled | App functionality, account management |

Current policy: no data is sold and no data is used for third-party targeted advertising. Confirm the production build contains no additional analytics or advertising SDK before submitting these answers.

## Required manual App Store Connect checks

- Confirm the Apple Developer membership is an Organization membership under the exact LLC legal name. If it is Individual, request conversion and complete D-U-N-S verification before public release if the LLC should be displayed as seller.
- Complete Agreements, Tax, and Banking using Apple's protected forms.
- Verify the app record uses the bundle ID and App Store Connect app ID declared in `mobile/app.json` and `mobile/eas.json`.
- Add accurate iPhone screenshots for every required display size and ensure screenshots show the production interface.
- Supply working barista and café review accounts in the private App Review Information fields.
- Test email/password, Sign in with Apple, Google sign-in, password reset, account deletion, report/block, job posting, applying, matching, messaging, photo/video upload, and push notifications on a physical iPhone.
- Confirm the production Supabase migrations are applied, Vercel environment variables are configured, and billing remains disabled for this release.
- Upload a release build to TestFlight, complete internal testing, inspect crashes, and only then submit the selected build for review.

## Release gate

The app is ready to submit only when automated checks pass, the production build passes the physical-device flow above, App Store Connect privacy answers match the build, review accounts work, and the seller/legal account setup is correct.
