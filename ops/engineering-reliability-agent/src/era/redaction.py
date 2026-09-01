from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import replace
from typing import Any

from .models import IncidentAssessment, IncidentEvidence


REDACTED = "[REDACTED]"
MAX_TEXT_LENGTH = 4_000

_SENSITIVE_FIELDS = {
    "access_token",
    "api_key",
    "apikey",
    "authorization",
    "body",
    "client_secret",
    "cookie",
    "database_url",
    "email",
    "ip",
    "ip_address",
    "jwt",
    "message_body",
    "password",
    "payload",
    "query",
    "refresh_token",
    "request_body",
    "response_body",
    "secret",
    "service_key",
    "set_cookie",
    "token",
    "user_id",
}

_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+\-/]+=*"), "Bearer [REDACTED]"),
    (re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b"), REDACTED),
    (re.compile(r"\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}\b"), REDACTED),
    (
        re.compile(r"\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{16,}\b"),
        REDACTED,
    ),
    (
        re.compile(
            r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\b"
        ),
        REDACTED,
    ),
    (re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE), REDACTED),
    (re.compile(r"(?<![\w:])(?:\d{1,3}\.){3}\d{1,3}(?![\w:])"), REDACTED),
    (re.compile(r"(?i)(https?://[^\s?#]+)\?[^\s#]*"), r"\1?[REDACTED]"),
    (
        re.compile(
            r"(?i)\b(authorization|cookie|password|secret|token|api[_-]?key)\b\s*[:=]\s*[^\s,;]+"
        ),
        r"\1=[REDACTED]",
    ),
)

_FORBIDDEN_RECOMMENDATION = re.compile(
    r"(?i)\b(push\s+(?:directly\s+)?to\s+main|merge\s+(?:the\s+)?(?:pr|pull request)|"
    r"deploy\s+(?:to\s+)?production|promote\s+(?:the\s+)?deployment|rollback\s+production|"
    r"execute\s+sql|apply\s+(?:the\s+)?migration|delete\s+(?:production\s+)?data|"
    r"modify\s+(?:supabase\s+)?rls|change\s+authentication|read\s+(?:the\s+)?secret|"
    r"invoke\s+(?:the\s+)?account[- ]deletion)\b"
)


def sanitize_text(value: str, *, max_length: int = MAX_TEXT_LENGTH) -> str:
    sanitized = value
    for pattern, replacement in _PATTERNS:
        sanitized = pattern.sub(replacement, sanitized)
    if len(sanitized) > max_length:
        sanitized = f"{sanitized[:max_length]}...[TRUNCATED]"
    return sanitized


def sanitize_identifier(value: str, *, max_length: int = 120) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._:-]", "_", value[:max_length])
    return cleaned or "unknown"


def _normalized_key(value: Any) -> str:
    return str(value).lower().replace("-", "_")


def sanitize_value(value: Any, *, field_name: str | None = None) -> Any:
    if field_name and _normalized_key(field_name) in _SENSITIVE_FIELDS:
        return REDACTED
    if isinstance(value, str):
        return sanitize_text(value)
    if isinstance(value, Mapping):
        return {
            str(key): sanitize_value(item, field_name=str(key))
            for key, item in value.items()
        }
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [sanitize_value(item) for item in value]
    if isinstance(value, (bool, int, float)) or value is None:
        return value
    return sanitize_text(str(value))


def sanitize_evidence(evidence: IncidentEvidence) -> IncidentEvidence:
    commit_sha = evidence.commit_sha
    if commit_sha and not re.fullmatch(r"[0-9a-fA-F]{7,64}", commit_sha):
        commit_sha = None
    return replace(
        evidence,
        id=sanitize_identifier(evidence.id),
        summary=sanitize_text(evidence.summary),
        route=sanitize_text(evidence.route, max_length=300) if evidence.route else None,
        deployment_id=sanitize_text(evidence.deployment_id, max_length=200)
        if evidence.deployment_id
        else None,
        commit_sha=commit_sha,
        metadata=sanitize_value(evidence.metadata),
    )


def sanitize_evidence_batch(
    evidence: Sequence[IncidentEvidence],
) -> list[IncidentEvidence]:
    return [sanitize_evidence(item) for item in evidence]


def sanitize_assessment(assessment: IncidentAssessment) -> IncidentAssessment:
    owner_approval = bool(assessment.requires_owner_approval)
    recommendations: list[str] = []
    for raw_item in assessment.recommended_actions[:8]:
        item = sanitize_text(str(raw_item), max_length=600)
        if _FORBIDDEN_RECOMMENDATION.search(item):
            owner_approval = True
            item = "Escalate to the owner; the requested action is outside the agent's permissions."
        if item not in recommendations:
            recommendations.append(item)
    return IncidentAssessment(
        severity=sanitize_identifier(str(assessment.severity), max_length=10),
        title=sanitize_text(str(assessment.title), max_length=200),
        summary=sanitize_text(str(assessment.summary), max_length=1_500),
        likely_cause=sanitize_text(str(assessment.likely_cause), max_length=1_500),
        evidence_ids=[
            sanitize_identifier(str(value)) for value in assessment.evidence_ids[:100]
        ],
        recommended_actions=recommendations,
        requires_owner_approval=owner_approval,
    )
