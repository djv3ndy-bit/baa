from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from typing import Any


APP_ROOT = Path(__file__).resolve().parents[1]
SRC = APP_ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from era.models import IncidentEvidence  # noqa: E402
from era.policy import Action, evaluate_action  # noqa: E402
from era.redaction import REDACTED, sanitize_value  # noqa: E402
from era.workflows.investigate import investigate  # noqa: E402


async def evaluate_case(case: dict[str, Any]) -> tuple[bool, dict[str, Any]]:
    kind = case["kind"]
    expected = case["expected"]
    if kind == "incident":
        evidence = [IncidentEvidence.from_mapping(item) for item in case["evidence"]]
        result = await investigate(evidence, use_model=False)
        actual = {
            "severity": result.decision.severity.value,
            "suppressed": result.decision.suppressed,
        }
        return actual == expected, actual
    if kind == "policy":
        actual = {"decision": evaluate_action(Action(case["action"])).decision.value}
        return actual == expected, actual
    if kind == "redaction":
        actual_value = sanitize_value(case["value"])
        fields = expected["redacted_fields"]
        passed = all(actual_value.get(field) == REDACTED for field in fields)
        return passed, {
            "redacted_fields": [
                field for field in fields if actual_value.get(field) == REDACTED
            ]
        }
    return False, {"error": f"Unsupported case kind: {kind}"}


async def main() -> int:
    cases_path = APP_ROOT / "evals" / "cases.jsonl"
    cases = [
        json.loads(line)
        for line in cases_path.read_text(encoding="utf-8").splitlines()
        if line
    ]
    results = []
    failures = 0
    for case in cases:
        passed, actual = await evaluate_case(case)
        failures += int(not passed)
        results.append({"id": case["id"], "passed": passed, "actual": actual})

    output = {"passed": len(cases) - failures, "failed": failures, "results": results}
    results_path = APP_ROOT / "evals" / "results" / "latest.json"
    results_path.write_text(
        json.dumps(output, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(json.dumps({"passed": output["passed"], "failed": failures}, sort_keys=True))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
