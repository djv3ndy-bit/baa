# AI team activation checkpoint — October 13, 2026

Status: implementation and local verification in the existing PR #87. Hosted activation remains pending. No production, database, OAuth, billing or mobile settings have been changed by this continuation.

## Existing work and hosting

- Continue `fix/ai-office-owner-auth-20261012` / [PR #87](https://github.com/djv3ndy-bit/baa/pull/87). The separate consent-session fix [PR #88](https://github.com/djv3ndy-bit/baa/pull/88) remains independent and unmerged.
- The GitHub Vercel report updated October 12 at 09:22 UTC records Ready previews for `bjm-ai-office` (`prj_N2Rq3waXsuo86okM9UdVPV3yZMGi`) and `bjm-ai-office-` (`prj_kGfPndNs51i1iyAJw7xgNB0FYvVb`), under Baristamatch (`team_W7sLByby0CKVDax9uhMshO5I`), root `bjm-ai-office`.
- October 13 connector reads list only `baa` and `baristamatch-android`. Both recorded Office IDs and the recorded Office preview return 404 through this connection; listing their deployments returns none. This establishes a visibility/access discrepancy, not project absence or deletion.
- The browser reaches Vercel login. No existing local Vercel CLI authentication was found. Dashboard permission inspection therefore requires owner sign-in. Preserve both projects until the intended keeper is established from actual dashboard records; do not create, delete, rename or reimport projects, or broaden access to all projects.

## Implementation completed

- The owner boundary now rejects ordinary customer `authenticated` tokens and requires `bjm_office_reader` in addition to issuer, exact resource audience, dedicated client, owner, scope and verified live session checks.
- Both HTTP entrypoints pass the validated request token directly into that request's private MCP/provider closure. No process-global bearer token or cross-request data cache is used.
- The legacy service-role table adapter is replaced with a single aggregate RPC contract using the publishable API key and validated owner token. Raw customer rows and credentials are never included in tool results.
- Provider errors, denied reads, invalid counts and stale/malformed responses remain null/unavailable. Health depends on successful aggregate reads. Support/payment reporting uses a fixed 30-day window and counts are not capped at 100/500 rows.
- The widget reports registered roles, unavailable data and connection failures accurately, supports MCP Apps alongside the legacy bridge, and loads its stylesheet in the embedded resource.
- Database roles, aggregate RPC, client-specific token hook and isolation tests are prepared for review only in [office-read-review.sql](../sql/office-read-review.sql). The effective privilege audit includes PUBLIC grants and the exact fingerprint of the reviewed pure profile predicate. No existing customer grants are revoked. Review the package before applying anything.

## Validation completed locally

- **108 tests passed, zero failures**, including real MCP SDK calls for all five tools; actual denied Vercel-handler requests; request-token/cache isolation; provider outages, malformed/stale responses and partial nulls; rendered widget states; and local PostgreSQL role, table, RPC and storage isolation.
- Both server and browser TypeScript checks passed. The production widget build passed and generated deterministic `assets/office.js` and `assets/office.css`.
- Browser checks passed for MCP Apps initialization, result hydration, report calls, visible errors, preserved report state, follow-up messages, disconnected controls, legacy fallback, and 390-pixel layout without overflow. Browser console checks found no errors. Fixtures were synthetic, not live business data.
- An independent review found no remaining actionable code issues in the prepared changes.
- Local verification used the bundled Node 24.19.0 runtime. The existing required GitHub `validate` workflow targets Node 22, now installs from the frozen Office pnpm lockfile, and checks both widget assets. CI results on the final commit must be read separately; local results are not a Node 22 claim.

## Required activation sequence

1. Sign in to the existing Vercel team and inspect the existing integration's project access. Establish the intended Office project and verify the exact preview commit/build. A Ready report alone does not prove authenticated readiness.
2. Obtain the exact callback URL from the intended ChatGPT/Codex connection UI. Review/register a dedicated predefined OAuth client using PKCE S256 and the `openid` scope. Keep dynamic client registration disabled.
3. Review the proposed database package against the current catalog, including inherited PUBLIC/schema/routine/storage privileges. Prove the reader cannot access customer rows, write tables, invoke legacy mutation RPCs, or write storage. Do not automatically revoke shared grants or alter existing customer policies to make an audit pass.
4. Review the project's existing token hook before installation. Compose the Office's client-specific audience/role rule with any existing hook; never overwrite an unknown hook or change customer-token claims globally. Owner/client/resource configuration stays private. Missing configuration must fail closed.
5. In the existing isolated preview, verify actual access-token issuance and refresh, `/auth/v1/user` acceptance, owner success, nonowner/regular-customer/wrong-client/wrong-resource denial, and revoked-session denial. Confirm ordinary website login is unchanged. Local synthetic-token tests are not this proof.
6. Verify the five tools and embedded UI with actual aggregate reads. Compare known counts independently and confirm database-only billing results cannot be mistaken for live Stripe reconciliation.
7. Present the exact reviewed configuration and production commit for the owner's final activation approval. Correct any needed production consent owner setting only within that approved change, then redeploy and repeat owner/nonowner checks before enabling access.

## Configuration

Server-only values: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `BJM_OFFICE_BASE_URL`, `BJM_AI_OFFICE_OWNER_USER_ID`, `BJM_AI_OFFICE_OAUTH_CLIENT_ID`, and `BJM_AI_OFFICE_AUTH_ENABLED=false` until activation. Never inherit `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY`. Never place bearer tokens in widget metadata, URLs, logs, source, or tool arguments.

## Primary references

- [OpenAI MCP authentication](https://developers.openai.com/plugins/build/auth)
- [Supabase OAuth token security](https://supabase.com/docs/guides/auth/oauth-server/token-security)
- [Custom Access Token Hook](https://supabase.com/docs/guides/auth/auth-hooks/custom-access-token-hook)
- [Supabase OAuth flows](https://supabase.com/docs/guides/auth/oauth-server/oauth-flows)

Current upstream Supabase Auth source supports verifying a custom-role, resource-bound token through `/user`, including session lookup. The actual hosted project version and issued token must still be tested. A database reader role restricts business-data access; it does not by itself remove account-level capabilities from every Supabase Auth endpoint.
