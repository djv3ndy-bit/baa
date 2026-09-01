import unittest

from era.response import build_response_package


def monitoring_payload(
    severity: str,
    *,
    summary: str = "Synthetic assessment",
    status_code: int = 200,
):
    return {
        "status": "healthy" if severity == "P3" else "alert",
        "collection": {
            "collection_failures": [],
        },
        "investigation": {
            "decision": {
                "severity": severity,
                "reasons": ["Synthetic classification"],
                "suppressed": False,
            },
            "evidence": [
                {
                    "id": f"event-{severity.lower()}",
                    "source": "health",
                    "occurred_at": "2026-09-01T00:00:00Z",
                    "summary": summary,
                    "environment": "production",
                    "route": "/api/public-config",
                    "status_code": status_code,
                    "deployment_id": None,
                    "commit_sha": "2cbaa93f47f2e386c6ca4f069590bd6cf79cbe0e",
                    "metadata": {},
                }
            ],
            "correlations": [
                {
                    "evidence_id": f"event-{severity.lower()}",
                    "commit_sha": "2cbaa93f47f2e386c6ca4f069590bd6cf79cbe0e",
                    "score": 0.9,
                    "reasons": ["The evidence identifies this commit."],
                }
            ],
            "assessment": {
                "severity": severity,
                "title": "Synthetic incident",
                "summary": summary,
                "likely_cause": "A recent reviewed change may be related.",
                "evidence_ids": [f"event-{severity.lower()}"],
                "recommended_actions": [
                    "Reproduce only in preview.",
                    "Prepare a draft pull request for owner review.",
                ],
                "requires_owner_approval": severity in {"P0", "P1"},
            },
        },
    }


class ResponsePackageTests(unittest.TestCase):
    def test_p1_builds_owner_alert_and_review_only_repair_plan(self) -> None:
        package = build_response_package(
            [monitoring_payload("P3"), monitoring_payload("P1", status_code=503)],
            repository="djv3ndy-bit/baa",
            run_id="12345",
            source_sha="2cbaa93f47f2e386c6ca4f069590bd6cf79cbe0e",
        ).to_dict()

        self.assertEqual(package["severity"], "P1")
        self.assertEqual(package["status"], "owner_action_required")
        self.assertTrue(package["alert"]["eligible"])
        self.assertTrue(package["alert"]["owner_approval_required"])
        self.assertTrue(
            package["repair"]["suggested_branch"].startswith("agent/era/incident-")
        )
        self.assertFalse(package["repair"]["direct_main_write_enabled"])
        self.assertFalse(package["repair"]["production_deploy_enabled"])
        self.assertIn("push_main", package["repair"]["prohibited_actions"])
        self.assertEqual(
            package["verification"]["trigger"], "push_to_main_after_owner_merge"
        )

    def test_healthy_package_never_requests_email_or_repair(self) -> None:
        package = build_response_package([monitoring_payload("P3")]).to_dict()

        self.assertEqual(package["status"], "healthy")
        self.assertFalse(package["incident"])
        self.assertFalse(package["alert"]["eligible"])
        self.assertIsNone(package["repair"]["suggested_branch"])

    def test_response_package_redacts_sensitive_text(self) -> None:
        package = build_response_package(
            [
                monitoring_payload(
                    "P1",
                    summary="Failure for owner@example.com token=must-not-leak",
                    status_code=503,
                )
            ]
        ).to_dict()
        serialized = str(package)

        self.assertNotIn("owner@example.com", serialized)
        self.assertNotIn("must-not-leak", serialized)
        self.assertIn("[REDACTED]", serialized)

    def test_fingerprint_is_stable_when_only_event_id_changes(self) -> None:
        first = monitoring_payload("P1", status_code=503)
        second = monitoring_payload("P1", status_code=503)
        second["investigation"]["evidence"][0]["id"] = "later-event-id"

        first_package = build_response_package([first]).to_dict()
        second_package = build_response_package([second]).to_dict()

        self.assertEqual(first_package["fingerprint"], second_package["fingerprint"])

    def test_invalid_or_missing_investigation_fails_closed_as_p2(self) -> None:
        package = build_response_package(
            [
                {
                    "status": "configuration_failed",
                    "error_type": "MissingReadOnlyConfiguration",
                }
            ]
        ).to_dict()

        self.assertEqual(package["severity"], "P2")
        self.assertEqual(package["status"], "review_recommended")
        self.assertFalse(package["alert"]["eligible"])


if __name__ == "__main__":
    unittest.main()
