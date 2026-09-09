# Embedded website Checkout

New café subscriptions open `/checkout.html`, where Stripe's full embedded Checkout page handles payment details. The surrounding page is white with black text; embedded session branding requests white and black. Managed Payments, dynamic payment methods, the configured $9.99 monthly Price, taxes, signed webhooks, and authenticated dashboard confirmation remain in use. Existing subscription management still opens the Stripe customer portal.

## Deployment order

1. In Vercel Production, save `STRIPE_PUBLISHABLE_KEY` with the `pk_live_` publishable key from the same Stripe account as `STRIPE_RESTRICTED_KEY` and `STRIPE_ACCOUNT_ID`. Do not enter a restricted or secret key in this variable. Test environments require a matching test key.
2. Apply `supabase/migrations/20260909044749_bind_checkout_attempt_ui_mode.sql` before deploying the new billing handler. It preserves old attempts as hosted and keeps four-argument callers compatible with the RPC's default parameter.
3. Deploy this change. `/api/config` reports `stripeEmbeddedCheckoutConfigured` as a boolean without returning the Stripe key. The boolean validates format and mode; actual iframe initialization must verify key-account compatibility.
4. Using an authorized café account, open Pro from Subscription and from the additional-job prompt. Confirm the payment form opens under the website's domain. Reload and retry, confirming an existing open session is reused. Confirm a retained job draft survives.
5. Confirm payment through Stripe's test environment, then verify the signed webhook and authenticated dashboard confirmation activate the correct café's Pro access. A client callback, redirect, or existing complimentary trial never proves a paid subscription.
6. Verify eligible wallets on supported devices and register the live payment-method domains in Stripe where required. Inspect the effective `Permissions-Policy` response and the Stripe iframe's payment permission. Bank and wallet authorization can still open another page.

The publishable key is returned only by the authenticated embedded Checkout endpoint. Client secrets stay in browser memory, are never logged or stored, and are issued only after a current session read validates café ownership, customer, mode, canonical Price, and Managed Payments. Stale initialization is destroyed on account changes or page departure.

Durable attempts persist their UI mode. A recovered attempt is replayed with its original payload before changing modes; ambiguous requests or expiration failures retain their key. A verified mode change returns a retry response. No automatic payment or subscription is submitted by the website outside Stripe's form.

## Validation

- 168 targeted application tests passed, including the embedded frontend, backend, configuration, ownership, retries, dashboard, and deletion paths.
- Nine actual PostgreSQL coordination tests passed. Independent database review ran all 63 database checks successfully.
- The website shell passed isolated browser checks at 1024, 736, 360, and 320 pixels with simulated authentication and Stripe responses. Actual live Stripe iframe and wallet verification remains a deployment step.

Current rollout: the safe readiness flag is live in commit `dca579b2c706614344047315416716fe112ff3db`. Production reported `stripeEmbeddedCheckoutConfigured: false` on September 9, 2026. The embedded checkout and migration are staged until a matching Production key is saved. The currently linked hosted checkout remains active.
