-- Atomic MCP review payload; derived byte-for-byte from standalone inner body.
-- An inner statement_timeout is not an outer DO deadline; caller must bound execution.
do $androidQueue$
begin
  execute $androidQueueDDL$set local lock_timeout = '3s';
set local statement_timeout = '20s';
do $guard$
begin
  if current_user<>'postgres' or current_setting('server_version_num')::int/10000<>17 then
    raise exception 'ANDROID_QUEUE_EXECUTOR_OR_VERSION';
  end if;
  if (select count(*) from private.native_billing_configuration) <> 1
    or not exists(select 1 from private.native_billing_configuration where singleton and environment='Production') then
    raise exception 'ANDROID_PRODUCTION_QUEUE_REQUIRED';
  end if;
  if to_regclass('private.android_public_push_configuration') is not null
    or to_regclass('private.android_public_push_events') is not null
    or to_regclass('private.android_public_push_deliveries') is not null
    or to_regclass('private.android_public_push_cursors') is not null
    or to_regprocedure('public.android_public_push_poll(integer)') is not null
    or to_regprocedure('public.android_public_push_claim()') is not null
    or to_regprocedure('public.android_public_push_revalidate(uuid,uuid)') is not null
    or to_regprocedure('public.android_public_push_finish(uuid,uuid,text)') is not null
    or to_regprocedure('private.android_public_push_source(text,uuid)') is not null
    or to_regprocedure('private.android_public_push_initialize()') is not null then
    raise exception 'ANDROID_QUEUE_COLLISION';
  end if;
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where
    (n.nspname='public' and p.proname in ('android_public_push_poll','android_public_push_claim','android_public_push_revalidate','android_public_push_finish'))
    or (n.nspname='private' and p.proname in ('android_public_push_source','android_public_push_initialize'))) then
    raise exception 'ANDROID_QUEUE_FUNCTION_COLLISION';
  end if;
  if to_regclass('public.android_device_push_tokens') is null
    or to_regprocedure('private.members_are_blocked(uuid,uuid)') is null then raise exception 'ANDROID_TOKENS_OR_BLOCKS_REQUIRED'; end if;
end;
$guard$;
create table private.android_public_push_configuration(
 singleton boolean primary key default true check(singleton),
 observe_enabled boolean not null default false,
 dispatch_enabled boolean not null default false,
 baseline_at timestamptz,
 project_ref text not null default 'lmwqrxoitraofaftpwhe' check(project_ref='lmwqrxoitraofaftpwhe'),
 firebase_project_id text not null default 'baristamatch' check(firebase_project_id='baristamatch'),
 package_name text not null default 'com.baristajobmatch.app' check(package_name='com.baristajobmatch.app'),
 check(not dispatch_enabled or (observe_enabled and baseline_at is not null))
);
insert into private.android_public_push_configuration(singleton) values(true);
create table private.android_public_push_cursors(
 source_kind text primary key check(source_kind in ('notification','discovery_message')),
 last_id uuid,upper_id uuid,sweep_completed_at timestamptz
);
insert into private.android_public_push_cursors(source_kind) values('notification'),('discovery_message');
create table private.android_public_push_events(
 id uuid primary key default gen_random_uuid(),
 source_kind text not null check(source_kind in ('notification','discovery_message')),
 source_id uuid not null,
 recipient_id uuid,notification_type text,route text,
 state text not null check(state in ('baseline','queued','skipped')),
 observed_at timestamptz not null default statement_timestamp(),
 expires_at timestamptz not null default statement_timestamp()+interval '1 hour',
 unique(source_kind,source_id),
 check((state='queued' and recipient_id is not null and notification_type in ('application','match','message') and route is not null)
   or state in ('baseline','skipped'))
);
create table private.android_public_push_deliveries(
 id uuid primary key default gen_random_uuid(),
 event_id uuid not null references private.android_public_push_events(id) on delete cascade,
 recipient_id uuid not null,token_sha256 text not null check(token_sha256 ~ '^[0-9a-f]{64}$'),
 token_updated_at timestamptz not null,
 state text not null default 'pending' check(state in ('pending','leased','accepted','skipped','dead','invalid')),
 available_at timestamptz not null default statement_timestamp(),
 attempts integer not null default 0 check(attempts between 0 and 5),
 lease_id uuid,lease_until timestamptz,finished_at timestamptz,
 unique(event_id,token_sha256),
 check((state='leased' and lease_id is not null and lease_until is not null) or state<>'leased')
);
create index android_public_push_due_idx on private.android_public_push_deliveries(available_at,id) where state in ('pending','leased');
create index android_public_push_finished_idx on private.android_public_push_deliveries(finished_at) where finished_at is not null;
create index android_public_push_events_observed_idx on private.android_public_push_events(observed_at);
alter table private.android_public_push_configuration enable row level security;
alter table private.android_public_push_cursors enable row level security;
alter table private.android_public_push_events enable row level security;
alter table private.android_public_push_deliveries enable row level security;
revoke all on table private.android_public_push_configuration,private.android_public_push_cursors,
 private.android_public_push_events,private.android_public_push_deliveries from public,anon,authenticated,service_role;

-- Canonical relationships and current authorization, not caller payloads. Never
-- returns source body/name/email. Read/unread and block changes suppress sends.
-- Notification rows do not retain individual message IDs: deletion of a single
-- message is not attestable here; generic previews reveal no message contents.
create function private.android_public_push_source(p_kind text,p_id uuid)
returns table(recipient_id uuid,notification_type text,route text)
language sql stable security definer set search_path='' as $source$
 select n.recipient_id,n.type,
   case n.type when 'application' then '/candidates' when 'match' then '/matches'
     else '/chat/'||a.id::text||'?kind=application' end
 from public.notifications n join public.applications a on a.id=n.application_id
 join public.jobs j on j.id=a.job_id
 join public.profiles cafe on cafe.id=j.owner_id
 join public.profiles barista on barista.id=a.barista_id
 where p_kind='notification' and n.id=p_id and n.read_at is null
   and cafe.role='cafe_owner_manager' and barista.role='barista'
   and cafe.suspended_at is null and barista.suspended_at is null
   and not private.members_are_blocked(cafe.id,barista.id)
   and ((n.type='application' and a.status='interested' and n.recipient_id=cafe.id and n.actor_id=barista.id)
     or (n.type='match' and a.status='matched' and n.recipient_id=barista.id and n.actor_id=cafe.id)
     or (n.type='message' and a.status='matched' and ((n.recipient_id=cafe.id and n.actor_id=barista.id)
       or (n.recipient_id=barista.id and n.actor_id=cafe.id))))
 union all
 select n.recipient_id,'message','/chat/'||m.id::text||'?kind=discovery'
 from public.discovery_message_notifications n join public.discovery_matches m on m.id=n.discovery_match_id
 join public.profiles cafe on cafe.id=m.cafe_id
 join public.profiles barista on barista.id=m.barista_id
 where p_kind='discovery_message' and n.id=p_id and n.read_at is null
   and n.recipient_id in (cafe.id,barista.id) and cafe.role='cafe_owner_manager' and barista.role='barista'
   and cafe.suspended_at is null and barista.suspended_at is null
   and not private.members_are_blocked(cafe.id,barista.id);
$source$;
revoke all on function private.android_public_push_source(text,uuid) from public,anon,authenticated,service_role;

-- Owner-only explicit activation step. One INSERT statement snapshots BOTH
-- source families consistently. No created_at cursor and no historical blast.
-- Refuse an unreviewed inventory larger than 100,000 IDs. Caller may retry only
-- before activation; a second baseline would discard real pending work.
create function private.android_public_push_initialize() returns integer
language plpgsql security definer set search_path='' as $init$
declare affected integer;
begin
  perform 1 from private.android_public_push_configuration where singleton and not observe_enabled
    and not dispatch_enabled and baseline_at is null for update;
  if not found then raise exception 'ANDROID_BASELINE_ALREADY_INITIALIZED'; end if;
  insert into private.android_public_push_events(source_kind,source_id,state)
    select kind,id,'baseline' from (
      select 'notification'::text kind,id from public.notifications
      union all select 'discovery_message',id from public.discovery_message_notifications
    ) sources limit 100001;
  get diagnostics affected = row_count;
  if affected>100000 then raise exception 'ANDROID_BASELINE_TOO_LARGE'; end if;
  update private.android_public_push_configuration set baseline_at=statement_timestamp(),observe_enabled=true where singleton;
  return affected;
end;
$init$;
revoke all on function private.android_public_push_initialize() from public,anon,authenticated,service_role;

create function public.android_public_push_poll(p_limit integer default 200) returns jsonb
language plpgsql security definer set search_path='' as $poll$
declare cfg private.android_public_push_configuration%rowtype; c record; s record; eligible record;
 ev uuid; last_seen uuid; seen integer; total integer:=0; cap integer;
begin
  if p_limit is null or p_limit<1 or p_limit>200 then raise exception 'ANDROID_POLL_LIMIT'; end if;
  select * into cfg from private.android_public_push_configuration where singleton for update skip locked;
  if not found then return jsonb_build_object('ready',false); end if;
  if not cfg.observe_enabled or cfg.baseline_at is null then return jsonb_build_object('ready',false); end if;
  for c in select * from private.android_public_push_cursors order by source_kind for update loop
    if c.upper_id is null then
      if c.source_kind='notification' then select id into c.upper_id from public.notifications order by id desc limit 1;
      else select id into c.upper_id from public.discovery_message_notifications order by id desc limit 1; end if;
    end if;
    last_seen:=c.last_id;seen:=0;
    for s in select id from (
      select id from public.notifications where c.source_kind='notification'
      union all select id from public.discovery_message_notifications where c.source_kind='discovery_message'
    ) sources where (c.last_id is null or id>c.last_id) and id<=c.upper_id order by id limit p_limit loop
      seen:=seen+1;last_seen:=s.id;ev:=null;
      select * into eligible from private.android_public_push_source(c.source_kind,s.id);
      insert into private.android_public_push_events(source_kind,source_id,recipient_id,notification_type,route,state)
      values(c.source_kind,s.id,eligible.recipient_id,eligible.notification_type,eligible.route,
        case when eligible.recipient_id is null then 'skipped' else 'queued' end)
      on conflict(source_kind,source_id) do nothing returning id into ev;
      if ev is not null then
        total:=total+1;
        if eligible.recipient_id is not null then
          select count(*) into cap from (select 1 from public.android_device_push_tokens t where t.user_id=eligible.recipient_id
            and t.enabled and t.platform='android' and t.firebase_project_id='baristamatch' and t.package_name='com.baristajobmatch.app' limit 101) tokens;
          if cap>100 then
            update private.android_public_push_events set state='skipped' where id=ev;
          else
            insert into private.android_public_push_deliveries(event_id,recipient_id,token_sha256,token_updated_at)
              select ev,t.user_id,encode(sha256(convert_to(t.fcm_token,'UTF8')),'hex'),t.updated_at
              from public.android_device_push_tokens t where t.user_id=eligible.recipient_id and t.enabled
                and t.platform='android' and t.firebase_project_id='baristamatch' and t.package_name='com.baristajobmatch.app';
          end if;
        end if;
      end if;
    end loop;
    update private.android_public_push_cursors set last_id=case when seen<p_limit then null else last_seen end,
      upper_id=case when seen<p_limit then null else c.upper_id end,
      sweep_completed_at=case when seen<p_limit then statement_timestamp() else sweep_completed_at end where source_kind=c.source_kind;
  end loop;
  -- Bounded terminal retention. Raw tokens/bodies never enter these tables.
  delete from private.android_public_push_deliveries where id in (select id from private.android_public_push_deliveries
    where finished_at<statement_timestamp()-interval '7 days' order by finished_at limit 200);
  -- Keep dedup tombstones while any canonical source exists (including baseline).
  delete from private.android_public_push_events e where e.id in (select old.id from private.android_public_push_events old
    where old.observed_at<statement_timestamp()-interval '7 days'
      and not exists(select 1 from public.notifications n where old.source_kind='notification' and n.id=old.source_id)
      and not exists(select 1 from public.discovery_message_notifications n where old.source_kind='discovery_message' and n.id=old.source_id)
    order by old.observed_at limit 200);
  return jsonb_build_object('ready',cfg.dispatch_enabled,'observed',total);
end;
$poll$;
revoke all on function public.android_public_push_poll(integer) from public,anon,authenticated,service_role;
grant execute on function public.android_public_push_poll(integer) to service_role;

create function public.android_public_push_claim() returns jsonb
language plpgsql security definer set search_path='' as $claim$
declare d private.android_public_push_deliveries%rowtype; lease uuid:=gen_random_uuid();
begin
  if not exists(select 1 from private.android_public_push_configuration where singleton and observe_enabled and dispatch_enabled and baseline_at is not null) then return null; end if;
  -- Close abandoned final attempts/expired events before selecting fresh work.
  update private.android_public_push_deliveries set state='dead',finished_at=statement_timestamp(),lease_id=null,lease_until=null
    where id in (select q.id from private.android_public_push_deliveries q join private.android_public_push_events e on e.id=q.event_id
      where q.state in ('pending','leased') and (q.lease_until is null or q.lease_until<=statement_timestamp())
        and (q.attempts>=5 or e.expires_at<=statement_timestamp()) order by q.available_at limit 100 for update of q skip locked);
  select q.* into d from private.android_public_push_deliveries q join private.android_public_push_events e on e.id=q.event_id
    where q.state in ('pending','leased') and q.available_at<=statement_timestamp()
      and (q.lease_until is null or q.lease_until<=statement_timestamp()) and q.attempts<5 and e.expires_at>statement_timestamp()
    order by q.available_at,q.id limit 1 for update of q skip locked;
  if not found then return null; end if;
  update private.android_public_push_deliveries set state='leased',attempts=attempts+1,lease_id=lease,
    lease_until=statement_timestamp()+interval '60 seconds' where id=d.id;
  return jsonb_build_object('delivery_id',d.id,'lease_id',lease);
end;
$claim$;
revoke all on function public.android_public_push_claim() from public,anon,authenticated,service_role;
grant execute on function public.android_public_push_claim() to service_role;

create function public.android_public_push_revalidate(p_delivery_id uuid,p_lease_id uuid) returns jsonb
language sql stable security definer set search_path='' as $valid$
 select jsonb_build_object('fcm_token',t.fcm_token,'recipient_id',d.recipient_id,'notification_type',e.notification_type,'route',e.route,'source_id',e.source_id)
 from private.android_public_push_deliveries d join private.android_public_push_events e on e.id=d.event_id
 cross join lateral private.android_public_push_source(e.source_kind,e.source_id) source
 join public.android_device_push_tokens t on t.user_id=d.recipient_id
   and encode(sha256(convert_to(t.fcm_token,'UTF8')),'hex')=d.token_sha256 and t.updated_at=d.token_updated_at
 where d.id=p_delivery_id and d.lease_id=p_lease_id and d.state='leased' and d.lease_until>statement_timestamp()
   and e.expires_at>statement_timestamp() and e.state='queued'
   and source.recipient_id=d.recipient_id and source.notification_type=e.notification_type and source.route=e.route
   and t.enabled and t.platform='android' and t.firebase_project_id='baristamatch' and t.package_name='com.baristajobmatch.app'
   and exists(select 1 from private.android_public_push_configuration where singleton and observe_enabled and dispatch_enabled and baseline_at is not null);
$valid$;
revoke all on function public.android_public_push_revalidate(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.android_public_push_revalidate(uuid,uuid) to service_role;

create function public.android_public_push_finish(p_delivery_id uuid,p_lease_id uuid,p_outcome text) returns boolean
language plpgsql security definer set search_path='' as $finish$
declare d private.android_public_push_deliveries%rowtype;
begin
  if p_outcome is null or p_outcome not in ('accepted','retry','skipped','dead','invalid') then raise exception 'ANDROID_FINISH_OUTCOME'; end if;
  select * into d from private.android_public_push_deliveries where id=p_delivery_id and lease_id=p_lease_id
    and state='leased' and lease_until>statement_timestamp() for update;
  if not found then return false; end if;
  if p_outcome='invalid' then
    -- Never disable a registration reassigned/refreshed after the failed send.
    update public.android_device_push_tokens t set enabled=false where t.user_id=d.recipient_id
      and encode(sha256(convert_to(t.fcm_token,'UTF8')),'hex')=d.token_sha256 and t.updated_at=d.token_updated_at
      and t.enabled and t.platform='android' and t.firebase_project_id='baristamatch' and t.package_name='com.baristajobmatch.app';
  end if;
  update private.android_public_push_deliveries set state=case when p_outcome='retry' and attempts<5 then 'pending'
      when p_outcome='retry' then 'dead' else p_outcome end,
    available_at=statement_timestamp()+make_interval(secs=>least(600,30*(2^(attempts-1))::integer)),
    lease_id=null,lease_until=null,
    finished_at=case when p_outcome='retry' and attempts<5 then null else statement_timestamp() end where id=d.id;
  return true;
end;
$finish$;
revoke all on function public.android_public_push_finish(uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.android_public_push_finish(uuid,uuid,text) to service_role;
$androidQueueDDL$;
end;
$androidQueue$;
