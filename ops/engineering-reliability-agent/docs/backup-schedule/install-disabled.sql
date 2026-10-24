-- REVIEW DRAFT ONLY. Not a migration; not run by CI or application deployment.
-- Requires separate owner approval and administrator review; see README.md.
-- No extension installation, token creation, HTTP request or job activation here.
begin;

do $preflight$
begin
  perform pg_advisory_xact_lock(hashtextextended('bjm-monitor-backup-install', 0));
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron')
     or not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_net')
     or not exists (select 1 from pg_catalog.pg_extension where extname = 'supabase_vault') then
    raise exception 'Required approved extensions are unavailable';
  end if;
  if coalesce(current_setting('cron.timezone', true), '') not in ('UTC', 'GMT', 'Etc/UTC') then
    raise exception 'Verify Cron uses UTC before installing the backup job';
  end if;
  if has_table_privilege('anon', 'net.http_request_queue', 'SELECT')
     or has_table_privilege('authenticated', 'net.http_request_queue', 'SELECT')
     or has_table_privilege('anon', 'vault.decrypted_secrets', 'SELECT')
     or has_table_privilege('authenticated', 'vault.decrypted_secrets', 'SELECT') then
    raise exception 'Application roles must not have access to dispatch credentials';
  end if;
  if exists (select 1 from cron.job where jobname = 'bjm-monitor-backup-dispatch') then
    raise exception 'Backup job already exists; inspect it instead of replacing it';
  end if;
  if (select count(*) from vault.secrets where name = 'bjm_monitor_dispatch_token') <> 1 then
    raise exception 'Exactly one dedicated dispatch credential must be configured';
  end if;
end;
$preflight$;

create schema if not exists ops_monitoring;
create table ops_monitoring.monitor_dispatch_receipts (
  request_id bigint primary key,
  requested_at timestamptz not null default now()
);
alter table ops_monitoring.monitor_dispatch_receipts enable row level security;
revoke all on ops_monitoring.monitor_dispatch_receipts from public, anon, authenticated;

select cron.schedule(
  'bjm-monitor-backup-dispatch',
  '37 * * * *',
  $job$
    do $dispatch$
    declare
      dispatch_token text;
      dispatch_request_id bigint;
    begin
      -- STRICT rejects missing/duplicate credentials; never emit the value.
      select decrypted_secret into strict dispatch_token
      from vault.decrypted_secrets where name = 'bjm_monitor_dispatch_token';
      if dispatch_token is null or length(dispatch_token) < 1
         or position(chr(10) in dispatch_token) > 0
         or position(chr(13) in dispatch_token) > 0 then
        raise exception 'Dispatch credential is invalid';
      end if;
      select net.http_post(
        url := 'https://api.github.com/repos/djv3ndy-bit/baa/actions/workflows/engineering-reliability-monitor.yml/dispatches',
        body := '{"ref":"main"}'::jsonb,
        headers := jsonb_build_object(
          'Accept', 'application/vnd.github+json',
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || dispatch_token,
          'User-Agent', 'BJM-Monitor-Backup'
        ),
        timeout_milliseconds := 10000
      ) into dispatch_request_id;
      insert into ops_monitoring.monitor_dispatch_receipts (request_id)
      values (dispatch_request_id);
      delete from ops_monitoring.monitor_dispatch_receipts
      where requested_at < now() - interval '7 days';
    end;
    $dispatch$;
  $job$
);

-- Job creation and disabling commit atomically: no active job is exposed.
select cron.alter_job(
  job_id := (select jobid from cron.job where jobname = 'bjm-monitor-backup-dispatch'),
  active := false
);
commit;
