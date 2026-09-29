# BaristaMatch café pricing

## Canonical launch offer

This document is the source of truth for customer-facing plan copy across the website and mobile app.

### Baristas

**Free.** BaristaMatch never charges baristas to find work.

### Free café plan — $0 forever

- One lifetime first job post, visible free for 30 days
- View applicants and full profiles for that job
- Message mutual matches
- Schedule interviews with matches
- No credit card required

The Free account does not expire, but its one free job has a 30-day publication period. It can be edited, paused, and reopened during those same 30 days without using another free post or extending the deadline. Reopening it after expiration requires active Pro. A café keeps its account, applicants, matches, and messages after the role is filled.

### Pro café plan — $9.99/month Founder Price

- Up to 3 concurrent active jobs
- Unlimited candidate profile viewing
- Unlimited messaging
- Smart candidate matches
- Saved baristas
- Full hiring dashboard
- Cancel anytime

Founder pricing stays with a café while its subscription remains continuously active. A canceled subscription can return to the then-current public price if it is restarted later.

## Access behavior

- Café plan details appear only after signup and sign-in with a saved café account. Public homepage navigation, footer and café marketing copy do not advertise plans or prices. The legacy pricing route directs guests to café signup and signed-in cafés to their dashboard Subscription section. The café welcome screen keeps plan content hidden until authorization succeeds.
- A café can use the full Free workflow for its first job, including reviewing applicants, matching, messaging, and scheduling interviews.
- A second job—meaning a second distinct lifetime post—requires Pro before it can be published or shown to baristas. A blocked attempt must preserve the café's draft and offer secure Stripe checkout.
- Editing, pausing, or reopening the original first job does not count as a second post.
- Pro permits no more than 3 active jobs at once.
- Downgrading or canceling never deletes the café profile, jobs, applicants, matches, or messages.
- If Pro ends with more than one active job, existing data remains readable and the café must close extra jobs before starting new hiring activity.
- Barista access remains free regardless of café plan status.

## Billing rollout state

Stripe billing and production enforcement remain paused until the web checkout, database policies, webhook lifecycle, cancellation behavior, tax registrations, and App Store purchase path have all passed release verification. Preview UI must never charge a customer.

## Future pricing

Validate conversion, retention, and support load before adding annual, multi-location, featured-job, or enterprise plans.

## First-job publication period — September 28, 2026

Each café receives one lifetime free job post, visible for 30 days. A second distinct job requires verified active Pro. Editing, pausing, deleting, or reopening does not reset the allowance or its deadline. An expired first post also requires Pro to reopen. Existing free posts receive 30 days from rollout. Their applicants, matches, and conversations remain saved. Paid pricing and the three-active-job limit remain unchanged.
