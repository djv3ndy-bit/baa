from __future__ import annotations

import asyncio
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol

from era.collectors.base import ReadOnlyCollector
from era.collectors.github import GitHubCollector
from era.collectors.health import HealthCollector
from era.collectors.supabase import SupabaseCollector
from era.collectors.vercel import VercelCollector
from era.models import Environment, EvidenceSource, IncidentEvidence, RecentChange
from era.providers.github import GitHubApiSource
from era.providers.supabase import SupabaseManagementSource
from era.providers.vercel import VercelApiSource
from era.redaction import sanitize_evidence_batch, sanitize_text


_LOOKBACK = re.compile(r"([1-9][0-9]*)([mh])")
_PROVIDERS = frozenset({"github", "health", "supabase", "vercel"})


class GitHubLiveCollector(Protocol):
    async def collect(self) -> Sequence[IncidentEvidence]: ...

    async def collect_changes(self) -> Sequence[RecentChange]: ...


@dataclass(frozen=True, slots=True)
class NamedCollector:
    provider: str
    collector: ReadOnlyCollector = field(repr=False)


@dataclass(frozen=True, slots=True)
class CollectionFailure:
    provider: str
    operation: str
    error_type: str

    def to_dict(self) -> dict[str, str]:
        return {
            "provider": self.provider,
            "operation": self.operation,
            "error_type": self.error_type,
        }


@dataclass(frozen=True, slots=True)
class LiveCollectionPlan:
    provider_names: tuple[str, ...]
    environment: Environment
    evidence_collectors: tuple[NamedCollector, ...] = field(repr=False)
    github_collector: GitHubLiveCollector | None = field(default=None, repr=False)


@dataclass(frozen=True, slots=True)
class LiveCollectionResult:
    providers: tuple[str, ...]
    evidence: tuple[IncidentEvidence, ...]
    changes: tuple[RecentChange, ...]
    failures: tuple[CollectionFailure, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "mode": "read_only",
            "model_used": False,
            "production_writes_enabled": False,
            "providers": list(self.providers),
            "collection_failures": [item.to_dict() for item in self.failures],
            "evidence": [item.to_dict() for item in self.evidence],
            "changes": [
                {
                    "sha": item.sha,
                    "committed_at": item.committed_at.isoformat().replace(
                        "+00:00", "Z"
                    ),
                    "title": sanitize_text(item.title, max_length=200),
                    "files": [
                        sanitize_text(path, max_length=300) for path in item.files[:100]
                    ],
                }
                for item in self.changes
            ],
        }


def _required(environment: Mapping[str, str], key: str) -> str:
    value = environment.get(key, "").strip()
    if not value:
        raise RuntimeError(f"{key} is required for the selected read-only provider")
    return value


def parse_lookback_minutes(value: str) -> int:
    match = _LOOKBACK.fullmatch(value)
    if not match:
        raise ValueError("Lookback must use a value such as 30m or 1h")
    amount = int(match.group(1))
    minutes = amount if match.group(2) == "m" else amount * 60
    if minutes > 1_440:
        raise ValueError("Lookback cannot exceed 24 hours")
    return minutes


def build_live_plan(
    *,
    provider_names: Sequence[str],
    environment_name: str,
    environment: Mapping[str, str],
    health_urls: Sequence[str] = (),
    supabase_services: Sequence[str] = (),
    limit: int = 25,
    lookback: str = "1h",
) -> LiveCollectionPlan:
    providers = tuple(dict.fromkeys(provider_names))
    if not providers or any(name not in _PROVIDERS for name in providers):
        raise ValueError("At least one supported provider must be selected")
    if not 1 <= limit <= 100:
        raise ValueError("Collection limit must be between 1 and 100")
    target_environment = Environment(environment_name)
    if target_environment not in {Environment.PRODUCTION, Environment.PREVIEW}:
        raise ValueError("Live collection is limited to production or preview")

    lookback_minutes = parse_lookback_minutes(lookback)
    evidence_collectors: list[NamedCollector] = []
    github_collector: GitHubLiveCollector | None = None

    if "health" in providers:
        if not health_urls:
            raise RuntimeError("At least one --health-url is required")
        allowed_hosts = frozenset(
            host.strip().lower()
            for host in environment.get("ERA_ALLOWED_HEALTH_HOSTS", "").split(",")
            if host.strip()
        )
        if not allowed_hosts:
            raise RuntimeError("ERA_ALLOWED_HEALTH_HOSTS is required for health checks")
        evidence_collectors.extend(
            NamedCollector(
                "health",
                HealthCollector(
                    url,
                    allowed_hosts,
                    environment=target_environment,
                ),
            )
            for url in health_urls
        )

    if "github" in providers:
        repository = _required(environment, "GITHUB_REPOSITORY")
        github_source = GitHubApiSource(environment.get("GITHUB_READ_TOKEN") or None)
        github_collector = GitHubCollector(
            github_source,
            repository,
            limit=limit,
        )

    if "vercel" in providers:
        vercel_source = VercelApiSource(
            _required(environment, "VERCEL_READ_TOKEN"),
            team_id=_required(environment, "VERCEL_TEAM_ID"),
        )
        evidence_collectors.append(
            NamedCollector(
                "vercel",
                VercelCollector(
                    vercel_source,
                    _required(environment, "VERCEL_PROJECT_ID"),
                    environment=target_environment,
                    since=lookback,
                    limit=limit,
                ),
            )
        )

    if "supabase" in providers:
        if target_environment is not Environment.PRODUCTION:
            raise RuntimeError("Supabase log collection must be labeled production")
        if not supabase_services:
            raise RuntimeError("At least one --supabase-service is required")
        supabase_source = SupabaseManagementSource(
            _required(environment, "SUPABASE_READ_ONLY_TOKEN"),
            lookback_minutes=lookback_minutes,
        )
        evidence_collectors.append(
            NamedCollector(
                "supabase",
                SupabaseCollector(
                    supabase_source,
                    _required(environment, "SUPABASE_PROJECT_REF"),
                    services=supabase_services,
                    limit=limit,
                ),
            )
        )

    return LiveCollectionPlan(
        provider_names=providers,
        environment=target_environment,
        evidence_collectors=tuple(evidence_collectors),
        github_collector=github_collector,
    )


async def run_live_plan(plan: LiveCollectionPlan) -> LiveCollectionResult:
    task_specs: list[tuple[str, str, Any]] = [
        (item.provider, "evidence", item.collector.collect())
        for item in plan.evidence_collectors
    ]
    if plan.github_collector:
        task_specs.extend(
            (
                ("github", "evidence", plan.github_collector.collect()),
                ("github", "changes", plan.github_collector.collect_changes()),
            )
        )

    results = await asyncio.gather(
        *(task for _, _, task in task_specs), return_exceptions=True
    )
    evidence: list[IncidentEvidence] = []
    changes: list[RecentChange] = []
    failures: list[CollectionFailure] = []
    for index, ((provider, operation, _), result) in enumerate(
        zip(task_specs, results, strict=True)
    ):
        if isinstance(result, BaseException) and not isinstance(result, Exception):
            raise result
        if isinstance(result, Exception):
            failure = CollectionFailure(provider, operation, type(result).__name__)
            failures.append(failure)
            evidence.append(
                IncidentEvidence(
                    id=f"collection-{provider}-{operation}-{index}",
                    source=EvidenceSource(provider),
                    occurred_at=datetime.now(UTC),
                    summary="Read-only provider collection failed",
                    environment=plan.environment,
                    metadata={
                        "collection_failed": True,
                        "degraded": True,
                        "operation": operation,
                        "error_type": failure.error_type,
                    },
                )
            )
        elif operation == "changes":
            changes.extend(result)
        else:
            evidence.extend(result)

    sanitized = tuple(sanitize_evidence_batch(evidence))
    return LiveCollectionResult(
        providers=plan.provider_names,
        evidence=sanitized,
        changes=tuple(changes),
        failures=tuple(failures),
    )
