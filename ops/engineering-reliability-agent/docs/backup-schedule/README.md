# Independent monitor trigger — disabled review draft

Status: **not installed or enabled**. This directory is not a Supabase migration
and is not invoked by any workflow. Merging it does not start a job.

GitHub's native hourly schedule can be delayed or dropped. On October 23, 2026,
the reliability monitor and billing workflow both showed multi-hour gaps while
their individual runs were short. That supports a scheduling problem but does
not prove its underlying cause or a customer-facing outage.

## Proposed change requiring owner approval

Use the existing production Supabase project's Cron service to request the
existing `engineering-reliability-monitor.yml` workflow on `main` at minute 37
of every hour (UTC). Keep the native minute-17 schedule as well. This adds up to
24 monitor runs a day; review GitHub usage and the workflow's existing approved
notification settings before activation. It does not trigger billing or deploy
the application. No new infrastructure purchase is proposed.

This is an independent timer, **not an independent monitor**. It still depends
on GitHub dispatch and runners, and shares the production Supabase failure
domain. It does not guarantee uninterrupted coverage or repair missed history.
The existing workflow concurrency limit serializes overlapping runs. A late
native run can still cause a redundant check; this draft deliberately avoids
claiming exactly-once dispatch or retrying an ambiguous POST.

## Prerequisites and credential boundary

1. Approve the fixed target, added run volume, installation of `pg_net`, and
   creation of the private dispatch-receipt table. The October 24 inspection found
   `pg_cron` and Vault installed; `pg_net` was not installed. Recheck before use.
2. Create a dedicated expiring fine-grained GitHub token restricted to
   `djv3ndy-bit/baa` with **Actions: write** (and GitHub's required metadata read).
   It can control other workflows in that repository: GitHub does not limit this
   permission to this one workflow. The SQL itself fixes the workflow and branch.
   Never broaden the existing monitoring read token. Record an expiry/renewal owner.
3. The owner stores that token directly in Supabase Vault as
   `bjm_monitor_dispatch_token`, without placing it in chat, source, SQL history,
   logs, or a GitHub secret. Do not use a Supabase service key for GitHub.
4. A database administrator installs `pg_net` through the approved extension
   path, verifies that application roles cannot read Vault or pg_net's request
   queue (which temporarily contains the Authorization header), inspects the SQL,
   and runs `install-disabled.sql` with sufficient Cron,
   Vault, and private-schema privileges. The job remains **inactive** on commit.
   A duplicate job name or receipt table causes the entire transaction to fail
   instead of silently replacing existing configuration.

Only after those steps and explicit activation approval, enable the exact job
in Supabase Cron. Do not run it manually as part of installation. The scheduled
command performs one POST, keeps only its request ID/time, and retains seven
days of those receipt references. It never stores credentials in the Cron command
or receipts. PostgreSQL administrators can access Vault; this does not isolate
the token from administrators of the production project.

## Verification before calling backup coverage working

- Check the Cron execution time and the matching receipt. A completed Cron job
  proves only that a request was queued. Join `request_id` to
  `net._http_response.id` promptly (pg_net response retention is limited); inspect
  only `status_code` and `timed_out`, not response bodies or headers. Missing
  response evidence remains unknown. HTTP 204 means GitHub accepted the request,
  not that a monitor finished. Do not automatically retry a timeout or lost reply.
- Find the new exact workflow/main `workflow_dispatch` run in repository-wide
  Actions history, using its creation time. Check its conclusion and both public
  and private monitoring artifacts, including collection failures. A green job
  alone is not a health result. If a manual run overlaps, attribution is uncertain.
- Observe two consecutive hourly backup runs with usable artifacts. Record
  backup coverage separately from `event=schedule`; backup checks must not close
  an incident about the native timer. Verify the next six hours before relying on
  the fallback. ChatGPT alerts remain read-only and cannot activate this draft.
- Treat missing backup execution/response/run/artifact evidence as a monitoring
  gap. This draft does not add a second out-of-band alerting service for Cron.

To stop the fallback, disable the named Cron job and revoke its dedicated GitHub
token after any queued request settles. Retain the native GitHub schedule and
monitoring read credentials. Do not delete application data or other Cron jobs.

## Validation and references

The Python retry tests run without real provider calls. This SQL has not been
executed against a database, and no dispatch, credential, extension, table or Cron
job has been created. Administrator review and live acceptance checks are required.

- [GitHub schedule limitations](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
- [GitHub workflow dispatch and permission](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)
- [Supabase Cron](https://supabase.com/docs/guides/cron/quickstart)
- [Supabase pg_net](https://supabase.com/docs/guides/database/extensions/pg_net)

