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

ChatGPT handles analysis and drafting using these tools. The 19 registered roles describe responsibilities and observe/recommend/prepare permission ceilings; they are available on request. This server does not start background workers, run scheduled specialist jobs, call the OpenAI API, or require an OpenAI API key. Routing, retry and handoff helpers are defined in the policy but are not connected to a worker execution loop.

The widget uses the MCP Apps bridge with a legacy ChatGPT fallback. Credentials remain server-side. Missing, denied, stale or malformed data is unavailable/null; only a successful read can produce a verified zero. Support and payment summaries cover 30 days; overview totals and subscription counts are all-time. Billing counts reflect database synchronization, not an independent Stripe reconciliation.

The decision queue contains available billing, website/data-health and recent-support signals. It does not read Notion tasks or provide complete business oversight. Notion is optional for this read-only V1 and currently unavailable. Supplying Notion settings would change the configuration flag but would not add a task reader; the existing task-writing helper is not registered as an Office tool.

## Security and activation

Every MCP request validates the exact bearer token with Supabase Auth, then enforces the configured owner, issuer, Office resource audience, dedicated OAuth client, `bjm_office_reader` role, `openid` scope and session lifetime. Ordinary customer tokens and privileged server keys are rejected.

Public OAuth discovery is available with only the validated Office and Supabase HTTPS origins. Anonymous `/mcp` requests return a discovery challenge during setup; supplying credentials still requires the complete private configuration and activation switch before any tool or provider runs.

The database review package validates live owner/client sessions through a private security-barrier view owned by the existing migration administrator. The aggregate role has no direct Auth schema/table access. The view's contract and grants are checked before reads; business sources remain restricted by column grants and role-specific RLS. Installation temporarily grants only the SET permission needed for function ownership, restores it before commit, and rolls back on failed checks.

The Office provider code uses the request's validated token only for the bounded aggregate snapshot adapter. The restricted database package, dedicated public OAuth client and client-specific token hook are installed. The reader passed the effective-privilege audit, including inherited `PUBLIC` grants, and the hosted denial checks.

The Supabase bearer token itself may permit account-level Auth operations beyond those Office tools. Neither `openid` nor the database reader role establishes a general Auth-endpoint permission boundary. No Office tool exposes the credential or an Auth mutation; the trusted server must protect the token. Destructive probes against the hosted owner account were not run. Before production enablement, explicitly accept this token-handling trust boundary or resolve it through a reviewed design; database denial results alone do not resolve it.

No refunds, sends, publications, merges, deployments or customer changes are implemented as Office tools. Consequential actions remain subject to owner approval.

## Verified checkpoint — October 13, 2026

The prior hosted checkpoint for [draft PR #87](https://github.com/djv3ndy-bit/baa/pull/87) used `cd0a8b83c76f3f1b89a9e17f9bab343d82ef9350`. Its [Office CI](https://github.com/djv3ndy-bit/baa/actions/runs/38436870592) passed 126 tests, both typechecks, the widget build, assets and routes. The production candidate additionally rejects a nil session UUID before contacting Auth; its regression and the full **127-test** suite, both typechecks and build pass locally. Normal Auth issues nonzero sessions; this closes the explicit live-session contract without alleging a current token-mint path. Final-commit CI and hosted results must be recorded separately.

Hosted preview verification passed normal ChatGPT owner consent, all five tools, the widget owner button and 13 independent aggregate comparisons. A separately approved local PKCE test passed owner issuance, refresh and 37 original/refreshed read checks, including raw-table and Storage denial. Logging out only the fresh local test session denied its still-unexpired Office/RPC tokens and refresh token while preserving the existing dedicated sessions. Twelve hosted database denial checks also passed.

**The preview is now disabled and protected.** Its private mapping and application activation switch are false, the temporary domain exception is removed, only the original ChatGPT callback remains, the local listener is closed and no disposable test sessions remain. A fresh disabled-mapping report returned unavailable/null data. These successful tests are a prior verified snapshot, not current preview availability or a production launch.

Production deployment is pending. Remaining proof includes real nonowner OAuth denial, ordinary customer-login regression, and widget behavior with CSP enforcement enabled; the earlier widget check used the pre-existing global CSP setting off and did not change it. Production must use its approved stable origin, matching resource audience/mapping, exact callback and complete production-scoped settings. Keep `BJM_AI_OFFICE_AUTH_ENABLED=false` until the remaining checks, Auth-token trust decision and final activation approval are complete. Rollback must disable the mapping first while retaining its row and exact-client restricted hook, then disable the app and return to a hardened disabled Production baseline built from the reviewed tree. The previous original Production deployment may contain the old privileged adapter; do not blindly restore it. See the activation guide for the complete sequence.

Required server-side settings are `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `BJM_OFFICE_BASE_URL`, `BJM_AI_OFFICE_OWNER_USER_ID`, `BJM_AI_OFFICE_OAUTH_CLIENT_ID` and `BJM_AI_OFFICE_AUTH_ENABLED`. Never inherit `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY`, copy the customer app's entire configuration, or put credentials in widget metadata or URLs. `BJM_PUBLIC_URL` is optional and defaults to the existing public website; Notion settings are not required for the five tools.

## Local verification

Use Node 22 and the committed Office lockfile:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build
```

The automated suite uses synthetic users/tokens and local database fixtures. It exercises the real MCP SDK, role/RPC constraints, provider failures and rendered widget states. Hosted OAuth and data-denial proof are recorded separately above; a local pass or a Ready deployment does not establish production authorization.

See [the activation checkpoint](docs/AI_TEAM_ACTIVATION_2026-10-13.md) for completed hosted work, remaining production prerequisites and the final approval boundary.
