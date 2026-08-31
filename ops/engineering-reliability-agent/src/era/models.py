from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
import re
from typing import Any, Mapping


class Severity(StrEnum):
    P0 = "P0"
    P1 = "P1"
    P2 = "P2"
    P3 = "P3"


class EvidenceSource(StrEnum):
    HEALTH = "health"
    VERCEL = "vercel"
    GITHUB = "github"
    SUPABASE = "supabase"
    APPLICATION = "application"


class Environment(StrEnum):
    PRODUCTION = "production"
    PREVIEW = "preview"
    DEVELOPMENT = "development"
    UNKNOWN = "unknown"


def _parse_datetime(value: Any) -> datetime:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    else:
        raise ValueError("occurred_at must be an ISO-8601 timestamp")
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


@dataclass(frozen=True, slots=True)
class IncidentEvidence:
    id: str
    source: EvidenceSource
    occurred_at: datetime
    summary: str
    environment: Environment = Environment.UNKNOWN
    route: str | None = None
    status_code: int | None = None
    deployment_id: str | None = None
    commit_sha: str | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> "IncidentEvidence":
        return cls(
            id=str(value["id"]),
            source=EvidenceSource(str(value["source"])),
            occurred_at=_parse_datetime(value["occurred_at"]),
            summary=str(value["summary"]),
            environment=Environment(str(value.get("environment", "unknown"))),
            route=str(value["route"]) if value.get("route") is not None else None,
            status_code=int(value["status_code"])
            if value.get("status_code") is not None
            else None,
            deployment_id=(
                str(value["deployment_id"])
                if value.get("deployment_id") is not None
                else None
            ),
            commit_sha=str(value["commit_sha"])
            if value.get("commit_sha") is not None
            else None,
            metadata=dict(value.get("metadata") or {}),
        )

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["source"] = self.source.value
        value["environment"] = self.environment.value
        value["occurred_at"] = self.occurred_at.isoformat().replace("+00:00", "Z")
        return value


@dataclass(frozen=True, slots=True)
class RecentChange:
    sha: str
    committed_at: datetime
    title: str
    files: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if not re.fullmatch(r"[0-9a-fA-F]{7,64}", self.sha):
            raise ValueError(
                "Recent change SHA must be a hexadecimal commit identifier"
            )

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> "RecentChange":
        return cls(
            sha=str(value["sha"]),
            committed_at=_parse_datetime(value["committed_at"]),
            title=str(value.get("title") or "Untitled change"),
            files=tuple(str(item) for item in value.get("files") or ()),
        )


@dataclass(frozen=True, slots=True)
class Correlation:
    evidence_id: str
    commit_sha: str
    score: float
    reasons: tuple[str, ...]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class SeverityDecision:
    severity: Severity
    reasons: tuple[str, ...]
    suppressed: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "severity": self.severity.value,
            "reasons": list(self.reasons),
            "suppressed": self.suppressed,
        }


@dataclass(slots=True)
class IncidentAssessment:
    severity: str
    title: str
    summary: str
    likely_cause: str
    evidence_ids: list[str]
    recommended_actions: list[str]
    requires_owner_approval: bool

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
