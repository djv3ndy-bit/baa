alter table public.traffic_pageviews add column if not exists channel text not null default 'web';
alter table public.traffic_pageviews drop constraint if exists traffic_pageviews_device_type;
alter table public.traffic_pageviews add constraint traffic_pageviews_device_type check (device_type in ('mobile','tablet','desktop','ios','android'));
alter table public.traffic_pageviews add constraint traffic_pageviews_channel check (channel in ('web','app'));

create or replace function public.owner_business_analytics()
returns jsonb language sql security definer set search_path=public as $$
with weeks as (
  select generate_series(date_trunc('week',current_date)-interval '7 weeks',date_trunc('week',current_date),interval '1 week') week_start
), weekly as (
  select week_start::date,
    (select count(*) from public.traffic_pageviews t where t.channel='web' and t.created_at>=week_start and t.created_at<week_start+interval '1 week')::int website_views,
    (select count(*) from public.traffic_pageviews t where t.channel='app' and t.created_at>=week_start and t.created_at<week_start+interval '1 week')::int app_views,
    (select count(*) from public.profiles p where p.created_at>=week_start and p.created_at<week_start+interval '1 week')::int signups,
    (select count(*) from public.jobs j where j.created_at>=week_start and j.created_at<week_start+interval '1 week')::int jobs,
    ((select count(*) from public.applications a where a.status='matched' and a.created_at>=week_start and a.created_at<week_start+interval '1 week')+(select count(*) from public.discovery_matches d where d.created_at>=week_start and d.created_at<week_start+interval '1 week'))::int matches,
    ((select count(*) from public.messages m where m.created_at>=week_start and m.created_at<week_start+interval '1 week')+(select count(*) from public.discovery_messages m where m.created_at>=week_start and m.created_at<week_start+interval '1 week'))::int messages
  from weeks order by week_start
), top_pages as (
 select path label,count(*)::int value from public.traffic_pageviews where channel='web' and created_at>=now()-interval '30 days' group by path order by value desc limit 8
), app_screens as (
 select path label,count(*)::int value from public.traffic_pageviews where channel='app' and created_at>=now()-interval '30 days' group by path order by value desc limit 8
), top_referrers as (
 select coalesce(referrer_host,'Direct / none') label,count(*)::int value from public.traffic_pageviews where channel='web' and created_at>=now()-interval '30 days' group by coalesce(referrer_host,'Direct / none') order by value desc limit 8
), devices as (
 select case when channel='app' then upper(device_type)||' app' else initcap(device_type)||' web' end label,count(*)::int value from public.traffic_pageviews where created_at>=now()-interval '30 days' group by channel,device_type order by value desc
), role_mix as (select case role when 'barista' then 'Baristas' else 'Café owners' end label,count(*)::int value from public.profiles group by role order by value desc),
job_mix as (select case when active then 'Active jobs' else 'Closed jobs' end label,count(*)::int value from public.jobs group by active order by value desc),
support_mix as (select initcap(replace(status,'_',' ')) label,count(*)::int value from public.support_tickets group by status order by value desc)
select jsonb_build_object(
 'generated_at',now(),
 'metrics',jsonb_build_object(
  'signups',(select count(*) from public.profiles),'signups_7d',(select count(*) from public.profiles where created_at>=now()-interval '7 days'),'signups_prev_7d',(select count(*) from public.profiles where created_at>=now()-interval '14 days' and created_at<now()-interval '7 days'),
  'baristas',(select count(*) from public.profiles where role='barista'),'cafes',(select count(*) from public.profiles where role='cafe_owner_manager'),'discoverable',(select count(*) from public.profiles where is_discoverable=true and suspended_at is null),
  'jobs',(select count(*) from public.jobs),'active_jobs',(select count(*) from public.jobs where active=true),'jobs_7d',(select count(*) from public.jobs where created_at>=now()-interval '7 days'),
  'applications',(select count(*) from public.applications),'interests',(select count(*) from public.discovery_interests),'matches',(select count(*) from public.applications where status='matched')+(select count(*) from public.discovery_matches),
  'messages',(select count(*) from public.messages)+(select count(*) from public.discovery_messages),'messages_7d',(select count(*) from public.messages where created_at>=now()-interval '7 days')+(select count(*) from public.discovery_messages where created_at>=now()-interval '7 days'),
  'notifications',(select count(*) from public.notifications),'support_open',(select count(*) from public.support_tickets where status in ('new','in_progress','waiting_user')),'support_resolved',(select count(*) from public.support_tickets where status in ('resolved','closed')),
  'website_7d',(select count(*) from public.traffic_pageviews where channel='web' and created_at>=now()-interval '7 days'),'website_prev_7d',(select count(*) from public.traffic_pageviews where channel='web' and created_at>=now()-interval '14 days' and created_at<now()-interval '7 days'),
  'website_30d',(select count(*) from public.traffic_pageviews where channel='web' and created_at>=now()-interval '30 days'),'app_7d',(select count(*) from public.traffic_pageviews where channel='app' and created_at>=now()-interval '7 days'),'app_30d',(select count(*) from public.traffic_pageviews where channel='app' and created_at>=now()-interval '30 days')
 ),
 'weekly',coalesce((select jsonb_agg(to_jsonb(weekly) order by week_start) from weekly),'[]'::jsonb),
 'top_pages',coalesce((select jsonb_agg(to_jsonb(top_pages)) from top_pages),'[]'::jsonb),'app_screens',coalesce((select jsonb_agg(to_jsonb(app_screens)) from app_screens),'[]'::jsonb),'referrers',coalesce((select jsonb_agg(to_jsonb(top_referrers)) from top_referrers),'[]'::jsonb),'devices',coalesce((select jsonb_agg(to_jsonb(devices)) from devices),'[]'::jsonb),'role_mix',coalesce((select jsonb_agg(to_jsonb(role_mix)) from role_mix),'[]'::jsonb),'job_mix',coalesce((select jsonb_agg(to_jsonb(job_mix)) from job_mix),'[]'::jsonb),'support_mix',coalesce((select jsonb_agg(to_jsonb(support_mix)) from support_mix),'[]'::jsonb)
); $$;
revoke execute on function public.owner_business_analytics() from public,anon,authenticated;
grant execute on function public.owner_business_analytics() to service_role;
