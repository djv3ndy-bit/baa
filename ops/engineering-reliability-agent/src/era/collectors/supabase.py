from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from typing import Any, Protocol

from era.models import Environment, EvidenceSource, IncidentEvidence


class SupabaseReadSource(Protocol):
    async def get_logs(
        self, project_ref: str, *, service: str, limit: int
    ) -> Sequence[Mapping[str, Any]]: ...


class SupabaseCollector:
    ALLOWED_SERVICES = frozenset(
        {"api", "postgres", "auth", "storage", "realtime", "edge-function"}
    )

    def __init__(
        self,
        source: SupabaseReadSource,
        project_ref: str,
        *,
        services: Sequence[str] = ("api", "postgres", "auth"),
        limit: int = 50,
    ) -> None:
        selected = tuple(services)
        if not selected or any(
            service not in self.ALLOWED_SERVICES for service in selected
        ):
            raise ValueError("Supabase collector requested an unsupported service")
        if limit < 1 or limit > 100:
            raise ValueError("Supabase collector limit must be between 1 and 100")
        self._source = source
        self._project_ref = project_ref
        self._services = selected
        self._limit = limit

    async def collect(self) -> list[IncidentEvidence]:
        evidence: list[IncidentEvidence] = []
        for service in self._services:
            logs = await self._source.get_logs(
                self._project_ref,
                service=service,
                limit=self._limit,
            )
            for index, item in enumerate(logs):
                status_code = item.get("status_code")
                level = str(item.get("level") or "").lower()
                if level not in {"error", "fatal"} and not (
                    status_code and int(status_code) >= 500
                ):
                    continue
                evidence.append(
                    IncidentEvidence.from_mapping(
                        {
                            "id": item.get("id") or f"supabase-{service}-{index}",
                            "source": EvidenceSource.SUPABASE.value,
                            "occurred_at": item.get("occurred_at")
                            or datetime.now(UTC).isoformat(),
                            "summary": item.get("summary")
                            or f"Supabase {service} error",
                            "environment": Environment.PRODUCTION.value,
                            "route": item.get("route"),
                            "status_code": status_code,
                            "metadata": {
                                "service": service,
                                "error_count": item.get("count", 1),
                            },
                        }
                    )
                )
        return evidence
