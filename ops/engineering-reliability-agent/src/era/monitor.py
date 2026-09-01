from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from era.live import LiveCollectionPlan, LiveCollectionResult, run_live_plan
from era.models import Severity
from era.workflows.investigate import InvestigationResult, investigate


_ALERT_SEVERITIES = frozenset({Severity.P0, Severity.P1, Severity.P2})


@dataclass(frozen=True, slots=True)
class MonitoringCycleResult:
    collection: LiveCollectionResult
    investigation: InvestigationResult
    alert_required: bool

    @property
    def exit_code(self) -> int:
        return 2 if self.alert_required else 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "mode": "recurring_monitor",
            "status": "alert" if self.alert_required else "healthy",
            "model_used": False,
            "production_writes_enabled": False,
            "alert_required": self.alert_required,
            "exit_code": self.exit_code,
            "collection": self.collection.to_dict(),
            "investigation": self.investigation.to_dict(),
        }


async def run_monitoring_cycle(plan: LiveCollectionPlan) -> MonitoringCycleResult:
    collection = await run_live_plan(plan)
    investigation = await investigate(
        collection.evidence,
        collection.changes,
        use_model=False,
    )
    alert_required = investigation.decision.severity in _ALERT_SEVERITIES
    return MonitoringCycleResult(collection, investigation, alert_required)
