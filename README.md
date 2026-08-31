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

- `STRIPE_RESTRICTED_KEY`: a least-privilege restricted key with read access to Account and read/write access to Customers, Checkout Sessions, Billing Portal Sessions, and Subscriptions
- `STRIPE_ACCOUNT_ID`: `acct_1UANO72euSkBN6zq`; the server refuses to use a key from any other Stripe account
- `STRIPE_MONTHLY_PRICE_ID`: the recurring monthly Price for the café plan
- `STRIPE_WEBHOOK_SECRET`: the signing secret for the `/api/stripe-webhook` endpoint
- `PUBLIC_SITE_URL`: `https://www.baristajobmatch.com` in production
- `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and `SUPABASE_SECRET_KEY`: the existing server-side Supabase configuration

Create one Stripe Product for the $9.99 café plan and attach its monthly recurring Price. In Stripe Workbench, register `https://www.baristajobmatch.com/api/stripe-webhook` and subscribe it to:

- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`

Apply `supabase/migrations/202608310001_connect_stripe_billing.sql` before enabling checkout. Keep test and live keys in separate Vercel environments and never place Stripe secret keys in the website or mobile app.
