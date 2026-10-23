# Recurring monitoring

The GitHub Actions monitor requests an hourly schedule and runs after every owner-approved push to `main`. It can also be started manually. GitHub may delay or omit scheduled runs; the one-hour lookback is not continuous coverage and does not recover every gap. Post-merge runs poll the read-only Vercel deployment API and do not begin health checks until the exact `github.sha` production deployment reports `READY`. An `ERROR`, missing read-only configuration, or timeout fails closed as a sanitized P2 verification incident; the workflow never treats a probe of the previous production revision as proof that the approved commit is healthy.

## Default coverage

The default cycle requires no long-lived provider secret. It uses the job's short-lived, repository-scoped GitHub token with only `contents: read` and `checks: read`, then performs HTTPS GET checks against:

- `https://www.baristajobmatch.com/` for website availability.
- `https://www.baristajobmatch.com/api/public-config` for Vercel Function routing and public Supabase Auth configuration readiness. The response body is discarded and never included in an artifact.
- Recent repository commits and failed GitHub checks for change correlation. The
  collector resolves GitHub Actions metadata for a check named `monitor` and excludes
  it only when the workflow path is this reliability monitor, preventing an alert from
  re-ingesting its own previous failure while preserving same-named failures elsewhere.
  Failed checks older than the configured `--lookback` window are ignored so a resolved
  historical failure cannot keep every later hourly run red.

For exactly the production homepage/public-config pair, if both initial probes are HTTP 5xx or unreachable, the collector makes two further paired GET rounds, fifteen seconds apart. Both endpoints must fail in all three rounds before a confirmed public outage is classified P1. A healthy first round adds no requests or wait. Recovery, one failing endpoint, redirects, 4xx responses and private-provider access failures do not meet this rule. This proves repeated failure from the monitor's vantage point, not a percentage of users affected. No customer request or database write is used to verify this rule.

Each run produces a sanitized JSON artifact retained for 14 days. The artifact includes the public and optional private monitoring results plus a response package with an incident fingerprint, affected routes, ranked change correlations, safe repair steps, and permanent prohibitions. Collected P0, P1, and P2 findings return a review-only state; P3 findings are healthy. A failed provider collection, including an access denial or timeout, returns `collection_failed` with exit code 3 so the workflow stays red instead of reporting a successful review. This does not promote a monitoring gap into a P0/P1 customer outage or change the email threshold. The workflow does not call an OpenAI model, create an issue, modify code, open or merge a pull request, deploy, or make a provider write.

## Owner-approved P0/P1 email alerts

Email is disabled by default. P2 and P3 never send email. A P0 or P1 may send one idempotent Resend message only after the owner provides all three settings below.

Repository variable:

- `ERA_P0_P1_EMAIL_ALERTS_APPROVED=true`: explicit owner approval for the external communication step.

GitHub Actions secrets:

- `ERA_ALERT_EMAIL`: the single owner-controlled destination. It is never printed or written to an artifact.
- `ERA_RESEND_API_KEY`: a dedicated Resend key with sending access only. Do not reuse a broad account-management key or expose the website runtime key.

The message contains only the sanitized severity, incident fingerprint, assessment, recommended review steps, and a stable link to the reliability workflow's runs. The transport connects only to `api.resend.com`, does not follow redirects, times out after eight seconds, and never returns the recipient, credential, or provider response body in logs or artifacts. The idempotency key includes the incident fingerprint and a SHA-256 digest of the exact canonical sending payload. Unchanged messages across runs reuse identical payloads and keys; substantive message or recipient changes get a new key rather than conflicting with an earlier send. Resend retains idempotency keys for 24 hours; this is provider retry protection, not a durable once-ever incident notification ledger.

## Optional private-provider coverage

Private Vercel and Supabase reads stay disabled unless the owner sets the repository variable `ERA_PRIVATE_MONITORING_ENABLED` to `true` and supplies every item below.

Repository variables:

- `ERA_VERCEL_PROJECT_ID`
- `ERA_VERCEL_TEAM_ID`
- `ERA_SUPABASE_PROJECT_REF`

GitHub Actions secrets:

- `ERA_VERCEL_READ_TOKEN`: an installation credential for a private integration with only Deployment Read (plus the required Integration Configuration Read), restricted to the website project `baa`. Vercel personal tokens, including project-scoped ones, carry write authority and are not read-only. Deployment events are build events; successful collection does not prove full runtime-log coverage.
- `ERA_SUPABASE_READ_ONLY_TOKEN`: a dedicated scoped personal access token limited to the production project and only **Logs: Read**. Save an expiry and arrange renewal before it expires. Never use a legacy account-wide token, short-lived OAuth token without refresh, publishable key, secret key, service-role key, database password, or database connection string.

Vercel deployment reads and historical runtime coverage are separate required operations. The configured adapter has no verified historical runtime source, so `runtime_history` reports `runtime_history_not_supported_by_configured_source` without reading deployment events. The monitor preserves successfully collected deployment evidence but returns `collection_failed` and exit code `3` even after credential renewal makes deployment reads work. This coverage gap is not evidence of a customer outage and does not trigger a P0/P1 email. Recovery requires a separately verified authorized runtime source; see [Least-privilege integrations](least-privilege-integrations.md#vercel).

The agent must not create, read back, print, or rotate these secrets. The owner saves them directly in GitHub's Actions settings. Enabling private coverage without all required values produces a sanitized configuration alert and performs no provider request.

## Manual owner delivery test

`engineering-reliability-alert-test.yml` is manual-only, main-only, and defaults to no send. A separately approved run can send one clearly labelled test through the monitor's Resend transport. It first requires the existing approval variable, sending key, and an exact match between the private owner destination and `hello@baristajobmatch.com`; a mismatch fails closed without a send. The test creates no outage or customer data. Its artifact distinguishes provider acceptance from independently verified mailbox delivery. Re-running the same job reuses its payload and per-run idempotency key.

## Activation boundary

Merging `.github/workflows/engineering-reliability-monitor.yml` activates the hourly schedule and therefore requires explicit owner review. Private-provider monitoring requires a second, separate owner action: saving the scoped credentials and enabling the repository variable. Neither approval permits production deployment, SQL, RLS/Auth changes, data deletion, secret disclosure, or direct writes to `main`.

P0/P1 email activation is a third, separate owner action because it sends an external communication. Saving the dedicated Resend key and owner destination does not authorize any application, database, GitHub, Vercel, or Supabase write.
