create policy "No client access to push event log"
on public.push_event_log for all to public
using (false) with check (false);
