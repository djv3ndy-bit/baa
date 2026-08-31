import unittest
from datetime import UTC, datetime

from era.models import Environment, EvidenceSource, IncidentEvidence, Severity
from era.severity import classify_incident


def evidence(**overrides):
    values = {
        "id": "evt-1",
        "source": EvidenceSource.APPLICATION,
        "occurred_at": datetime.now(UTC),
        "summary": "Signal",
        "environment": Environment.PRODUCTION,
        "metadata": {},
    }
    values.update(overrides)
    return IncidentEvidence(**values)


class SeverityTests(unittest.TestCase):
    def test_data_corruption_is_p0(self) -> None:
        decision = classify_incident([evidence(metadata={"data_corruption": True})])
        self.assertEqual(decision.severity, Severity.P0)

    def test_sustained_auth_outage_is_p1(self) -> None:
        decision = classify_incident(
            [
                evidence(
                    route="/login",
                    status_code=503,
                    metadata={
                        "core_service": True,
                        "availability": "down",
                        "duration_minutes": 8,
                        "impact_percent": 45,
                    },
                )
            ]
        )
        self.assertEqual(decision.severity, Severity.P1)

    def test_partial_push_failure_is_p2(self) -> None:
        decision = classify_incident(
            [
                evidence(
                    route="/api/send-message",
                    status_code=500,
                    metadata={"degraded": True, "error_count": 8},
                )
            ]
        )
        self.assertEqual(decision.severity, Severity.P2)

    def test_failed_check_is_p2(self) -> None:
        decision = classify_incident(
            [
                evidence(
                    source=EvidenceSource.GITHUB,
                    metadata={"conclusion": "failure"},
                )
            ]
        )
        self.assertEqual(decision.severity, Severity.P2)

    def test_deprecation_warning_is_p3(self) -> None:
        decision = classify_incident([evidence(summary="Node deprecation warning")])
        self.assertEqual(decision.severity, Severity.P3)
        self.assertFalse(decision.suppressed)

    def test_paused_billing_is_suppressed(self) -> None:
        decision = classify_incident(
            [
                evidence(
                    route="/api/create-checkout-session",
                    status_code=503,
                    metadata={"condition": "billing_paused"},
                )
            ]
        )
        self.assertEqual(decision.severity, Severity.P3)
        self.assertTrue(decision.suppressed)


if __name__ == "__main__":
    unittest.main()
