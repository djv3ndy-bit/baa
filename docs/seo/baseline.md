# BaristaMatch SEO baseline — 2026-09-24

## Evidence and scope

Source: `djv3ndy-bit/baa`, main commit `3ce3f1982103da1c50074e54523c7234856a6b86` (2026-09-23). Public audit completed at **2026-09-24 03:09:01 UTC**. Raw metadata, headings, links, response hashes, status codes and redirect chains are in [baseline-2026-09-24.json](baseline-2026-09-24.json).

Method: 40 unauthenticated HTTP GETs, following up to five redirects, parsing returned HTML without executing JavaScript. All 24 root HTML documents in production matched the source files byte-for-byte. Findings below describe **before this PR**. Re-run from repository root with `python3 scripts/seo-baseline.py --output /tmp/bjm-seo.json`; never overwrite the dated baseline with a later run. Requests can appear in infrastructure logs; this runner does not execute the site's pageview JavaScript.

No Search Console property, production database or Google URL Inspection was accessed. Live job counts, Google-selected canonicals, indexed-page totals, rankings, impressions and conversion rates remain unknown. Crawlability is not evidence of indexing. A sitemap is a discovery aid, not a ranking or inclusion guarantee.

## Findings and first response

| Priority | Observed baseline | Response |
| --- | --- | --- |
| P1 | `/robots.txt` and `/sitemap.xml` both return 404; neither exists in source | Add an explicit crawl policy and a five-URL sitemap. A missing robots file did not itself block Google. |
| P1 | No canonical tags in any root HTML page | Add self-canonicals to the five public informational documents, using existing HTTPS/www/clean URLs. |
| P1 | Six utility pages lack robots noindex: dashboard, login, signup, reset-password, verify-email, support-admin | Add head-only `noindex,follow`. Keep them crawlable so the tag can be read; keep all utility routes out of the sitemap. |
| P1 | No public city hub, job index or dedicated public job-detail document | Plan the public-data boundary and two-city content gate. Do not index authenticated dashboard query URLs. |
| P2 | Homepage has OG title/description but lacks OG URL/type/image and Twitter metadata | Add canonical social URL and existing approved hero asset; preserve title, description and visible copy. |
| P2 | Homepage job/hiring links lead to role-specific signup, and informational links mostly use redirecting `.html` URLs | Existing journeys work. Keep auth parameters intact; normalize editorial links separately only with navigation tests. Add real city/job links when those destinations exist. |
| P2 | Existing analytics counts visits and business activity but has no demonstrated organic-to-conversion attribution | Document Search Console and event plan; do not claim current SEO conversions. |
| P2 | Hero source asset is 2,121,875 bytes; image markup lacks intrinsic dimensions, loading hints and fetch priority | Candidate performance work only. Measure current mobile LCP/CLS/INP before optimizing the approved image. |

## Complete root route inventory

All routes below returned HTTP 200 with HTML on unauthenticated GET. For account/admin routes, that is the page shell, not evidence that protected data is publicly accessible. Source inspection shows dashboard session validation followed by login redirect and authenticated marketplace loading.

| Canonical or clean route | Baseline robots | Proposed indexing policy | Sitemap |
| --- | --- | --- | --- |
| `/` | None | Index: homepage | Yes |
| `/support` | None | Index: public help entry point | Yes |
| `/privacy` | None | Index: public policy | Yes |
| `/terms` | None | Index: public terms | Yes |
| `/delete-account` | None | Index: public deletion instructions | Yes |
| `/dashboard` | None | Add noindex | No |
| `/login` | None | Add noindex | No |
| `/signup` | None | Add noindex, including role/query variants | No |
| `/reset-password` | None | Add noindex | No |
| `/verify-email` | None | Add noindex | No |
| `/support-admin` | None | Add noindex | No |
| `/account-deleted` | noindex | Retain | No |
| `/cafe-trial` | noindex,nofollow | Retain | No |
| `/checkout` | noindex,nofollow | Retain | No |
| `/pricing` | noindex,nofollow | Retain | No |
| `/mobile-auth-start` | noindex | Retain | No |
| `/mobile-auth-callback` | noindex | Retain | No |
| `/mobile-billing-return` | noindex | Retain | No |
| `/owner-accounts` | noindex,nofollow,noarchive | Retain | No |
| `/owner-audience` | noindex,nofollow | Retain | No |
| `/owner-dashboard` | noindex,nofollow | Retain | No |
| `/owner-growth` | noindex,nofollow | Retain | No |
| `/owner-marketplace` | noindex,nofollow | Retain | No |
| `/owner-subscriptions` | noindex,nofollow | Retain | No |

Support, legal and deletion pages serve real public needs; their sitemap inclusion does not mean they target local job queries. Noindex is a search instruction, not authorization or a privacy boundary. All current application access controls remain required and unchanged.

Additional surfaces: `/api/*` are application endpoints, excluded from the sitemap and disallowed in robots; they still require their existing authorization. The separate `bjm-ai-office/` project has its own deployment configuration and is outside this website's page inventory. SEO audit files and runner are excluded from deployment by `.vercelignore`.

## Redirects, missing pages and duplicates

- Apex `https://baristajobmatch.com/` and HTTP `http://www.baristajobmatch.com/` each redirect once with 308 to the HTTPS www homepage.
- `/index.html` redirects with 308 to `/`; `/support.html`, `/privacy.html`, `/terms.html` and `/delete-account.html` redirect with 308 to their extensionless versions. `/support/` redirects with 308 to `/support`.
- Retired `/owner-reliability` redirects with 307 to `/owner-dashboard`, already noindex.
- `/barista-jobs`, `/barista-jobs/miami-fl`, `/barista-jobs/fort-lauderdale-fl`, `/hire-baristas` and a deliberately nonexistent path all return genuine 404s. There is no observed homepage fallback soft-404 for those samples.
- `vercel.json` already sets `cleanUrls: true` and `trailingSlash: false`. Keep those routing rules. The new sitemap uses only final URLs, no signup parameters, private routes or fragments. No speculative lastmod timestamps are supplied.

## Content, headings and public jobs

The homepage delivers its principal copy in HTML and has one H1, a title, a description and useful role-specific signup links. Navigation's “For Baristas” and “For Cafés” are section anchors, not separate indexable landing pages. Its headings describe the product, not a local vacancy inventory. Avoid changing the approved visible design or stuffing city names into headings merely for SEO.

The homepage's Cafe Feliz card is a static illustration with no verified job record or public detail URL. It is ineligible for JobPosting markup. No JSON-LD was found on the 24 root pages. `dashboard.html` fetches jobs after a session check; the job-detail experience is inside the authenticated dashboard. Source policies assign job SELECT access to `authenticated`, then apply owner/active/participant and other authorization rules. This is not a public job feed. Deployed database policy and current job inventory were not inspected.

## Performance and indexing limitations

The current homepage HTML is 34,900 bytes. The large PNG hero is an optimization candidate; CSS already controls image geometry, so absent HTML dimensions alone do not prove layout shift. Request timings in the evidence include the audit network and are neither representative user timings nor CWV scores.

The repository contains an old desktop Lighthouse summary dated 2026-08-27 (performance 81, accessibility 92, SEO 100). It is historical evidence, not a current mobile baseline or proof of Google index coverage. A current field baseline requires Search Console/CrUX if there is enough traffic; otherwise record insufficient data and use a repeatable mobile lab run separately. Do not launch the historical quality-audit workflow just to read metrics: it commits a result back to main.

Google guidance: [robots versus indexing](https://developers.google.com/search/docs/crawling-indexing/robots/intro), [noindex](https://developers.google.com/search/docs/crawling-indexing/block-indexing), [sitemaps](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap).
