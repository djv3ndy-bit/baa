# Android paid Café Pro launch readiness

Reviewed against main `6fedc77d7ebb899528cea924054cb0b75c4b4f0d` on 2026-10-07.

## Approved product and current status

- Café Founder Pro: **US$9.99 per month**, auto-renewing, with no annual plan.
- Baristas stay free. Existing café free-first-job behavior and Pro's three-active-job limit remain unchanged.
- The native purchase UI must show the actual verified store price. A documentation price is not permission to substitute a guessed product or offer.
- **Android checkout remains unavailable.** This preparation does not activate products, billing flags, credentials, database changes, store submission, or release.
- Existing Apple catalog, Apple review-mode safety checks, and website subscribers remain unchanged.

## Implemented preparation and remaining code gates

1. `mobile/features/native-subscription/storeCatalog.ts` intentionally returns `null` for Android. Add a Google plan only after its exact product ID, monthly base-plan ID, US availability, price and terms are independently verified in Play Console and through the installed SDK. Do not copy Apple's product identifier.
2. Server preflight now supports Google/`US` using trusted server product/base-plan configuration and `NATIVE_GOOGLE_PURCHASES_ENABLED`, which defaults off and additionally requires both existing sales gates. Google readiness is isolated from Apple credentials. Existing Apple status, preparation, start and recovery work with the Google gate off and need no new schema. Before enabling Google, apply `server/native-billing/sql/checkout_provider.sql` after the existing native checkout SQL. This unapplied, transaction-wrapped prerequisite adds a scoped provider lookup, provider-bound atomic start, and an Apple-only legacy start wrapper for rollback safety. Missing provider SQL rejects Google preparation before a reservation is created. With Google enabled, start selects the runtime/gate from the durable reservation and rechecks its provider atomically. Shared account binding and website duplicate-purchase checks remain in force.
3. `ExpoSubscriptionEntry.tsx` wraps review-mode stores in `sandboxOnlyStore`. That wrapper deliberately requires an Apple Sandbox app transaction and cannot validate an Android license tester. Do not remove or weaken that Apple guard. Design an explicit Android internal-test installation/account procedure; membership in an internal testing track alone does not prevent real charges. Until its safety is verified, keep Android review checkout closed.
4. Google acknowledgement currently occurs on the server after durable verification, then the client calls `finishTransaction`, whose installed `expo-iap` 5.5.1 Android implementation acknowledges again. Verify this duplicate-ack behavior on a licensed test device and make the completion contract explicit before launch. Do not ignore arbitrary SDK errors or treat an unverified receipt as complete.
5. Cover interrupted Google checkout recovery. A started reservation does not expire, and the only explicit resume path is Apple-only. In particular, a canceled pending Google purchase maps to expired/free, while reservation settlement only recognizes blocking/current subscriptions. Do not release a reservation based on an empty restore or an unrelated old receipt; establish a current purchase-token/attempt relationship before adding terminal-state recovery.
6. Define the authenticated RTDN policy for both license-test and real purchases. The server currently requires `testPurchase` to match its one configured environment. Test and production databases must remain separate. Do not weaken this check merely to accept both streams at one endpoint.

## Required configuration evidence

See `server/native-billing/google-play.env.example` for blank placeholders. Presence and parseability do not establish external permissions or operational readiness.

### Google Play catalog and account

- Confirm the intended Play developer/organization account owns package `com.baristajobmatch.app`, has completed applicable identity and payments setup, and has the intended signing/upload configuration.
- Record the actual subscription product ID and one active, auto-renewing monthly base plan. Verify US availability, US$9.99 recurring price, and that no introductory trial, prepaid plan, installment commitment, or annual option is silently selected.
- Verify the installed Android SDK returns that product/base plan, a usable offer token, the expected monthly recurring phase, USD price, and Play-account country `US`.
- Do not infer any of this from the Apple catalog or historic repository notes.

### Backend verification and notifications

- `GOOGLE_PLAY_PRODUCT_ID` and `GOOGLE_PLAY_BASE_PLAN_ID`: exact verified catalog values.
- `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`: a real server-only RSA service-account credential with appropriate access to the app's Android Publisher API. Confirm a read of a designated test purchase and an authorized acknowledgement in the isolated test environment. A syntactically valid key does not establish those permissions.
- `GOOGLE_PLAY_PUSH_AUDIENCE`: exact HTTPS OIDC audience of the authenticated Pub/Sub push subscription. `GOOGLE_PLAY_PUSH_SERVICE_ACCOUNT_EMAIL`: exact verified identity of that push service account.
- Configure the app's RTDN topic and authenticated push delivery to the intended `/api/native-purchases?action=google-events` endpoint. Confirm a Play Console test notification actually reaches and is accepted by the backend; confirm real test subscription events trigger an authoritative `subscriptionsv2.get` read and durable reconciliation. A publisher-side success alone is insufficient.
- Confirm retry/dead-letter monitoring for verification and acknowledgement failures. Google requires prompt acknowledgement after granting access and automatically refunds unacknowledged purchases after three days; license tests use accelerated timing.
- Confirm deployed private native billing ledger, checkout-coordination RPCs, native job-entitlement integration, role privileges, and their environment match. SQL existing in `review/` is not evidence of production deployment.
- Do not change existing website or Apple billing flags during Android preparation. The template's disabled `NATIVE_PURCHASES_ENABLED`/`BILLING_ENABLED` values apply to a new isolated setup only; `NATIVE_GOOGLE_PURCHASES_ENABLED` must stay disabled until separately approved activation. Confirm `NATIVE_BILLING_ENVIRONMENT` and platform-provided `VERCEL_ENV` agree. Restoration and existing-account status stay available when new sales are disabled. Do not roll back the provider SQL while any Google reservation may exist: the legacy start wrapper must remain Apple-only.

### Android build and testing

- Verify the real Firebase client `google-services.json` for `com.baristajobmatch.app` is supplied through `GOOGLE_SERVICES_JSON` or the reviewed local file. The production Android build currently fails closed without it. This public client file is distinct from the private Google Play billing credential, FCM V1 credential and Play submission credential.
- Confirm production public API/Supabase configuration and the native-subscription presentation flag. No server secret may use an `EXPO_PUBLIC_` variable or ship inside the app.
- Build a signed AAB with the intended upload key, increasing version code and the required Android/Play Billing toolchain. Inspect the final artifact; dependency declarations alone are not release evidence.
- Add designated accounts as license testers, opt them into the correct test track and verify the Google account used by Play. Observe the test payment method and test-purchase disclosure before completing a test purchase. Keep real payment testing separately authorized.
- Test free café, existing Stripe subscriber, existing Apple subscriber, new Google purchase, cancellation, pending/declined payment, late success after timeout, app restart, repeated taps, account switch, restore, reinstall/different device, acknowledgement failure/retry, renewals, grace/hold, expiry, refund/revocation, and linked-token replacement.
- Test paid access on Android and website using the same café account, and verify baristas cannot buy or gain café-only controls. Confirm first free job and second-job gating in the database.

## Verification scope

The local configuration checks reject missing/mixed-environment values, malformed OIDC audiences, arbitrary credential types/endpoints and invalid RSA keys without contacting Google or printing secrets. Existing unit and local database tests exercise ownership, durable grants before acknowledgement, stale-event handling, and duplicate protection. These tests do not verify Play Console setup, live permissions, signed-device billing, production database deployment, or store approval.

Run `npm test` with the repository's compiled auth-callback fixture, `node --test tests/approved-update/*.test.mjs`, `npm run test:database`, and the mobile type/auth/store checks. The Store readiness workflow explicitly includes the approved-update regressions. Both Vercel project configurations disable automatic Git deployments for `fix/android-billing-release-prep`; this does not authorize a manual deployment or change `main` deployment behavior.

## Official references

- [Play Billing setup and RTDN](https://developer.android.com/google/play/billing/getting-ready)
- [Google Play purchase verification and acknowledgement](https://developer.android.com/google/play/billing/security)
- [Play Billing test purchases](https://developer.android.com/google/play/billing/test)
- [Internal-track testing and license testers](https://support.google.com/googleplay/android-developer/answer/9845334?hl=en)
- [Subscription acknowledgement API](https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptions/acknowledge)

This checklist records required evidence, not a claim that external setup is complete. The older Google Play submission record and September release-review notes are historical and need fresh account/build verification.
