# Activation analytics repair — September 28, 2026

## Findings

Reviewed main `3e4834e` and [PR #64](https://github.com/djv3ndy-bit/baa/pull/64),
merged September 22 at 21:29:08 UTC (`d4ccd742`). No subsequent commit on main
changes the event writer, signup screen, callback, or Supabase migrations.
[Growth and social launch plan](https://app.notion.com/p/3d0de8c72206813eb2a2ce4da46f7fe5)
still reports no post-merge events (last edited September 22).

- Main sends `metadata` but never inspects the returned insert error. Its only
  committed `product_events` definition is the minimal policy-test fixture; no
  committed migration establishes the metadata column.
- **Production differs from that fixture.** Read-only inspection of project
  `lmwqrxoitraofaftpwhe` found `id` (bigint identity), `user_id` (uuid),
  `event_name` (text), `metadata` (non-null jsonb, default `{}`), and `created_at`.
  The remotely recorded `20260826022248_cafe_subscription_foundation` migration
  already created metadata in August. This is not a newer post-PR fix.
  Production still has zero total and zero post-merge events. Missing metadata
  therefore cannot be asserted as the cause of the live zero count. Installed
  app version, genuine usage and transport failures remain unverified.
- RLS is enabled, with authenticated INSERT checked against `auth.uid()` and
  no client SELECT/UPDATE/DELETE grant. This PR preserves existing privileges
  and policies exactly; it introduces no privileged function or auth trigger.
- Email signup without a session routes to `/verify-email`; the existing
  `20260902052302` trigger creates the profile. The HTTPS callback bridge
  forwards tokens to the native route, which authenticates and checks the
  saved role before routing home. That path had no completion event.

## Change

The additive migration handles both a schema missing metadata and the existing
production schema. A partial unique index allows one `signup_completed` per
non-null user ID, across callback replays, retries, and app restarts. Other event
names remain repeatable. Existing records are never deleted or backfilled.

The writer uses plain INSERT with the verified current account ID and no
returned representation. It handles returned errors and thrown failures;
diagnostics contain only an allowlisted event name and fixed failure category.
Only a signup conflict on the named uniqueness index is treated as a duplicate.
Metadata contains `surface: mobile` and, when valid, the saved role enum. Names,
emails, locations, demographics, tokens, raw error text and arbitrary strings
are excluded. The existing pseudonymous `user_id` is retained; no identifier is
added.

The callback emits only for a successful `type=signup` confirmation with a
confirmed email, the same authenticated user and a supported saved role. Warm
query-parameter routes now preserve that type; fragment/cold links already do.
Ordinary OAuth/login, magic-link, recovery, invite and email-change callbacks
do not count. Role-less users still complete setup through the existing signup
screen. Immediate-session and explicit-profile signup events remain supported
and use the confirmed saved role and expected user ID.

All callers keep analytics fire-and-forget. Navigation and account setup never
wait for the event write. There is no durable retry queue or historical backfill;
an offline/terminated app can still lose a best-effort event. A later explicit
completion retry can succeed without double-counting.

## Validation

Local tests use synthetic accounts and network stubs only:

- Event writer: all six events, the installed Supabase SDK's POST/error handling,
  metadata filtering, unauthenticated and switched accounts, returned/throwing
  failures, retry after failure, named signup conflicts, callback classification.
- Actual native screens: both roles, cold and warm confirmation routes,
  duplicate link delivery, immediate-session signup, failed auth/context,
  navigation while the analytics promise remains unresolved, and analytics failure.
- PGlite PostgreSQL queries: reproduce missing-column failure before migration;
  successful inserts afterward for legacy and live-shaped schemas; migration
  reapplication; old payload compatibility; repeatable steps; duplicate signup
  rejection; anonymous/null-subject/cross-account rejection; unchanged RLS/grants.
  Existing duplicate history makes the migration fail without data loss.
- Existing authentication, signup and policy-performance regressions, mobile
  TypeScript check and launch static checks.

The auth workflow runs the event and native-screen tests. The existing Website
account-journey workflow discovers the new database test automatically.

The six targeted suites above passed locally: **79 tests, zero failures/skips**.
Mobile `npm run typecheck --prefix mobile`, `node launch-check.js`, and
`git diff --check` passed. This is local regression evidence, not a production
email/signup smoke test or proof that an installed mobile build contains the fix.

## Release handoff — approval required, not performed

This branch is for review. No database migration, app build submission, merge or
deployment was performed. Both Vercel project configurations disable automatic
deployment only for `fix/activation-analytics-confirmed-signup`, following
[Vercel's branch configuration](https://vercel.com/docs/project-configuration/git-configuration).
Other branches retain their existing behavior. Keep the rule while reviewing;
renaming the branch requires updating it before pushing.

1. Recheck aggregate event counts and duplicate signup groups before an approved
   release. Review any duplicates instead of deleting historical data:

   ```sql
   select count(*) as duplicate_signup_groups
   from (
     select user_id from public.product_events
     where event_name = 'signup_completed' and user_id is not null
     group by user_id having count(*) > 1
   ) duplicate_groups;
   ```

2. Apply `20260928121018_repair_activation_product_events.sql` first in an approved
   staging environment, then production only after release approval. The migration
   has a three-second lock timeout and requests a PostgREST schema-cache reload.
   A duplicate or lock failure stops the migration for review; do not release the
   client until the migration is confirmed. Check the metadata column and named
   index definition, plus unchanged RLS/grants.
3. Use an isolated test environment to confirm email signup for each role, replay
   the callback/reopen the app, and verify exactly one completion per account.
   Confirm ordinary login/recovery produce none; exercise the other five events.
   Validate inserts through PostgREST under authenticated RLS, not a service key.
4. Release the reviewed mobile build/update separately. Confirm real post-release
   usage produces aggregate events without `schema_mismatch`, `permission_denied`
   or other failure diagnostics. Never seed production with fake activation events.

Rollback: revert the client changes through the approved release process while
leaving the additive metadata column and event history intact. Removing that
column breaks older clients that already send it. Keep the deduplication index
unless a separately reviewed database change proves removal necessary.
