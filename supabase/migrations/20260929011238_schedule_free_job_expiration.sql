-- Supabase's built-in scheduler; no external service or paid plan is required.
-- This migration deliberately fails if scheduling cannot be installed.
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('baristamatch-expire-free-job-posts', '* * * * *',
  'select private.expire_free_job_posts()');
