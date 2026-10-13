# BJM AI Office

Private owner reporting through an MCP server and React widget. Continue the existing Office projects and PR #87; do not recreate the Office or change the customer website deployment root.

## Current capability

Five authenticated, read-only tools are implemented:

| Tool | Result |
| --- | --- |
| `get_owner_overview` | Aggregate business, support, billing and health report |
| `get_ai_team_status` | The 19 registered roles and permission ceilings |
| `get_decision_queue` | Review signals; no action execution or task persistence |
| `get_system_health` | Website reachability and actual aggregate-read availability |
| `get_billing_summary` | Subscription totals and payment counts |

ChatGPT handles analysis using these tools. This server does not call the OpenAI API, start 19 independent background workers, or require an OpenAI API key. Registered roles describe responsibilities; they do not establish active execution.

The widget uses the MCP Apps bridge with a legacy ChatGPT fallback. Credentials remain server-side. Missing, denied, stale or malformed data is unavailable/null; only a successful read can produce a verified zero. Support and payment summaries cover 30 days; overview totals and subscription counts are all-time. Billing counts reflect database synchronization, not an independent Stripe reconciliation.

## Security and activation

Every MCP request validates the exact bearer token with Supabase Auth, then enforces the configured owner, issuer, Office resource audience, dedicated OAuth client, `bjm_office_reader` role, `openid` scope and session lifetime. Ordinary customer tokens and privileged server keys are rejected.

Public OAuth discovery is available with only the validated Office and Supabase HTTPS origins. Anonymous `/mcp` requests return a discovery challenge during setup; supplying credentials still requires the complete private configuration and activation switch before any tool or provider runs.

The database review package validates live owner/client sessions through a private security-barrier view owned by the existing migration administrator. The aggregate role has no direct Auth schema/table access. The view's contract and grants are checked before reads; business sources remain restricted by column grants and role-specific RLS. Installation temporarily grants only the SET permission needed for function ownership, restores it before commit, and rolls back on failed checks.

The request's validated token can call only the aggregate snapshot adapter. The proposed database role, restricted aggregate function and dedicated-client token hook are an **unapplied review package**, not evidence of deployed database isolation. The reader role must pass the effective-privilege audit, including inherited `PUBLIC` grants, before activation. Account-level Supabase Auth capabilities are distinct from business-data privileges; never disclose the access token.

Keep `BJM_AI_OFFICE_AUTH_ENABLED=false` until hosted owner/nonowner login, OAuth refresh/revocation, and direct table/RPC/storage denial tests pass. No refunds, sends, publications, merges, deployments or customer changes are implemented as Office tools.

## Local verification

Use Node 22 and the committed Office lockfile:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build
```

Tests use synthetic users/tokens and local database fixtures. They exercise the real MCP SDK, role/RPC constraints, provider failures and rendered widget states. They do not prove real hosted OAuth or Vercel authorization.

See [the current activation checkpoint](docs/AI_TEAM_ACTIVATION_2026-10-13.md) for completed work, remaining prerequisites and the existing project IDs.
