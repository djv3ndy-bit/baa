-- Expand address validation to the 50 states and Washington, D.C.
-- No rows are rewritten; existing triggers, roles, entitlements and RLS stay intact.
begin;
set local lock_timeout = '3s';
create or replace function public.validate_job_location()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op='UPDATE' and new.location is not distinct from old.location
    and new.address_line1 is not distinct from old.address_line1
    and new.address_line2 is not distinct from old.address_line2
    and new.city is not distinct from old.city and new.state is not distinct from old.state
    and new.postal_code is not distinct from old.postal_code then return new; end if;
  new.state := upper(btrim(coalesce(new.state,'')));
  new.city := btrim(coalesce(new.city,''));
  new.postal_code := btrim(coalesce(new.postal_code,''));
  new.address_line1 := btrim(coalesce(new.address_line1,''));
  if new.state not in ('AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY') or new.city='' or new.address_line1=''
    or new.postal_code !~ '^[0-9]{5}(-[0-9]{4})?$' then
    raise exception 'Enter a street address, city, valid U.S. state code, and ZIP code' using errcode='23514';
  end if;
  new.location := new.city || ', ' || new.state || ', ' || new.postal_code;
  return new;
end;
$$;
revoke all on function public.validate_job_location() from public, anon, authenticated;
commit;
