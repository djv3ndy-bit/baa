from __future__ import annotations

import re
from collections.abc import Sequence

from .models import Correlation, IncidentEvidence, RecentChange


def _route_tokens(route: str | None) -> set[str]:
    if not route:
        return set()
    return {
        token for token in re.split(r"[^a-z0-9]+", route.lower()) if len(token) >= 4
    }


def correlate_changes(
    evidence: Sequence[IncidentEvidence],
    changes: Sequence[RecentChange],
    *,
    max_hours: float = 24,
) -> list[Correlation]:
    correlations: list[Correlation] = []
    for item in evidence:
        for change in changes:
            score = 0.0
            reasons: list[str] = []
            if item.commit_sha and (
                item.commit_sha.startswith(change.sha)
                or change.sha.startswith(item.commit_sha)
            ):
                score += 0.65
                reasons.append("The evidence identifies this commit.")

            delta_hours = (
                item.occurred_at - change.committed_at
            ).total_seconds() / 3600
            if 0 <= delta_hours <= max_hours:
                score += max(0.05, 0.25 * (1 - delta_hours / max_hours))
                reasons.append(
                    f"The change preceded the signal by {delta_hours:.1f} hours."
                )

            tokens = _route_tokens(item.route)
            matching_files = [
                path for path in change.files if tokens & _route_tokens(path)
            ]
            if matching_files:
                score += 0.2
                reasons.append("Changed paths overlap the affected route.")

            if score >= 0.2:
                correlations.append(
                    Correlation(
                        evidence_id=item.id,
                        commit_sha=change.sha,
                        score=round(min(score, 1.0), 3),
                        reasons=tuple(reasons),
                    )
                )
    return sorted(correlations, key=lambda item: item.score, reverse=True)
