# Apple Sandbox account compatibility — local review draft

This work is local preparation only. Nothing in this folder has been applied to
Supabase, Vercel, a live website, an uploaded iOS build or App Review. The SQL is
a one-time **draft fragment**, not an invented migration and not startup code.
There is no tester activation or mapping seed in the fragment.

## Purpose and baseline

The production schema read on October 31, 2026 has one global native billing
configuration row set to Production. Its native checkout functions and paid-job
bridge use that global setting. The live `native_checkout_provider` function
also explicitly hardcodes Production, despite a more generic source proposal.
Changing only the Apple verifier would therefore leave checkout or actual paid
features unavailable.

The fragment `server/native-billing/sql/apple_sandbox_test_accounts.sql` keeps
global Production and introduces an initially empty, server-owned Apple Sandbox
mapping limited by a database CHECK to the existing dedicated reviewer café
UUID. Source backend provenance is `badfed14682a4e8aa0f96bfa97a14dd53ee01e22`;
the database baseline is separately captured live metadata, not inferred from
that Git revision.

Before its first DDL statement, the fragment fails closed on unexpected current
function bodies, owners, volatility, definer flags, search paths, RPC EXECUTE
grants, exact argument names/defaults/results, table privilege kinds, RLS settings, client policies, captured constraints
or indexes. It also requires the unchanged singleton Production configuration.
The untouched Stripe checkout body is guarded too. Reapplication aborts rather
than silently replacing a potentially changed authorization model.

## Server-only contracts

All management/context/checkout/ledger RPCs are executable only by service_role;
there are no direct service_role or client grants on the private mapping or
native tables.

- `native_billing_context(p_user_id uuid, p_provider text DEFAULT NULL)`
  returns `{environment, appleSandboxTester}`. An unmapped account uses the
  configured environment. An active mapped café resolves NULL/apple to Sandbox.
  A mapped Google context is rejected. A disabled/expired mapping returns to
  the configured environment; suspension/role changes cannot authorize Sandbox.
- `native_billing_set_apple_sandbox_tester(p_user_id uuid, p_enabled boolean,
  p_expires_at timestamptz DEFAULT NULL)` is restricted to the exact reviewer
  café. Activation requires a future expiry no more than 30 days away, the
  active café profile, an unpaused account, configured Production, and no
  unresolved Stripe/native/checkout state. Revocation increments the durable
  generation and does not cancel any purchase.
- `native_checkout_claim/start/recover_apple` gain a trailing
  `p_guard_protocol text DEFAULT NULL`. Their old signatures are dropped, so
  PostgREST cannot choose an ambiguous overload. Mapped Apple Sandbox launch
  requires the exact `apple-app-transaction-v1` protocol supplied by the
  backend, stored on the attempt, and current mapping generation. NULL behavior
  for unmapped Production and the isolated Sandbox QA configuration remains.
- `native_checkout_attempt_context(p_user_id uuid,p_attempt_id uuid)` returns
  only the exact owned attempt's recorded
  `{environment,provider,guardProtocol}`, allowing the backend to cancel the
  original environment without trusting a client environment field.
- The new authenticated `native_billing_self_access(p_user_id uuid)` exposes
  only a self-only boolean. Other-user IDs return false. It exposes no receipt,
  binding, transaction, mapping list or private ledger row. The existing public
  hiring helper remains SECURITY INVOKER and self-only.

The backend must derive the UID from its existing authenticated session and use
the resolver. Client request flags, user_metadata and cached claims cannot
authorize a tester. The protocol header only admits compatible clients. The
native SDK checks the verified AppTransaction environment and bundle on-device
before launch; that proof is not sent to or validated by the backend. Genuine
purchase signatures, product identity and account binding are verified on the
server when reconciling the resulting purchase. The header alone never chooses
an environment or grants access.

## Lifecycle and security behavior

Mapping updates, new checkout and native ledger application serialize on the
existing café subscription row. Authority is rechecked after waiting for that
lock; mapping expiry uses `clock_timestamp()`, not a transaction-start clock.
New authorization declines under a stale repeatable-read/serializable snapshot.
A persisted generation prevents an older reservation from launching after a
mapping transition.

Unmapped customers retain the configured environment for status, checkout and
Stripe coordination. Unrelated historical Sandbox noise cannot block their
normal Production flow or grant Production paid access. Only the exact tester
with a retained server-owned mapping record keeps unresolved Apple Sandbox
obligations as blockers after revocation/expiry.

Revocation/expiry immediately removes current Sandbox access and prevents new
launch/recovery. Exact recorded-environment cancellation and settlement still
work. An already-owned, revisioned historical record may receive verified
expired/revoked updates after revocation; a new unauthorized record or a
nonterminal unauthorized update is rejected. The matching backend separately
verifies and acknowledges an owned historical nonterminal notification without
applying it, rather than granting access or retrying forever. This is an
intentional conservative limit: such a renewal does not refresh the retained
SQL ledger while tester authorization is off.

Apple/Google environment partitions, store bindings, ownership, optimistic
revisions, superseded token tombstones and event replay identity remain. No
Sandbox proof is relabeled Production. No Sandbox row confers ordinary
Production paid access. The same account cannot silently bypass the existing
Stripe/native purchase coordination.

The native paid-job and hiring bridges recognize genuine current Production
native entitlements normally, and only current mapped Apple Sandbox
entitlements for the designated tester. Native access respects suspension,
role, owner pause and current expiration. Existing real Stripe and
complimentary/free rules remain. The saved source job-match messaging policy
intentionally preserves existing participant chat after paid access ends;
discovery-message insertion separately requires current hiring access.

The service-only summary adds an authoritative `ownerPaused` boolean; a missing
café account state defaults to paused. No pause timestamp is returned. The
coordinated backend masks current access/purchase/resume while preserving the
financial subscription status and manage action, and restores current access
when the owner pause is removed.

## Local verification

`tests/database/apple-sandbox-test-accounts.test.mjs` runs **31 passing tests**
inside disposable in-process PGlite 0.5.8. It reuses an already installed package;
no dependency was installed and it cannot fall back to a hosted database.

The fixture loads source migrations, exact captured live native/Stripe function
definitions and synthetic data. It tests actual roles and RLS, genuine guarded
job insertion, saved source discovery-message policies, ordinary Sandbox noise,
both environment paths, mapping expiry/revocation/generation, exact guard
protocol, cancellation/settlement, ownership/revision/replay, sanitized summary,
and atomic drift rejection. The fixture omits notification side effects.

Saved local TAP output:
`../apple-sandbox-pglite-test-results.tap` relative to this work folder.
The root agent separately runs real PostgreSQL 17 independent-session races
using the same fixture helper; those results are reported in its own artifact.

## Remaining release gates

This draft is not a production rollout approval. Before applying any shared
database or backend change, refresh/verify baseline drift, review the complete
coordinated backend/native patch and obtain the owner's separate approval.
The mapping stays empty until a separately approved, bounded activation for
the already designated reviewer account.

A genuine native Apple Sandbox purchase and restoration are still required in
an appropriately signed, authorized build. Synthetic SQL/provider fixtures do
not prove Apple agreements, product availability, App Store connectivity,
receipt signatures in a real store session, or Apple acceptance. No build
upload, submission or resubmission is included here.

## Rollout order and rollback boundary

Deploy the SQL with its mapping still empty before deploying the new backend.
The fragment queues `NOTIFY pgrst, 'reload schema'` immediately before COMMIT;
PostgreSQL delivers it only after that transaction commits. Verify refreshed
PostgREST named/default RPC dispatch and the read-only context result before
deploying dependent backend code. The direct local SQL tests prove PostgreSQL
named/default compatibility, not a live PostgREST cache refresh. PostgREST
documents both [omitted default parameters](https://docs.postgrest.org/en/stable/references/api/functions.html)
and the required [schema cache reload](https://docs.postgrest.org/en/stable/references/schema_cache.html).

With an empty mapping, the prior backend's omitted guard arguments still bind
to the new defaulted SQL signatures. A stale installed client without the
capability header is rejected for a mapped tester before a reservation or store
launch. No profile completeness, complimentary access or trial data is changed.

Disabling the mapping is necessary before an old-code rollback but is not
sufficient for complete tester recovery. The old backend hardcodes Production,
so it cannot cancel/settle/reconcile recorded Sandbox obligations. A pending
Sandbox attempt remains safely blocked after such a rollback. Retain the new
billing endpoints until outstanding Sandbox attempts/subscriptions have been
resolved through verified outcomes, or explicitly accept that tester-only
fail-closed recovery limitation. Do not release an uncertain started attempt or
change its recorded environment just to make rollback appear complete.

