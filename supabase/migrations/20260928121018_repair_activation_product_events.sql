-- The live table already has metadata, but older schemas/fixtures do not.
-- Add it without changing existing values, table grants, or insert-only RLS.
set local lock_timeout = '3s';

alter table public.product_events
  add column if not exists metadata jsonb not null default '{}'::jsonb;

-- A completion is once per account, including duplicate callback delivery,
-- setup retries, and app restarts. Other funnel events remain repeatable.
-- If historical duplicates exist, fail safely for review; never delete events.
create unique index if not exists product_events_signup_completed_user_idx
  on public.product_events (user_id)
  where event_name = 'signup_completed';

notify pgrst, 'reload schema';
