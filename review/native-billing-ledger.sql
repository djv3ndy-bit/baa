-- REVIEW PROPOSAL ONLY. Not deployed and not yet connected to the existing
-- entitlement/Stripe checkout functions. Those integrations are release gates.
-- Financial ownership rows intentionally retain an opaque original account ID
-- after deletion; the final retention/deletion integration must be reviewed.
create schema if not exists private;

create table private.native_billing_accounts (
  user_id uuid primary key,
  store_binding uuid not null unique default gen_random_uuid(),
  created_at timestamptz not null default now()
);
create table private.native_billing_subscriptions (
  provider text not null check (provider in ('apple','google')),
  environment text not null check (environment in ('Sandbox','Production')),
  provider_subscription_id text not null check (length(provider_subscription_id) between 1 and 8192),
  provider_subscription_key text not null check (provider_subscription_key = encode(sha256(convert_to(provider_subscription_id,'UTF8')),'hex')),
  user_id uuid not null references private.native_billing_accounts(user_id),
  product_id text not null check (length(product_id) between 1 and 255),
  transaction_id text not null check (length(transaction_id) between 1 and 8192),
  status text not null check (status in ('active','grace','pending','payment_required','expired','revoked')),
  current_period_end timestamptz,
  grace_period_end timestamptz,
  auto_renews boolean not null,
  revision bigint not null default 1,
  verified_at timestamptz not null default now(),
  superseded_by text,
  primary key (provider,environment,provider_subscription_key)
);
create index native_billing_subscriptions_account_idx on private.native_billing_subscriptions(user_id,environment);
create table private.native_billing_events (
  provider text not null check (provider in ('apple','google')),
  environment text not null check (environment in ('Sandbox','Production')),
  event_id text not null check (length(event_id) between 1 and 255),
  payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
  claim_id uuid,
  claim_expires_at timestamptz,
  processed_at timestamptz,
  attempts integer not null default 0,
  primary key(provider,environment,event_id)
);
alter table private.native_billing_accounts enable row level security;
alter table private.native_billing_subscriptions enable row level security;
alter table private.native_billing_events enable row level security;
revoke all on private.native_billing_accounts,private.native_billing_subscriptions,private.native_billing_events from public,anon,authenticated;

create function public.native_billing_account(p_user_id uuid) returns uuid
language plpgsql security definer set search_path=pg_catalog,private as $$
declare binding uuid;
begin
  if not exists(select 1 from public.profiles where id=p_user_id and role='cafe_owner_manager' and suspended_at is null) then
    raise exception 'Native billing requires an active cafe account';
  end if;
  insert into private.native_billing_accounts(user_id) values(p_user_id) on conflict(user_id) do nothing;
  select store_binding into binding from private.native_billing_accounts where user_id=p_user_id;
  return binding;
end;
$$;

create function public.native_billing_owner(p_binding uuid) returns uuid
language sql stable security definer set search_path=pg_catalog,private as $$
  select user_id from private.native_billing_accounts where store_binding=p_binding;
$$;

create function public.native_billing_read(p_provider text,p_environment text,p_subscription_id text) returns jsonb
language sql stable security definer set search_path=pg_catalog,private as $$
  select to_jsonb(subscription) from private.native_billing_subscriptions subscription
  where provider=p_provider and environment=p_environment and provider_subscription_key=encode(sha256(convert_to(p_subscription_id,'UTF8')),'hex') and provider_subscription_id=p_subscription_id;
$$;

create function public.native_billing_apply(
  p_user_id uuid,p_binding uuid,p_provider text,p_environment text,p_subscription_id text,
  p_product_id text,p_transaction_id text,p_status text,p_period_end timestamptz,
  p_grace_end timestamptz,p_auto_renews boolean,p_expected_revision bigint,
  p_linked_subscription_id text default null
) returns text language plpgsql security definer set search_path=pg_catalog,private as $$
declare existing private.native_billing_subscriptions%rowtype;
  linked private.native_billing_subscriptions%rowtype;
  new_key text;
begin
  if p_expected_revision is null or p_expected_revision<0 or not exists(
    select 1 from private.native_billing_accounts where user_id=p_user_id and store_binding=p_binding
  ) then raise exception 'Native billing ownership could not be confirmed'; end if;
  -- Serialize one account's ownership changes, including Google token replacement.
  perform pg_advisory_xact_lock(hashtextextended('native-billing:'||p_user_id::text,0));
  new_key:=encode(sha256(convert_to(p_subscription_id,'UTF8')),'hex');
  if p_linked_subscription_id is not null and (p_provider<>'google' or p_linked_subscription_id=p_subscription_id or length(p_linked_subscription_id) not between 1 and 8192) then
    raise exception 'Invalid linked native subscription';
  end if;
  -- Insert a sentinel without access; concurrent writers synchronize on the
  -- unique provider subscription key, then compare the authoritative revision.
  insert into private.native_billing_subscriptions(provider,environment,provider_subscription_id,provider_subscription_key,user_id,product_id,transaction_id,status,auto_renews,revision)
  values(p_provider,p_environment,p_subscription_id,encode(sha256(convert_to(p_subscription_id,'UTF8')),'hex'),p_user_id,p_product_id,p_transaction_id,'pending',false,0)
  on conflict(provider,environment,provider_subscription_key) do nothing;
  select * into existing from private.native_billing_subscriptions
  where provider=p_provider and environment=p_environment and provider_subscription_key=encode(sha256(convert_to(p_subscription_id,'UTF8')),'hex') and provider_subscription_id=p_subscription_id for update;
  if not found then raise exception 'Native subscription identity conflict'; end if;
  if existing.user_id<>p_user_id then raise exception 'Native subscription belongs to another account'; end if;
  if existing.superseded_by is not null then return 'superseded'; end if;
  if existing.revision<>p_expected_revision then return 'retry'; end if;
  if p_linked_subscription_id is not null and p_status<>'pending' then
    -- Retain a tombstone even if the old token never reached this server, so
    -- a delayed restoration cannot reactivate the superseded purchase.
    insert into private.native_billing_subscriptions(provider,environment,provider_subscription_id,provider_subscription_key,user_id,product_id,transaction_id,status,auto_renews,revision,superseded_by)
    values(p_provider,p_environment,p_linked_subscription_id,encode(sha256(convert_to(p_linked_subscription_id,'UTF8')),'hex'),p_user_id,p_product_id,p_linked_subscription_id,'revoked',false,0,new_key)
    on conflict(provider,environment,provider_subscription_key) do nothing;
    select * into linked from private.native_billing_subscriptions
    where provider=p_provider and environment=p_environment and provider_subscription_key=encode(sha256(convert_to(p_linked_subscription_id,'UTF8')),'hex') for update;
    if linked.user_id<>p_user_id or linked.provider_subscription_id<>p_linked_subscription_id then
      raise exception 'Linked native subscription belongs to another account';
    end if;
    if linked.superseded_by is not null and linked.superseded_by<>new_key then
      raise exception 'Linked native subscription was already replaced';
    end if;
    update private.native_billing_subscriptions set status='revoked',auto_renews=false,superseded_by=new_key,revision=revision+1,verified_at=clock_timestamp()
    where provider=p_provider and environment=p_environment and provider_subscription_key=linked.provider_subscription_key and superseded_by is distinct from new_key;
  end if;

  if existing.revision>0 and existing.product_id=p_product_id and existing.transaction_id=p_transaction_id
    and existing.status=p_status and existing.current_period_end is not distinct from p_period_end
    and existing.grace_period_end is not distinct from p_grace_end and existing.auto_renews=p_auto_renews then return 'duplicate'; end if;
  update private.native_billing_subscriptions set product_id=p_product_id,transaction_id=p_transaction_id,status=p_status,
    current_period_end=p_period_end,grace_period_end=p_grace_end,auto_renews=p_auto_renews,
    revision=revision+1,verified_at=clock_timestamp()
  where provider=p_provider and environment=p_environment and provider_subscription_key=encode(sha256(convert_to(p_subscription_id,'UTF8')),'hex') and provider_subscription_id=p_subscription_id;
  return 'applied';
end;
$$;

create function public.native_billing_access(p_user_id uuid,p_environment text) returns boolean
language sql stable security definer set search_path=pg_catalog,private as $$
  select exists(select 1 from public.profiles where id=p_user_id and role='cafe_owner_manager' and suspended_at is null)
    and exists(select 1 from private.native_billing_subscriptions where user_id=p_user_id and environment=p_environment
    and superseded_by is null and ((status='active' and current_period_end>now()) or (status='grace' and grace_period_end>now())));
$$;

create function public.native_billing_claim_event(p_provider text,p_environment text,p_event_id text,p_payload_hash text,p_claim_id uuid) returns text
language plpgsql security definer set search_path=pg_catalog,private as $$
declare existing private.native_billing_events%rowtype;
begin
  if p_claim_id is null then raise exception 'Event claim required'; end if;
  insert into private.native_billing_events(provider,environment,event_id,payload_hash)
  values(p_provider,p_environment,p_event_id,p_payload_hash) on conflict(provider,environment,event_id) do nothing;
  select * into existing from private.native_billing_events where provider=p_provider and environment=p_environment and event_id=p_event_id for update;
  if existing.payload_hash<>p_payload_hash then raise exception 'Event identity conflict'; end if;
  if existing.processed_at is not null then return 'duplicate'; end if;
  if existing.claim_expires_at>now() then return 'busy'; end if;
  update private.native_billing_events set claim_id=p_claim_id,claim_expires_at=now()+interval '5 minutes',attempts=attempts+1
  where provider=p_provider and environment=p_environment and event_id=p_event_id;
  return 'claimed';
end;
$$;

create function public.native_billing_finish_event(p_provider text,p_environment text,p_event_id text,p_claim_id uuid,p_success boolean) returns boolean
language plpgsql security definer set search_path=pg_catalog,private as $$
declare affected integer;
begin
  if p_success is null then raise exception 'Event outcome required'; end if;
  update private.native_billing_events set processed_at=case when p_success then now() else null end,claim_id=null,claim_expires_at=null
  where provider=p_provider and environment=p_environment and event_id=p_event_id and claim_id=p_claim_id and claim_expires_at>now();
  get diagnostics affected=row_count; return affected=1;
end;
$$;

revoke execute on function public.native_billing_account(uuid) from public,anon,authenticated;
revoke execute on function public.native_billing_read(text,text,text) from public,anon,authenticated;
revoke execute on function public.native_billing_apply(uuid,uuid,text,text,text,text,text,text,timestamptz,timestamptz,boolean,bigint,text) from public,anon,authenticated;
revoke execute on function public.native_billing_access(uuid,text) from public,anon,authenticated;
revoke execute on function public.native_billing_claim_event(text,text,text,text,uuid) from public,anon,authenticated;
revoke execute on function public.native_billing_finish_event(text,text,text,uuid,boolean) from public,anon,authenticated;
grant execute on function public.native_billing_account(uuid) to service_role;
grant execute on function public.native_billing_read(text,text,text) to service_role;
grant execute on function public.native_billing_apply(uuid,uuid,text,text,text,text,text,text,timestamptz,timestamptz,boolean,bigint,text) to service_role;
grant execute on function public.native_billing_access(uuid,text) to service_role;
grant execute on function public.native_billing_claim_event(text,text,text,text,uuid) to service_role;
grant execute on function public.native_billing_finish_event(text,text,text,uuid,boolean) to service_role;

revoke execute on function public.native_billing_owner(uuid) from public,anon,authenticated;
grant execute on function public.native_billing_owner(uuid) to service_role;

-- Service-only sanitized status: no receipts, purchase tokens, original
-- transaction IDs, signing material or store-account bindings are returned.
create function public.native_billing_summary(p_user_id uuid,p_environment text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,private as $$
begin
  if p_environment is null or p_environment not in ('Sandbox','Production') or not exists(
    select 1 from public.profiles where id=p_user_id and role='cafe_owner_manager' and suspended_at is null
  ) then raise exception 'Native billing requires an active cafe account'; end if;
  return jsonb_build_object('accountId',p_user_id,'environment',p_environment,'subscriptions',coalesce((
    select jsonb_agg(jsonb_build_object('provider',provider,'status',status,
      'currentPeriodEnd',current_period_end,'gracePeriodEnd',grace_period_end,'autoRenews',auto_renews)
      order by verified_at desc,provider,provider_subscription_key)
    from private.native_billing_subscriptions where user_id=p_user_id and environment=p_environment
      and superseded_by is null and revision>0
  ),'[]'::jsonb));
end;
$$;
revoke execute on function public.native_billing_summary(uuid,text) from public,anon,authenticated;
grant execute on function public.native_billing_summary(uuid,text) to service_role;
