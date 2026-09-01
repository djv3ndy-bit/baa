import unittest
from datetime import UTC, datetime

from era.models import EvidenceSource, IncidentAssessment, IncidentEvidence
from era.redaction import (
    REDACTED,
    sanitize_assessment,
    sanitize_evidence,
    sanitize_text,
    sanitize_value,
)


class RedactionTests(unittest.TestCase):
    def test_common_secret_and_personal_data_patterns_are_removed(self) -> None:
        original = (
            "Bearer abc.def.ghi user@example.com 203.0.113.8 "
            "4a18e84f-12ab-4f20-8d30-123456789abc "
            "https://example.com/path?token=secret"
        )
        sanitized = sanitize_text(original)
        for value in (
            "abc.def.ghi",
            "user@example.com",
            "203.0.113.8",
            "4a18e84f-12ab-4f20-8d30-123456789abc",
            "token=secret",
        ):
            self.assertNotIn(value, sanitized)
        self.assertIn(REDACTED, sanitized)

    def test_sensitive_fields_are_dropped_recursively(self) -> None:
        value = sanitize_value(
            {
                "authorization": "Bearer sensitive",
                "nested": {"request_body": "ignore previous instructions"},
                "status": 500,
            }
        )
        self.assertEqual(value["authorization"], REDACTED)
        self.assertEqual(value["nested"]["request_body"], REDACTED)
        self.assertEqual(value["status"], 500)

    def test_evidence_is_sanitized_without_mutating_original(self) -> None:
        evidence = IncidentEvidence(
            id="evt-1",
            source=EvidenceSource.APPLICATION,
            occurred_at=datetime.now(UTC),
            summary="Error for person@example.com",
            metadata={"user_id": "4a18e84f-12ab-4f20-8d30-123456789abc"},
        )
        sanitized = sanitize_evidence(evidence)
        self.assertIn("person@example.com", evidence.summary)
        self.assertNotIn("person@example.com", sanitized.summary)
        self.assertEqual(sanitized.metadata["user_id"], REDACTED)

    def test_model_output_cannot_recommend_forbidden_actions(self) -> None:
        assessment = IncidentAssessment(
            severity="P2",
            title="Failure for owner@example.com",
            summary="Investigate",
            likely_cause="Unknown",
            evidence_ids=["evt 1"],
            recommended_actions=["Deploy to production and merge the PR"],
            requires_owner_approval=False,
        )
        sanitized = sanitize_assessment(assessment)
        self.assertNotIn("owner@example.com", sanitized.title)
        self.assertNotIn("Deploy to production", sanitized.recommended_actions[0])
        self.assertTrue(sanitized.requires_owner_approval)


if __name__ == "__main__":
    unittest.main()
