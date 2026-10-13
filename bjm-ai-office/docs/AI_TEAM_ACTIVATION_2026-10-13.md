# AI team activation checkpoint — October 13, 2026

Status: implementation and local verification in the existing PR #87. Hosted activation remains pending. No production, database, OAuth, billing or mobile settings have been changed by this continuation.

## Existing work and hosting

- Continue `fix/ai-office-owner-auth-20261012` / [PR #87](https://github.com/djv3ndy-bit/baa/pull/87). The separate consent-session fix [PR #88](https://github.com/djv3ndy-bit/baa/pull/88) remains independent and unmerged.
- Signed-in Vercel inspection confirms the original `bjm-ai-office` and the separate `bjm-ai-office-` both exist. Continue the original Office, whose root is `bjm-ai-office`; do not create, delete, rename or reimport either project.
- The reviewed original Office preview at commit `737f6bc` renders the current widget and both assets correctly. Its Standard Protection requires Vercel login; an unauthenticated API request returns Vercel's 401, so this is not hosted Office OAuth verification. No deployment-protection setting was changed.
- October 13 connector reads list only `baa` and `baristamatch-android`. Both recorded Office IDs and the recorded Office preview return 404 through this connection; listing their deployments returns none. This establishes a visibility/access discrepancy, not project absence or deletion.
- Vercel sign-in is complete. No local Vercel CLI authentication was found. The existing ChatGPT Sign in with Vercel connection exposes no project-grant selector in its account page; do not disconnect/reconnect or broaden permissions speculatively.
- The Office has no Office/Supabase environment variables and no linked shared variables. The production Supabase OAuth server is enabled, dynamic registration is disabled, its current key is ECC P-256, and no active OAuth clients, Auth hooks or Office database roles/configuration are installed. No settings were changed. ChatGPT is signed in through Chrome; its custom MCP form exposes a callback before creation. Recopy that exact callback after choosing the final endpoint and discovering its metadata. No connection was submitted.

## Implementation completed

- The owner boundary now rejects ordinary customer `authenticated` tokens and requires `bjm_office_reader` in addition to issuer, exact resource audience, dedicated client, owner, scope and verified live session checks.
- Public OAuth discovery needs only validated Office/Supabase HTTPS origins. Anonymous MCP requests receive a discovery challenge before activation; credential-bearing requests remain behind complete private configuration and the activation switch, without executing tools or providers during setup.
- Both HTTP entrypoints pass the validated request token directly into that request's private MCP/provider closure. No process-global bearer token or cross-request data cache is used.
- The legacy service-role table adapter is replaced with a single aggregate RPC contract using the publishable API key and validated owner token. Raw customer rows and credentials are never included in tool results.
- Provider errors, denied reads, invalid counts and stale/malformed responses remain null/unavailable. Health depends on successful aggregate reads. Support/payment reporting uses a fixed 30-day window and counts are not capped at 100/500 rows.
- The widget reports registered roles, unavailable data and connection failures accurately, supports MCP Apps alongside the legacy bridge, and loads its stylesheet in the embedded resource.
- Database roles, aggregate RPC, client-specific token hook and isolation tests are prepared for review only in [office-read-review.sql](../sql/office-read-review.sql). The effective privilege audit includes PUBLIC grants and the exact fingerprint of the reviewed pure profile predicate. The PostgreSQL 16+ installer temporarily grants only the SET ability needed for aggregate function ownership and restores its exact original membership before commit. A private security-barrier view delegates only the configured owner's live dedicated-client sessions; the aggregate role receives no direct Auth schema/table privileges. Its owner, definition fingerprint, projection, options, dependencies, rules and grants are audited before lookup. Existing customer grants are preserved. Review the package before applying anything.

## Validation completed locally

- **122 tests passed, zero failures**, including real MCP SDK calls for all five tools; actual denied Vercel-handler requests; public discovery without tool execution; request-token/cache isolation; provider outages, malformed/stale responses and partial nulls; rendered widget states; and local PostgreSQL role, table, RPC and storage isolation. Non-superuser migration tests prove inert empty configuration, installation with existing Auth reads but no delegation rights, private-view isolation/drift detection, temporary membership cleanup/preservation and atomic rollback. Read-only hosted metadata confirms PostgreSQL 17.6 and a matching restricted migration session; the package is still unapplied there.
- Both server and browser TypeScript checks passed. The production widget build passed and generated deterministic `assets/office.js` and `assets/office.css`.
- Browser checks passed for MCP Apps initialization, result hydration, report calls, visible errors, preserved report state, follow-up messages, disconnected controls, legacy fallback, and 390-pixel layout without overflow. Browser console checks found no errors. Fixtures were synthetic, not live business data.
- An independent review found no remaining actionable code issues in the prepared changes.
- Local verification used the bundled Node 24.19.0 runtime. The existing required GitHub `validate` workflow targets Node 22, now installs from the frozen Office pnpm lockfile, and checks both widget assets. CI results on the final commit must be read separately; local results are not a Node 22 claim.

## Required activation sequence

1. Agree on the exact hosted test origin and how ChatGPT can reach it through the current Vercel protection. A narrowly reviewed exception for the immutable preview hostname can expose discovery without changing other previews; it exposes every path on that hostname and must be removed after testing. Any security-access or protection change requires concrete approval. Recopy the final connection's displayed callback after metadata discovery. A Ready preview does not prove authenticated readiness.
2. Review the database target and package against the current catalog, including inherited PUBLIC/schema/routine/storage privileges. An approved installation may leave configuration empty and disabled before the callback is known; do not install the Auth hook or authorize a new Office client in that state. Prove the reader cannot access customer rows, write tables, invoke legacy mutation RPCs, or write storage. Do not revoke shared grants or alter customer policies to make an audit pass.
3. Prepare the predefined OAuth client using the exact callback, PKCE S256 and `openid`; keep dynamic registration disabled. Before the client can be authorized, populate its private owner/client/resource mapping with `enabled=false` and install the reviewed client-specific token hook. A disabled mapped client must still receive the restricted reader role; never allow it to fall through to ordinary customer claims.
4. Recheck existing token hooks immediately before installation. Compose with any intervening hook; never overwrite an unknown hook or change customer-token claims globally. Configure only the approved Office preview values. Review the independent consent-session PR #88 and the website's existing preview-only owner setting before testing the real consent flow; neither production consent deployment nor owner correction is implied by this checkpoint.
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
