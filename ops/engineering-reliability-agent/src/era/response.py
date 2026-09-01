from __future__ import annotations

import hashlib
import json
import re
from dataclasses import asdict, dataclass
from typing import Any, Mapping, Sequence

from .models import Severity
from .redaction import sanitize_identifier, sanitize_text, sanitize_value


_SEVERITY_RANK = {
    Severity.P0: 0,
    Severity.P1: 1,
    Severity.P2: 2,
    Severity.P3: 3,
}
_SHA = re.compile(r"[0-9a-fA-F]{7,64}")
_PROHIBITED_ACTIONS = (
    "push_main",
    "merge_pull_request",
    "deploy_or_promote_production",
    "execute_sql_or_apply_migration",
    "delete_production_data",
    "modify_supabase_rls_or_auth",
    "read_or_write_secrets",
)


@dataclass(frozen=True, slots=True)
class ResponsePackage:
    severity: str
    status: str
    incident: bool
    fingerprint: str
    title: str
    summary: str
    likely_cause: str
    evidence_ids: tuple[str, ...]
    affected_routes: tuple[str, ...]
    change_correlations: tuple[dict[str, Any], ...]
    collection_failures: tuple[dict[str, str], ...]
    recommended_actions: tuple[str, ...]
    alert: dict[str, Any]
    repair: dict[str, Any]
    verification: dict[str, Any]
    source: dict[str, str]

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        for key in (
            "evidence_ids",
            "affected_routes",
            "change_correlations",
            "collection_failures",
            "recommended_actions",
        ):
            value[key] = list(value[key])
        return value


def _severity(value: Any, *, fallback: Severity = Severity.P2) -> Severity:
    try:
        return Severity(str(value))
    except ValueError:
        return fallback


def _highest_severity(payloads: Sequence[Mapping[str, Any]]) -> Severity:
    values: list[Severity] = []
    for payload in payloads:
        if payload.get("severity") is not None:
            values.append(_severity(payload.get("severity")))
            continue
        investigation = payload.get("investigation")
        if isinstance(investigation, Mapping):
            decision = investigation.get("decision")
            if isinstance(decision, Mapping):
                values.append(_severity(decision.get("severity")))
                continue
        status = str(payload.get("status", ""))
        if status in {"collection_failed", "configuration_failed"}:
            values.append(Severity.P2)
    return min(values or [Severity.P3], key=_SEVERITY_RANK.__getitem__)


def _assessment_for_severity(
    payloads: Sequence[Mapping[str, Any]], severity: Severity
) -> Mapping[str, Any]:
    for payload in payloads:
        investigation = payload.get("investigation")
        if not isinstance(investigation, Mapping):
            continue
        decision = investigation.get("decision")
        assessment = investigation.get("assessment")
        if (
            isinstance(decision, Mapping)
            and _severity(decision.get("severity")) is severity
            and isinstance(assessment, Mapping)
        ):
            return assessment
    return {}


def _unique_text(values: Sequence[Any], *, limit: int, max_length: int) -> tuple[str, ...]:
    output: list[str] = []
    for value in values:
        item = sanitize_text(str(value), max_length=max_length)
        if item and item not in output:
            output.append(item)
        if len(output) >= limit:
            break
    return tuple(output)


def _evidence(payloads: Sequence[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    output: list[Mapping[str, Any]] = []
    for payload in payloads:
        investigation = payload.get("investigation")
        if not isinstance(investigation, Mapping):
            continue
        items = investigation.get("evidence")
        if isinstance(items, list):
            output.extend(item for item in items if isinstance(item, Mapping))
    return output[:100]


def _correlations(payloads: Sequence[Mapping[str, Any]]) -> tuple[dict[str, Any], ...]:
    output: list[dict[str, Any]] = []
    for payload in payloads:
        investigation = payload.get("investigation")
        if not isinstance(investigation, Mapping):
            continue
        items = investigation.get("correlations")
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, Mapping):
                continue
            sha = str(item.get("commit_sha", ""))
            if not _SHA.fullmatch(sha):
                continue
            try:
                score = max(0.0, min(float(item.get("score", 0)), 1.0))
            except (TypeError, ValueError):
                score = 0.0
            reasons = item.get("reasons")
            output.append(
                {
                    "evidence_id": sanitize_identifier(
                        str(item.get("evidence_id", "unknown"))
                    ),
                    "commit_sha": sha.lower(),
                    "score": round(score, 3),
                    "reasons": list(
                        _unique_text(
                            reasons if isinstance(reasons, list) else [],
                            limit=4,
                            max_length=300,
                        )
                    ),
                }
            )
    output.sort(key=lambda item: item["score"], reverse=True)
    return tuple(output[:10])


def _collection_failures(
    payloads: Sequence[Mapping[str, Any]],
) -> tuple[dict[str, str], ...]:
    output: list[dict[str, str]] = []
    for payload in payloads:
        collection = payload.get("collection")
        if isinstance(collection, Mapping):
            items = collection.get("collection_failures")
            for item in items if isinstance(items, list) else []:
                if not isinstance(item, Mapping):
                    continue
                output.append(
                    {
                        "provider": sanitize_identifier(
                            str(item.get("provider", "unknown"))
                        ),
                        "operation": sanitize_identifier(
                            str(item.get("operation", "unknown"))
                        ),
                        "error_type": sanitize_identifier(
                            str(item.get("error_type", "unknown"))
                        ),
                    }
                )
        status = str(payload.get("status", ""))
        if status in {
            "collection_failed",
            "configuration_failed",
            "deployment_failed",
            "deployment_timeout",
        }:
            output.append(
                {
                    "provider": sanitize_identifier(
                        str(payload.get("provider") or "monitor")
                    ),
                    "operation": sanitize_identifier(
                        str(payload.get("operation") or status)
                    ),
                    "error_type": sanitize_identifier(
                        str(payload.get("error_type") or status)
                    ),
                }
            )
    return tuple(output[:25])


def _fingerprint(
    severity: Severity,
    evidence: Sequence[Mapping[str, Any]],
    correlations: Sequence[Mapping[str, Any]],
    failures: Sequence[Mapping[str, Any]],
) -> str:
    signals = []
    for item in evidence:
        signals.append(
            {
                "source": sanitize_identifier(str(item.get("source", "unknown"))),
                "route": sanitize_text(str(item.get("route") or ""), max_length=300),
                "status_code": item.get("status_code"),
                "summary": sanitize_text(str(item.get("summary", "")), max_length=300),
                "deployment_id": sanitize_identifier(
                    str(item.get("deployment_id") or "none"), max_length=200
                ),
                "commit_sha": (
                    str(item.get("commit_sha", "")).lower()
                    if _SHA.fullmatch(str(item.get("commit_sha", "")))
                    else "none"
                ),
            }
        )
    stable = {
        "severity": severity.value,
        "signals": sorted(
            signals,
            key=lambda item: json.dumps(item, separators=(",", ":"), sort_keys=True),
        ),
        "commits": sorted(
            str(item.get("commit_sha", "")) for item in correlations[:5]
        ),
        "failures": sorted(
            (
                sanitize_identifier(str(item.get("provider", "unknown"))),
                sanitize_identifier(str(item.get("operation", "unknown"))),
                sanitize_identifier(str(item.get("error_type", "unknown"))),
            )
            for item in failures
        ),
    }
    encoded = json.dumps(stable, separators=(",", ":"), sort_keys=True).encode()
    return hashlib.sha256(encoded).hexdigest()[:16]


def build_response_package(
    payloads: Sequence[Mapping[str, Any]],
    *,
    repository: str = "unknown/unknown",
    run_id: str = "unknown",
    source_sha: str = "unknown",
) -> ResponsePackage:
    if not payloads:
        raise ValueError("At least one monitoring result is required")
    sanitized = [sanitize_value(dict(payload)) for payload in payloads]
    severity = _highest_severity(sanitized)
    assessment = _assessment_for_severity(sanitized, severity)
    evidence = _evidence(sanitized)
    evidence_ids = _unique_text(
        [item.get("id", "unknown") for item in evidence],
        limit=100,
        max_length=120,
    )
    routes = _unique_text(
        [item.get("route") for item in evidence if item.get("route")],
        limit=25,
        max_length=300,
    )
    correlations = _correlations(sanitized)
    failures = _collection_failures(sanitized)
    incident = severity is not Severity.P3
    alert_eligible = severity in {Severity.P0, Severity.P1}
    fingerprint = _fingerprint(severity, evidence, correlations, failures)

    default_title = (
        "Owner action required"
        if alert_eligible
        else "Incident review recommended"
        if incident
        else "Reliability checks healthy"
    )
    title = sanitize_text(str(assessment.get("title") or default_title), max_length=200)
    summary = sanitize_text(
        str(
            assessment.get("summary")
            or (
                "A required monitoring or deployment-verification operation failed closed."
                if failures
                else "No actionable incident was detected."
            )
        ),
        max_length=1_500,
    )
    likely_cause = sanitize_text(
        str(
            assessment.get("likely_cause")
            or "Not determined without an owner-reviewed investigation."
        ),
        max_length=1_500,
    )
    raw_actions = assessment.get("recommended_actions")
    recommended = _unique_text(
        raw_actions if isinstance(raw_actions, list) else [],
        limit=8,
        max_length=600,
    )
    if not recommended:
        recommended = (
            "Review the sanitized evidence and highest-ranked recent change.",
            "Reproduce only in preview or a synthetic development environment.",
            "Prepare a draft pull request and require owner review before merge.",
        )

    branch = f"agent/era/incident-{fingerprint}" if incident else None
    return ResponsePackage(
        severity=severity.value,
        status=(
            "owner_action_required"
            if alert_eligible
            else "review_recommended"
            if incident
            else "healthy"
        ),
        incident=incident,
        fingerprint=fingerprint,
        title=title,
        summary=summary,
        likely_cause=likely_cause,
        evidence_ids=evidence_ids,
        affected_routes=routes,
        change_correlations=correlations,
        collection_failures=failures,
        recommended_actions=recommended,
        alert={
            "eligible": alert_eligible,
            "severity_threshold": "P0_or_P1",
            "channel": "owner_email",
            "owner_approval_required": True,
            "sent": False,
        },
        repair={
            "mode": "owner_reviewed_draft_pr",
            "suggested_branch": branch,
            "allowed_actions": [
                "prepare_incident_branch",
                "reproduce_in_preview",
                "prepare_minimal_fix",
                "run_allowlisted_tests",
                "create_draft_pull_request",
            ],
            "prohibited_actions": list(_PROHIBITED_ACTIONS),
            "owner_approval_required": incident,
            "direct_main_write_enabled": False,
            "production_deploy_enabled": False,
        },
        verification={
            "trigger": "push_to_main_after_owner_merge",
            "mode": "read_only_monitor",
            "model_used": False,
            "production_writes_enabled": False,
        },
        source={
            "repository": sanitize_text(repository, max_length=200),
            "run_id": sanitize_identifier(run_id),
            "commit_sha": (
                source_sha.lower() if _SHA.fullmatch(source_sha) else "unknown"
            ),
        },
    )
