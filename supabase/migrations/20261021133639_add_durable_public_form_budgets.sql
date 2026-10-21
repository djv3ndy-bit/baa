-- Server-only shared budgets for anonymous website forms. The caller supplies
-- HMAC-SHA256 identifiers; raw addresses, email, and form contents never belong
-- in this table. Apply this migration before enabling the website guards.
create schema if not exists private;

create table if not exists private.public_form_budgets (
  bucket_key text primary key check (bucket_key ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz not null,
  expires_at timestamptz not null,
  request_count integer not null check (request_count between 0 and 10000),
  check (expires_at > window_started_at)
);

create index if not exists public_form_budgets_expiry_idx
  on private.public_form_budgets (expires_at, bucket_key);

alter table private.public_form_budgets enable row level security;
revoke all on table private.public_form_budgets from public, anon, authenticated, service_role;

comment on table private.public_form_budgets is
  'Private fixed-window website abuse counters keyed only by server HMAC digests. Access is through a service-only RPC.';

create or replace function public.consume_public_form_budget(p_buckets jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '1s'
as $function$
declare
  entry jsonb;
  counter private.public_form_budgets%rowtype;
  observed_at timestamptz;
  window_start timestamptz;
  window_end timestamptz;
  limit_count integer;
  window_size integer;
  used_count integer;
  retry_seconds integer := 0;
  allowed boolean := true;
begin
  if p_buckets is null or pg_catalog.jsonb_typeof(p_buckets) <> 'array' then
    raise exception 'Invalid public form budgets' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(p_buckets) not between 1 and 8 then
    raise exception 'Invalid public form budgets' using errcode = '22023';
  end if;

  for entry in select value from pg_catalog.jsonb_array_elements(p_buckets) loop
    if pg_catalog.jsonb_typeof(entry) <> 'object' then
      raise exception 'Invalid public form budgets' using errcode = '22023';
    end if;
    if entry - array['bucket_key', 'max_requests', 'window_seconds'] <> '{}'::jsonb
       or pg_catalog.jsonb_typeof(entry->'bucket_key') is distinct from 'string'
       or (entry->>'bucket_key') !~ '^[0-9a-f]{64}$'
       or pg_catalog.jsonb_typeof(entry->'max_requests') is distinct from 'number'
       or (entry->>'max_requests') !~ '^[1-9][0-9]{0,4}$'
       or pg_catalog.jsonb_typeof(entry->'window_seconds') is distinct from 'number'
       or (entry->>'window_seconds') !~ '^[1-9][0-9]{0,4}$' then
      raise exception 'Invalid public form budgets' using errcode = '22023';
    end if;
    if (entry->>'max_requests')::integer > 10000
       or (entry->>'window_seconds')::integer > 86400 then
      raise exception 'Invalid public form budgets' using errcode = '22023';
    end if;
  end loop;
  if (select pg_catalog.count(distinct value->>'bucket_key')
      from pg_catalog.jsonb_array_elements(p_buckets)) <> pg_catalog.jsonb_array_length(p_buckets) then
    raise exception 'Duplicate public form budget' using errcode = '22023';
  end if;

  -- The subtransaction rolls back every insertion/reset/increment on denial.
  -- A blocked IP therefore cannot create persistent counters for fresh emails.
  begin
    -- Every worker acquires row/unique-index locks in the same key order. An
    -- UPSERT also locks a bucket that did not exist when this request started.
    -- A stuck transaction fails closed after one second of waiting per lock.
    for entry in
      select value from pg_catalog.jsonb_array_elements(p_buckets)
      order by value->>'bucket_key' collate "C"
    loop
      insert into private.public_form_budgets (bucket_key, window_started_at, expires_at, request_count)
      values (entry->>'bucket_key', 'epoch'::timestamptz, 'epoch'::timestamptz + interval '1 second', 0)
      on conflict (bucket_key) do update set bucket_key = excluded.bucket_key;
    end loop;

    -- Read the clock after waiting for all locks, so a request crossing a window
    -- boundary cannot use a stale timestamp. Epoch-aligned windows need no jobs.
    observed_at := pg_catalog.clock_timestamp();
    for entry in select value from pg_catalog.jsonb_array_elements(p_buckets) loop
      limit_count := (entry->>'max_requests')::integer;
      select * into strict counter from private.public_form_budgets
      where bucket_key = entry->>'bucket_key';
      used_count := case when counter.expires_at <= observed_at then 0 else counter.request_count end;
      if used_count >= limit_count then
        retry_seconds := greatest(retry_seconds,
          pg_catalog.ceil(extract(epoch from counter.expires_at - observed_at))::integer, 1);
      end if;
    end loop;
    if retry_seconds > 0 then
      raise exception 'Public form budget exhausted' using errcode = 'P0429';
    end if;

    for entry in select value from pg_catalog.jsonb_array_elements(p_buckets) loop
      window_size := (entry->>'window_seconds')::integer;
      window_start := pg_catalog.to_timestamp(
        pg_catalog.floor(extract(epoch from observed_at) / window_size) * window_size
      );
      window_end := window_start + pg_catalog.make_interval(secs => window_size);
      update private.public_form_budgets
      set request_count = case when expires_at <= observed_at then 1 else request_count + 1 end,
          window_started_at = case when expires_at <= observed_at then window_start else window_started_at end,
          expires_at = case when expires_at <= observed_at then window_end else expires_at end
      where bucket_key = entry->>'bucket_key';
    end loop;
  exception when sqlstate 'P0429' then
    allowed := false;
  end;

  -- Indexed, bounded cleanup never waits behind a concurrent form submission.
  -- Each call removes at most 64 rows expired for more than one extra day.
  delete from private.public_form_budgets
  where bucket_key in (
    select stale.bucket_key from private.public_form_budgets stale
    where stale.expires_at < observed_at - interval '1 day'
    order by stale.expires_at, stale.bucket_key
    limit 64 for update skip locked
  );

  return pg_catalog.jsonb_build_object('allowed', allowed, 'retry_after_seconds', retry_seconds);
end;
$function$;

revoke all on function public.consume_public_form_budget(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.consume_public_form_budget(jsonb) to service_role;

comment on function public.consume_public_form_budget(jsonb) is
  'Atomically consumes 1-8 HMAC-keyed website budgets or consumes none. Service-only; never accepts raw identifiers.';

notify pgrst, 'reload schema';
