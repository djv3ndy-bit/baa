create table if not exists public.subscription_payments (
  id uuid primary key default gen_random_uuid(),
  cafe_user_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null default 'stripe',
  provider_payment_id text unique,
  amount_cents integer not null check (amount_cents>=0),
  currency text not null default 'usd',
  status text not null check (status in ('pending','succeeded','failed','refunded')),
  paid_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.subscription_payments enable row level security;
drop policy if exists "No client access to subscription payments" on public.subscription_payments;
create policy "No client access to subscription payments" on public.subscription_payments for all using (false) with check (false);
revoke all on public.subscription_payments from anon,authenticated;

create or replace function public.owner_subscription_analytics()
returns jsonb language sql security definer set search_path=public as $$
with account_rows as (
 select coalesce(nullif(p.cafe_name,''),nullif(p.display_name,''),'Unnamed café') name,
  coalesce(nullif(p.location,''),'Location not added') location,
  s.status,s.trial_started_at,s.trial_ends_at,s.current_period_end,s.cancel_at_period_end,
  (s.stripe_subscription_id is not null) connected_to_billing,
  case when s.status='active' and s.stripe_subscription_id is not null then 999 else 0 end monthly_cents
 from public.cafe_subscriptions s join public.profiles p on p.id=s.user_id
 order by s.created_at desc
), weeks as (
 select generate_series(date_trunc('week',current_date)-interval '7 weeks',date_trunc('week',current_date),interval '1 week') week_start
), revenue_weekly as (
 select week_start::date,
  coalesce((select sum(amount_cents) from public.subscription_payments sp where sp.status='succeeded' and sp.paid_at>=week_start and sp.paid_at<week_start+interval '1 week'),0)::int collected_cents
 from weeks order by week_start
)
select jsonb_build_object(
 'price_cents',999,
 'processor_connected',exists(select 1 from public.cafe_subscriptions where stripe_subscription_id is not null),
 'metrics',jsonb_build_object(
  'trialing',(select count(*) from public.cafe_subscriptions where status='trialing'),
  'active_paid',(select count(*) from public.cafe_subscriptions where status='active' and stripe_subscription_id is not null),
  'past_due',(select count(*) from public.cafe_subscriptions where status='past_due'),
  'canceling',(select count(*) from public.cafe_subscriptions where cancel_at_period_end=true),
  'ended',(select count(*) from public.cafe_subscriptions where status in ('canceled','expired')),
  'trials_ending_30d',(select count(*) from public.cafe_subscriptions where status='trialing' and trial_ends_at between now() and now()+interval '30 days'),
  'mrr_cents',(select coalesce(sum(monthly_cents),0) from account_rows),
  'arr_cents',(select coalesce(sum(monthly_cents),0)*12 from account_rows),
  'collected_cents',(select coalesce(sum(amount_cents),0) from public.subscription_payments where status='succeeded'),
  'refunded_cents',(select coalesce(sum(amount_cents),0) from public.subscription_payments where status='refunded')
 ),
 'accounts',coalesce((select jsonb_agg(to_jsonb(account_rows)) from account_rows),'[]'::jsonb),
 'weekly_revenue',coalesce((select jsonb_agg(to_jsonb(revenue_weekly) order by week_start) from revenue_weekly),'[]'::jsonb)
); $$;
revoke execute on function public.owner_subscription_analytics() from public,anon,authenticated;
grant execute on function public.owner_subscription_analytics() to service_role;
