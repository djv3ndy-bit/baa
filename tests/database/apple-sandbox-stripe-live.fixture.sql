-- Read-only current live function definition. No business data or secrets.
CREATE OR REPLACE FUNCTION public.claim_stripe_checkout(p_user_id uuid, p_claim_id uuid, p_attempt_id uuid, p_channel text, p_ui_mode text DEFAULT 'hosted'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  existing public.cafe_subscriptions%rowtype;
  claimed_attempt_id uuid;
  claimed_channel text;
  claimed_ui_mode text;
  recovered boolean;
begin
  if p_user_id is null
     or p_claim_id is null
     or p_attempt_id is null
     or p_channel is null
     or p_channel not in ('web', 'app')
     or p_ui_mode is null
     or p_ui_mode not in ('hosted', 'embedded') then
    raise exception 'Invalid Checkout claim';
  end if;

  select * into existing
  from public.cafe_subscriptions
  where user_id = p_user_id
  for update;

  if not found
     or (
       existing.stripe_checkout_claim_id is not null
       and existing.stripe_checkout_claim_expires_at is not null
       and existing.stripe_checkout_claim_expires_at > now()
     ) then
    return null;
  end if;

  if private.native_checkout_is_blocked(p_user_id) then return null; end if;

  recovered := existing.stripe_checkout_attempt_id is not null;
  if not recovered and p_channel = 'app' and p_ui_mode <> 'hosted' then
    raise exception 'Invalid Checkout claim';
  end if;

  claimed_attempt_id := coalesce(existing.stripe_checkout_attempt_id, p_attempt_id);
  claimed_channel := case when recovered then coalesce(existing.stripe_checkout_channel, p_channel) else p_channel end;
  claimed_ui_mode := case when recovered then coalesce(existing.stripe_checkout_ui_mode, 'hosted') else p_ui_mode end;

  update public.cafe_subscriptions
  set stripe_checkout_claim_id = p_claim_id,
      stripe_checkout_claim_expires_at = now() + interval '5 minutes',
      stripe_checkout_claim_kind = 'checkout',
      stripe_checkout_attempt_id = claimed_attempt_id,
      stripe_checkout_channel = claimed_channel,
      stripe_checkout_ui_mode = claimed_ui_mode,
      updated_at = now()
  where user_id = p_user_id;

  return jsonb_build_object(
    'attemptId', claimed_attempt_id,
    'channel', claimed_channel,
    'uiMode', claimed_ui_mode,
    'recovered', recovered
  );
end;
$function$;
