# Genuine JobPosting strategy

Status: design contract for the next PR, not enabled functionality. The foundation adds no JobPosting objects. The illustration on the homepage must never be a source for job schema.

## Existing source and missing contract

`dashboard.html` reads `id`, `owner_id`, `title`, `location`, structured address fields, `pay_min`, `pay_max`, `schedule`, `description`, `required_skills`, `active`, and `created_at`; employer name is joined from `profiles.cafe_name`. Job edits set `updated_at`. Pause/reopen toggles `active`. The source job policy was created for `authenticated` in `20260831090000_add_member_safety_controls.sql` and refined in `20260908110000_consolidate_job_participant_visibility.sql`; paid publication rules also exist. These are signed-in application contracts, not permission for public search publication.

No inspected posting form collects a closing deadline, and the inspected job fetch does not include one. `created_at` does not necessarily prove the first public publication date. No inspected form establishes separate consent for a public search page. Confirm deployed columns, grants, current status and the employer publication agreement before designing a migration. Do not guess production schema or broaden anonymous access to existing jobs/profiles.

## Proposed eligibility rule

Serve a public job only when all of these project requirements hold:

1. A real, owner-authorized employer has opted to publish that particular vacancy publicly; it is not a fixture, demo, draft or duplicate.
2. The vacancy is still active and accepting applications; employer removal, moderation, account deletion, publication entitlement and any configured deadline have been evaluated using current authoritative state.
3. The employer has supplied a meaningful title/description, a verified public employer name and valid workplace location. Only employer-designated business location data may be published; no personal address is inferred from a profile.
4. A stable public URL renders the same reviewed facts in HTML without authentication. The application action works and returns a signed-in applicant to this job. If that path is not implemented, do not claim `directApply`.

Use an explicit allowlist serializer, never spread a joined database record into HTML or JSON-LD. Keep `owner_id`, personal email/phone, DOB, demographics, candidate details, messages, application history, private profile/storage URLs, tokens and billing state out of responses. The safe projection may include an opaque public job ID, employer-approved business name, job text, workplace, pay, schedule, publication date and deadline. Establish per-job withdrawal and deletion rules before exposure. Existing application authorization stays intact.

## Mapping to an individual job page

Google's job guidance requires genuine single-vacancy pages and accurate visible data. Required fields include `title`, `description`, `datePosted`, `hiringOrganization` and `jobLocation` for on-site work. An expiration date, when one exists, belongs in `validThrough`. Optional properties must not be invented. See [Google JobPosting documentation](https://developers.google.com/search/docs/appearance/structured-data/job-posting).

The following is the proposed BaristaMatch implementation mapping; unresolved fields block publication rather than receive made-up values.

| Property | Proposed source / constraint |
| --- | --- |
| `@context`, `@type` | `https://schema.org`, `JobPosting`, on a single eligible job detail only |
| `url`, `identifier` | Canonical `/jobs/{stable-public-id}` and stable public ID; no private owner ID |
| `title`, `description` | Employer-authored job fields, rendered visibly; sanitize description HTML and escape JSON-LD safely against `</script>` injection |
| `datePosted` | Audited first-publication date; use `created_at` only if its semantics are confirmed. Do not refresh on ordinary edits. |
| `hiringOrganization.name` | Verified, publication-approved `cafe_name`; BaristaMatch is the platform, not automatically the employer |
| `hiringOrganization.sameAs`, `logo` | Include only supplied, verified public employer assets; omit otherwise |
| `jobLocation.address` | Approved workplace address fields; city/state/postcode and country US; never derive an address from private personal data |
| `baseSalary` | Supplied `pay_min`/`pay_max`, USD and HOUR only after confirming these are actual base hourly wages; show the same pay on the page. No guessed tips or market estimates. |
| `employmentType` | Map actual Full-time/Part-time to supported values. Morning/Evening shift is scheduling information, not a substitute employment type. |
| `validThrough` | Real employer deadline, including timezone. Never invent a deadline from `updated_at` or silently promise indefinite availability. |
| `directApply` | Omit until the real application journey meets the documented conditions |

## Lifecycle and consistency

This project should initially require an explicit deadline or a separately approved freshness policy for public jobs. That is a product safeguard, not a claim that Google mandates a deadline for every vacancy. If no expiration exists, Google permits omission of `validThrough`, but the platform still needs a reliable closure mechanism.

| State | Proposed public response | Schema and sitemap |
| --- | --- | --- |
| Eligible and active | 200, complete public details, enabled Apply | One JobPosting; include canonical URL |
| Paused, closed or expired | 200 with accurate unavailable notice and no application action; noindex | Remove JobPosting and sitemap entry immediately |
| Deleted or public permission withdrawn | 404 or 410 without retained job/personal data | Remove schema and sitemap entry |
| Unknown public ID | 404 | No schema, no sitemap entry |
| Data source temporarily unavailable | 503 with retry guidance; never substitute stale active details | No new schema/active listing claims; retry sitemap generation without replacing it with misleading empty success |
| Reopened | Re-evaluate consent, current eligibility and deadline; same stable ID | Restore only after gates pass; retain truthful original publication date |

Use the same eligibility function for page HTML, schema, city cards and sitemap. For the first public-job release prefer uncached current eligibility reads over serving stale vacancies; if caching is later introduced, document and test invalidation on pause, expiry, withdrawal and deletion. Exclude inactive pages from the sitemap. Consider Google's Indexing API for approved job URL updates/removals only after credentials and the publication workflow are reviewed; this milestone does not call it.

## Required next-PR tests

- Genuine active fixture emits valid required fields matching visible HTML; no fixture is deployed as a live vacancy.
- Draft, test, blocked, withdrawn, expired, paused, deleted and ineligible jobs emit no active schema; exact-deadline boundary and timezone cases covered.
- Invalid dates, missing employer/location, unsafe HTML/JSON, reversed pay range and unknown schedule values fail safely.
- Serialized page, JSON-LD and API payloads cannot contain forbidden profile/account fields or private storage URLs.
- Close/reopen/delete and source-failure tests exercise both direct requests and sitemap/list consistency; authenticated existing application flows remain intact.
- Run Rich Results Test and Search Console URL Inspection on an eligible deployed page after release approval. Record actual tool results; syntactic JSON validity alone is not Google validation or an indexing guarantee.
