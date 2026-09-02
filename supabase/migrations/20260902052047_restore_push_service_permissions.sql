-- Push notifications validate the originating job, interest, match, or message
-- through the trusted server role. Restore only the columns used by that API;
-- anon and authenticated client permissions are unchanged.
grant select (id, title, city, state, postal_code, owner_id, active)
on table public.jobs to service_role;

grant select (id, sender_id, target_id)
on table public.discovery_interests to service_role;

grant select (id, barista_id, cafe_id)
on table public.discovery_matches to service_role;

grant select (id, match_id, sender_id, body)
on table public.discovery_messages to service_role;
