# Android test Publisher authentication

The optional `vercel_oidc` mode uses Vercel's signed request identity, Google
Workload Identity Federation, and service-account impersonation. It supports
only the dedicated `android-testing` Custom Environment in the existing `baa`
project. It cannot authenticate generic Preview, development, or Production
deployments. Existing JSON credentials and Apple authentication retain their
current behavior.

This code does not create cloud trust, grant access, activate billing, or enable
purchases. Keep `NATIVE_PURCHASES_ENABLED=false` and `BILLING_ENABLED=false` until
the separate release checks are complete. Do not change the existing iOS review
environment, production configuration, issuer mode, or aliases.

## Configuration

Set these **server-only public configuration values** on the approved Custom
Environment after its actual ID and Google provider resource exist. Never put
OIDC tokens, Google access tokens, or Publisher credentials into mobile/EAS.

| Variable | Required value |
| --- | --- |
| `GOOGLE_PLAY_AUTH_MODE` | `vercel_oidc` |
| `NATIVE_BILLING_ENVIRONMENT` | `Sandbox` |
| `VERCEL_ENV` | Vercel's `preview` value |
| `VERCEL_TARGET_ENV` | Vercel's `android-testing` value |
| `GOOGLE_PLAY_WIF_PROJECT_NUMBER` | `397053773139` |
| `GOOGLE_PLAY_WIF_SERVICE_ACCOUNT_EMAIL` | `baristamatch-play-test@baristamatch.iam.gserviceaccount.com` |
| `GOOGLE_PLAY_WIF_PROVIDER_RESOURCE` | `projects/397053773139/locations/global/workloadIdentityPools/baristamatch-android-test/providers/vercel-android-testing` (create this exact approved resource before use) |
| `GOOGLE_PLAY_WIF_VERCEL_ISSUER` | `https://oidc.vercel.com/baristamatch` (existing team issuer mode) |
| `GOOGLE_PLAY_WIF_VERCEL_AUDIENCE` | `https://vercel.com/baristamatch` |
| `GOOGLE_PLAY_WIF_VERCEL_CUSTOM_ENVIRONMENT_ID` | Actual generated ID of `android-testing`; no placeholder |

Leave `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` absent/empty in this mode. Missing or
invalid WIF configuration never falls back to JSON credentials, Application
Default Credentials, a token file, or an environment token. To retain the
existing JSON mode, leave `GOOGLE_PLAY_AUTH_MODE` absent or explicitly use
`service_account_json` with the existing JSON credential.

Existing product/base-plan and authenticated Pub/Sub configuration remain
required. Publisher authentication does not configure or authorize RTDN or FCM.

## Required trust boundary

The Google OIDC provider must verify the exact issuer and audience above and
require all of these signed claims in its condition:

- `owner_id = team_W7sLByby0CKVDax9uhMshO5I`
- `project_id = prj_VuAxQpdhDJPeTPdanA5HjtOrylA5`
- `environment = android-testing`
- `custom_environment_id = <actual generated ID>`
- `sub = owner:baristamatch:project:baa:environment:android-testing`

Bind only that external identity to the intended Publisher service account for
impersonation. Its Play Console permissions remain app scoped. Branch tracking
and deployment policy should restrict the Custom Environment to the approved
Git source; editable branch variables are not signed authorization claims.

Both catalog readiness and receipt verification use the same auth factory. The
token supplier obtains only the platform request-context header, verifies its
signature and exact identity, then supplies it to Google's SDK. The SDK exchanges
it at the fixed Google STS endpoint and impersonates only the pinned service
account with the Android Publisher scope. It reads a fresh request token on
each access-token refresh; it may cache Google access tokens.

A catalog GET establishes catalog read access only. It does not prove purchase
verification or acknowledgement permission. Sandbox verification still rejects
receipts without Google's `testPurchase` marker; Production rejects test
receipts. No live billing flags are changed by this mode.

Sources: [Vercel OIDC reference](https://vercel.com/docs/oidc/reference),
[Vercel Google Cloud federation](https://vercel.com/docs/oidc/gcp),
[Google auth-library federation](https://docs.cloud.google.com/iam/docs/authenticate-with-auth-libraries),
[Android Publisher authorization](https://developers.google.com/android-publisher/getting_started).
