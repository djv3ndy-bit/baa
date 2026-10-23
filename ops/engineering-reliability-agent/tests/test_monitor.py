import unittest
from datetime import UTC, datetime

from era.live import LiveCollectionPlan, NamedCollector
from era.models import Environment, EvidenceSource, IncidentEvidence
from era.monitor import run_monitoring_cycle
from era.providers.http import ProviderReadError
from era.response import build_response_package


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
        self.assertEqual(payload["status"], "healthy")
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
        self.assertEqual(result.to_dict()["status"], "alert")
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

        self.assertEqual(result.exit_code, 3)
        self.assertEqual(payload["status"], "collection_failed")
        self.assertTrue(result.alert_required)
        self.assertNotIn("must-not-leak", str(payload))
        self.assertEqual(
            payload["collection"]["collection_failures"][0]["error_type"],
            "TimeoutError",
        )

    async def test_provider_access_denials_fail_the_monitor_without_fabricating_an_outage(self) -> None:
        class DeniedCollector:
            def __init__(self, status):
                self.status = status

            async def collect(self):
                raise ProviderReadError(
                    "synthetic private error text", reason_code="http_error", http_status=self.status
                )

        for status in (401, 403):
            with self.subTest(status=status):
                plan = LiveCollectionPlan(
                    provider_names=("vercel",), environment=Environment.PRODUCTION,
                    evidence_collectors=(NamedCollector("vercel", DeniedCollector(status)),),
                )
                result = await run_monitoring_cycle(plan)
                payload = result.to_dict()
                self.assertEqual(result.exit_code, 3)
                self.assertEqual(payload["exit_code"], 3)
                self.assertEqual(payload["status"], "collection_failed")
                self.assertEqual(payload["collection"]["collection_failures"][0]["http_status"], status)
                self.assertNotIn("synthetic private error text", str(payload))
                self.assertEqual(result.investigation.decision.severity.value, "P2")
                self.assertFalse(build_response_package([payload]).to_dict()["alert"]["eligible"])

    async def test_collection_failure_does_not_suppress_a_separately_observed_p1_incident(self) -> None:
        outage = IncidentEvidence(
            id="synthetic-production-outage", source=EvidenceSource.HEALTH,
            occurred_at=datetime.now(UTC), summary="Synthetic observed outage",
            environment=Environment.PRODUCTION, route="/login", status_code=503,
            metadata={"impact_percent": 40},
        )
        plan = LiveCollectionPlan(
            provider_names=("health", "supabase"), environment=Environment.PRODUCTION,
            evidence_collectors=(
                NamedCollector("health", StaticCollector([outage])),
                NamedCollector("supabase", FailingCollector()),
            ),
        )
        result = await run_monitoring_cycle(plan)
        payload = result.to_dict()
        self.assertEqual(result.exit_code, 3)
        self.assertEqual(payload["status"], "collection_failed")
        self.assertEqual(result.investigation.decision.severity.value, "P1")
        package = build_response_package([payload]).to_dict()
        self.assertEqual(package["severity"], "P1")
        self.assertTrue(package["alert"]["eligible"])


if __name__ == "__main__":
    unittest.main()
