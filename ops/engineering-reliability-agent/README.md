# Engineering & Reliability Agent

This package is the safety-first control plane for BaristaMatch incident investigation. The foundation release accepts sanitized evidence, applies deterministic incident rules, correlates failures with recent changes, and optionally asks one OpenAI Agents SDK agent to explain the likely cause and next steps.

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

Collectors depend on narrow read-only provider interfaces. Their production adapters will be wired in a later, separately reviewed phase.

- GitHub: metadata, commits, changed paths, Actions status, and pull-request reads. No administration, workflows, secrets, deployments, merges, or `main` writes.
- Vercel: project-scoped deployment, build-log, and bounded runtime-error reads. No deployment token or promotion capability.
- Supabase: project-scoped log and advisor reads only. No service key, SQL, migrations, branch merge/reset, Auth administration, RLS, or database write tools.
- Health: HTTPS `GET` requests only, exact host allowlist, no credentials, query strings, or redirects.

All provider records pass through field-level and pattern-based redaction before they can be stored, prompted, or included in a pull request.

## Runtime modes

- `dry-run`: deterministic classification and correlation; no model or network call.
- `analyze`: the same deterministic path plus one model-generated explanation.
- `serve`: readiness endpoint only in this foundation release.

Branch creation, code patching, test execution, draft PR creation, preview verification, and post-deployment observation are intentionally deferred until their dedicated tools and approval checks receive separate review.
