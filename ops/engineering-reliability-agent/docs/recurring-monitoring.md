# Recurring monitoring

The GitHub Actions monitor runs once per hour and after every owner-approved push to `main`. It can also be started manually. Post-merge runs use the read-only Vercel deployment API for up to ten minutes and do not begin health checks until the exact `github.sha` production deployment reports `READY`. An `ERROR`, missing read-only configuration, or timeout fails closed as a sanitized P2 verification incident; the workflow never treats a probe of the previous production revision as proof that the approved commit is healthy.

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

Each run produces a sanitized JSON artifact retained for 14 days. The artifact includes the public and optional private monitoring results plus a response package with an incident fingerprint, affected routes, ranked change correlations, safe repair steps, and permanent prohibitions. P0, P1, and P2 findings fail the workflow so GitHub displays a review-only alert. P3 findings pass. The workflow does not call an OpenAI model, create an issue, modify code, open or merge a pull request, deploy, or make a provider write.

## Owner-approved P0/P1 email alerts

Email is disabled by default. P2 and P3 never send email. A P0 or P1 may send one idempotent Resend message only after the owner provides all three settings below.

Repository variable:

- `ERA_P0_P1_EMAIL_ALERTS_APPROVED=true`: explicit owner approval for the external communication step.

GitHub Actions secrets:

- `ERA_ALERT_EMAIL`: the single owner-controlled destination. It is never printed or written to an artifact.
- `ERA_RESEND_API_KEY`: a dedicated Resend key with sending access only. Do not reuse a broad account-management key or expose the website runtime key.

The message contains only the sanitized severity, incident fingerprint, assessment, recommended review steps, and a link to the GitHub Actions run. The transport connects only to `api.resend.com`, does not follow redirects, times out after eight seconds, and never returns the recipient, credential, or provider response body in logs or artifacts. Repeated sends for the same incident fingerprint use the same idempotency key.

## Optional private-provider coverage

Private Vercel and Supabase reads stay disabled unless the owner sets the repository variable `ERA_PRIVATE_MONITORING_ENABLED` to `true` and supplies every item below.

Repository variables:

- `ERA_VERCEL_PROJECT_ID`
- `ERA_VERCEL_TEAM_ID`
- `ERA_SUPABASE_PROJECT_REF`

GitHub Actions secrets:

- `ERA_VERCEL_READ_TOKEN`: a dedicated, expiring Vercel token limited to the smallest applicable team. Never reuse a deployment-capable automation token or an owner's broad personal token.
- `ERA_SUPABASE_READ_ONLY_TOKEN`: a dedicated token with only `analytics_logs_read`, or an OAuth token with only `analytics:read`. Never use a publishable key, secret key, service-role key, database password, or database connection string.

The agent must not create, read back, print, or rotate these secrets. The owner saves them directly in GitHub's Actions settings. Enabling private coverage without all required values produces a sanitized configuration alert and performs no provider request.

## Activation boundary

Merging `.github/workflows/engineering-reliability-monitor.yml` activates the hourly schedule and therefore requires explicit owner review. Private-provider monitoring requires a second, separate owner action: saving the scoped credentials and enabling the repository variable. Neither approval permits production deployment, SQL, RLS/Auth changes, data deletion, secret disclosure, or direct writes to `main`.

P0/P1 email activation is a third, separate owner action because it sends an external communication. Saving the dedicated Resend key and owner destination does not authorize any application, database, GitHub, Vercel, or Supabase write.
