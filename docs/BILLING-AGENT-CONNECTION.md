# Billing Agent operational connection

Status at preparation (2026-09-07): connector implementation and offline tests prepared; live Stripe authentication and end-to-end runtime synchronization have NOT been verified. A merged file, green offline CI, or an installed ChatGPT plugin is not proof that this scheduled agent is operational.

## Architecture and boundaries

`GitHub Actions -> Stripe GET-only collector -> existing api/_billing-agent.js -> private Notion Payments queue`

This is a separate operational adapter, not a replacement billing engine. No existing checkout, payment endpoint, webhook handler, pricing, subscription, database, website layout, or mobile release file is changed. The Apple seller-name/public-launch hold remains in effect.

The only Stripe routes are GET `/v1/account`, `/v1/subscriptions`, `/v1/charges`, and `/v1/events`. No arbitrary provider URL, redirects, POST, PATCH, DELETE, refund, retry-charge, subscription mutation, or application database write is supported. Notion may receive review records only. Marking a card Approved NEVER triggers a financial action; any future executor needs separately scoped owner approval.

## Secure activation

1. Review this change and its CI results before merging. Do not bypass failed checks. Keep `BILLING_AGENT_ENABLED` unset/false until configuration is ready.
2. In the intended Stripe account, create or confirm a dedicated restricted key named **BJM Billing Monitor**. Begin in test mode. Give **Read** access only to the resources needed for current account identity, charges, subscriptions, invoices, and events (including dependencies Stripe requires for those reads). All write permissions must remain disabled. An `rk_` prefix alone does not prove read-only permissions; inspect the permission list. Do not reuse the application checkout `STRIPE_SECRET_KEY`, an organization key, or a webhook signing secret.
3. In `djv3ndy-bit/baa` -> Settings -> Secrets and variables -> Actions, save the key only as encrypted repository secret `STRIPE_BILLING_READ_ONLY_KEY`. Reuse the existing encrypted `NOTION_API_TOKEN`; its access should be restricted to the AI Agent Control Center. Never paste tokens into ChatGPT, Notion, issue/PR comments, committed files, command arguments, screenshots, or workflow logs. The connectors used during preparation cannot create or inspect these secrets.
4. Set repository variables: `BILLING_AGENT_MODE=test`; `BILLING_AGENT_STRIPE_ACCOUNT_ID` to the intended exact Stripe `acct_...`; `BILLING_AGENT_READ_ONLY_CONFIRMED=true` only after checking permissions; optionally `BILLING_AGENT_LOOKBACK_DAYS=7` (range 1-28); finally `BILLING_AGENT_ENABLED=true`.
5. Run **Billing Agent Connection** manually on `main`. Verify both jobs succeed and that the private Notion **Billing & Payments** view receives the mode-labeled connection card with a current timestamp. In a Stripe sandbox, use approved test fixtures for a failed payment and a suspected duplicate; inspect the corresponding review-only cards. Do not simulate failures or duplicate charges against real customers.
6. For live read-only activation, separately confirm the live account ID and restricted permissions, securely replace the secret with its `rk_live_` key, set mode `live`, then run and inspect the private heartbeat again. Mark operational only after that live read and Notion write actually succeed. Existing test records are distinctly labeled and have separate event keys.

To pause: set `BILLING_AGENT_ENABLED=false` or disable the workflow. To revoke Stripe access: revoke the dedicated restricted key. Do not rotate the application's unrelated checkout key.

## Output and owner workflow

The existing Notion data source is `64a712d1-8a77-44da-8db5-6a80b9ace054` (not its enclosing database ID). New findings use Area **Payments**, Source **Billing Agent**, and Status **Waiting for Owner Approval**. The connector validates schema and select options before writes.

Same-account/mode findings use deterministic Event Keys. On repeat runs, only the machine Summary field is refreshed: owner Status, checkbox, title, notes, and decisions remain untouched. The workflow serializes runtime runs. Notion does not provide a uniqueness constraint here; ambiguous creates are not blindly retried, and multiple rows matching an Event Key cause a failure for investigation. Review cards are never automatically closed or treated as authorization to execute.

A connection heartbeat is written last, only after the entire data collection and all finding writes succeed. An existing heartbeat can become stale after a failed later run: check its timestamp and GitHub Actions, not just its status. Failures produce only sanitized machine error codes. No raw payment payloads, customer names/emails, card data, credential values, business metrics, or Notion page URLs are published to the public repository's logs or artifacts. Review summaries and counts are sent only to the private Notion destination. Notion board presence does not by itself guarantee mobile push notifications.

## Coverage and limitations

- Default window: charges created and selected billing events created in the last 7 days, up to a fixed request cutoff; configurable 1-28 days. Current subscriptions are paginated with `status=all`. This is a bounded API snapshot, not a settlement ledger or a transactional snapshot across all endpoints.
- Each list is paginated up to 20 pages of 100. A cap, repeated record, malformed result, wrong Stripe account, wrong test/live mode, missing credential, or denied permission fails closed. The adapter does not label a partial window healthy. More than 100 findings also stops before Notion synchronization.
- Equal-price payments are compared only within the same Stripe customer. Anonymous charges are not cross-compared; uncaptured authorizations and fully refunded charges are excluded from duplicate candidates. Partial refunds remain reviewable. Duplicate candidates use UTC charge-creation day, not settlement date or guaranteed capture date, and must be investigated manually.
- A historical failed charge or invoice failure event may already have recovered. It is not proof that the customer still owes money. Outstanding event deliveries older than 15 minutes prompt a delivery-log review, not a claim that a specific endpoint failed.
- Reading Stripe Events cannot establish your application's webhook-processing idempotency or confirm delivery/processing of every webhook. This adapter does not reconcile complimentary access or Stripe subscriptions against Supabase entitlements; those remain separate checks. Stripe retains API event history for up to 30 days, so this is not a historical backfill service.
- No refunds, retries, cancellations, pricing changes, customer messaging, card execution buttons, database repairs, marketing actions, or app-store publication are part of this bridge.

## Verification

Run `node --test tests/billing-agent.test.mjs tests/billing-connection.test.mjs` on Node 22. At preparation, all 35 tests passed locally (9 unchanged policy tests plus 26 new connector tests), including a fully mocked end-to-end read-to-Notion flow. No real Stripe requests were executed by those tests. Verify GitHub CI and live runtime separately.

Source versions are pinned per request: Stripe `2025-06-30.basil`; Notion `2025-09-03`. This does not upgrade the app's account-level or webhook API versions.

Official references: https://docs.stripe.com/keys ; https://docs.stripe.com/api/charges/list ; https://docs.stripe.com/api/events/list ; https://github.com/stripe/stripe-node/blob/master/src/resources/Accounts.ts ; https://developers.notion.com/guides/get-started/upgrade-guide-2025-09-03
