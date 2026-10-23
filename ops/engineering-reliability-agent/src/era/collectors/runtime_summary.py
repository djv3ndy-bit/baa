from __future__ import annotations

from era.models import Environment, EvidenceSource, IncidentEvidence
from era.providers.runtime_summary import RuntimeSummarySource


class RuntimeSummaryCollector:
    def __init__(self, source: RuntimeSummarySource, project_id: str, *, environment: Environment,
                 since: str):
        self._source, self._project, self._environment, self._since = source, project_id, environment, since

    async def collect(self) -> list[IncidentEvidence]:
        summary = await self._source.read(self._project, self._environment.value, self._since)
        evidence = []
        for category, kind, label in (
            ("runtime_error", "error", "Runtime error events observed"),
            ("runtime_fatal", "fatal", "Runtime fatal events observed"),
            ("http_5xx", "http5xx", "Runtime HTTP server-error events observed"),
        ):
            count = summary.counts[category]
            if count:
                evidence.append(IncidentEvidence(
                    id="runtime-summary-" + kind, source=EvidenceSource.VERCEL,
                    occurred_at=summary.until, summary=label, environment=Environment.PRODUCTION,
                    status_code=500 if kind == "http5xx" else None,
                    metadata={"runtime_summary_kind": kind, "runtime_summary_project_id": self._project,
                              "error_count": count},
                ))
        return evidence
