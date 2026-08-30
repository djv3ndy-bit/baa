-- The owner analytics API updates complimentary café access through the
-- trusted server client. RLS bypass alone does not grant table privileges,
-- so PostgREST also needs explicit SELECT and UPDATE grants for service_role.
grant select, update on table public.cafe_subscriptions to service_role;
