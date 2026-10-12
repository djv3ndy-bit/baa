# Android reviewer Pro access — prepared, not activated

This change supplies temporary premium access for explicitly selected café
reviewer accounts without creating Google/Stripe purchase records. It is only
for the isolated Android review database/API and dedicated `android-testing`
Vercel Custom Environment. Apple review and production receive no grant field
when this feature is disabled, which is the default.

The active status adds `reviewAccess: { active: true, expiresAt: ISO8601 }`, sets
account access to Pro and blocks new checkout. Actual provider, receipt status,
period, renewal and subscription history remain unchanged. The Android client
labels the grant as reviewer access with its exact expiration; actual store
management remains available only for existing provider subscriptions.

## Deployment and activation order

1. Independently verify the selected Supabase project is the isolated Android
   project. The reviewed SQL is target-specific and checks Sandbox, but SQL
   cannot intrinsically attest the hosted project ref. Do not apply elsewhere.
2. After explicit approval, apply
   `server/native-billing/sql/android_reviewer_access.sql` only there. It starts
   disabled, with an empty allowlist and no grants. No client/service role can
   read or edit its private configuration/grant tables; the sanitized read RPC
   is service-role-only.
3. Deploy the reviewed backend with `ANDROID_REVIEW_ACCESS_ENABLED=false`.
   Build/upload/install a new Android client containing the reviewer field/UI
   support. Build8 predates this contract and must not be used to claim correct
   reviewer presentation after activation. No Apple build or production deploy.
4. Obtain approval for the exact saved café UUID, Custom Environment ID and
   dated finite expiration. Keep those operational values outside published
   source. Confirm the account exists, has the saved café role, is unsuspended,
   and has ordinary unpaused hiring access. No pending/reserved/started native
   or website checkout may exist. Do not clear a real pending purchase merely
   to activate this grant.
5. Set the following variables exclusively on the Android Custom Environment:

   | Name | Value |
   | --- | --- |
   | `ANDROID_REVIEW_ACCESS_ENABLED` | `true` after reviewed activation |
   | `ANDROID_REVIEW_API_BASE_URL` | `https://android-testing.baristajobmatch.com/api` |
   | `ANDROID_REVIEW_PACKAGE_NAME` | `com.baristajobmatch.app` |
   | `ANDROID_REVIEW_CUSTOM_ENVIRONMENT_ID` | Exact existing Android Custom Environment ID |
   | `ANDROID_REVIEW_USER_IDS` | Explicit comma-separated approved café UUIDs; maximum8, no spaces/duplicates |

   Existing values must still be the exact Android `SUPABASE_URL`, Sandbox
   `NATIVE_BILLING_ENVIRONMENT`, preview `VERCEL_ENV`, `android-testing`
   `VERCEL_TARGET_ENV`, and the same CID in
   `GOOGLE_PLAY_WIF_VERCEL_CUSTOM_ENVIRONMENT_ID`. No secret or raw platform
   token is added. Every allowed grant lookup verifies the signed request
   context afresh against the existing team issuer/audience, owner/project,
   subject, environment and exact server-configured CID. An enabled lookup
   failure returns an error and never silently enables checkout.
6. In one approved target-only transaction, insert the selected private grant
   with the approved expiry and activate the private configuration using the
   same CID/UUID allowlist. Activation locks the same café subscription row as
   checkout/deletion and rejects an open checkout. The final native checkout
   state write also rejects an active grant. Purchase switches are independent;
   enabling reviewer access does not enable purchases for other accounts.
7. Verify new-client reviewer sign-in, truthful no-payment/expiry text, second
   and third active jobs, fourth-job rejection, existing matching/messaging,
   disabled new purchase and unchanged real provider history/management. Only
   then assert full premium access in Play reviewer instructions. Local tests
   do not establish hosted or device acceptance.

## Revocation, expiration and rollback

For a single reviewer, set `private.android_reviewer_grants.revoked_at` in an
approved target-only operation; for all reviewers, also set private
configuration `enabled=false`. Expiry is checked by server and SQL on each
read, so it does not rely on a scheduler. Revocation/expiry reduction remains
possible after suspension or owner pause. Auth deletion cascades the grant;
retained profiles/stale JWTs cannot keep reviewer paid access.

Disable/revoke the **database** grant/configuration and also set
`ANDROID_REVIEW_ACCESS_ENABLED=false` on the Android Custom Environment,
redeploying through its existing permitted Git path. Server-flag-only shutdown
would hide the UI grant while leaving the database job predicate active.
DB-only shutdown safely removes reviewer paid access but leaves enabled
lookups verifying configuration; complete both parts and verify Free status.
Keep verified purchase ledgers and the first-free-job history intact. Existing
genuine Stripe/native paid access continues according to its original rules.

Validation covers actual local PostgreSQL RLS/permissions, three-job limits,
expiry/revocation/Auth cascade, exact signed SDK identity, closed checkout
activation orders, default/iOS contracts and outage behavior. Lock ordering is
reviewed and serialized order cases are exercised in PGlite; this is not a
multi-session hosted concurrency test or a completed Play/device test.
