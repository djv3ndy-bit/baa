# BaristaMatch Exact Website

This website uses the approved BaristaMatch mockup as its exact visual centerpiece and adds working navigation, preview actions, waitlist forms, and responsive supporting sections.

Upload these items to the root of GitHub:
- index.html
- vercel.json
- README.md
- assets/

Vercel settings:
- Framework Preset: Other
- Build Command: blank
- Output Directory: blank or .

## Stripe Billing

The website and native app use server-created Stripe Checkout and Customer Portal sessions. Configure these server-side environment variables separately in Vercel Preview and Production:

- `STRIPE_RESTRICTED_KEY`: a least-privilege restricted key with Prices Read; Customers Read/Write (including Customer search and deletion during account deletion); Checkout Sessions Read/Write (create, list, retrieve, and expire); Subscriptions Read; and Billing Portal Sessions Write. Accounts Read and Invoices Read are not required
- `STRIPE_ACCOUNT_ID`: the expected Stripe account ID; the server verifies that the configured Price is bound to this account through protected Price metadata
- `STRIPE_MONTHLY_PRICE_ID`: the recurring monthly Price for the café plan; the restricted key must be able to retrieve it
- `STRIPE_WEBHOOK_SECRET`: the signing secret for the `/api/stripe-webhook` endpoint
- `STRIPE_LIVEMODE`: `false` for sandbox environments and `true` only for the reviewed live Production configuration
- `BILLING_ENABLED`: keep `false` until the release gate is complete; set `true` only in the explicitly approved environment to allow new Checkout Sessions
- `PUBLIC_SITE_URL`: `https://www.baristajobmatch.com` in production
- `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and `SUPABASE_SECRET_KEY`: the existing server-side Supabase configuration

Create one Stripe Product for the $9.99 café plan and attach its monthly recurring Price. Set the Price metadata keys `application=baristamatch`, `plan=cafe_monthly`, and `stripe_account_id=<expected account ID>`. In Stripe Workbench, register `https://www.baristajobmatch.com/api/stripe-webhook` and subscribe it to:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`
- `charge.refunded`

### Café job entitlement

Each café receives exactly one free job post for the lifetime of its account. Editing, pausing, reopening, reviewing applicants, matching with a barista, messaging, and scheduling an interview for that same first job remain free. Creating any second distinct job row requires a real Stripe subscription in `active` status, or an unexpired Stripe-backed `trialing` status; complimentary access and legacy local trials do not qualify. Pro allows at most three active job posts at once. The website preserves an unpaid second-job form as a browser draft while Checkout is completed, but it must not insert or expose that job to baristas before the database confirms Pro access.

Apply all Supabase migrations in timestamp order. The billing and job-entitlement launch sequence must include these migrations in this order:

1. `supabase/migrations/202608310001_connect_stripe_billing.sql`
2. `supabase/migrations/20260908090000_harden_stripe_runtime_coordination.sql`
3. `supabase/migrations/20260908100000_enforce_cafe_job_posting_entitlements.sql`

The final migration assigns each existing café's earliest job row as its lifetime-free job, retains that assignment even if the job is deleted, and pauses later active jobs for cafés without current Stripe access. Review the affected production rows before applying it. Apply the complete sequence before deploying this billing runtime or enabling Checkout.

Configure the Customer Portal for payment-method updates and cancellation, disable Product/Price switching at launch, and test its cancellation behavior before accepting a payment. Account deletion expires open Checkout Sessions and immediately ends active Pro billing by deleting every verified Stripe Customer owned by the café; legacy rows first resolve the Customer through their Subscription. Recovered Checkout attempts are settled under the exact deletion claim before Stripe is mutated, and every retry still rediscovers owned Customers. The request fails closed if Stripe account validation or cleanup cannot be confirmed. Keep Stripe Tax off until the business address, product tax treatment, and required registrations are confirmed.

Keep test and live keys in separate Vercel environments and never place Stripe secret keys in the website or mobile app. Sandbox end-to-end tests must use a separate Supabase test project. If that is temporarily impossible, use dedicated test-only café accounts and billing rows that can never be used in Production; a test webhook must never write test-mode subscription state into a live café's billing row.
