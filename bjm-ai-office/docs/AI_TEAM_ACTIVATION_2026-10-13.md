# October 14 direction — chat-only team, locally prepared

**The new chat-only OAuth broker and narrow PostgreSQL gateway are prepared locally, not installed or live. Public Office website activation remains on hold. Use the current [README](../README.md) for this design; every setup/configuration/activation step below is a historical record for the previous Supabase-bearer/widget implementation. Do not execute those old steps to activate the new design.**

The user chose the current chat as the team interface. Operations Manager coordinates 19 roles on request within their observe/recommend/prepare ceilings, using five restricted reporting tools. The new server registers no widget and gives ChatGPT only Office-owned `office.read` credentials. Upstream owner credentials remain inside the sign-in callback; a separate restricted gateway supplies reports. No autonomous workers, new chats or schedules are implied.

All selected prior supervised checks were completed and temporary access was cleaned up, including the later ordinary/nonowner, private-object, combined wrong-client/resource and enforced-CSP checks. The earlier post-revocation Auth response classifier limitation remains recorded; cleanup was independently verified. The old preview is disabled/protected, the original approved callback restored and disposable fixtures/sessions cleaned up. These historical results do not prove the new broker, new gateway or a final production origin.

The new SQL remains unapplied. Fresh approval and hosted proof must cover its exact origin/callback/client configuration, dedicated gateway credential, owner sign-in and local-session cleanup, five reports, denial/refresh/revocation behavior, customer-login preservation and actual chat workflows. Both documented ChatGPT callback formats are supported as one exact configured pin; copy the final URI from connection management rather than guessing. Keep the legacy mapping disabled and its exact-client hook/configuration intact until separately approved retirement. Roll back to the reviewed chat-only disabled baseline, never to an old JWT/privileged adapter.

---

# AI Office activation checkpoint — October 13, 2026

**Status: the approved preview and local security tests passed, and temporary access cleanup is complete. The Office preview is disabled and protected. Production Office deployment and final activation remain pending.**

Continue the existing `bjm-ai-office` project, root `bjm-ai-office`, and [draft PR #87](https://github.com/djv3ndy-bit/baa/pull/87) on `fix/ai-office-owner-auth-20261012`. Prior hosted-preview head: `cd0a8b83c76f3f1b89a9e17f9bab343d82ef9350`; tree: `5cc33d310dc9db85e3e5a17521bead22b0be4b6d`. The production candidate additionally rejects a nil session UUID before contacting Auth, with a regression test and **127 local tests**, typechecks and build passing. Normal Auth issues nonzero sessions; no current nil-token mint path is alleged. Record final-commit CI and hosted evidence independently. The PR is unmerged. The separate existing `bjm-ai-office-` project is preserved. Create no replacement projects and do not change the customer website deployment root.

## Production V1 scope

This is private owner reporting and drafting through ChatGPT, with five authenticated read-only tools: owner overview, team registry, decision signals, system health and billing summary. The widget can load these reports and ask ChatGPT to prepare drafts.

The 19 registry entries are role definitions available on request. Their ceilings are observe, recommend or prepare; none has an execute ceiling. They do not establish independent agents, scheduled work or continuous background execution. Policy routing/retry/handoff helpers are not connected to a worker loop. No OpenAI API key is required.

The decision queue checks only available billing, website/data-health and recent-support signals. Notion is currently unavailable and optional for this V1. Its configuration flag is not a task read: adding settings alone does not expand decision coverage. The existing Notion-writing helper is not registered as an Office tool. An empty queue does not prove that all business work is clear.

Support and payment summaries use a 30-day window; overview totals and subscription counts are all-time. Counts come from database aggregates, not an independent Stripe reconciliation. Missing, denied, malformed or stale data remains unavailable/null. Describe reports using their snapshot time; an earlier successful report is not a current availability claim.

No Office tool sends email or messages, persists tasks, charges/refunds/cancels subscriptions, changes customers, publishes, merges or deploys. Consequential actions and production activation remain subject to owner approval.

## Implementation and hosted proof

- Every MCP request validates its exact bearer token with Supabase Auth and enforces the owner, issuer, dedicated client, exact Office resource audience, restricted `bjm_office_reader` role, `openid` scope and session lifetime. Ordinary customer tokens and privileged server keys are rejected.
- Both HTTP entrypoints pass the validated token into that request's MCP/provider closure. There is no process-global bearer token or cross-request data cache. Providers call only the aggregate snapshot RPC and whitelist returned counts.
- Migration `20261013171447` is installed. The dedicated public PKCE client, one-row private mapping and client-specific token hook exist. Dynamic client registration remains disabled. The private security-barrier session view and restricted roles passed the effective-privilege audit without revoking shared customer grants; the aggregate role has no direct Auth schema/table privileges.
- **Twelve hosted database denial checks passed.** The ordinary customer-claim preservation and dedicated restricted claims were also checked synthetically on the hosted hook; this does not replace a real customer/nonowner login regression.
- Normal ChatGPT owner consent, all five MCP tools, all five purpose-built connector calls and the widget's owner-report button succeeded. **Thirteen aggregate counts matched independent comparisons**, without reading raw customer rows for those comparisons.
- The separately approved local PKCE test passed normal owner issuance and refresh, `/auth/v1/user` acceptance and **37 original/refreshed read checks**. Raw-table reads were denied and Storage listing returned AccessDenied, while the aggregate RPC and all five tools worked.
- Logging out only the fresh local test session succeeded. Its still-unexpired token then received Office 401 and aggregate RPC 403; its refresh attempt was denied. Existing dedicated sessions were preserved, and the existing ChatGPT owner report continued working.
- Disabling the mapping produced a fresh owner response with unavailable/null business, support and billing data. The widget displayed unavailable values and an attention signal rather than zero counts.
- The approved website Production owner-setting correction was saved privately and the same website source was redeployed successfully. The verified owner reached the correct dedicated-client consent. This separate configuration correction is not an Office production deployment or a merge of the independent consent-session [PR #88](https://github.com/djv3ndy-bit/baa/pull/88).

## Auth-token trust boundary

The Office validates the token through Supabase Auth, and its provider code uses that token only for the bounded aggregate adapter. No Office tool returns the credential or exposes an Auth mutation. The trusted server must keep the token out of the widget, logs, URLs, source and tool arguments.

The same Supabase bearer may permit account-level Auth operations outside the Office tools. `openid` and the restricted database role are not a general Auth-endpoint permission boundary. Hosted table/RPC/Storage denials prove business-data restrictions; they do not prove that every account Auth mutation is denied. Destructive owner-account probes were not run and must not be used as a readiness shortcut.

**Production enablement requires an explicit decision to accept this token-handling trust boundary or resolve it with a reviewed design.** A read-only Office tool surface alone does not settle that decision.

## Automated and UI verification

[Office CI run 38436870592](https://github.com/djv3ndy-bit/baa/actions/runs/38436870592) passed on reviewed head `cd0a8b83c76f3f1b89a9e17f9bab343d82ef9350`: **126 tests**, both TypeScript checks, widget build, assets and routes. The local suite also passed 126 tests. Local verification used Node 24.19.0; the recorded CI run used Node 22.23.3. Local PKCE-driver offline checks passed separately.

Synthetic browser checks passed initialization, result hydration, reports, visible errors, preserved report state, follow-up messages, disconnected controls, legacy fallback and the 390-pixel layout. Real owner widget interaction subsequently passed during the approved hosted window.

Resource CSP metadata uses the standard `_meta.ui.csp` camelCase fields and allows only the configured Office origin. **Enforced-CSP browser behavior remains unverified:** the successful hosted widget check used the pre-existing global CSP-enforcement setting off, and that setting was not changed.

## Current parked state and completed cleanup

- Office application activation is false and the private mapping is disabled; the live owner-session view returns no rows.
- The exact temporary branch-domain protection exception is removed. Browser access returns to Vercel sign-in and anonymous MCP requests receive Vercel 401.
- The client's sole original ChatGPT callback is restored. The temporary local callback is removed, the listener is closed and no disposable test sessions remain.
- Existing dedicated owner sessions were preserved. No global logout or client-grant revocation was used.

No cleanup remains for the approved temporary preview/local test. The preview's unavailable state is intentional. Installed restricted database/Auth infrastructure and saved branch-specific settings remain in place for the next approved step.

## Remaining production acceptance and activation sequence

1. **Complete the remaining real checks.** Verify nonowner OAuth denial and ordinary customer login with the installed hook. Resolve and record widget behavior with CSP enforcement enabled. Preserve the existing owner/customer sessions and account settings unless a specific test requires an approved narrow change.
2. **Review the exact production target and configuration.** Use the existing original Office project and a verified stable production HTTPS origin. Confirm that public discovery, the MCP resource audience, dedicated-client mapping, callback and widget asset origin agree. A preview token/resource and branch-only settings do not establish production configuration. Keep dynamic registration disabled and do not broaden project protection speculatively. Establish and record a hardened disabled Production baseline built from the reviewed tree before enablement.
3. **Approve the final production change before merging, promoting or deploying.** Present the exact reviewed source, production-scoped values, mapping/hook change if needed, validation results, Auth-token trust decision and safe rollback baseline. Explicitly accept or resolve the account-level Auth bearer boundary before enabling access. The earlier preview/local-test approval does not itself authorize Office production activation. Keep the independent PR #88 separate unless its change is still needed and independently approved.
4. **Deploy with access disabled, then run the approved production verification window.** Confirm public metadata and the anonymous OAuth challenge, exact deployed source and assets, owner success, nonowner/customer/wrong-client/wrong-resource denial, direct data restrictions and unchanged website login. Verify all five tools and the widget against independently checked aggregates on the final origin.
5. **Enable only within the final approved scope.** Record the resulting availability, snapshot and accepted limitations. Keep the following rollback contract available and verified.

## Rollback contract

1. **Disable the private mapping first.** Set its enabled state false while retaining the exact-client configuration row, restricted token hook and isolation roles. Deleting the mapping or removing the hook could let future dedicated-client tokens fall through to ordinary `authenticated` claims.
2. **Disable the Office application.** Set the Production activation switch false and deploy that disabled state. Keep the restricted client configuration and hook installed.
3. **Return only to the hardened disabled Production baseline built from the reviewed tree.** Verify its exact source and disabled settings. The original previous Production deployment may contain the legacy privileged adapter; a blind rollback to that deployment is unsafe.
4. Remove any temporary callback or protection exception introduced for testing and confirm Office/business access is denied while ordinary customer behavior is preserved. This closes Office and aggregate access; it does not establish revocation of every bearer-token Auth capability. Any account-session revocation needs its own deliberate, narrowly scoped decision.

## Required server-side configuration

`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `BJM_OFFICE_BASE_URL`, `BJM_AI_OFFICE_OWNER_USER_ID`, `BJM_AI_OFFICE_OAUTH_CLIENT_ID` and `BJM_AI_OFFICE_AUTH_ENABLED`. Keep activation false until the remaining checks and final approval are complete. `BJM_PUBLIC_URL` is optional and defaults to the existing public website; Notion settings are not required for the five tools.

Never inherit `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY`, copy the full customer-app environment, or place bearer tokens/private values in source, widget metadata, URLs, logs or tool arguments. Owner/client identifiers and credentials are intentionally omitted from this document.

## Primary references

- [OpenAI MCP authentication](https://developers.openai.com/plugins/build/auth)
- [OpenAI component resource metadata](https://developers.openai.com/plugins/reference)
- [Supabase OAuth token security](https://supabase.com/docs/guides/auth/oauth-server/token-security)
- [Custom Access Token Hook](https://supabase.com/docs/guides/auth/auth-hooks/custom-access-token-hook)
- [Supabase OAuth flows](https://supabase.com/docs/guides/auth/oauth-server/oauth-flows)

A restricted database reader limits business-data privileges; `openid` does not supply a general account-Auth permission boundary. The explicit token-handling decision and safe rollback above remain production prerequisites.
