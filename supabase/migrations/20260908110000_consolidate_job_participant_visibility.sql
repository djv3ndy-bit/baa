-- Keep paused-job history available to existing applicants without evaluating
-- two permissive SELECT policies for every jobs query.
alter policy "Members can view active jobs and owners can view theirs"
on public.jobs
using (
  owner_id = (select auth.uid())
  or (
    active is true
    and not private.members_are_blocked((select auth.uid()), owner_id)
  )
  or private.job_caller_is_application_participant(id, owner_id)
);

drop policy if exists "Application participants can view their jobs" on public.jobs;
