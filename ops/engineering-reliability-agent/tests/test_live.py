import unittest
from datetime import UTC, datetime

from era.live import (
    LiveCollectionPlan,
    NamedCollector,
    build_live_plan,
    parse_lookback_minutes,
    run_live_plan,
)
from era.models import Environment, EvidenceSource, IncidentEvidence, RecentChange


class FakeEvidenceCollector:
    async def collect(self):
        return [
            IncidentEvidence(
                id="health-1",
                source=EvidenceSource.HEALTH,
                occurred_at=datetime.now(UTC),
                summary="authorization=must-not-leak",
                environment=Environment.PREVIEW,
                route="/health?token=must-not-leak",
                status_code=500,
            )
        ]


class FakeGitHubCollector:
    async def collect(self):
        return [
            IncidentEvidence(
                id="github-1",
                source=EvidenceSource.GITHUB,
                occurred_at=datetime.now(UTC),
                summary="Check failed",
                commit_sha="abcdef1234567890",
            )
        ]

    async def collect_changes(self):
        return [
            RecentChange(
                sha="abcdef1234567890",
                committed_at=datetime.now(UTC),
                title="Fix token=must-not-leak",
                files=("api/send-message.js",),
            )
        ]


class FailingCollector:
    async def collect(self):
        raise RuntimeError("authorization=must-not-leak")


class LiveCollectionTests(unittest.IsolatedAsyncioTestCase):
    def test_lookback_is_bounded(self) -> None:
        self.assertEqual(parse_lookback_minutes("30m"), 30)
        self.assertEqual(parse_lookback_minutes("1h"), 60)
        with self.assertRaises(ValueError):
            parse_lookback_minutes("25h")

    def test_health_plan_requires_an_exact_allowlist(self) -> None:
        plan = build_live_plan(
            provider_names=("health",),
            environment_name="preview",
            environment={"ERA_ALLOWED_HEALTH_HOSTS": "preview.example.com"},
            health_urls=("https://preview.example.com/health",),
        )
        self.assertEqual(plan.provider_names, ("health",))

        with self.assertRaises(ValueError):
            build_live_plan(
                provider_names=("health",),
                environment_name="preview",
                environment={"ERA_ALLOWED_HEALTH_HOSTS": "preview.example.com"},
                health_urls=("https://attacker.example/health",),
            )

    def test_provider_credentials_fail_closed(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "VERCEL_READ_TOKEN"):
            build_live_plan(
                provider_names=("vercel",),
                environment_name="production",
                environment={
                    "VERCEL_PROJECT_ID": "prj_example",
                    "VERCEL_TEAM_ID": "team_example",
                },
            )
        with self.assertRaisesRegex(RuntimeError, "labeled production"):
            build_live_plan(
                provider_names=("supabase",),
                environment_name="preview",
                environment={},
                supabase_services=("api",),
            )

    async def test_collection_is_sanitized_and_never_uses_a_model(self) -> None:
        plan = LiveCollectionPlan(
            provider_names=("health", "github"),
            environment=Environment.PREVIEW,
            evidence_collectors=(NamedCollector("health", FakeEvidenceCollector()),),
            github_collector=FakeGitHubCollector(),
        )

        result = await run_live_plan(plan)
        payload = result.to_dict()

        self.assertFalse(payload["model_used"])
        self.assertFalse(payload["production_writes_enabled"])
        self.assertNotIn("must-not-leak", str(payload))
        self.assertEqual(len(payload["evidence"]), 2)
        self.assertEqual(payload["changes"][0]["sha"], "abcdef1234567890")

    async def test_provider_failures_are_sanitized_degraded_evidence(self) -> None:
        plan = LiveCollectionPlan(
            provider_names=("vercel",),
            environment=Environment.PRODUCTION,
            evidence_collectors=(NamedCollector("vercel", FailingCollector()),),
        )

        payload = (await run_live_plan(plan)).to_dict()

        self.assertNotIn("must-not-leak", str(payload))
        self.assertEqual(payload["collection_failures"][0]["provider"], "vercel")
        self.assertTrue(payload["evidence"][0]["metadata"]["degraded"])


if __name__ == "__main__":
    unittest.main()
