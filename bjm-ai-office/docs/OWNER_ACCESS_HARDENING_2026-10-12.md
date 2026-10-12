# Owner Intelligence: security prerequisite, not production activation

Status: draft implementation for review. Do not label the Office or its 19 registered agents operational from this patch.

## Verified checkpoint

The current consent gate from PR #82 is merged, but both Office MCP entrypoints had no owner authentication. The provider adapter currently relies on SUPABASE_SECRET_KEY/SUPABASE_SERVICE_ROLE_KEY, so deploying it as previously written would not be an RLS-limited read-only integration. Public health also called private provider health. The recorded separate Office Vercel project was not found under the connected team during this inspection; the website project remains present. Resolve the intended hosting target rather than recreating or deleting projects blindly.

The owner's selected account was verified privately against the production Supabase auth.users record. Its confirmed active UUID was saved to the EXISTING website Vercel PREVIEW BJM_AI_OFFICE_OWNER_USER_ID variable only. No UUID is in this repository. The production owner setting was NOT edited or redeployed in this pass.

## Implemented boundary

- Both local/Express and Vercel MCP transports authenticate before server creation, tool listing, resource reads or calls.
- Supabase Auth /auth/v1/user verifies the exact submitted token using only the publishable key. Decoded JWT claims alone never authorize.
- Application checks require the configured owner, issuer, exact OAuth client, resource-specific audience, authenticated role, session ID, openid scope and a valid lifetime of at most one hour.
- Missing configuration/activation, provider outages and inherited privileged database credentials fail closed. Owner metadata supplied by users never grants access.
- Public health is process liveness only. Protected resource metadata has no owner identity or credentials.
- Only five read tools are registered. The previous Notion task-writing tool is deliberately not registered in this read-only build.
- No new runtime dependencies; no secret values in code, test fixtures or error logs.

## Explicit remaining blockers

1. Restore or identify the separate private Office hosting target with owner approval; do not alter the customer website root directory or Android/iOS deployment targets.
2. After approval, correct the website PRODUCTION owner ID and redeploy the exact reviewed production commit. Existing deployments do not inherit a saved environment edit automatically. Test /api/oauth-owner in the owner's real browser session, then a separate nonowner session. Never mint an owner token or ask for a pasted token to shortcut the test.
3. Register a dedicated predefined OAuth client with the exact callback from ChatGPT's connection UI; keep Dynamic OAuth Apps/DCR disabled. A client ID is not an owner identity. Verify PKCE S256 and all redirect/issuer discovery metadata.
4. Configure and verify issuance of a resource-bound ACCESS token for https://<office-origin>/mcp, including client_id and scope. Generic Supabase aud=authenticated tokens are intentionally rejected. Verify the configured issuer's /user endpoint accepts that resource-bound access-token shape; this has NOT been proven by mock tests. Do not remove audience checks to make it pass. Use an issuer-supported verification/introspection design if the /user endpoint cannot validate that shape. Do not change customer token issuance globally.
5. Replace the legacy service-role provider adapter with genuinely least-privilege, reviewed database access. OAuth openid/email scopes do not constrain table writes. Test direct OAuth-token reads/writes against database RLS/grants, plus RPCs and storage, not just MCP tool annotations. Missing/denied provider responses must become unavailable/null, not numeric zero. Do NOT set SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY on the Office to make the adapter work: this patch intentionally blocks such a configuration.
6. Complete a dependency-installed TypeScript/build check and end-to-end authenticated tests in an isolated environment. Only then review activation. Keep BJM_AI_OFFICE_AUTH_ENABLED unset/false until these checks pass.

## Required configuration after the blockers are resolved

All values remain server-side: SUPABASE_URL; SUPABASE_PUBLISHABLE_KEY (sb_publishable_...); BJM_OFFICE_BASE_URL (HTTPS origin only); BJM_AI_OFFICE_OWNER_USER_ID (private verified UUID); BJM_AI_OFFICE_OAUTH_CLIENT_ID (dedicated client); BJM_AI_OFFICE_AUTH_ENABLED (false until approved). Never copy all customer-app environment variables to the Office.

## Validation and limitations

Run `node --test tests/owner-auth.test.mjs tests/owner-boundary-wiring.test.mjs` inside bjm-ai-office. These are offline unit tests with synthetic JWT-shaped strings and a mocked Supabase Auth response, plus source-level route wiring invariants. They do NOT cryptographically verify mock signatures, prove real issuer compatibility, test browser OAuth, prove database isolation, or replace an installed build/security review. Production signature verification is delegated to Supabase Auth; there is no custom cryptography.

HTTP health=200 means process reachable, not authenticated readiness or functioning business data. Agent registry entries are not running workers. This patch deliberately blocks the previous privileged data setup rather than falsely presenting it as secure completion.

## Primary references inspected

- https://developers.openai.com/plugins/build/auth
- https://supabase.com/docs/guides/auth/oauth-server/token-security
- https://supabase.com/docs/guides/auth/oauth-server/mcp-authentication
- https://supabase.com/docs/reference/javascript/auth-getuser

Supabase markdown changelog fetch was unavailable in this environment; the HTML changelog and current auth documentation were consulted. Implementation uses the existing stable Auth user endpoint, not new schema or OAuth API features.
