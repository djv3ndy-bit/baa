import unittest
from datetime import UTC, datetime, timedelta

from era.correlation import correlate_changes
from era.models import EvidenceSource, IncidentEvidence, RecentChange


class CorrelationTests(unittest.TestCase):
    def test_commit_time_and_route_overlap_rank_change(self) -> None:
        now = datetime.now(UTC)
        item = IncidentEvidence(
            id="evt-1",
            source=EvidenceSource.VERCEL,
            occurred_at=now,
            summary="Endpoint failed",
            route="/api/send-message",
            commit_sha="abcdef123456",
        )
        matching = RecentChange(
            sha="abcdef1234567890",
            committed_at=now - timedelta(minutes=20),
            title="Change message delivery",
            files=("api/send-message.js",),
        )
        unrelated = RecentChange(
            sha="999999999999",
            committed_at=now - timedelta(hours=30),
            title="Change homepage",
            files=("index.html",),
        )
        correlations = correlate_changes([item], [unrelated, matching])
        self.assertEqual(correlations[0].commit_sha, matching.sha)
        self.assertGreaterEqual(correlations[0].score, 0.9)
        self.assertFalse(
            any(value.commit_sha == unrelated.sha for value in correlations)
        )


if __name__ == "__main__":
    unittest.main()
