# Account database regressions

Run `pnpm install --frozen-lockfile` and `pnpm test` from this directory. PGlite 0.5.8 is pinned with an integrity lockfile. It executes PostgreSQL functions, triggers, RLS, constraints, role changes, and transactions locally. No production connection, credentials, Docker, or message delivery service is used.

The production-shaped fixture contains the tables and existing rules needed for these repairs, including broad Supabase-style default table grants and the Realtime publication. The profile SELECT rule is deliberately simplified; this suite does not replace the separate production profile/privacy policy audit. Private demographic and complimentary billing records remain unchanged by the migration. Each test runs in a rolled-back transaction.

The suite verifies café completion, blank fields, suspension, visibility opt-outs, email and role-less OAuth signup, direct API authorization and immutable application identity, supported status transitions, complete Florida job addresses and legacy updates, durable discovery notifications, recipient-scoped read acknowledgments, unrelated/blocked/anonymous denial, and privileged helper permissions.

## Release order and recovery

Apply `20260907045304_repair_account_integrity_and_discovery_notifications.sql` before deploying the frontend that reads `discovery_message_notifications` and calls `mark_discovery_conversation_read(p_match_id)`. The RPC is a security invoker and returns an integer count; the notification trigger resides in `private` and is not client-callable. The new table has only `id`, `recipient_id`, `discovery_match_id`, `created_at`, and `read_at`. The authenticated role can SELECT its own rows and UPDATE only `read_at`; direct INSERT, DELETE, identity changes, anonymous access, and service-role inserts are revoked. Only the private trigger creates these events. The table is added to an existing `supabase_realtime` publication once.

Existing `notifications` schema and application events remain untouched, so shipped native apps do not gain discovery badges they cannot acknowledge. Existing discovery messages are not retrospectively marked unread. The frontend must subscribe to the new recipient-scoped table and refresh an active discovery conversation on its events; the production publication previously contained `messages` and `notifications`, not `discovery_messages`. Billing access policies remain unchanged.

The migration does **not** flip any profile's visibility flag. An existing café owner should reopen and save their completed Café Profile. The corrected database predicate then accepts their explicit publish action; the frontend must use the saved database row before reporting success. Existing barista `visible_to_cafes` opt-ins remain untouched. A support-assisted recovery may first select which cafés satisfy the new predicate, but any bulk publication should be a separate reviewed decision.

New applications must start `interested`. Only the owning café may change `interested` to `matched` or `declined`; the applicant may withdraw an `interested` or `matched` application. Terminal applications cannot be silently reopened. Existing records are not reclassified. Trusted service-role administration remains possible.

New or revised job addresses must contain a street, city, `FL`, and a five-digit or ZIP+4 postal code. Unchanged legacy addresses remain compatible with ordinary title/description/pause updates. Updating one address field on a legacy row requires supplying a complete address. No existing job location is rewritten by migration application.

After production application, run security advisors, confirm migration presence and new table/RPC privileges, and query a synthetic complete café composite through `profile_meets_visibility_requirements` (SELECT only). Complete real role-to-role smoke tests using authorized test accounts. Roll back the frontend independently if needed; preserve the authorization repairs and resolve database problems with a reviewed forward migration.
