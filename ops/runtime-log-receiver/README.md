# BaristaMatch runtime count receiver — local review draft

Nothing in this folder has been deployed. It adds an isolated `era-runtime` Edge
Function for the existing Supabase project `lmwqrxoitraofaftpwhe`. Live read-only
project metadata confirmed that ref is `baristamatch`. It does not edit existing
website functions, app source, authentication, customer tables or App Review.

The proposed URL is
`https://lmwqrxoitraofaftpwhe.supabase.co/functions/v1/era-runtime`.
Applying its database objects, deploying the function, configuring a Vercel drain,
and incurring provider usage charges all remain pending separate owner approval.

## Authentication and data retained

`POST` accepts Vercel JSON-array log drain deliveries only. Configure a drain for
the exact `baa` project (`prj_VuAxQpdhDJPeTPdanA5HjtOrylA5`), production environment,
`lambda` and `edge` sources, JSON format, no compression, 100% sampling. The
privately provisioned random 256-bit ingest token is used as both the drain's
`Authorization: Bearer …` custom header and signature verification secret. This
avoids another owner-entered Supabase environment secret. It is one shared secret,
not two independent authentication factors.

Every POST requires the exact Bearer token syntax and native WebCrypto HMAC-SHA1
verification of the original bytes against `x-vercel-signature`, followed by the
database's lookup of the token's SHA256 digest. Raw tokens are never sent to SQL.
The same ingest RPC first receives an empty array as a strictly non-mutating
authorization probe. Unknown keys fail before JSON parsing or per-event hashing;
the probe cannot write deliveries/counters or prune/refresh coverage. A valid key
then submits normalized events or the malformed-batch coverage latch.
Missing/invalid signatures fail before SQL. A self-signed request with an unknown,
expired or revoked ingest token is refused by SQL. There is no anonymous test or
verification bypass, and no CORS/browser access flow.

The receiver requires explicit matching project/environment/source on every log.
Missing environment, build/static/external logs or a mixed cross-project batch
are refused as a whole. After complete raw HMAC verification, malformed signed
batches call the same fixed ingest RPC with `p_events:null`; only a registered
token may latch incomplete coverage, and that rejection never advances freshness.
An unknown key cannot alter state. It limits requests to 1MiB, 5,000 records, five seconds of
body reading, event age at most 24 hours, and clock lead at most 60 seconds. The
database revalidates normalized input and enforces separate storage caps.
Oversized or timed-out requests cannot be fully HMAC-verified and therefore
cannot safely alter coverage state. They are refused and remain an unknown
delivery gap. Vercel's documentation currently says batches up to 1MB, but live
payload/encoding compatibility must be verified before asserting full coverage;
the receiver does not silently discard bytes or relax authentication to fit.

It forwards only a SHA256 event key derived from project/deployment/log ID, UTC
timestamp, and one category: `runtime_fatal`, `runtime_error`, `http_5xx`, or
`runtime_ok`. Categories are mutually exclusive in that priority order. Top-level
status `-1` means a crashed function and counts as fatal; proxy `-1` alone does
not. Counts represent unique log records, not necessarily unique requests. Raw
messages, routes, query strings, emails, IPs, user agents, request IDs and trace
IDs are neither logged by this handler nor sent to the database.

The SQL contract deduplicates delivery and event digests. Retrying an already
committed batch after a lost response does not double count or refresh freshness.
Replaying the same event under different JSON serialization also cannot refresh
freshness. Conflicting data for an existing event key fails closed. An empty,
old-only or duplicate batch cannot establish healthy coverage.

`GET` accepts only a short-lived RS256 GitHub Actions OIDC JWT. It verifies the
signature with bounded public JWKS fetched only from
`https://token.actions.githubusercontent.com/.well-known/jwks`, cached for five
minutes. Unknown keys fail closed until cache refresh; redirects and alternate key
URLs are refused. No JWT is persisted, forwarded to SQL or written to output.

Required claims are fixed:

- Issuer: `https://token.actions.githubusercontent.com`.
- Audience: the exact receiver URL above.
- Subject: `repo:djv3ndy-bit@313253306/baa@1324630119:ref:refs/heads/main`.
- Repository: `djv3ndy-bit/baa`, repository ID `1324630119`, owner ID `313253306`.
- Workflow: `djv3ndy-bit/baa/.github/workflows/engineering-reliability-monitor.yml@refs/heads/main`.
- Main branch ref/type, integer `iat`/`nbf`/`exp`, unexpired and at most ten minutes
  of token lifetime, with at most 30 seconds of clock skew.

The immutable subject format follows the repository's live creation date of
August 6, 2026. Legacy-name subjects and other branches/workflows are denied.
JWT/JWKS JSON rejects duplicate keys and noncanonical base64url. This grants only
aggregate reads to the approved main workflow; it does not grant GitHub database
credentials or write access.

GET requires exactly `since` and `until`, canonical UTC milliseconds
(`YYYY-MM-DDTHH:mm:ss.sssZ`), a window of at most two hours and lookback at most
24 hours. It returns only the version, fixed project/environment, window, four
category counts, coverage start/last delivery, and complete/truncated flags. The
function validates the entire RPC result and rejects unexpected fields.

## Backend permissions and RPC contract

`index.ts` uses only automatically supplied `SUPABASE_URL` and the default key in
`SUPABASE_SECRET_KEYS`. Modern secret keys are sent on `apikey` only. The existing
legacy `SUPABASE_SERVICE_ROLE_KEY` is a compatibility fallback, sent as `apikey`
and Bearer JWT. This does not create, rotate or migrate any application key.
These backend credentials already have broad database authority; the handler
restricts outbound calls to the exact existing project and these two fixed RPCs:

```text
public.era_runtime_ingest(p_token_digest, p_delivery_digest, p_events)
public.era_runtime_summary(p_since, p_until)
```

Only `service_role` can execute them. Their new tables belong to a private schema
with RLS and no `anon`, `authenticated` or `PUBLIC` access. No caller-supplied
table, SQL, RPC name, destination URL or backend authorization header is used.
`verify_jwt=false` applies only to this new function because its POST uses an
external provider secret and its GET uses GitHub's issuer; both are fully
authenticated inside the handler.

SQL is prepared separately in
`artifacts/runtime-drain-review-20261023/schema.sql` at the workspace root.
It is a review draft, not an applied migration. Summary RPC success is the strict
JSON contract above; invalid windows return a fixed error. Ingest success is
`{authorized:true, accepted:true, duplicate:boolean, inserted_events:number}`.
Storage/capacity failure returns 503 so the receiver never silently acknowledges
dropped records. All external errors are fixed text; provider/SQL error bodies
are never exposed.

## Verification before any all-clear

Offline tests exercise real cryptographic signatures with an ephemeral test-only
RSA key, HMAC fixtures, byte/count/time bounds, exact source restrictions, forged
claims, duplicate JSON keys, JWKS errors/cache rotation, aggregate output filtering,
retry/replay behavior and fixed outbound RPC credentials. They make no network,
account or real database calls:

```sh
node --test test_receiver.mjs test_oidc.mjs
```

After approval, live verification must confirm the deployed JWT setting, denied
unsigned/forged/wrong-project requests, service-only grants, and an actual Vercel
signed delivery from `baa`. Vercel's setup test sends sample events; a sample with
dummy project/environment is correctly refused. Current public docs do not
specify a separate anonymous challenge protocol, so no bypass is implemented.
Resolve any provider-test mismatch with documented configuration or actual
signed delivery rather than weakening the checks.

The proposed five-minute cloud function heartbeat and hourly GitHub reader must
then establish a full lookback window. Before that warmup, or when delivery is
stale, truncated, unauthenticated or unavailable, monitoring remains incomplete.
Provider acceptance of an alert email is distinct from independently verified
mailbox receipt. A final cloud test must verify both without relying on a Mac
process. This draft has not performed those live checks.

## Current primary references

- [Supabase function configuration](https://supabase.com/docs/guides/functions/function-configuration).
- [Supabase auto-provided keys](https://supabase.com/docs/guides/functions/secrets).
- [Supabase key migration conventions](https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys).
- [GitHub OIDC claims and immutable subject format](https://docs.github.com/en/actions/reference/security/oidc).
- [Vercel log drain schema and formats](https://vercel.com/docs/drains/reference/logs).
- [Vercel raw-body signature verification](https://vercel.com/docs/drains/security).
- [Vercel custom headers, setup tests and payload limits](https://vercel.com/docs/drains/using-drains).
- [Vercel drain test API](https://vercel.com/docs/rest-api/drains/validate-drain-delivery-configuration).

The required first changelog fetch of `https://supabase.com/changelog.md` was
attempted but the documentation reader rejected its Markdown content type and
the sandbox could not resolve the direct fetch. The current HTML
[changelog](https://supabase.com/changelog) was checked instead. Its relevant
October 12 notice retires outdated TLS1.2 CBC suites no earlier than November10;
this implementation uses the platform's standard TLS Fetch stack. The October5
framework-adapter deprecation does not apply to this dependency-free function.

## Review files and CI

The proposed [isolated store](review/schema.sql), [cloud heartbeat](review/cloud-heartbeat.sql) and [executed offline schema tests](review/schema.test.mjs) are included for review. They are drafts, not applied migrations. Generate canonical migration files through the Supabase CLI only after owner approval. The existing Website security CI job runs receiver/OIDC tests and these storage tests with the repository's locked PGlite dependency. Native source, native builds and App Review are outside this change.
