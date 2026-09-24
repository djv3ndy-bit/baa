# Issue #62 — first SEO milestone

Prepared 2026-09-24. Foundation released after owner direction to make the website discoverable on Google. Related issue: https://github.com/djv3ndy-bit/baa/issues/62

This is a technical-foundation PR and a proposed local-marketplace plan. It does not publish city pages or jobs. The owner-approved design, native app, authentication, billing, database policies and user data are unchanged. Keep issue #62 open for architecture review and the subsequent public-job work.

## Deliverables

| Deliverable | File | State |
| --- | --- | --- |
| Current source/live baseline, route inventory and priorities | [baseline.md](baseline.md) | Captured; findings reviewed against source |
| Reproducible timestamped public HTTP evidence | [baseline-2026-09-24.json](baseline-2026-09-24.json) | 40 requests; no credentials or private data |
| Miami/Fort Lauderdale architecture and quality gates | [local-architecture.md](local-architecture.md) | Proposed; owner review outstanding |
| Genuine JobPosting data contract and expiry strategy | [jobposting-strategy.md](jobposting-strategy.md) | Documented; deliberately not activated |
| Measurement, release checklist and rollback | [release-and-measurement.md](release-and-measurement.md) | Ready for review |
| Sitemap, robots, canonical/social tags, utility noindex | Root website files | Implemented on PR branch only |

## Current owner direction

The owner has deferred all public job and city job pages. For now, job browsing stays behind sign-in/sign-up on both web and app. A future browse-first experience is an idea only, not approved implementation scope. The JobPosting and local architecture documents are deferred proposals.

PR #68 passed all five GitHub workflows and was merged as `e94d4446fc2200aa96093beaa81be0d6e5156c21`. The follow-up adds only the actual Google-issued homepage verification tag for the canonical HTTPS www Search Console property; no job data is exposed. Search Console verification, submission and indexing status must be confirmed from its interface, not inferred from the presence of the tag.

## Original review decisions

1. Review and merge the foundation only after CI and the release checklist pass.
2. Review the proposed two-city architecture. The city slugs are reserved in the plan, not created or submitted for indexing.
3. Before another implementation PR, approve a narrowly scoped public job projection and employer publication policy. Existing signed-in job data is not blanket permission to publish it on Google.

## Checks performed locally

- `node --test tests/seo.test.mjs`: 6/6 pass.
- `node launch-check.js`: pass.
- `npm run test:accounts`: 76/76 pass; synthetic fixtures, no live account mutations.
- Python XML parser: valid sitemap with five canonical URLs.
- Compared all eleven edited HTML files with base commit `3ce3f1982103da1c50074e54523c7234856a6b86`: content following `</head>`, every style block and every script block are identical. There are no stylesheet, application script, image, native app or database edits.

Local Node was v24.19.0; the dedicated SEO CI job uses the repository's Node 22 target. Full mobile builds, live account journeys, rendered preview checks, Google URL Inspection and Rich Results Test were not run locally. No JobPosting markup was introduced, so this PR makes no claim of job rich-result validation.

The added CI job has read-only repository permissions, no secrets and no deployment steps. Vercel may create its normal branch preview; production merge/deployment is not part of this work.
