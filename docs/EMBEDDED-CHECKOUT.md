# Embedded website Checkout

New café subscriptions open the existing dashboard’s Subscription section. The approved layout keeps the dashboard navigation and places pricing, benefits, and Stripe’s full embedded Checkout inside one wide white rounded panel. Stripe controls its inner form and payment methods; the embedded session requests a white background and black payment button. `/checkout.html` is a compatibility redirect to `/dashboard.html?section=subscription`. Existing subscription management still opens the Stripe customer portal through Account Settings.

The controller checks `/api/config` on each launch. When `stripeEmbeddedCheckoutConfigured` is false or absent, it offers an explicit hosted Checkout button using the existing web endpoint and payload. It does not initialize Stripe.js or request an embedded session until readiness is true. The same plan panel remains available during rollout, and the additional-job prompt preserves its saved draft while opening Subscription. Managed Payments, the configured $9.99 monthly Price, taxes, signed webhooks, and authenticated dashboard confirmation remain in use.

## Deployment order

1. In Vercel Production, save `STRIPE_PUBLISHABLE_KEY` with the `pk_live_` publishable key from the same Stripe account as `STRIPE_RESTRICTED_KEY` and `STRIPE_ACCOUNT_ID`. Do not enter a restricted or secret key in this variable. Test environments require a matching test key.
2. Database prerequisite is complete: `supabase/migrations/20260909044749_bind_checkout_attempt_ui_mode.sql` was applied to Production on September 9, 2026; Supabase recorded remote migration version `20260909051857`. Do not apply it again merely to match the local filename. The migration preserves old attempts as hosted and keeps four-argument callers compatible with the RPC’s default parameter.
3. Deploy this change; the hosted fallback remains available until the key is configured. `/api/config` reports `stripeEmbeddedCheckoutConfigured` as a boolean without returning the Stripe key. The boolean validates format and mode; actual iframe initialization must verify key-account compatibility.
4. Using an authorized café account, open Pro from Subscription and from the additional-job prompt. Confirm the payment form opens under the website's domain. Reload and retry, confirming an existing open session is reused. Confirm a retained job draft survives.
5. Confirm payment through Stripe's test environment, then verify the signed webhook and authenticated dashboard confirmation activate the correct café's Pro access. A client callback, redirect, or existing complimentary trial never proves a paid subscription.
6. Verify eligible wallets on supported devices and register the live payment-method domains in Stripe where required. Inspect the effective `Permissions-Policy` response and the Stripe iframe's payment permission. Bank and wallet authorization can still open another page.

The publishable key is returned only by the authenticated embedded Checkout endpoint. Client secrets stay in browser memory, are never logged or stored, and are issued only after a current session read validates café ownership, customer, mode, canonical Price, and Managed Payments. The dashboard reuses its existing authenticated Supabase client. Stale initialization is destroyed on account changes, section changes, or page departure; departed controllers unsubscribe their auth and page listeners. The dashboard waits for any returned payment confirmation before mounting checkout, and rejects delayed mounts for a different section, account, or DOM panel.

Durable attempts persist their UI mode. A recovered attempt is replayed with its original payload before changing modes; ambiguous requests or expiration failures retain their key. A verified mode change returns a retry response. No automatic payment or subscription is submitted by the website outside Stripe's form.

## Validation

- 98 targeted frontend checks passed after inline integration: embedded/hosted readiness, token refresh, account changes, delayed initialization, teardown, retry, dashboard confirmation ordering, job drafts, pricing access, and marketplace/layout regressions. Checkout JavaScript syntax also passed.
- Earlier backend/configuration/ownership/retry/deletion checks passed separately; see the release verification for the exact combined suite.
- Nine actual PostgreSQL coordination tests passed. Independent database review ran all 63 database checks successfully.
- The inline dashboard shell passed isolated browser checks at 1280, 1024, 736, 360, and 320 pixels with simulated authentication and Stripe responses. Stripe’s mount spans the full lower panel on small screens, retaining approximately 283 pixels at a 320-pixel viewport. Actual live Stripe iframe and wallet verification remains a deployment step.

Current rollout: the safe readiness flag is live in commit `dca579b2c706614344047315416716fe112ff3db`. Production reported `stripeEmbeddedCheckoutConfigured: false` on September 9, 2026. The database migration is applied. The inline frontend is ready to release with hosted fallback while a matching Production publishable key is pending. Embedded checkout activates only when configuration reports readiness; actual key-account compatibility and live wallet rendering still need verification.
