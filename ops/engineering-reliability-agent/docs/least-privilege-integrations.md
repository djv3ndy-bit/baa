# Least-privilege integrations

The Engineering & Reliability Agent uses dedicated read-only credentials. It must never reuse website runtime credentials, database passwords, Supabase service-role keys, deployment-capable tokens, or an owner's broad personal token.

The provider clients are disabled by default. `collect-live` activates only the providers named on that invocation and fails closed unless their exact allowlists and read-only configuration are present. Credential creation, secret storage, and recurring runtime activation each require owner review.

## GitHub

Preferred credential: a GitHub App installation token limited to `djv3ndy-bit/baa`. A short-lived fine-grained personal access token is an acceptable development fallback.

Required repository permissions:

- Metadata: read
- Contents: read
- Checks: read

The client only reads recent commits, individual commit metadata and changed paths, and completed check runs. It has no contents-write, pull-request-write, Actions-write, administration, secrets, deployment, or merge permission.

## Vercel

Preferred credential: the connected Vercel read application. A dedicated, expiring access token for the smallest applicable team is an acceptable runtime fallback when the connected application cannot be used by the service.

The configured project ID is an application-level allowlist. The client only lists that project's deployments and reads bounded deployment events. It does not expose operations for creating, canceling, promoting, rolling back, or deleting deployments, or for reading or changing environment variables.

## Supabase

Preferred credential: a fine-grained project token with only `analytics_logs_read`, or an OAuth token with only `analytics:read`.

Never provide a service-role key, database connection string, database password, Auth administration credential, or a token with database-write, migration, RLS, Edge Function write, Storage write, or project-configuration permissions.

The client calls only the unified analytics log endpoint. Queries are fixed, query one source at a time, are bounded to at most 24 hours and 100 rows, and return timestamps, status codes, routes, and aggregate counts. Raw event messages, headers, request bodies, response bodies, user identifiers, emails, and IP addresses are not selected.

The client uses the new ClickHouse-backed `analytics/endpoints/logs` API and filters its unified stream with the current `source` column. It does not use the deprecated `logs.all` endpoint, which Supabase has scheduled for removal on September 23, 2026.

## Network and data controls

- HTTPS is mandatory.
- Provider hosts are exact allowlists: `api.github.com`, `api.vercel.com`, and `api.supabase.com`.
- Redirects are rejected.
- The only supported HTTP method is `GET`.
- Requests time out after eight seconds.
- Responses are capped at one megabyte.
- Provider error bodies are never included in application errors.
- Collected evidence is sanitized again before classification or model use.

## Owner-approved activation checklist

1. Create dedicated credentials with the scopes above and short expirations where supported.
2. Store credentials in the agent runtime's secret manager, not in the repository or website runtime.
3. Configure only the approved repository, Vercel project/team, Supabase project, and health hosts.
4. Run provider contract tests with synthetic responses.
5. Run a read-only live collection in preview or an isolated operations environment.
6. Review the sanitized output for personal data or secret leakage.
7. Approve runtime scheduling separately. Do not deploy, merge, or modify production during activation.

## Isolated activation command

Use one provider at a time first. The command requires an explicit environment, provider, lookback, and bounded limit. Supabase additionally requires at least one explicit service.

```bash
PYTHONPATH=src .venv/bin/python -m era.main collect-live \
  --environment production \
  --provider supabase \
  --supabase-service api \
  --lookback 30m \
  --limit 25
```

The command returns only sanitized evidence and recent-change metadata. It sets `model_used` and `production_writes_enabled` to `false` in its output. Missing credentials, unsafe health URLs, unsupported environments, redirects, oversized responses, and lookbacks beyond 24 hours stop the collection.
