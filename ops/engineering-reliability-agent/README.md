# Engineering & Reliability Agent

This package is the safety-first control plane for BaristaMatch incident investigation and owner-controlled response. It accepts sanitized evidence, applies deterministic incident rules, correlates failures with recent changes, builds a review-only response package, and can send an explicitly owner-approved P0/P1 alert. One optional OpenAI Agents SDK analysis may explain the likely cause and next steps, but recurring monitoring and alerting remain model-free.

It does **not** connect to production by default and exposes no tool that can merge code, deploy, execute SQL, change authentication, change RLS, delete data, or read secrets.

## Foundation contract

Inputs:

- Health, Vercel, GitHub, and Supabase evidence supplied by read-only adapters.
- Recent GitHub changes supplied as commit metadata and changed file paths.
- Explicit operational context such as affected routes, duration, and estimated impact.

Outputs:

- A deterministic P0/P1/P2/P3 classification.
- Suppression of declared expected conditions such as paused billing.
- Sanitized evidence and ranked change correlations.
- A constrained incident assessment and owner-approval flag.
- A sanitized response package with an incident fingerprint, affected routes, ranked change correlations, a suggested incident branch, review-gated repair steps, and permanent prohibitions.

The deterministic classifier is authoritative. Model output may improve the explanation but cannot lower the computed severity or unlock a prohibited action.

## Safety boundaries

Always forbidden:

- Push or merge to `main`.
- Deploy, promote, or roll back production.
- Execute SQL or database migrations.
- Delete production data.
- Modify Supabase RLS, database security, Auth, or security configuration.
- Read or expose secrets, cookies, authorization headers, customer messages, or raw request bodies.
- Invoke the account-deletion endpoint.

Owner approval is required before proposing changes to payments, dependencies, deployment configuration, GitHub workflows, migrations, or external communications. Approval creates a review boundary; it does not give this agent a production deployment, merge, SQL, Auth, or RLS capability.

## Local setup

Use Python 3.12 and keep the API key outside the repository.

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -e .
```

Run deterministic tests and evals without making network or OpenAI API calls:

```bash
.venv/bin/python -m unittest discover -s tests -v
PYTHONPATH=src .venv/bin/python evals/run_local.py
```

Run a fixture through the real deterministic investigation path:

```bash
PYTHONPATH=src .venv/bin/python -m era.main dry-run --input evals/sample-incident.json
```

Run an isolated, model-free live collection for the public website and repository:

```bash
ERA_ALLOWED_HEALTH_HOSTS=www.baristajobmatch.com \
GITHUB_REPOSITORY=djv3ndy-bit/baa \
PYTHONPATH=src .venv/bin/python -m era.main collect-live \
  --environment production \
  --provider health \
  --health-url https://www.baristajobmatch.com/ \
  --provider github \
  --lookback 1h \
  --limit 10
```

`collect-live` never calls a model or performs a provider write. Each selected provider fails closed unless its exact allowlist and read-only configuration are present. Vercel and Supabase activation additionally requires dedicated credentials described below; do not reuse website runtime secrets.

Run one complete deterministic monitoring cycle locally:

```bash
ERA_ALLOWED_HEALTH_HOSTS=www.baristajobmatch.com \
GITHUB_REPOSITORY=djv3ndy-bit/baa \
PYTHONPATH=src .venv/bin/python -m era.main monitor \
  --environment production \
  --provider health \
  --health-url https://www.baristajobmatch.com/ \
  --health-url https://www.baristajobmatch.com/api/public-config \
  --provider github \
  --lookback 1h \
  --limit 10
```

The command exits with status `2` for a P0/P1/P2 alert and `0` for P3. Provider collection failures become sanitized P2 degradation evidence, so a broken monitoring integration cannot silently report a healthy cycle. See [Recurring monitoring](docs/recurring-monitoring.md) for the inactive review-gated schedule and credential activation boundary.

Build a deterministic response package from one or more monitoring results:

```bash
GITHUB_REPOSITORY=djv3ndy-bit/baa \
GITHUB_RUN_ID=12345 \
GITHUB_SHA=2cbaa93f47f2e386c6ca4f069590bd6cf79cbe0e \
PYTHONPATH=src .venv/bin/python -m era.main prepare-response \
  --input public-result.json \
  --input private-provider-result.json
```

The package never edits code. It identifies the allowed next steps—incident branch, preview reproduction, minimal fix preparation, allowlisted tests, and a draft pull request—and explicitly disables direct `main` writes and production deployment.

Run the readiness server:

```bash
PORT=8080 PYTHONPATH=src .venv/bin/python -m era.main serve
curl --fail http://127.0.0.1:8080/health
```

The live `analyze` command requires `OPENAI_API_KEY` in the process environment. The application intentionally does not load `.env` files itself. It defaults to the cost-controlled `gpt-5.4-mini` model; set `ERA_MODEL` only when an owner has approved a different model.

```bash
PYTHONPATH=src .venv/bin/python -m era.main analyze --input evals/sample-incident.json
```

## Integrations

Collectors depend on narrow read-only provider interfaces. GET-only provider clients are implemented under `src/era/providers`, but production credentials and runtime wiring remain disabled until a later, separately reviewed phase.

- GitHub: metadata, commits, changed paths, Actions status, and pull-request reads. No administration, workflows, secrets, deployments, merges, or `main` writes.
- Vercel: project-scoped deployment, build-log, and bounded runtime-error reads. No deployment token or promotion capability.
- Supabase: project-scoped log and advisor reads only. No service key, SQL, migrations, branch merge/reset, Auth administration, RLS, or database write tools.
- Health: HTTPS `GET` requests only, exact host allowlist, no credentials, query strings, or redirects.

All provider records pass through field-level and pattern-based redaction before they can be stored, prompted, or included in a pull request.

The shared provider transport enforces HTTPS, exact API-host allowlists, GET-only requests, an eight-second timeout, a one-megabyte response cap, no redirects, and error messages that omit response bodies. Supabase collection uses the analytics log endpoint with fixed ClickHouse queries; it never runs Postgres SQL and does not select raw log messages.

See [Least-privilege integrations](docs/least-privilege-integrations.md) for the required scopes and the owner-approved activation checklist.

## Runtime modes

- `dry-run`: deterministic classification and correlation; no model or network call.
- `analyze`: the same deterministic path plus one model-generated explanation.
- `collect-live`: bounded, sanitized GET-only evidence collection; no model or write operation.
- `monitor`: collection plus deterministic correlation and P0-P3 classification; no model or write operation.
- `prepare-response`: combine sanitized monitor results into an owner-review response package; no model or network operation.
- `notify`: send a P0/P1 owner email only when the repository approval variable and dedicated alert secrets are present. P2/P3 never send email.
- `serve`: readiness endpoint only in this foundation release.

The hourly and post-merge workflows do not create branches or edit code. A response package may be handed to an owner-approved Codex task, which can prepare a separate incident branch, run allowlisted tests, and open a draft pull request. Merge and production deployment remain owner-only. Every approved merge triggers a model-free post-deployment run that first confirms the exact reviewed commit is `READY` through the read-only Vercel API.
