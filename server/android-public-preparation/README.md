# Shared-marketplace Android additions — preparation and application record

Prepared 2026-10-12 from source `c028aeddf84dbde26948b21266a16211ad603383` (tree `bf40d23a33bae6506ccb3be2c4b647199853fa9a`) and the same-day read-only catalog audit. **The original preparation is retained below as historical review evidence. The exact SQL passed the 61-case LOCAL synthetic PostgreSQL 17.5 WASM suite; the separate MCP payload passed 63 cases. See the dated application status for the later authorized hosted step.** A later explicitly authorized temporary download of exact PGlite0.3.7 enabled the local tests; it added no shared/global dependencies and made no cloud changes. Independent read-only reviews by both peer agents completed with no actionable findings. These files do not authorize any further migration, rerun, activation or deployment.

## Dated application status — October 12, 2026

After separate exact-target approval, the single-DO payload SHA256
`11257763382ba2c4769d0f32567ae249a79ef3fa2a2a21e35eb3b62fc8b94d19`
was applied once to the externally verified shared Production project
`lmwqrxoitraofaftpwhe` as migration
`20261012101710_android_public_billing_fcm_support`. Recorded hosted catalog,
permission and migration-history postchecks verified the approved additions and
preserved the existing baseline, including supplementary existing Auth internal
triggers. The true/Production configuration is unchanged; advisors reported no
new security finding. The original standalone SQL bytes remain unchanged.

The matching separate Google public pool/provider, Publisher account and FCM
account are now configured with exact new-project Production trust and no
user-managed keys. No Android public server deployment, database-secret
connection, live federation/catalog validation, purchase/send enablement,
outbox/scheduler, public domain or public app release has occurred. Website/iOS
and existing Sandbox deployment configuration were not changed by these steps.

Evidence outside the source tree:
`artifacts/google-play/android-shared-marketplace-additions-applied-20261012.md`
and `artifacts/google-play/android-public-google-access-configured-20261012.md`.
The remaining sections retain the original pre-application design and test
limits. They must not be read as instructions to reapply the existing migration
or as proof of mobile/Data API, concurrent-load, purchase or push acceptance.

## Target and prerequisites (original pre-application review)

The independently verified real-account project is `lmwqrxoitraofaftpwhe`, name `baristamatch`, region `us-east-2`, Healthy, PostgreSQL 17.6. Public configuration selected `https://lmwqrxoitraofaftpwhe.supabase.co`; no API key was recorded. Read-only catalog queries confirmed the existing native ledger/checkout/job functions and absence of the two proposed object families. The authorized nonsecret configuration read returned exactly one `singleton=true, environment=Production` row. That row has no purchase-enabled field; server purchase flags were not read.

Before any separately approved application, re-verify the selected project using Supabase project metadata and the reviewed real-account public URL. **SQL cannot independently prove the hosted project ref.** A caller-set setting, JWT claim, filename, or Production singleton is not proof of project identity. Never run this candidate on Android Sandbox `ojvjlvojvozvhktbclcg` or any unverified project. Re-check baseline catalog hashes/signatures because they may change after this audit.

The draft requires executor `postgres`, PostgreSQL major 17, existing dependency column types and RPC signatures, and exactly one true/Production singleton. Unknown executor, signatures, types, version, prior objects, or configuration cause an abort, not an attempted repair. Confirm the normal Supabase `service_role` bypass-RLS behavior and public Data API exposure before client/runtime acceptance; the draft does not change role attributes, schema exposure, schema grants, or API settings.

## Exact proposed additions

| Object | Behavior and access |
| --- | --- |
| `public.native_checkout_provider(uuid,text,uuid)` | Read-only SECURITY DEFINER lookup for the trusted backend. Returns the stored provider only for the specified user's unexpired reserved Production attempt and unsuspended café profile, with the existing Production singleton. `service_role` EXECUTE only; no client/PUBLIC execute. Does not claim/start/cancel or settle an attempt. |
| `public.android_device_push_tokens` | Native FCM token primary key, Auth user FK with DELETE CASCADE, exact Android platform/Firebase `baristamatch`/package `com.baristajobmatch.app`, enabled state, server-maintained timestamps. Opaque tokens are bounded to 1–2048 bytes and reject whitespace/control characters. No data backfill. |
| User index and timestamp trigger/helper | User index supports ownership/FK cleanup. SECURITY INVOKER helper with empty search path preserves created_at and assigns updated_at. No PUBLIC/client/service execute on the helper. FK creation also adds PostgreSQL's internal referential triggers; existing triggers are not replaced. |
| Four authenticated own-row policies | SELECT/INSERT/UPDATE/DELETE compare `auth.uid()` to user_id; UPDATE has both USING and WITH CHECK. A client cannot read another account's token or transfer ownership to another account. RLS is enabled. |

Object inventory from the exact SQL: **2 functions** (provider lookup and timestamp helper), **1 table**, **1 explicitly created ownership index**, **1 explicitly created timestamp trigger**, and **4 RLS policies** — 9 explicit CREATE statements. PostgreSQL also creates the token primary-key backing index (so 2 new indexes total), 6 table constraints (primary key, Auth FK and 4 CHECKs), and the FK’s 4 internal referential triggers (2 on the new table and 2 on auth.users). All 8 columns are NOT NULL, including the primary-key column. PostgreSQL also supplies the table row/array types and automatic TOAST storage/catalog objects; these are excluded from the 9 explicit CREATE count. This is a concrete object inventory, not a guarantee of zero shared operational impact; managed DDL hooks and hosted behavior still need verification. No existing function, policy, trigger or ACL is replaced.

Explicit token-table grants: authenticated gets SELECT/INSERT/UPDATE/DELETE only; anon/PUBLIC none. Trusted service_role gets SELECT and only column UPDATE(enabled,updated_at); it cannot register, delete, or update token/user/project/package identity via these grants. The existing backend architecture uses a broad service key, so this new table's grants do not reduce that key's unrelated existing capabilities. Owner postgres retains normal ownership. Known inherited default grants are revoked **on the new objects only**. Unexpected ACL grantees/grant options or effective role privileges abort the transaction. No global or per-schema default privileges are changed.

The provider addition follows `server/native-billing/sql/checkout_provider.sql`, with an explicit Production boundary and true singleton check. The token shape/ACL/RLS follow `server/android-push/sql/android_fcm_tokens.sql`; that existing artifact is Sandbox-only and must not be applied to the real project. These new files are deliberately separate.

## Preserved boundaries and incomplete work

This candidate does not replace/alter existing billing, job, Stripe, Apple, Auth-profile, storage, notification, realtime, cron, or deletion functions, triggers, policies, ACLs, or configuration rows. Existing Expo `public.device_push_tokens` remains unchanged. No reviewer schema/grants, fake subscriptions, Sandbox widening, outgoing calls, credentials, Android sender flags, or provider access are added.

Creating the table requires brief locks, including an Auth FK lock; the transaction has a 3-second lock timeout and 20-second per-statement timeout. A busy system can abort it. Existing managed event triggers may react to DDL; compare the preservation manifest after application. It excludes internal triggers (including existing Auth RI triggers), so it cannot prove those old internal triggers unchanged. The separate new-FK postcheck must show4 enabled internal triggers,2 on the new token table and2 on auth.users. Do not claim an additive migration has zero operational risk.

This is **not the complete Android public push migration**. The separate outbox/consumer design must preserve website/iOS Expo delivery and cover application, discovery, and job events without direct/outbox double delivery. Production Android auth/WIF, server and client scope gates, deletion behavior, final public build configuration, and runtime acceptance remain separate reviewed work. Nothing here enables purchases or pushes.

## Historical application, rerun, and rollback plan

1. Obtain approval for the exact final SQL and verified target; refresh preconditions and save sections 1–2 of `validation.sql` as the baseline. Compare section2 existing-object manifests; section1 new-object flags intentionally change false→true, while the Production singleton stays unchanged. Do not require every section1–2 output to be byte-identical. Keep Android public registration/consumer/purchases disabled while preparing.
2. Before promotion, run isolated disposable PostgreSQL 17 tests for the DDL/ACL/RLS and provider lookup, including wrong owner, wrong environment, expired/started attempts, foreign-user CRUD, update ownership transfer, invalid token/identity values, timestamp behavior and Auth cascade. A later explicit authorization permitted isolated local WASM execution: all 61 cases passed on PostgreSQL 17.5. Native PG17 execution remains unexecuted, and no hosted PostgreSQL 17.6/runtime acceptance is claimed. Refresh target-specific preconditions before application; local fixture tests are not hosted proof.
3. When a real migration is approved, create its migration-history filename with the official Supabase CLI workflow, then copy the exact reviewed SQL. The CLI is absent here and installation was prohibited, so this directory contains review files rather than an invented timestamp migration.
4. Apply the SQL as one transaction only through the verified approved target/runner. The runner's transaction behavior must be checked before using this explicit BEGIN/COMMIT script. Do not split statements into independent commits. A failed statement requires ROLLBACK/failed-transaction cleanup; do not continue or bypass its precondition.
5. Compare existing-object preservation manifests and inspect new ACLs/policies/FK/index/trigger/functions using sections 3–4 of `validation.sql`. Run Supabase security advisors and bounded authorized two-account/API tests before enabling Android production usage. Never log/read raw tokens or provider receipts for verification.
6. A successful rerun intentionally aborts before DDL because objects now exist; inspect definitions/migration history rather than replacing them. Failed first application rolls back all additions. No automatic DROP, overwrite, or data deletion is provided.
7. If a later rollout needs rollback, first disable the separate Android public registration/consumer and purchase rollout, preserve existing Expo/Apple paths, and inspect any new data/clients. Leaving unused additive objects is safer than dropping registered-device data. Removing them requires a separately reviewed dependency/data plan; this candidate includes no destructive rollback script.

## Evidence and documentation

Local catalog evidence (outside repository): `artifacts/google-play/android-shared-marketplace-schema-audit-20261012.json` and `.md`, and `android-shared-marketplace-outbox-coverage-20261012.md`. Only catalog definitions/metadata and the authorized nonsecret Production singleton were read; no application/Auth/user/token/receipt rows, secrets, vault contents, or cron commands were read.

The Supabase changelog markdown fetch was attempted but the reader rejected its content type; no changelog-based compatibility claim is made. Current primary guidance reviewed: [Supabase RLS and grants](https://supabase.com/docs/guides/database/postgres/row-level-security), [PostgreSQL 17 GRANT](https://www.postgresql.org/docs/17/sql-grant.html). Documentation supports explicit grants plus ownership policies; it does not substitute for the separately recorded hosted postchecks or later runtime acceptance.

## Local PostgreSQL 17 evidence and limits

The initial bounded inspection found no native `postgres`, `initdb`, `psql`, or `pg_ctl`, and no Docker/Podman/Colima runner on PATH or the checked app/Homebrew paths. Known existing BaristaMatch PGlite installations resolve to version 0.5.8, whose local version-only query reported PostgreSQL 18.3. That runtime was not used for this candidate.

After separate explicit authorization, the exact official public npm package `@electric-sql/pglite@0.3.7` was downloaded into `/private/tmp/baristamatch-pg17-wasm-napv4bi6`. Registry SHA512 integrity and package identity/version were verified; no additional dependencies, install scripts, credentials/config files, global install, hosted client, or upload were used. Tarball SHA256: `5939f21eb5f44cabe729ea159ab8b741d3ed2b9d4cb14e630dd3f0cef0bc5108`. Actual runtime metadata reported **PostgreSQL 17.5 / 170005, UTF8, postgres**. The adapter checks engine major before every fixture/candidate application and rejects a different major; unexpected network fetch is disabled.

`run-local-pg17-wasm-tests.mjs` reused the exact 61-case manifest and synthetic fixtures from the native harness. **The initial local run and an independent peer rerun each passed 61/61 cases**, on the same PostgreSQL 17.5/170005 UTF8 engine and unchanged SQL hash. The rerun refreshed `local-pg17-wasm-test-report.json`. This includes provider identity/environment/state/expiry/role/suspension boundaries and Apple provider preservation; authenticated own/foreign/null-session token RLS and ownership transfer/upsert denial; token byte/Unicode whitespace and platform/project/package checks; service cleanup column limits; timestamps/Auth cascade; existing-object hash preservation; validation-query execution; precondition/collision/unexpected-default-ACL failure atomicity; and successful-rerun abort. Authenticated cases explicitly assert non-owner current_user, no BYPASSRLS and active RLS. Each case/error rolls back and resets role/account identity, then asserts the baseline token rows remain unchanged.

Checkout dependency functions are **sentinel stubs with audited argument/source return contracts**, not approximations of production internals. PGlite uses one exclusive WASM backend: the suite proves neither concurrent locks/races nor native PostgreSQL 17.6, Supabase managed event triggers, hosted project identity/schema exposure, PostgREST behavior, existing full checkout state-machine internals, or mobile SDK/runtime behavior. No hosted SQL was executed. The proposed SQL bytes/hash are unchanged; its initial "no SQL executed" header is historical preparation wording, superseded only for these local synthetic tests by this dated evidence, not hosted migration authorization.

Local WASM rerun (uses only the already downloaded local runtime):

```sh
/Users/tmac/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node /private/tmp/baristamatch-android-public-prep-20261012/server/android-public-preparation/run-local-pg17-wasm-tests.mjs --runtime-root /private/tmp/baristamatch-pg17-wasm-napv4bi6
```

`run-local-pg17-tests.py` remains the **UNEXECUTED native PG17 option**. Its `--plan-only` command records UNEXECUTED in the separate `local-pg17-test-report.json`; that native report is not the WASM result. With an existing native PG17 bin directory supplied explicitly, the helper initializes a fresh UTF8 synthetic cluster under this preparation directory, rejects TCP, uses a private local Unix socket with local trust/host reject, strips inherited environment variables, and uses no password/service/startup files. Runtime files are removed after shutdown. It does not accept a hosted connection string. Do not substitute PG18 or bypass the SQL guard.

Actual offline checks also passed: Python compile, plan-manifest count/hash checks, Node syntax, SQL object/mutation allowlist, reviewed token-shape comparison and whitespace. These static checks supplement the local WASM results; neither provides hosted migration proof.

## Proposed Supabase MCP/Management API path — single atomic DO

The original standalone SQL remains byte-identical at SHA256 `c2101c477ed064daebec4ba2a4ea39a00ab3459c6801c87f97b3e13696439716`. Do not submit that explicit BEGIN/COMMIT script to an executor whose outer transaction/migration-history wrapping is undocumented. Parent's connector inspection found the MCP apply_migration query is forwarded unchanged; this does not establish Management API wrapper behavior or migration-history atomicity.

The separate `proposed-production-billing-fcm-mcp.sql` contains exactly **one top-level DO statement**, with no transaction-control commands. `build-mcp-payload.py` verifies the exact original hash and lexically identifies top-level statements while skipping comments/quoted bodies. It removes only the original top-level BEGIN/COMMIT lines, then executes every remaining original source byte inside uniquely dollar-quoted dynamic SQL. All guards, DDL, ACL checks and settings are retained; no exceptions are swallowed and no existing source SQL is overwritten. `mcp-payload-manifest.json` records the source/payload hashes. At preparation this was a local payload, not authorization or hosted proof; its later exact approved application is recorded in the dated status above.

Actual payload SHA256: `11257763382ba2c4769d0f32567ae249a79ef3fa2a2a21e35eb3b62fc8b94d19`. `run-local-pg17-mcp-tests.mjs` reused all original61 cases against that payload, plus2 explicit atomicity cases, on the already verified local PGlite0.3.7 PostgreSQL17.5 UTF8 runtime. **63/63 local synthetic cases passed**: failure injected AFTER the entire DDL/postchecks left no new objects and preserved baseline hashes; applying within a caller transaction then rolling that transaction back also removed the objects, proving the payload did not commit the caller transaction locally. Existing rerun/precondition failure cases also pass. `local-pg17-mcp-wasm-test-report.json` is the separate evidence. Authenticated nonowner/RLS assertions and per-case rollback/role/identity resets remain active. The explicit new-FK postcheck lists4 internal triggers and the adapter asserts their enabled state and2+2 table distribution.

**Timeout limitation:** `lock_timeout='3s'` remains inside the payload. The retained `SET LOCAL statement_timeout='20s'` occurs after the single outer DO has already started and is **not a proven20-second deadline** for that DO or the Management API operation. Do not claim an overall timeout from that setting. Executor-level statement/request limits must be independently understood before hosted application. Settings are transaction-local; an undocumented caller transaction may also retain them until its transaction ends.

The DO's statement-level atomicity is locally demonstrated. The later hosted application and catalog/history postchecks are recorded above; they do not prove executor wrapper internals, concurrent-traffic lock behavior or full mobile/Data API behavior. Re-verify target project/configuration/objects immediately before any separately approved application; only the externally verified existing real-account project `lmwqrxoitraofaftpwhe` in Production is eligible. Parent saved a refreshed read-only hosted baseline at `artifacts/google-play/android-shared-marketplace-before-additions-20261012.json` (Healthy17.6, true/Production, proposed objects absent); this is read-only evidence, not a migration.

For the proposed MCP path, submit only the exact reviewed single-DO payload after approval and wrapper review; do not add BEGIN/COMMIT around it or strip its guards ad hoc. Run the read-only validation sections afterward: section2 unchanged-object manifests should match; section1 presence flags intentionally flip; section3 includes the expected newFK internal-trigger inventory. Preserve the external verified-project, current executor, Production singleton, no-previous-object and runtime/rollout gates from above. There is no destructive rollback or implicit rollout authorization.
