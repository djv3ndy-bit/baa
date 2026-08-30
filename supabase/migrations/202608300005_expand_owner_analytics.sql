create or replace function public.owner_business_analytics()
returns jsonb language sql security definer set search_path=public as $$
with days as (
  select d::date as metric_date from generate_series(current_date-29,current_date,interval '1 day') d
), daily as (
  select metric_date,
    (select count(*) from public.traffic_pageviews t where t.created_at>=metric_date and t.created_at<metric_date+interval '1 day')::int pageviews,
    (select count(*) from public.profiles p where p.created_at>=metric_date and p.created_at<metric_date+interval '1 day')::int signups,
    (select count(*) from public.jobs j where j.created_at>=metric_date and j.created_at<metric_date+interval '1 day')::int jobs,
    ((select count(*) from public.messages m where m.created_at>=metric_date and m.created_at<metric_date+interval '1 day')+
     (select count(*) from public.discovery_messages m where m.created_at>=metric_date and m.created_at<metric_date+interval '1 day'))::int messages
  from days order by metric_date
), top_pages as (
  select path label,count(*)::int value from public.traffic_pageviews where created_at>=now()-interval '30 days' group by path order by value desc limit 8
), top_referrers as (
  select coalesce(referrer_host,'Direct / none') label,count(*)::int value from public.traffic_pageviews where created_at>=now()-interval '30 days' group by coalesce(referrer_host,'Direct / none') order by value desc limit 8
), top_devices as (
  select device_type label,count(*)::int value from public.traffic_pageviews where created_at>=now()-interval '30 days' group by device_type order by value desc
), role_mix as (
  select case role when 'barista' then 'Baristas' else 'Café owners' end label,count(*)::int value from public.profiles group by role order by value desc
), job_mix as (
  select case when active then 'Active jobs' else 'Closed jobs' end label,count(*)::int value from public.jobs group by active order by value desc
), support_mix as (
  select initcap(replace(status,'_',' ')) label,count(*)::int value from public.support_tickets group by status order by value desc
)
select jsonb_build_object(
 'generated_at',now(),
 'metrics',jsonb_build_object(
  'signups',(select count(*) from public.profiles),
  'signups_7d',(select count(*) from public.profiles where created_at>=now()-interval '7 days'),
  'baristas',(select count(*) from public.profiles where role='barista'),
  'cafes',(select count(*) from public.profiles where role='cafe_owner_manager'),
  'discoverable',(select count(*) from public.profiles where is_discoverable=true and suspended_at is null),
  'jobs',(select count(*) from public.jobs),
  'active_jobs',(select count(*) from public.jobs where active=true),
  'jobs_7d',(select count(*) from public.jobs where created_at>=now()-interval '7 days'),
  'applications',(select count(*) from public.applications),
  'interests',(select count(*) from public.discovery_interests),
  'matches',(select count(*) from public.applications where status='matched')+(select count(*) from public.discovery_matches),
  'messages',(select count(*) from public.messages)+(select count(*) from public.discovery_messages),
  'messages_7d',(select count(*) from public.messages where created_at>=now()-interval '7 days')+(select count(*) from public.discovery_messages where created_at>=now()-interval '7 days'),
  'notifications',(select count(*) from public.notifications),
  'support_open',(select count(*) from public.support_tickets where status in ('new','in_progress','waiting_user')),
  'support_resolved',(select count(*) from public.support_tickets where status in ('resolved','closed')),
  'pageviews_today',(select count(*) from public.traffic_pageviews where created_at>=current_date),
  'pageviews_7d',(select count(*) from public.traffic_pageviews where created_at>=now()-interval '7 days'),
  'pageviews_30d',(select count(*) from public.traffic_pageviews where created_at>=now()-interval '30 days')
 ),
 'daily',coalesce((select jsonb_agg(jsonb_build_object('date',metric_date,'pageviews',pageviews,'signups',signups,'jobs',jobs,'messages',messages) order by metric_date) from daily),'[]'::jsonb),
 'top_pages',coalesce((select jsonb_agg(to_jsonb(top_pages)) from top_pages),'[]'::jsonb),
 'referrers',coalesce((select jsonb_agg(to_jsonb(top_referrers)) from top_referrers),'[]'::jsonb),
 'devices',coalesce((select jsonb_agg(to_jsonb(top_devices)) from top_devices),'[]'::jsonb),
 'role_mix',coalesce((select jsonb_agg(to_jsonb(role_mix)) from role_mix),'[]'::jsonb),
 'job_mix',coalesce((select jsonb_agg(to_jsonb(job_mix)) from job_mix),'[]'::jsonb),
 'support_mix',coalesce((select jsonb_agg(to_jsonb(support_mix)) from support_mix),'[]'::jsonb)
); $$;
revoke execute on function public.owner_business_analytics() from public,anon,authenticated;
grant execute on function public.owner_business_analytics() to service_role;
