create or replace function public.owner_business_analytics()
returns jsonb
language sql
security definer
set search_path = public
as $$
with
daily as (
  select d::date as day, count(t.id)::int as value
  from generate_series(current_date - 29, current_date, interval '1 day') d
  left join public.traffic_pageviews t
    on t.created_at >= d and t.created_at < d + interval '1 day'
  group by d order by d
),
top_pages as (
  select path as label, count(*)::int as value from public.traffic_pageviews
  where created_at >= now() - interval '30 days'
  group by path order by value desc limit 8
),
top_referrers as (
  select coalesce(referrer_host,'Direct / none') as label, count(*)::int as value
  from public.traffic_pageviews where created_at >= now() - interval '30 days'
  group by coalesce(referrer_host,'Direct / none') order by value desc limit 8
),
top_devices as (
  select device_type as label, count(*)::int as value from public.traffic_pageviews
  where created_at >= now() - interval '30 days'
  group by device_type order by value desc
)
select jsonb_build_object(
  'generated_at', now(),
  'metrics', jsonb_build_object(
    'signups',(select count(*) from public.profiles),
    'baristas',(select count(*) from public.profiles where role='barista'),
    'cafes',(select count(*) from public.profiles where role='cafe_owner_manager'),
    'jobs',(select count(*) from public.jobs),
    'active_jobs',(select count(*) from public.jobs where active=true),
    'matches',(select count(*) from public.applications where status='matched') + (select count(*) from public.discovery_matches),
    'messages',(select count(*) from public.messages) + (select count(*) from public.discovery_messages),
    'pageviews_30d',(select count(*) from public.traffic_pageviews where created_at >= now() - interval '30 days'),
    'pageviews_7d',(select count(*) from public.traffic_pageviews where created_at >= now() - interval '7 days')
  ),
  'daily',coalesce((select jsonb_agg(jsonb_build_object('date',day,'value',value) order by day) from daily),'[]'::jsonb),
  'top_pages',coalesce((select jsonb_agg(to_jsonb(top_pages)) from top_pages),'[]'::jsonb),
  'referrers',coalesce((select jsonb_agg(to_jsonb(top_referrers)) from top_referrers),'[]'::jsonb),
  'devices',coalesce((select jsonb_agg(to_jsonb(top_devices)) from top_devices),'[]'::jsonb)
);
$$;
revoke execute on function public.owner_business_analytics() from public, anon, authenticated;
grant execute on function public.owner_business_analytics() to service_role;
