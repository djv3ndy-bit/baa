# Recurring monitoring

The proposed GitHub Actions monitor runs once per hour after an owner reviews and merges its workflow to the default branch. A scheduled workflow on this development branch is inactive. The workflow can also be started manually after it exists on the default branch.

## Default coverage

The default cycle requires no long-lived provider secret. It uses the job's short-lived, repository-scoped GitHub token with only `contents: read` and `checks: read`, then performs HTTPS GET checks against:

- `https://www.baristajobmatch.com/` for website availability.
- `https://www.baristajobmatch.com/api/public-config` for Vercel Function routing and public Supabase Auth configuration readiness. The response body is discarded and never included in an artifact.
- Recent repository commits and failed GitHub checks for change correlation.

Each run produces a sanitized JSON artifact retained for 14 days. P0, P1, and P2 findings fail the workflow so GitHub displays a review-only alert. P3 findings pass. The workflow does not call an OpenAI model, create an issue, modify code, open or merge a pull request, deploy, send email, or make a provider write.

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
