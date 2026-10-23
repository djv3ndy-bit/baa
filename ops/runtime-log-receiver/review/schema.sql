-- REVIEW DRAFT ONLY. Not a migration; never applied to a hosted database.
-- Generate a canonical migration with `supabase migration new` after approval.
-- Deliberately fails on existing objects: do not replace/reset an active feed.
-- No customer/auth/application tables, extensions, jobs or credentials changed.
begin;

create schema ops_monitoring;
revoke all on schema ops_monitoring from public, anon, authenticated;
grant usage on schema ops_monitoring to service_role;

create table ops_monitoring.runtime_ingest_keys (
  token_digest text primary key check (token_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  check (expires_at > created_at)
);
-- Digests provisioned privately only after owner approval. No raw tokens stored.
create table ops_monitoring.runtime_state (
  id smallint primary key check (id = 1),
  coverage_started_at timestamptz,
  last_delivery_at timestamptz,
  truncated boolean not null default false,
  event_count integer not null default 0 check (event_count between 0 and 100000),
  delivery_count integer not null default 0 check (delivery_count between 0 and 10000)
);
insert into ops_monitoring.runtime_state (id) values (1);

create table ops_monitoring.runtime_events (
  event_key text primary key check (event_key ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz not null check (pg_catalog.isfinite(occurred_at)),
  category text not null check (category in ('runtime_fatal','runtime_error','http_5xx','runtime_ok'))
);
create index runtime_events_occurred_at_idx on ops_monitoring.runtime_events (occurred_at);
create table ops_monitoring.runtime_deliveries (
  delivery_digest text primary key check (delivery_digest ~ '^[0-9a-f]{64}$'),
  received_at timestamptz not null
);
create index runtime_deliveries_received_at_idx on ops_monitoring.runtime_deliveries (received_at);

alter table ops_monitoring.runtime_ingest_keys enable row level security;
alter table ops_monitoring.runtime_ingest_keys force row level security;
alter table ops_monitoring.runtime_state enable row level security;
alter table ops_monitoring.runtime_state force row level security;
alter table ops_monitoring.runtime_events enable row level security;
alter table ops_monitoring.runtime_events force row level security;
alter table ops_monitoring.runtime_deliveries enable row level security;
alter table ops_monitoring.runtime_deliveries force row level security;
create policy service_only on ops_monitoring.runtime_ingest_keys to service_role using (true) with check (true);
create policy service_only on ops_monitoring.runtime_state to service_role using (true) with check (true);
create policy service_only on ops_monitoring.runtime_events to service_role using (true) with check (true);
create policy service_only on ops_monitoring.runtime_deliveries to service_role using (true) with check (true);
revoke all on all tables in schema ops_monitoring from public, anon, authenticated;
grant select on ops_monitoring.runtime_ingest_keys to service_role;
grant select, update on ops_monitoring.runtime_state to service_role;
grant select, insert, delete on ops_monitoring.runtime_events, ops_monitoring.runtime_deliveries to service_role;

-- A separately approved cron job calls this fixed private maintenance function.
-- Invoker only; serializes with ingest so counters/caps stay exact.
create function ops_monitoring.prune_runtime() returns void
language plpgsql security invoker set search_path = '' as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_events integer;
  v_deliveries integer;
begin
  perform 1 from ops_monitoring.runtime_state where id = 1 for update;
  delete from ops_monitoring.runtime_events where occurred_at < v_now - interval '24 hours';
  get diagnostics v_events = row_count;
  delete from ops_monitoring.runtime_deliveries where received_at < v_now - interval '24 hours';
  get diagnostics v_deliveries = row_count;
  update ops_monitoring.runtime_state
    set event_count = event_count - v_events, delivery_count = delivery_count - v_deliveries
    where id = 1;
end;
$$;
revoke all on function ops_monitoring.prune_runtime() from public, anon, authenticated;
grant execute on function ops_monitoring.prune_runtime() to service_role;

create function public.era_runtime_ingest(
  p_token_digest text, p_delivery_digest text, p_events jsonb
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_state ops_monitoring.runtime_state%rowtype;
  v_event jsonb;
  v_time timestamptz;
  v_new integer;
  v_inserted integer;
  v_fresh boolean;
begin
  if p_token_digest is null or not exists (
    select 1 from ops_monitoring.runtime_ingest_keys
    where token_digest = p_token_digest and revoked_at is null and expires_at > v_now
  ) then return pg_catalog.jsonb_build_object('authorized',false); end if;

  if p_delivery_digest is null or p_delivery_digest !~ '^[0-9a-f]{64}$'
     or p_events is null or pg_catalog.jsonb_typeof(p_events) <> 'array'
     or pg_catalog.jsonb_array_length(p_events) > 5000
     or pg_catalog.octet_length(p_events::text) > 1048576 then
    update ops_monitoring.runtime_state set truncated = true, coverage_started_at = null where id = 1;
    return pg_catalog.jsonb_build_object('authorized',true,'accepted',false,'status','invalid_batch');
  end if;
  for v_event in select value from pg_catalog.jsonb_array_elements(p_events) loop
    if pg_catalog.jsonb_typeof(v_event) <> 'object'
       or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(v_event)) <> 3
       or not (v_event ?& array['event_key','occurred_at','category'])
       or pg_catalog.jsonb_typeof(v_event->'event_key') <> 'string'
       or (v_event->>'event_key') !~ '^[0-9a-f]{64}$'
       or pg_catalog.jsonb_typeof(v_event->'category') <> 'string'
       or (v_event->>'category') not in ('runtime_fatal','runtime_error','http_5xx','runtime_ok')
       or pg_catalog.jsonb_typeof(v_event->'occurred_at') <> 'string'
       or (v_event->>'occurred_at') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' then
      update ops_monitoring.runtime_state set truncated = true, coverage_started_at = null where id = 1;
      return pg_catalog.jsonb_build_object('authorized',true,'accepted',false,'status','invalid_batch');
    end if;
    begin
      v_time := (v_event->>'occurred_at')::timestamptz;
    exception when invalid_datetime_format or datetime_field_overflow then
      update ops_monitoring.runtime_state set truncated = true, coverage_started_at = null where id = 1;
      return pg_catalog.jsonb_build_object('authorized',true,'accepted',false,'status','invalid_batch');
    end;
    if pg_catalog.to_char(v_time at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> v_event->>'occurred_at'
       or v_time < v_now - interval '24 hours' or v_time > v_now + interval '60 seconds' then
      update ops_monitoring.runtime_state set truncated = true, coverage_started_at = null where id = 1;
      return pg_catalog.jsonb_build_object('authorized',true,'accepted',false,'status','invalid_batch');
    end if;
  end loop;
  if (select pg_catalog.count(*) <> pg_catalog.count(distinct value->>'event_key')
      from pg_catalog.jsonb_array_elements(p_events)) then
    update ops_monitoring.runtime_state set truncated = true, coverage_started_at = null where id = 1;
    return pg_catalog.jsonb_build_object('authorized',true,'accepted',false,'status','invalid_batch');
  end if;

  -- Side-effect-free registered-key probe after Edge verifies full raw HMAC.
  -- No retention prune, delivery row, counter, gap or heartbeat writes.
  if pg_catalog.jsonb_array_length(p_events) = 0 then
    return pg_catalog.jsonb_build_object('authorized',true,'accepted',true,'duplicate',false,'inserted_events',0);
  end if;
  perform ops_monitoring.prune_runtime();
  select * into strict v_state from ops_monitoring.runtime_state where id = 1 for update;
  -- Do not backdate a heartbeat when a concurrent ingest waited for this lock.
  v_now := pg_catalog.clock_timestamp();
  if not exists (select 1 from ops_monitoring.runtime_ingest_keys
    where token_digest = p_token_digest and revoked_at is null and expires_at > v_now) then
    return pg_catalog.jsonb_build_object('authorized',false);
  end if;
  if exists (select 1 from ops_monitoring.runtime_deliveries where delivery_digest = p_delivery_digest) then
    return pg_catalog.jsonb_build_object('authorized',true,'accepted',true,'duplicate',true,'inserted_events',0);
  end if;
  -- A reused event key with conflicting data cannot silently hide another error.
  if exists (select 1 from pg_catalog.jsonb_array_elements(p_events) as b(e)
    join ops_monitoring.runtime_events as r on r.event_key = b.e->>'event_key'
    where r.category <> b.e->>'category' or r.occurred_at <> (b.e->>'occurred_at')::timestamptz) then
    update ops_monitoring.runtime_state set truncated = true, coverage_started_at = null where id = 1;
    return pg_catalog.jsonb_build_object('authorized',true,'accepted',false,'status','invalid_batch');
  end if;
  select pg_catalog.count(*)::integer,
    coalesce(pg_catalog.bool_or((b.e->>'occurred_at')::timestamptz >= v_now - interval '15 minutes'),false)
    into v_new,v_fresh
    from pg_catalog.jsonb_array_elements(p_events) as b(e)
    where not exists (select 1 from ops_monitoring.runtime_events as r where r.event_key = b.e->>'event_key');
  if v_state.event_count + v_new > 100000 or v_state.delivery_count + 1 > 10000 then
    update ops_monitoring.runtime_state set truncated = true, coverage_started_at = null where id = 1;
    return pg_catalog.jsonb_build_object('authorized',true,'accepted',false,'status','capacity_exceeded');
  end if;
  insert into ops_monitoring.runtime_deliveries (delivery_digest,received_at) values (p_delivery_digest,v_now);
  insert into ops_monitoring.runtime_events (event_key,occurred_at,category)
    select b.e->>'event_key',(b.e->>'occurred_at')::timestamptz,b.e->>'category'
    from pg_catalog.jsonb_array_elements(p_events) as b(e)
    on conflict (event_key) do nothing;
  get diagnostics v_inserted = row_count;
  update ops_monitoring.runtime_state set
    event_count = event_count + v_inserted, delivery_count = delivery_count + 1,
    coverage_started_at = case when v_fresh and
      (coverage_started_at is null or truncated or last_delivery_at < v_now - interval '15 minutes')
      then v_now else coverage_started_at end,
    last_delivery_at = case when v_fresh then v_now else last_delivery_at end,
    truncated = case when v_fresh then false else truncated end
    where id = 1;
  return pg_catalog.jsonb_build_object('authorized',true,'accepted',true,'duplicate',false,'inserted_events',v_inserted);
end;
$$;
revoke all on function public.era_runtime_ingest(text,text,jsonb) from public, anon, authenticated;
grant execute on function public.era_runtime_ingest(text,text,jsonb) to service_role;

-- Edge verifies GitHub OIDC first; no read token/digest is provisioned.
create function public.era_runtime_summary(p_since timestamptz,p_until timestamptz)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_state ops_monitoring.runtime_state%rowtype;
  v_counts jsonb;
begin
  if p_since is null or p_until is null or not pg_catalog.isfinite(p_since) or not pg_catalog.isfinite(p_until)
    or p_since >= p_until or p_until - p_since > interval '2 hours'
    or p_since < v_now - interval '24 hours' or p_until > v_now + interval '60 seconds' then
    return pg_catalog.jsonb_build_object('status','invalid_window');
  end if;
  -- Same lock as ingest: counts and heartbeat represent one coherent snapshot.
  select * into strict v_state from ops_monitoring.runtime_state where id = 1 for share;
  select pg_catalog.jsonb_build_object(
    'runtime_fatal',pg_catalog.count(*) filter (where category = 'runtime_fatal'),
    'runtime_error',pg_catalog.count(*) filter (where category = 'runtime_error'),
    'http_5xx',pg_catalog.count(*) filter (where category = 'http_5xx'),
    'runtime_ok',pg_catalog.count(*) filter (where category = 'runtime_ok')
  ) into v_counts from ops_monitoring.runtime_events where occurred_at >= p_since and occurred_at < p_until;
  return pg_catalog.jsonb_build_object(
    'schema_version',1,'project_id','prj_VuAxQpdhDJPeTPdanA5HjtOrylA5','environment','production',
    'window',pg_catalog.jsonb_build_object(
      'since',pg_catalog.to_char(p_since at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'until',pg_catalog.to_char(p_until at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
    'counts',v_counts,
    'coverage_started_at',pg_catalog.to_char(v_state.coverage_started_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'last_delivery_at',pg_catalog.to_char(v_state.last_delivery_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'complete',coalesce(v_state.coverage_started_at <= p_since
      and v_state.last_delivery_at >= v_now - interval '15 minutes'
      and v_state.last_delivery_at >= p_until - interval '15 minutes'
      and p_until <= v_now and not v_state.truncated
      and exists (select 1 from ops_monitoring.runtime_ingest_keys where revoked_at is null and expires_at > v_now),false),
    'truncated',v_state.truncated
  );
end;
$$;
revoke all on function public.era_runtime_summary(timestamptz,timestamptz) from public, anon, authenticated;
grant execute on function public.era_runtime_summary(timestamptz,timestamptz) to service_role;
commit;
