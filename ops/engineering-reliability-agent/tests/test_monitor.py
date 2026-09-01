import unittest
from datetime import UTC, datetime

from era.live import LiveCollectionPlan, NamedCollector
from era.models import Environment, EvidenceSource, IncidentEvidence
from era.monitor import run_monitoring_cycle


class StaticCollector:
    def __init__(self, evidence):
        self.evidence = evidence

    async def collect(self):
        return self.evidence


class FailingCollector:
    async def collect(self):
        raise TimeoutError("token=must-not-leak")


def health_evidence(status_code: int) -> IncidentEvidence:
    return IncidentEvidence(
        id=f"health-{status_code}",
        source=EvidenceSource.HEALTH,
        occurred_at=datetime.now(UTC),
        summary="Health check passed" if status_code == 200 else "Health check failed",
        environment=Environment.PRODUCTION,
        route="/api/health",
        status_code=status_code,
        metadata={"degraded": status_code >= 500},
    )


class MonitoringCycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_healthy_cycle_never_uses_a_model_or_write_action(self) -> None:
        plan = LiveCollectionPlan(
            provider_names=("health",),
            environment=Environment.PRODUCTION,
            evidence_collectors=(
                NamedCollector("health", StaticCollector([health_evidence(200)])),
            ),
        )

        result = await run_monitoring_cycle(plan)
        payload = result.to_dict()

        self.assertEqual(result.exit_code, 0)
        self.assertFalse(payload["model_used"])
        self.assertFalse(payload["production_writes_enabled"])
        self.assertFalse(payload["alert_required"])
        self.assertEqual(payload["investigation"]["decision"]["severity"], "P3")

    async def test_degradation_requires_an_alert(self) -> None:
        plan = LiveCollectionPlan(
            provider_names=("health",),
            environment=Environment.PRODUCTION,
            evidence_collectors=(
                NamedCollector("health", StaticCollector([health_evidence(503)])),
            ),
        )

        result = await run_monitoring_cycle(plan)

        self.assertEqual(result.exit_code, 2)
        self.assertTrue(result.alert_required)
        self.assertEqual(result.investigation.decision.severity.value, "P2")

    async def test_monitoring_gap_is_an_alert_without_leaking_error_text(self) -> None:
        plan = LiveCollectionPlan(
            provider_names=("supabase",),
            environment=Environment.PRODUCTION,
            evidence_collectors=(NamedCollector("supabase", FailingCollector()),),
        )

        result = await run_monitoring_cycle(plan)
        payload = result.to_dict()

        self.assertEqual(result.exit_code, 2)
        self.assertTrue(result.alert_required)
        self.assertNotIn("must-not-leak", str(payload))
        self.assertEqual(
            payload["collection"]["collection_failures"][0]["error_type"],
            "TimeoutError",
        )


if __name__ == "__main__":
    unittest.main()
