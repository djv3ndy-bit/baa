# BJM AI team — chat-only reporting

**Prepared locally; the new design is not installed, connected or live.** Continue the existing Office project and draft PR #87. Public Office website activation is on hold. No new project, customer website change, merge or production deployment is implied by this package.

## What the team does

Operations Manager coordinates 19 roles in the current chat. Their on-request workflows preserve observe/recommend/prepare ceilings; none executes actions or runs independently in the background. No OpenAI API key, new chats or schedules are required.

| Restricted tool | Available result |
| --- | --- |
| `get_owner_overview` | Aggregate business, support, billing, health and attention signals |
| `get_ai_team_status` | The 19 roles, responsibilities and permission ceilings |
| `get_decision_queue` | Available review signals; no task persistence or execution |
| `get_system_health` | Website reachability and aggregate-read availability |
| `get_billing_summary` | Recorded subscription totals and payment counts |

Try “Manager, prepare my brief” or “Marketing, draft a growth plan.” Role instructions arrive during MCP initialization; refresh the plugin after changes. No widget/dashboard is registered. The retained legacy `web/` source is excluded from the chat deployment.

Reports omit individual customer/support/prospect/matching records and arbitrary queries; request supplied evidence when needed. Notion task reading is unavailable, even if its configuration flag is set. The queue covers available billing, website/data-health and recent-support signals, so an empty queue is not a complete business all-clear.

Missing, denied, malformed or stale data stays unavailable/null; label snapshot time. Support/payments cover 30 days; overview/subscription totals are all-time. Database records are not Stripe reconciliation, and zero payment records does not establish zero revenue. Website health is not store-release status or a security audit.

No tool sends, publishes, spends, charges/refunds/cancels, changes customers, merges or deploys. Return requested drafts/proposals here; obtain missing human authorization for separate protected actions. Approval never raises ceilings or adds tools.

## New security boundary

The new ChatGPT connection receives only opaque, Office-owned credentials scoped to `office.read`. It does not receive a Supabase account bearer or database credential. A public PKCE client authenticates the owner through a separate upstream identity client. The broker verifies the exact fresh identity and requires acknowledged session-local logout before creating an Office authorization code. A verified fresh nonowner or rejected account also receives local cleanup. Unverifiable responses fail closed without unsafe logout; their session cleanup is not proven.

Office access lasts 15 minutes. Refresh credentials rotate within an absolute 30-day grant lifetime; replay revokes that family. Codes and credentials are stored only as hashes. The short-lived upstream flow is encrypted with a separate server key. Upstream access/refresh/ID/provider credentials are never forwarded to ChatGPT or persisted in Office state. They must also stay out of logs, URLs, tool output and artifacts.

A separate narrow PostgreSQL gateway handles Office OAuth state and a fixed aggregate snapshot. Its login has no direct customer/Auth table access or general database authority. Database checks revalidate the enabled configuration, active owner consent, grant, client and resource on each report. Customer Supabase JWTs are not accepted at the production MCP boundary. The legacy JWT module is retained only for historical compatibility tests; production entrypoints use the new chat boundary and injected gateway adapter.

`sql/office-chat-gateway-review.sql` is **unapplied**. It requires PostgreSQL 16+, creates isolated roles with the gateway initially `NOLOGIN`, and leaves configuration empty/disabled. Its privilege checks must pass without weakening shared customer grants. The runtime database password is provisioned separately only within approved setup.

## Configuration from the current code

Use server-side settings on the existing Office project, scoped to the approved environment. Keep private values in secret settings; never copy the customer app's entire environment.

| Setting | Required contract |
| --- | --- |
| `BJM_OFFICE_BASE_URL` | Stable canonical HTTPS origin, without credentials, port, path, query or fragment; issuer is this origin and resource is `<origin>/mcp` |
| `SUPABASE_URL` | Existing project's HTTPS origin; the gateway requires its 20-character project reference under `supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | Publishable key only; privileged keys are rejected |
| `BJM_AI_OFFICE_OWNER_USER_ID` | Previously verified owner UUID; never infer it from another service's login |
| `BJM_CHAT_UPSTREAM_CLIENT_ID` | Separate upstream public PKCE identity client; expected `authenticated` role/audience and `openid`, with `<origin>/oauth/owner/callback` registered |
| `BJM_CHAT_OAUTH_CLIENT_ID` | Exact predefined ChatGPT public-client identifier, matching the private gateway row |
| `BJM_CHAT_OAUTH_REDIRECT_URI` | Exact callback displayed by ChatGPT management, matching the private row; never guess or use a wildcard |
| `BJM_CHAT_OAUTH_FLOW_KEY` | Secret canonical unpadded base64url encoding of 32 random bytes |
| `BJM_CHAT_OAUTH_ENABLED` | Private operation requires exactly `true`; leave false until approved verification |
| `BJM_CHAT_DATABASE_HOST` | Verified existing project's AWS Supabase pooler hostname |
| `BJM_CHAT_DATABASE_URL` | Dedicated `bjm_office_gateway_login.<project-reference>` credential only, approved host, port `6543`, database `/postgres`; TLS certificate verification is mandatory |
| `BJM_CHAT_DATABASE_CA_PEM` | Optional verified CA certificate if needed; never a private key |
| `BJM_PUBLIC_URL` | Optional HTTPS website health target; defaults to the existing public website |

`SUPABASE_SECRET_KEY` and `SUPABASE_SERVICE_ROLE_KEY` must be absent. The old `BJM_AI_OFFICE_AUTH_ENABLED` and old OAuth-client setting do not activate this design. Both the new application flag and gateway configuration must be enabled for private reports. Redeploy the reviewed source after environment changes.

The broker and SQL accept either documented ChatGPT callback format, but configuration pins exactly one URI. Copy the final callback displayed in the actual connection management page; never infer it from the server URL or add a wildcard. [OpenAI callback guidance](https://developers.openai.com/plugins/build/auth).

Discovery and the anonymous MCP 401 challenge require only the Office origin, without database initialization. Public liveness is `/health`; OAuth paths are `/oauth/authorize`, `/oauth/token`, `/oauth/revoke` and `/oauth/owner/callback`. Errors never expose private configuration.

## Safe rollout and rollback

1. Review the final source and run the checks below. Prior preview proof belongs to the previous JWT design and cannot establish this broker's hosted readiness.
2. Obtain approval for the exact existing project, environment, source, origin, narrow SQL/credential setup, separate identity client and displayed ChatGPT callback. Install/configure the gateway disabled, provision the dedicated login privately, and deploy a disabled chat-only baseline. Vercel uses `framework: null`, `pnpm run build:chat` and `dist-chat`; its only static file is `robots.txt`.
3. Prepare the ChatGPT connection and verify its displayed callback/client/resource. A URL edit may change callback identity. Complete connection and refresh tools/instructions during the approved window; do not retain temporary access exceptions.
4. Run an explicitly approved activation window. Prove normal owner sign-in and fresh-session logout, all five reports and independent aggregate comparisons, nonowner/customer/wrong-client/resource denial, opaque-token refresh/replay/revocation, direct gateway restrictions, unavailable states, unchanged customer login and actual chat workflows at the final origin. Record the exact source and results; no destructive account probes.
5. Enable permanent reporting only after that fresh proof and approval. Retire the old ChatGPT link, grants and client only through an exact, separately approved plan. Keep its old mapping disabled and exact-client hook/configuration intact until retirement is demonstrably safe; deleting them prematurely can restore ordinary customer claims to future legacy tokens. Never revoke unrelated sessions or change shared customer grants.

For rollback, **disable the new gateway configuration first**, then set `BJM_CHAT_OAUTH_ENABLED=false` and redeploy the reviewed chat-only disabled baseline. Revoke only specifically approved Office grant families where required; restore approved callbacks and remove temporary exceptions. Keep the legacy mapping disabled and restricted hook intact. Do not revert to the old JWT or privileged adapter, remove shared grants, or use global customer logout. Database/password retirement requires a separate narrow plan after access is closed.

## Local verification

Use Node 22 and the committed Office lockfile:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm run build:chat
pnpm build
```

`build:chat` must produce only `dist-chat/robots.txt`; `build` checks the retained legacy frontend separately. Tests use synthetic identities, a local database and mocked upstream services. Actual SDK/API checks bind a temporary loopback port; a sandbox may require local-listener permission. Local passes and a Ready deployment do not replace hosted OAuth and final-origin proof.

The [historical activation record](docs/AI_TEAM_ACTIVATION_2026-10-13.md) preserves earlier results and cleanup. Its old setup steps are not instructions for this new design.
