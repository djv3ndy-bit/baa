-- ADDITIONAL OWNER-REVIEW DRAFT ONLY. Not a migration; never executed remotely.
-- Approval required: enable pg_net + one cron job + ongoing provider usage.
-- Live read-only metadata supplied by parent: pg_cron 1.6.4 already installed;
-- pg_net 0.20.4 available, NOT enabled. Recheck metadata before implementation.
-- Abort on conflicting extension/job rather than replacing existing settings.
begin;
do $$ begin
  if exists (select 1 from pg_catalog.pg_extension where extname = 'pg_net') then
    raise exception 'Review existing pg_net configuration before continuing';
  end if;
  if exists (select 1 from pg_catalog.pg_namespace where nspname = 'net') then
    raise exception 'Review existing net schema before continuing';
  end if;
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    raise exception 'Required existing pg_cron is unavailable';
  end if;
  if exists (select 1 from cron.job where jobname = 'era-runtime-heartbeat-v1') then
    raise exception 'Existing heartbeat must be inspected, never reset';
  end if;
end $$;

create extension pg_net;
-- New extension only: prevent application clients using its networking API.
revoke all on schema net from public, anon, authenticated;
revoke all on all functions in schema net from public, anon, authenticated;

-- One cloud job, every five minutes. No tokens, cookies, customer data or writes
-- to the website. This no-store path invokes the real Vercel api/config function.
-- The subsequent signed drain delivery (NOT this SQL call) advances coverage.
-- Pruning shares the ingest row lock; execute it under the intended service role.
-- Verify the scheduling role may SET ROLE service_role before approving rollout.
select cron.schedule('era-runtime-heartbeat-v1', '*/5 * * * *', $job$
  set local role service_role;
  select ops_monitoring.prune_runtime();
  reset role;
  select net.http_get(
    url := 'https://www.baristajobmatch.com/api/public-config',
    headers := '{"User-Agent":"BaristaMatch-runtime-heartbeat/1","Cache-Control":"no-cache"}'::jsonb,
    timeout_milliseconds := 5000
  );
$job$);
commit;

-- Verification after a separately approved rollout: inspect only job name,
-- schedule/active flag and sanitized status codes/timestamps; do not print
-- pg_net response bodies, which are unnecessary for runtime coverage.
-- No enable/disable/reset/unschedule actions are included in this draft.
