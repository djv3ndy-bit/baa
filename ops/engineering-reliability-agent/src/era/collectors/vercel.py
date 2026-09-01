from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from typing import Any, Protocol

from era.models import Environment, EvidenceSource, IncidentEvidence


class VercelReadSource(Protocol):
    async def list_failed_deployments(
        self, project_id: str, *, environment: str, since: str, limit: int
    ) -> Sequence[Mapping[str, Any]]: ...

    async def list_runtime_errors(
        self, project_id: str, *, environment: str, since: str, limit: int
    ) -> Sequence[Mapping[str, Any]]: ...


class VercelCollector:
    def __init__(
        self,
        source: VercelReadSource,
        project_id: str,
        *,
        environment: Environment = Environment.PRODUCTION,
        since: str = "1h",
        limit: int = 50,
    ) -> None:
        if limit < 1 or limit > 100:
            raise ValueError("Vercel collector limit must be between 1 and 100")
        self._source = source
        self._project_id = project_id
        self._environment = environment
        self._since = since
        self._limit = limit

    async def collect(self) -> list[IncidentEvidence]:
        deployments = await self._source.list_failed_deployments(
            self._project_id,
            environment=self._environment.value,
            since=self._since,
            limit=self._limit,
        )
        errors = await self._source.list_runtime_errors(
            self._project_id,
            environment=self._environment.value,
            since=self._since,
            limit=self._limit,
        )
        evidence: list[IncidentEvidence] = []
        for index, item in enumerate(deployments):
            evidence.append(
                IncidentEvidence.from_mapping(
                    {
                        "id": item.get("id") or f"vercel-deployment-{index}",
                        "source": EvidenceSource.VERCEL.value,
                        "occurred_at": item.get("occurred_at")
                        or datetime.now(UTC).isoformat(),
                        "summary": item.get("summary") or "Vercel deployment failed",
                        "environment": self._environment.value,
                        "deployment_id": item.get("deployment_id"),
                        "commit_sha": item.get("commit_sha"),
                        "metadata": {
                            "deployment_failed": True,
                            "state": item.get("state"),
                        },
                    }
                )
            )
        for index, item in enumerate(errors):
            evidence.append(
                IncidentEvidence.from_mapping(
                    {
                        "id": item.get("id") or f"vercel-runtime-{index}",
                        "source": EvidenceSource.VERCEL.value,
                        "occurred_at": item.get("occurred_at")
                        or datetime.now(UTC).isoformat(),
                        "summary": item.get("summary") or "Vercel runtime error",
                        "environment": self._environment.value,
                        "route": item.get("route"),
                        "status_code": item.get("status_code"),
                        "deployment_id": item.get("deployment_id"),
                        "commit_sha": item.get("commit_sha"),
                        "metadata": {"error_count": item.get("count", 1)},
                    }
                )
            )
        return evidence
