# Release, measurement and rollback

## Foundation scope

This PR adds `robots.txt`, a five-URL XML sitemap, canonical tags on existing public pages, missing noindex tags on six utility pages and homepage social metadata using the current approved image. No layout, visible text, application JavaScript, routes, database, billing, native app or account permissions change. The baseline and later-page proposals remain repository-only documents, excluded by `.vercelignore`.

## Review and release checklist

- [x] Source/live baseline captured before website edits, including all root HTML routes.
- [x] Sitemap contains only existing canonical informational pages; no job, account, query or proposed city URLs.
- [x] Robots allows page crawling so noindex can be seen, and advertises the canonical sitemap. API endpoints are disallowed; API authorization remains the actual security boundary.
- [x] Six SEO tests, launch static checks and 76 account/message regression tests pass locally.
- [x] XML parses; edited page bodies, styles and scripts match the baseline exactly.
- [ ] GitHub CI checks at the PR head reviewed; note any unrelated failures rather than declaring a blanket pass.
- [ ] On a branch preview, check homepage at phone and desktop sizes and confirm role/signup links, login and help links still work. Do not use real accounts or submit forms just for SEO verification.
- [ ] Verify preview `robots.txt` is text and `sitemap.xml` is XML, with expected status 200 and final URL canonicals. Preview-level noindex is expected; do not mistake it for a production defect.
- [ ] Owner approves merge/release. This milestone does not merge or deploy to production.
- [ ] After approved production release, repeat HTTP checks: robots/sitemap 200; five sitemap pages 200 and canonical; utility noindex visible; missing pages remain 404. Confirm no production `X-Robots-Tag: noindex` overrides the public-page policy.
- [ ] Submit the sitemap in the verified Search Console property and inspect the homepage plus representative utility routes. Record Google's actual chosen canonical and indexing reason.

No search-engine submission, DNS change, scheduled task or public job publication is performed in this PR. Existing automated Vercel branch previews may run normally.

## Measurement baseline: unknown is not zero

Current `analytics.js` sends path and referrer hostname to `/api/analytics`, skips Do Not Track and localhost, and does not establish durable conversion attribution. `api/analytics.js` stores pageviews with device/channel; aggregate business counts exist in the marketing analytics migration. Those sources cannot by themselves prove that a particular signup, post, application or match came from organic search. Do not join anonymous visits to private identities by guesswork.

| Metric | Preferred evidence | Baseline status / next step |
| --- | --- | --- |
| Search impressions, clicks, CTR, queries, landing pages | Verified Google Search Console Search Performance | Not accessed; export latest complete 28 days and preceding 28 days, noting GSC timezone and reporting lag |
| Indexed pages, exclusions, selected canonical | GSC Page Indexing, Sitemaps, URL Inspection | Not accessed; sitemap missing in current deployment |
| Real-user LCP, INP, CLS | GSC Core Web Vitals / CrUX | Unknown; mark insufficient traffic explicitly if applicable |
| Organic landing visits | Existing referrer-host pageviews, with documented search-engine classification | Available implementation, counts not queried; referrer loss and bot traffic limit accuracy |
| Organic signups by café/barista | Future verified signup-success event plus approved attribution | Not implemented/verified; aggregate signups are not an SEO conversion rate |
| Organic café first posts | Server-confirmed eligible job creation linked to an approved attribution record | Not implemented/verified |
| Organic barista applications | Server-confirmed unique application acceptance | Not implemented/verified; distinguish from discovery interests |
| Organic matches | Server-confirmed match transition | Not implemented/verified; distinguish job and discovery matches |

Recommended later instrumentation: first-touch organic landing path/referrer category carried through signup under a reviewed retention/consent design; a coarse role and source identifier, not personal details, in reports. Count success only after server confirmation, deduplicate by durable event ID, and treat retries, existing accounts, direct/internal traffic, owner visits and test accounts explicitly. Preserve Do Not Track handling. Do not label a click on Apply as a completed application.

Search Console access can be granted to an existing verified property. If ownership verification is missing, use the actual Google-issued DNS/meta value through a separate reviewed change, never a placeholder token. The workstream needs read-only GSC reporting after setup; API submission or verification changes require their concrete release review.

## Owner brief format after release

Weekly reporting is a proposal, not an automation created here. Include observation period and source freshness; impressions/clicks/CTR by city landing page and query; sitemap submitted/indexed/excluded counts with reasons; attribution coverage; confirmed conversions where available; one evidence-based next action. Until city pages launch, label their rows “not published,” not zero impressions. Separate branded discovery from Miami/Fort Lauderdale non-brand demand. Avoid ranking promises.

## Rollback

Revert this PR's single implementation commit through the normal reviewed deployment path. This removes the new sitemap/robots and metadata only; there is no data migration to reverse. Verify homepage/account journeys and response tags after rollback. If a public page is accidentally noindexed, remove the erroneous directive, redeploy through review and use GSC to request recrawl; changes in Google are not immediate. Preserve the dated baseline as review evidence even if implementation is reverted.
