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

The website and native app use server-created Stripe Checkout and Customer Portal sessions. Configure these server-side environment variables in Vercel for Preview and Production:

- `STRIPE_RESTRICTED_KEY`: a least-privilege sandbox restricted key with Products and Prices read access plus the minimum write access needed for Customers, Checkout Sessions, Billing Portal Sessions, and Subscriptions; Accounts Read is not required
- `STRIPE_ACCOUNT_ID`: the expected Stripe sandbox account ID; the server verifies that the configured Price is bound to this account through protected Price metadata
- `STRIPE_MONTHLY_PRICE_ID`: the recurring monthly sandbox Price for the café plan; the restricted key must be able to retrieve it
- `STRIPE_WEBHOOK_SECRET`: the signing secret for the `/api/stripe-webhook` endpoint
- `PUBLIC_SITE_URL`: `https://www.baristajobmatch.com` in production
- `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and `SUPABASE_SECRET_KEY`: the existing server-side Supabase configuration

Create one Stripe Product for the $9.99 café plan and attach its monthly recurring Price. Set the Price metadata keys `application=baristamatch`, `plan=cafe_monthly`, and `stripe_account_id=<expected sandbox account ID>`. In Stripe Workbench, register `https://www.baristajobmatch.com/api/stripe-webhook` and subscribe it to:

- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`
- `charge.refunded`

Apply `supabase/migrations/202608310001_connect_stripe_billing.sql` before enabling checkout. Keep test and live keys in separate Vercel environments and never place Stripe secret keys in the website or mobile app.
