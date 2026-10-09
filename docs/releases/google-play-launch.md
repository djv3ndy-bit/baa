# BaristaMatch Google Play launch

Prepared October 9, 2026. Publisher: **BaristaMatch LLC**. The Android launch must include **Pro purchases**.

## Current status

The organization developer account is verified, the US monthly Café Pro product/base plan is active, and Android 1.0.5 (3) is on the internal testing track with purchases disabled. That first bundle predates the dedicated Android backend pins and must not be promoted to production. Android source remains separate in draft PR #86 on `codex/google-play-pro-release`, based on the existing iOS release branch at `5ccc56dcfac5aac80c080f14c0b194db1abad304` (PR #80). The dedicated Android Sandbox backend and database are initialized; public access checks pass. Optional keyless authentication code is prepared, but its custom environment, Google trust and runtime acceptance remain pending. No Google private key exists. Source tests and public GET checks do not establish successful purchases, device compatibility or public-release approval.

Existing app identity:

| Setting | Value |
| --- | --- |
| Store name | BaristaMatch |
| Android package | `com.baristajobmatch.app` |
| Version in the source | `1.0.5` |
| Expo project owner | `tovendy` |
| Build format | Signed Android App Bundle (`.aab`) |
| Production build profile | `production` in `mobile/eas.json` |
| Subscription currently expected by the app | Café Pro, monthly, US storefront, USD 9.99 |

EAS uses remote version codes and auto-increment. Read the code from the actual resulting bundle; the `versionCode` in `app.json` does not establish the uploaded version. Confirm the chosen source includes the features of the submitted iOS app before creating the Android candidate. This work does not update the Apple submission.

## 1. Create the organization account

- [ ] Open [Google Play Console signup](https://play.google.com/console/signup) using the Google account that will own BaristaMatch LLC's developer account.
- [ ] Choose **Organization**.
- [ ] Prepare BaristaMatch LLC's D-U-N-S number, exact legal name and address, website, phone, and developer contact details. Match the payments profile to the Dun & Bradstreet record.
- [ ] Complete identity, organization, and website verification when requested.
- [ ] Pay Google's **US$25 one-time registration fee** and accept its developer agreement.

Check whether the LLC already has a D-U-N-S number before requesting one. Google says a new D-U-N-S request can take up to 30 days. The 12-testers/14-days requirement discussed earlier applies to qualifying new **personal** accounts; this launch is using an organization account.

Sources: [Signup](https://support.google.com/googleplay/android-developer/answer/6112435), [Account types](https://support.google.com/googleplay/android-developer/answer/13634885), [Organization information](https://support.google.com/googleplay/android-developer/answer/13628312).

## 2. Create the Play app and Pro product

- [ ] Create **BaristaMatch**, app type **App**, using the existing package `com.baristajobmatch.app` when uploading the bundle. Enable Play App Signing.
- [ ] Configure the initial distribution to match the app's existing US-only purchase restrictions.
- [ ] Create the actual Café Pro subscription and an auto-renewing **monthly** base plan; configure USD 9.99 for the United States and activate the base plan.
- [ ] Copy the real product ID and base-plan ID into the matching server and mobile configuration below. The code does not invent or automatically create a Play product.
- [ ] Keep introductory/promotional offers out of the initial launch; the current client selects the ordinary monthly base plan.
- [ ] Create license testers and an internal testing track for signed-device billing tests.

The plan must be configured on Google Play independently of the Apple product. The prepared checkout checks require the actual product, active base plan, monthly period, expected price, and US availability to match.

## 3. Configure billing and notifications

Store these values in the appropriate managed environment. The two `EXPO_PUBLIC_` identifiers below are public product metadata; service-account private keys belong only in server or EAS credential storage.

| Location | Configuration needed |
| --- | --- |
| Mobile/EAS production environment | `EXPO_PUBLIC_GOOGLE_PLAY_PRODUCT_ID`, `EXPO_PUBLIC_GOOGLE_PLAY_BASE_PLAN_ID`, and `EXPO_PUBLIC_NATIVE_SUBSCRIPTIONS_ENABLED=true` after setup is validated |
| Server environment | Matching `GOOGLE_PLAY_PRODUCT_ID` and `GOOGLE_PLAY_BASE_PLAN_ID` |
| Server Android Publisher credential | Existing `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`; the isolated Android Custom Environment also supports the explicit [keyless WIF mode](google-play-wif.md). Play API permissions are required for verification and acknowledgement. |
| Server notification authentication | `GOOGLE_PLAY_PUSH_AUDIENCE` and `GOOGLE_PLAY_PUSH_SERVICE_ACCOUNT_EMAIL` |
| Server release flags | `NATIVE_BILLING_ENVIRONMENT=Production`, `VERCEL_ENV=production`, `NATIVE_PURCHASES_ENABLED=true`, and `BILLING_ENABLED=true` only in the intended production environment |
| Android app notification configuration | EAS production **file** variable `GOOGLE_SERVICES_JSON` for the Firebase Android app with package `com.baristajobmatch.app` |
| Push delivery credential | FCM v1 service-account credential through EAS credential management |

Google Play real-time developer notifications use the existing endpoint:

`https://www.baristajobmatch.com/api/native-purchases?action=google-events`

Configure authenticated Pub/Sub push delivery with an audience and service-account identity matching the server settings. Test lifecycle updates, including renewals and cancellation. Firebase's client `google-services.json`, the FCM delivery credential, and the Play API/server notification credentials serve different purposes.

Select **Get notifications for subscriptions and all voided purchases** in Play Console. Subscription voids re-fetch the current subscription state; a refunded order alone does not revoke Pro. Valid one-time-product voids are acknowledged and deduplicated without changing subscription access, because the app does not sell one-time products. Malformed, mixed, and unknown notification payloads are rejected.

Public-release limitation: `pendingRefundReviewNotification` is not implemented. Google's current [RTDN reference](https://developer.android.com/google/play/billing/rtdn-reference#pendingrefundreviewnotification) describes a separate chargeback-review response within 24 hours through `orders.reviewrefund`. Confirm delivery eligibility and the required operational response before public paid release; this candidate does not submit refund preferences or usage evidence. Owner-only Sandbox tests do not establish that workflow or successful end-to-end refund handling.

- [ ] Confirm the existing native ledger and checkout functions are deployed in the target database.
- [ ] Apply the additive service-role-only function in `server/native-billing/sql/checkout_provider.sql` **before** deploying the updated server. It selects the provider from the saved account-bound reservation before authorizing store startup. Its absence prevents startup.
- [ ] Review and deploy the server changes; preserve the original Apple and website subscription protections.
- [ ] Test Play verification and acknowledgement permissions explicitly. A successful catalog lookup proves catalog read access, not purchase acknowledgement access.

Sources: [Expo FCM setup](https://docs.expo.dev/push-notifications/fcm-credentials/), [Google purchase verification](https://developer.android.com/google/play/billing/security), [Real-time developer notifications](https://developer.android.com/google/play/billing/rtdn-reference).

## 4. Prepare listing and review information

Draft text is in [google-play-store-listing.md](google-play-store-listing.md). Publish only after the tested Android candidate supports the described features and Pro purchasing.

- [ ] Supply a **512 × 512 PNG** store icon and **1024 × 500** feature graphic.
- [ ] Capture at least two actual Android screenshots; use the Android candidate rather than screenshots with iOS system controls.
- [ ] Complete Data safety using the actual Android build, SDK behavior, backend data flows, and retained records. Do not copy Apple privacy answers without checking their Google equivalents.
- [ ] Complete the content rating, target audience, ads, app access, and other applicable declarations.
- [ ] Provide working reviewer access for both barista and café flows and explain how to exercise Pro with Google's test purchase flow.
- [ ] Verify the public privacy policy and account deletion page, plus deletion inside the app. Public retrieval during this preparation returned older privacy text and could not retrieve the deletion URL; their current behavior remains unverified.
- [ ] Review existing-subscriber links to the website billing portal against the current Play payment rules and the actual Android UI before release.

Sources: [Google listing assets](https://support.google.com/googleplay/android-developer/answer/9866151), [App review declarations](https://support.google.com/googleplay/android-developer/answer/9859455), [Payments policy](https://support.google.com/googleplay/android-developer/answer/9858738).

## 5. Test with Google license testers

The production backend deliberately rejects Google test purchases. Use the separate `android-payment-review` build profile and isolated test backend for license-tester billing tests; do not weaken the production receipt-environment check.

- [ ] Configure the isolated API/database with `NATIVE_BILLING_ENVIRONMENT=Sandbox` and `VERCEL_ENV=preview`. Apply the required native billing SQL to this isolated database and configure its own Google verification/RTDN settings.
- [ ] Supply the genuine Play product/base-plan IDs and Firebase file to the EAS preview environment. Build from `mobile/` with `eas build --platform android --profile android-payment-review`.
- [ ] Keep `EXPO_PUBLIC_GOOGLE_PLAY_LICENSE_TESTING` out of production. The explicit test flag allows the Google SDK only in the isolated Android test build; it does **not** prove that the Google account is a license tester. Apple review purchases still require Apple's Sandbox installation proof.
- [ ] Upload the isolated build to internal testing and install it using a configured Google **license-tester account**. Check the active Google account in the purchase dialog and confirm that Google shows a **test purchase notice and test payment method** before completing a purchase. Being on an internal track alone does not make a transaction a test purchase.
- [ ] Verify purchase, acknowledgement, restore/reinstall, account binding, cancellation, renewal, payment failure, and RTDN access updates in the isolated environment.
- [ ] Verify that an existing website/Apple/Google subscription or pending checkout blocks a duplicate, including concurrent attempts. Use the corresponding test-provider records and credentials.

Google's SDK does not provide the Apple app-transaction proof used by the existing iOS guard. The signed test profile, isolated backend, Play license-tester setup, and visible Google test-payment confirmation together define this test procedure. The server still verifies Google's `testPurchase` response and rejects real purchases in Sandbox.

Source: [Google billing tests](https://developer.android.com/google/play/billing/test).

## 6. Build the production candidate and submit

- [ ] Run the mobile type check and store configuration checks with the intended production inputs.
- [ ] Build the signed Android candidate from `mobile/` using `eas build --platform android --profile production` after Firebase and billing inputs are configured.
- [ ] Inspect the generated manifest for the package, version code, permissions, and target API. Google currently requires API 36+ for new phone apps.
- [ ] Run the existing `mobile/scripts/verify-android-bundle.py` check on the real bundle and complete 16 KB device/emulator compatibility testing. Source configuration does not establish binary compatibility.
- [ ] Upload to the internal testing track. Manual upload is available; EAS Submit requires its own Google service-account configuration. The existing `submit.production` profile only specifies iOS, so do not assume Android automated submission is configured.
- [ ] Test signup/login, both dashboards, jobs/applications, matches, messaging, media selection, account deletion, notifications, and interrupted-network behavior on Android.
- [ ] Carry forward the isolated billing evidence above; verify the production candidate uses the intended live API/database, configured real product, and production credentials. Test normal app behavior against production without treating license-test receipts as production purchases.
- [ ] Run Apple billing regression checks after the server update.
- [ ] Fix failures, complete Play declarations, and send the release for Google review. Promote to production only after the required testing and approval.

Sources: [Expo Android submission](https://docs.expo.dev/submit/android/), [Target API](https://support.google.com/googleplay/android-developer/answer/11926878), [16 KB compatibility](https://developer.android.com/guide/practices/page-sizes).

## Evidence still required

Dedicated Publisher authentication and RTDN setup, deployed keyless/notification source acceptance, current privacy/deletion review, store assets, a newly isolated signed Android AAB, and successful device/billing tests remain required. Production database/configuration and release approval remain separate gates. The verified LLC account, active product/base plan, initialized Android Sandbox database/backend and first purchases-disabled AAB do not establish these remaining outcomes. Local unit and database fixture tests validate code behavior; they do not replace release acceptance.

## Local validation

October 8, 2026: 505 automated checks passed across the approved-update suite and Android build/manifest/bundle checks, plus 26 database fixture tests covering checkout coordination and Apple recovery. The mobile TypeScript check, store configuration check, and diff whitespace check passed. These ran with the bundled Node.js 24.19.0 runtime; the pinned Node.js 22 EAS builder and resulting signed binary remain part of the external build verification.
