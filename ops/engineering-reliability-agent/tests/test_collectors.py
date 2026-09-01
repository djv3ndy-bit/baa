import unittest
from datetime import UTC, datetime

from era.collectors.github import GitHubCollector
from era.collectors.health import HealthCollector
from era.collectors.supabase import SupabaseCollector
from era.collectors.vercel import VercelCollector
from era.models import EvidenceSource


class FakeGitHub:
    async def list_recent_changes(self, repository, *, limit):
        return []

    async def list_failed_checks(self, repository, *, limit):
        return [
            {
                "id": "check-1",
                "occurred_at": datetime.now(UTC).isoformat(),
                "summary": "Tests failed",
                "commit_sha": "abc123",
                "check_name": "unit",
                "conclusion": "failure",
            }
        ]


class FakeVercel:
    async def list_failed_deployments(self, project_id, *, environment, limit):
        return []

    async def list_runtime_errors(self, project_id, *, environment, since, limit):
        return [
            {
                "id": "runtime-1",
                "occurred_at": datetime.now(UTC).isoformat(),
                "summary": "Function failed",
                "route": "/api/example",
                "status_code": 500,
            }
        ]


class FakeSupabase:
    async def get_logs(self, project_ref, *, service, limit):
        return [
            {
                "id": f"{service}-1",
                "occurred_at": datetime.now(UTC).isoformat(),
                "level": "error",
                "summary": f"{service} failure",
                "status_code": 500,
            }
        ]


class CollectorTests(unittest.IsolatedAsyncioTestCase):
    async def test_read_only_provider_adapters_map_evidence(self) -> None:
        github = await GitHubCollector(FakeGitHub(), "owner/repo").collect()
        vercel = await VercelCollector(FakeVercel(), "project").collect()
        supabase = await SupabaseCollector(
            FakeSupabase(), "project", services=("api",)
        ).collect()
        self.assertEqual(github[0].source, EvidenceSource.GITHUB)
        self.assertEqual(vercel[0].source, EvidenceSource.VERCEL)
        self.assertEqual(supabase[0].source, EvidenceSource.SUPABASE)

    def test_health_collector_rejects_unsafe_urls(self) -> None:
        hosts = frozenset({"example.com"})
        with self.assertRaises(ValueError):
            HealthCollector("http://example.com/health", hosts)
        with self.assertRaises(ValueError):
            HealthCollector("https://untrusted.example/health", hosts)
        with self.assertRaises(ValueError):
            HealthCollector("https://example.com/health?token=value", hosts)

    def test_supabase_collector_has_no_sql_service(self) -> None:
        with self.assertRaises(ValueError):
            SupabaseCollector(FakeSupabase(), "project", services=("sql",))


if __name__ == "__main__":
    unittest.main()
