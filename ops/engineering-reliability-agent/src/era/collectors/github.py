from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

from era.models import Environment, EvidenceSource, IncidentEvidence, RecentChange


class GitHubReadSource(Protocol):
    async def list_recent_changes(
        self, repository: str, *, limit: int
    ) -> Sequence[Mapping[str, Any]]: ...

    async def list_failed_checks(
        self, repository: str, *, limit: int
    ) -> Sequence[Mapping[str, Any]]: ...


class GitHubCollector:
    def __init__(
        self,
        source: GitHubReadSource,
        repository: str,
        *,
        limit: int = 25,
        lookback_minutes: int | None = None,
    ) -> None:
        if limit < 1 or limit > 100:
            raise ValueError("GitHub collector limit must be between 1 and 100")
        if lookback_minutes is not None and not 1 <= lookback_minutes <= 1_440:
            raise ValueError("GitHub lookback must be between 1 and 1440 minutes")
        self._source = source
        self._repository = repository
        self._limit = limit
        self._lookback_minutes = lookback_minutes

    async def collect_changes(self) -> list[RecentChange]:
        values = await self._source.list_recent_changes(
            self._repository, limit=self._limit
        )
        return [RecentChange.from_mapping(value) for value in values]

    async def collect(self) -> list[IncidentEvidence]:
        failures = await self._source.list_failed_checks(
            self._repository, limit=self._limit
        )
        evidence: list[IncidentEvidence] = []
        cutoff = (
            datetime.now(UTC) - timedelta(minutes=self._lookback_minutes)
            if self._lookback_minutes is not None
            else None
        )
        for index, failure in enumerate(failures):
            occurred_at = failure.get("occurred_at") or datetime.now(UTC).isoformat()
            item = IncidentEvidence.from_mapping(
                {
                    "id": failure.get("id") or f"github-{index}",
                    "source": EvidenceSource.GITHUB.value,
                    "occurred_at": occurred_at,
                    "summary": failure.get("summary") or "GitHub check failed",
                    "environment": failure.get("environment")
                    or Environment.UNKNOWN.value,
                    "commit_sha": failure.get("commit_sha"),
                    "metadata": {
                        "check_name": failure.get("check_name"),
                        "conclusion": failure.get("conclusion"),
                    },
                }
            )
            if cutoff is None or item.occurred_at >= cutoff:
                evidence.append(item)
        return evidence
