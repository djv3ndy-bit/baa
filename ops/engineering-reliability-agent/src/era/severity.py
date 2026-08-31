from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from .models import Environment, IncidentEvidence, Severity, SeverityDecision


_EXPECTED_CONDITIONS = {
    "billing_paused",
    "unauthenticated_probe",
    "planned_maintenance",
}
_CORE_ROUTES = {
    "/api/apply-job",
    "/api/match-application",
    "/api/send-message",
    "/api/stripe-webhook",
    "/login",
    "/signup",
}


def _number(metadata: dict[str, Any], key: str) -> float:
    try:
        return float(metadata.get(key, 0))
    except (TypeError, ValueError):
        return 0


def classify_incident(evidence: Sequence[IncidentEvidence]) -> SeverityDecision:
    if not evidence:
        return SeverityDecision(Severity.P3, ("No incident evidence was supplied.",))

    metadata = [dict(item.metadata) for item in evidence]
    conditions = {
        str(item.get("condition", "")) for item in metadata if item.get("condition")
    }
    unexpected = conditions - _EXPECTED_CONDITIONS
    has_error_without_condition = any(
        (item.status_code or 0) >= 500 and not dict(item.metadata).get("condition")
        for item in evidence
    )

    if conditions and not unexpected and not has_error_without_condition:
        return SeverityDecision(
            Severity.P3,
            (
                "All signals match an explicitly declared expected operational condition.",
            ),
            suppressed=True,
        )

    if any(bool(item.get("credible_security_incident")) for item in metadata):
        return SeverityDecision(
            Severity.P0, ("Evidence indicates a credible security incident.",)
        )
    if any(
        bool(item.get("data_corruption")) or bool(item.get("data_loss"))
        for item in metadata
    ):
        return SeverityDecision(
            Severity.P0, ("Evidence indicates data corruption or data loss.",)
        )

    production = any(item.environment is Environment.PRODUCTION for item in evidence)
    impact_percent = max(
        (_number(item, "impact_percent") for item in metadata), default=0
    )
    duration_minutes = max(
        (_number(item, "duration_minutes") for item in metadata), default=0
    )
    availability_down = any(
        str(item.get("availability", "")).lower() == "down" for item in metadata
    )

    if production and impact_percent >= 70 and duration_minutes >= 5:
        return SeverityDecision(
            Severity.P0,
            ("A sustained production outage affects at least 70% of users.",),
        )

    routes = {item.route for item in evidence if item.route}
    core_affected = bool(routes & _CORE_ROUTES) or any(
        bool(item.get("core_service")) for item in metadata
    )
    production_deploy_failed = any(
        bool(item.get("deployment_failed"))
        and bool(item.get("active_production_unavailable"))
        for item in metadata
    )
    if production and (
        production_deploy_failed
        or impact_percent >= 30
        or (core_affected and availability_down and duration_minutes >= 5)
    ):
        return SeverityDecision(
            Severity.P1,
            ("A production-critical service is broadly or persistently unavailable.",),
        )

    error_count = sum(int(_number(item, "error_count")) for item in metadata)
    has_server_error = any((item.status_code or 0) >= 500 for item in evidence)
    degraded = any(bool(item.get("degraded")) for item in metadata)
    operational_failure = any(
        bool(item.get("deployment_failed"))
        or bool(item.get("collection_failed"))
        or str(item.get("conclusion", "")).lower()
        in {"action_required", "cancelled", "failure", "startup_failure", "timed_out"}
        for item in metadata
    )
    if has_server_error or degraded or operational_failure or error_count >= 2:
        return SeverityDecision(
            Severity.P2,
            ("The incident is a partial or limited production degradation.",),
        )

    return SeverityDecision(
        Severity.P3,
        (
            "The signal is informational, a warning, or has no demonstrated user impact.",
        ),
    )
