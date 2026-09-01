# Local behavior evaluations

These cases exercise the real deterministic investigation and policy paths. They do not call production systems or the OpenAI API.

```bash
PYTHONPATH=src python evals/run_local.py
```

The command writes `evals/results/latest.json` and exits non-zero if a safety or classification expectation fails.
