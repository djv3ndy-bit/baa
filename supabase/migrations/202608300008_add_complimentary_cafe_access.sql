alter table public.cafe_subscriptions add column if not exists complimentary_access boolean not null default false;

create or replace function public.cafe_has_hiring_access(target_user_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
 select case when coalesce((select role from public.profiles where id=target_user_id),'')<>'cafe_owner_manager' then true else exists(
  select 1 from public.cafe_subscriptions s where s.user_id=target_user_id and (
   s.complimentary_access=true or s.status='active' or (s.status='trialing' and s.trial_ends_at>now())
  ))
 end;
$$;
revoke execute on function public.cafe_has_hiring_access(uuid) from public,anon;
grant execute on function public.cafe_has_hiring_access(uuid) to authenticated,service_role;

alter policy "Participants can update relevant applications" on public.applications
 using ((barista_id=(select auth.uid())) or exists(select 1 from public.jobs j where j.id=applications.job_id and j.owner_id=(select auth.uid())))
 with check ((((barista_id=(select auth.uid())) and status='withdrawn') or exists(select 1 from public.jobs j where j.id=applications.job_id and j.owner_id=(select auth.uid()))) and public.cafe_has_hiring_access((select auth.uid())));
alter policy "Members can send valid discovery interests" on public.discovery_interests
 with check (((select auth.uid())=sender_id) and public.cafe_has_hiring_access(sender_id) and exists(select 1 from public.profiles sender join public.profiles target on target.id=discovery_interests.target_id where sender.id=discovery_interests.sender_id and sender.is_discoverable=true and target.is_discoverable=true and sender.suspended_at is null and target.suspended_at is null and ((sender.role='barista' and target.role='cafe_owner_manager') or (sender.role='cafe_owner_manager' and target.role='barista'))));
alter policy "Participants can create mutual discovery matches" on public.discovery_matches
 with check ((((select auth.uid())=barista_id or (select auth.uid())=cafe_id) and public.cafe_has_hiring_access((select auth.uid())) and exists(select 1 from public.profiles b join public.profiles c on c.id=discovery_matches.cafe_id where b.id=discovery_matches.barista_id and b.role='barista' and c.role='cafe_owner_manager' and b.suspended_at is null and c.suspended_at is null) and exists(select 1 from public.discovery_interests i where i.sender_id=discovery_matches.barista_id and i.target_id=discovery_matches.cafe_id) and exists(select 1 from public.discovery_interests i where i.sender_id=discovery_matches.cafe_id and i.target_id=discovery_matches.barista_id)));
alter policy "matched users can send messages" on public.messages
 with check ((sender_id=auth.uid()) and public.cafe_has_hiring_access(auth.uid()) and exists(select 1 from public.applications a join public.jobs j on j.id=a.job_id where a.id=messages.application_id and a.status='matched' and (auth.uid()=a.barista_id or auth.uid()=j.owner_id)));
alter policy "Matched members can send discovery messages" on public.discovery_messages
 with check ((sender_id=(select auth.uid())) and public.cafe_has_hiring_access((select auth.uid())) and exists(select 1 from public.discovery_matches m where m.id=discovery_messages.match_id and ((select auth.uid())=m.barista_id or (select auth.uid())=m.cafe_id)));

create or replace function public.owner_membership_controls()
returns jsonb language sql security definer set search_path=public as $$
select jsonb_build_object(
 'complimentary_count',(select count(*) from public.cafe_subscriptions where complimentary_access=true),
 'accounts',coalesce((select jsonb_agg(jsonb_build_object(
  'user_id',s.user_id,'name',coalesce(nullif(p.cafe_name,''),nullif(p.display_name,''),'Unnamed café'),'location',coalesce(nullif(p.location,''),'Location not added'),
  'status',s.status,'trial_ends_at',s.trial_ends_at,'current_period_end',s.current_period_end,'cancel_at_period_end',s.cancel_at_period_end,
  'connected_to_billing',(s.stripe_subscription_id is not null),'monthly_cents',case when s.status='active' and s.stripe_subscription_id is not null then 999 else 0 end,
  'complimentary_access',s.complimentary_access
 ) order by s.created_at desc) from public.cafe_subscriptions s join public.profiles p on p.id=s.user_id),'[]'::jsonb)
); $$;
revoke execute on function public.owner_membership_controls() from public,anon,authenticated;
grant execute on function public.owner_membership_controls() to service_role;
