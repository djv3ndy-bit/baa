# Android public Publisher authentication — preparation only

Prepared October 12, 2026. **Local source candidate, not deployed or activated.**

## Dated setup status — October 12, 2026

The approved Google public pool/provider and both separate public service
accounts are now configured. The saved Production trust matches the exact
`baristamatch-android` project, team issuer/audience/subject and project ID
specified below. The Publisher account has app-only Play access; the separate
FCM account has the approved sending permission. Both accounts have zero
user-managed keys. Resource readback is not live federation or delivery proof.

The exact shared-marketplace single-DO payload, SHA256
`11257763382ba2c4769d0f32567ae249a79ef3fa2a2a21e35eb3b62fc8b94d19`,
was applied once as migration `20261012101710_android_public_billing_fcm_support`
to the externally verified Production project `lmwqrxoitraofaftpwhe`. Recorded
postchecks verified the approved additions and preserved existing baseline
objects, permissions, configuration and migration history.

No Android public server has been deployed or connected to a database secret;
no live federation/catalog check, purchase/send enablement, scheduler, new
public domain, client release or public promotion has occurred. The proposed
first server step is a separately reviewed, protected Production catalog-only
check with no database credentials and all purchase/sending switches off.
Existing website/iOS and Sandbox deployments remain outside that step.

Operational evidence is kept outside the source tree in
`artifacts/google-play/android-public-google-access-configured-20261012.md` and
`artifacts/google-play/android-shared-marketplace-additions-applied-20261012.md`.
The following source design originated before resource creation; the dated
status above records the completed setup without claiming runtime acceptance.
The owner approved creation of a separate Vercel Android project and selection
of its team OIDC issuer. The project `baristamatch-android` was created and its
identity settings were checked in the UI. That is UI evidence, not a successful
signed-token or connector/runtime verification.

The Google workload identity pool/provider and public Publisher account below
are now configured under the separate approval recorded above. This code itself
performs no IAM grant, database access, deployment, environment setup, purchase
enablement or app release. Runtime validation and activation remain separate
from source review.

## Separate production identity

`googleAuth.mjs` retains the existing Sandbox identity and JSON credential path.
Its additional WIF path accepts only the exact new Android project's signed
production identity. The new path never reuses the Sandbox Google provider or
service account. It requires the following server configuration:

| Setting | Production candidate requirement |
| --- | --- |
| `GOOGLE_PLAY_AUTH_MODE` | `vercel_oidc` |
| `NATIVE_BILLING_ENVIRONMENT` | `Production` |
| `VERCEL_ENV` / `VERCEL_TARGET_ENV` | Both `production` |
| `GOOGLE_PLAY_WIF_PROJECT_NUMBER` | `397053773139` |
| `GOOGLE_PLAY_WIF_PROVIDER_RESOURCE` | `projects/397053773139/locations/global/workloadIdentityPools/baristamatch-android-public/providers/vercel-android-production` — configured; live validation pending |
| `GOOGLE_PLAY_WIF_SERVICE_ACCOUNT_EMAIL` | `baristamatch-play-public@baristamatch.iam.gserviceaccount.com` — configured; live validation pending |
| `GOOGLE_PLAY_WIF_VERCEL_ISSUER` | `https://oidc.vercel.com/baristamatch` |
| `GOOGLE_PLAY_WIF_VERCEL_AUDIENCE` | `https://vercel.com/baristamatch` |
| `GOOGLE_PLAY_WIF_VERCEL_CUSTOM_ENVIRONMENT_ID` | Absent, including no empty copied setting |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | Absent/empty in WIF mode |

The signed token must bind the exact team and stable new project ID pinned in
source, the subject
`owner:baristamatch:project:baristamatch-android:environment:production`, and
`environment=production`. Issuer, audience and subject are explicit verifier
options; team/project/environment claims are checked by the actual Vercel SDK.
The production audience must be the exact string, not a multiple-audience list.
Required time claims must be present and valid, issued-at cannot be in the
future, and token lifetime cannot exceed Google's documented 24-hour limit.

Vercel documents `custom_environment_id` as present only for a Custom
Environment. Built-in production tokens therefore must not contain that claim;
the production path rejects it even when it is null or empty. This rule comes
from the official claim definition, not an inference from the UI's abbreviated
identity table. [Vercel OIDC reference](https://vercel.com/docs/oidc/reference).

Only the platform request context's token is read. The source never calls the
fallback-capable `getVercelOidcToken`, reads a token file/environment variable,
or accepts an application-supplied request header. Signature verification occurs
before inspected claims authorize the token. Configuration variables cannot
establish trust. Production settings are snapshotted before asynchronous SDK
loading, preventing later config mutation from changing the validated identity.

The Google SDK exchanges verified request tokens at the fixed STS endpoint and
impersonates only the pinned public service account with the Android Publisher
scope. It can cache Google access tokens; each federation refresh requires a
fresh current request-context token. This is request-context authentication and
does not supply an identity for an arbitrary background process or local script.

## Prerequisites before any activation

The configured Google provider independently pins the same exact signed issuer,
audience, subject, stable owner/project IDs and production environment, with no
Custom Environment claim. Its production mappings and the specific external
subject's impersonation grant were read back; the Publisher account's saved
Play permissions are app scoped. Preserve those exact settings. The configured
trust boundary still requires a live signed request and catalog-only validation;
resource readback does not prove that exchange or purchase acknowledgement.

An approved deployment must then prove its actual signed identity and separately
exercise the required Publisher operations. Catalog read success alone would
not prove purchase verification or acknowledgement permissions. Product/base-plan
configuration and authenticated RTDN delivery remain separate requirements;
this factory grants no FCM or database access. The existing provider still
distinguishes test and live receipts by configured billing environment.

No existing iOS review project, Sandbox trust, production website setting,
issuer mode, alias, JSON credential, or mobile/iOS source is changed by this path.

## Local verification

`google-public-wif-auth.test.mjs` exercises the actual locked `@vercel/oidc`
4.0.0/Jose signature verifier using a locally generated RSA key/JWKS fixture.
It rejects forged/HS256/malformed tokens, missing or mismatched signed claims,
old-project identity, preview/Custom Environment identity, multiple audiences,
invalid time claims and all fallback token sources. It tests separate config
pins, immutable production config, Google SDK STS/impersonation refresh and
unchanged Sandbox configuration/JSON behavior. Network APIs are blocked and
Google responses are fixture adapters. Existing Sandbox and Apple regressions
run alongside these cases. This does not prove live Google permission or public
deployment readiness.

Primary sources checked October 12, 2026:

- [Vercel OIDC claims and request-token behavior](https://vercel.com/docs/oidc/reference).
- [Vercel Google Cloud federation](https://vercel.com/docs/oidc/gcp).
- [Google OIDC federation requirements](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-other-providers).
- [Google WIF trust best practices](https://docs.cloud.google.com/iam/docs/best-practices-for-using-workload-identity-federation).
- Locked local `@vercel/oidc` 4.0.0 `verify-vercel-oidc-token.js` and `get-context.js`:
  verified signature/explicit claim options and platform-context-only source.
