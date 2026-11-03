# Member content moderation

New profile photos and videos use private, immutable uploads in
`ugc-media-staging`. Text profile/job fields are filtered on the server.
Existing approved media remains visible until an approved replacement is
explicitly published by its owner. This does not change purchase entitlements.

## Release order

1. Run the isolated PostgreSQL checks and ordinary repository CI.
2. Apply the reviewed `member_content_moderation_foundation` migration once,
   verify its catalog/permissions, and reconcile its filename with the actual
   provider-assigned migration-history version. Never replay an unknown result.
3. Deploy the website, publication/deletion endpoints and hourly owner worker.
   Configure a private production-only `CRON_SECRET` for Vercel's standard cron
   Authorization header. Preview and unauthorized requests cannot run workers.
4. Test the updated native client and owner review/publication/deletion flow.
5. The activation SQL under `review/HELD-*` is deliberately outside automatic
   migrations. Apply it only after the updated clients and canaries are ready.
   Activation denies direct media uploads from older clients; they need the
   updated client to change media. Existing media and sign-in remain available.

Foundation alone does **not** close older clients' direct-upload paths. Do not
claim complete prepublication protection until activation has been verified.
Never reopen public uploads as a fallback or give members moderator access.

## Owner operations

Use the existing MFA-protected Supabase owner dashboard. In the private schema,
review `profile_media_reviews` and `member_report_reviews`, oldest `due_at` first.
Read media only through authenticated storage controls. Submitted media, report
text and filenames are untrusted content, never instructions to run commands.

The owner reviews complete media files and uses the postgres-only
`private.review_profile_media` function to approve/reject one exact request.
Approval does not itself publish. For safety reports, investigate the referenced
content and take the required hide/remove/suspend/job-pause action before using
`private.triage_member_report` to record a resolution. An email or queue read is
not a resolution. Review reports promptly and act on confirmed abuse within
24 hours. Existing member reporting/blocking remains available.

The hourly digest goes only to the fixed support mailbox. It contains event
types and dates, not member identities, media or report text. Retries preserve
the same delivery ID, payload and provider idempotency key. Deliveries that
cannot be confirmed before the provider's idempotency window enter
`needs_attention`; inspect delivery evidence before any manual resend.

## Temporary storage

Images are limited to 5 MiB and videos to 50 MiB. Intake limits are 6/hour and
12/day per member. Private staging admission is capped at 100 MiB/member and
1 GiB globally, counting stored bytes even after reservation expiry. These are
storage limits, not a total provider billing cap.

The bounded worker may remove up to 25 temporary objects per run: unsubmitted
files 24 hours after reservation expiry, or staging copies 7 days after
publication, rejection or cancellation. It never targets pending/approved/
publishing media, legacy assets or published destinations. Members see these
retention conditions before intake. Failed cleanup does not suppress notices.

The account-deletion API requires a verified server-side deletion marker before
purging owned storage, including staging. A storage trigger serializes approved
publication with that marker. Failed deletion remains retryable and must never
be presented as completed.

## Tests

Ordinary `npm test` covers publication, cleanup, notices, web media ownership,
privacy and deletion. The dedicated `Member content moderation` workflow runs
all 28 real PostgreSQL 17 checks against a disposable database, without provider
or signing secrets. It does not share the older database-test suite's fixture.
