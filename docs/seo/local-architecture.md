# Proposed local page architecture

Status: proposed for owner review under #62; no routes in this plan are published by the foundation PR. Current inventory is **unknown**, not zero. There is no anonymous approved job dataset yet.

## Small, useful page set

| Route | Purpose and distinct value | Indexing gate |
| --- | --- | --- |
| `/barista-jobs` | Browse genuine public openings, select Miami or Fort Lauderdale, understand how applying works | Approved public projection, usable inventory and links to individual jobs |
| `/barista-jobs/miami-fl` | Jobs with verified workplace city Miami, FL; actual pay/schedule details; locally relevant employer-reviewed guidance | Distinct helpful content and real, current inventory; editorial review required |
| `/barista-jobs/fort-lauderdale-fl` | Separate Fort Lauderdale workplace inventory and guidance drawn from those employers | Same gate; do not clone Miami copy and substitute the city name |
| `/jobs/{stable-public-id}` | One genuine vacancy with full description, named employer, workplace, pay where supplied, schedule, application action and status | Employer permits public publication; safe data contract and freshness checks pass |
| `/hire-baristas` | One shared café hiring guide explaining the verified posting/matching process in the two launch markets | Owner-approved factual copy, a useful hiring checklist, and accurate account/pricing flow |

Initially, use the homepage's existing café section for hiring intent. Do not create two near-identical city hiring pages. Add a shared hiring guide only if it offers more than the homepage. Preserve existing café and barista signup parameters and working auth/dashboard job links.

## City content acceptance brief

Each city page must contain actual openings or independently useful, maintained local guidance; this proposed first launch requires both. No arbitrary word-count or job-count target makes thin content valuable.

- City-specific inventory from normalized workplace city/state; link each displayed opening to a public detail URL. Never infer nearby inventory from a substring or postcode radius. Existing tests distinguish Miami from Miami Beach and Miami Gardens; preserve that distinction. Any expanded metro coverage must be explicitly labeled and reviewed separately.
- For each listed role, show only approved employer facts: job title, café name, city, schedule and supplied pay. Count only currently eligible jobs. Do not present example/test records, candidate profiles or estimates as vacancies.
- Helpful local guidance based on verified employer information: which shift start times apply, whether experience/training is offered, and where the advertised workplaces actually are. Source transit/commute advice before adding it; do not invent neighborhood demand, salary averages or hiring urgency.
- A short explanation of applying and what profile information is needed, with the correct barista signup action. Preserve the selected job through authentication before claiming a seamless application flow.
- A visible last-reviewed date only when someone actually reviewed the local content. Link to the sibling city as a genuine alternative, clearly labeled with the other city's name.

Use the approved header/footer, typography, palette, spacing and cards. No global CSS replacement or homepage redesign. Build the later pages as server-rendered or reliably generated HTML so listings and details exist without login/JavaScript; current static hosting has no public-job renderer, so that work needs a separate implementation PR.

## Empty and stale content

- Before launch: keep unfinished drafts in repository documents. No placeholder “jobs coming soon” city URLs in the sitemap.
- If inventory later reaches zero, show an honest zero-opening state and real alternatives. Retain indexability only while the page independently provides substantial maintained local value; otherwise use noindex and remove it from the sitemap. Reindex after inventory/content review, not just because a count becomes positive.
- Filters, sort orders, role/signup parameters, arbitrary city queries and neighborhood permutations must not generate indexable pages. Define the two accepted city slugs explicitly; unknown city paths return 404.
- Do not redirect a closed job to the homepage or turn its URL into another vacancy. Preserve the stable identity and follow the closure policy in [jobposting-strategy.md](jobposting-strategy.md).

## Internal links when later pages are ready

Add a restrained text link within the existing footer to the job index and shared hiring guide. The job index links to the two city pages; city pages link to genuine details; details link back to their own city and the job index. Every link must be a real HTML anchor to a working canonical URL. No new links go live before the destination passes its gate. Add descriptive titles, descriptions, one H1 and self-canonicals to each new page; never put JobPosting schema on the index or city lists.

## Review outcome for this milestone

Engineering review recommendation: technical foundations first; defer public jobs and city pages until publication consent, expiry handling and privacy tests exist. Owner acceptance of this architecture is still outstanding. The safe foundation PR does not imply approval of a new public data surface.
