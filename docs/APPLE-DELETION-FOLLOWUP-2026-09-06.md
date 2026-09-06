# Apple-account deletion follow-up — September 6, 2026

> Current execution status and remaining gates: [Launch checklist](LAUNCH-CHECKLIST.md). This preparation/audit record is not itself proof of store approval.

## Scope and correction
Baseline: 3fb5a58a1f3e7e9d01d1f16c2c9b0608a234de3f. The current repository deletion integration has no retained Apple provider token or automatic /auth/revoke path. Supabase sessions are not Apple provider credentials and must never be sent to Apple's revoke endpoint.

The preceding audit was too absolute about automatic revocation being the only supported deletion path. Apple TN3194 explicitly describes a no-token fallback: fulfill the account deletion request, direct the user to manually revoke Apple access, and leave the client unauthenticated. This repair implements that fallback on web and native source. It does not certify App Review acceptance or implement future provider-token capture/revocation.

## Repairs
- The authenticated deletion endpoint detects Apple-linked identities from verified Auth service fields, not editable user_metadata or request-body flags. It returns manual_required only after account deletion actually succeeds. Existing authentication, confirmation and fail-closed storage cleanup are preserved.
- Native deletion requires explicit success, prevents duplicate submissions, binds the request to the reviewed signed-in account, clears this project's local auth storage, and opens a persistent Apple follow-up screen. A local logout failure is separate from a confirmed account deletion and never retries deletion.
- Web deletion has the same explicit-success and account-switch protections. Its SIGNED_OUT navigation no longer overwrites the completion page. A short-lived token-free receipt prevents a direct URL/query parameter from being displayed as proof of deletion.
- The public page and native screen provide current Apple device/web instructions. No Apple password, provider token, signing key or user identifier is placed in URLs, logs, public documents or receipts.
- Temporary repair-branch source-snapshot tooling is removed before merge.

## Limits and outstanding gates
Automatic Apple authorization revocation, secure provider-token capture/storage for future sign-ins and provider revocation-notification integration remain unimplemented. Manual disconnect is not presented as automatic. The owner still requires BaristaMatch LLC seller verification. Signed IPA/AAB testing, remaining deletion/retention/subscription lifecycle work and store-console requirements remain open. No production accounts are deleted or signed-in identities revoked by this repair process. Tests use mocked identities and storage.

Web/backend deployment and native installed-build status must be reported separately. Merging native source does not update an installed TestFlight app.

## Primary sources checked
- https://developer.apple.com/documentation/technotes/tn3194-handling-account-deletions-and-revoking-tokens-for-sign-in-with-apple
- https://developer.apple.com/support/offering-account-deletion-in-your-app/
- https://support.apple.com/en-us/102571
- https://supabase.com/docs/reference/javascript/auth-signout
