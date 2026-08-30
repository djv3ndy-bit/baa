-- Explicit deny policies document and enforce that these tables are only
-- reachable through trusted server endpoints using the service role.
create policy "No client access to app errors" on public.app_errors
for all to public using (false) with check (false);

create policy "No client access to support admins" on public.support_admins
for all to public using (false) with check (false);

create policy "No client access to support ticket updates" on public.support_ticket_updates
for all to public using (false) with check (false);

create policy "No client access to support tickets" on public.support_tickets
for all to public using (false) with check (false);

create policy "No client access to waitlist signups" on public.waitlist_signups
for all to public using (false) with check (false);
