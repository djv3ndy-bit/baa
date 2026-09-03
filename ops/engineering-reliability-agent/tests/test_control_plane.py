import unittest
from collections.abc import Mapping
from typing import Any

from era.providers.github import GitHubApiSource


class QueueTransport:
    def __init__(self, responses: list[Any]) -> None:
        self.responses = list(responses)
        self.requests: list[tuple[str, Mapping[str, str]]] = []

    async def get_json(self, url: str, *, headers: Mapping[str, str]) -> Any:
        self.requests.append((url, headers))
        if not self.responses:
            raise AssertionError("Unexpected provider request")
        return self.responses.pop(0)


def failed_check(check_id: int, name: str, run_id: int | None = None) -> dict[str, Any]:
    check: dict[str, Any] = {
        "id": check_id,
        "name": name,
        "conclusion": "failure",
        "completed_at": "2026-09-03T11:30:00Z",
    }
    if run_id is not None:
        check["details_url"] = (
            f"https://github.com/djv3ndy-bit/baa/actions/runs/{run_id}/job/999"
        )
    return check


class ReliabilityControlPlaneTests(unittest.IsolatedAsyncioTestCase):
    async def test_excludes_all_known_monitoring_control_workflows(self) -> None:
        transport = QueueTransport(
            [
                [{"sha": "abcdef1234567890", "commit": {}}],
                {
                    "check_runs": [
                        failed_check(1, "monitor", 101),
                        failed_check(2, "sync", 102),
                        failed_check(3, "verify", 103),
                        failed_check(4, "test", 104),
                        failed_check(5, "product-unit"),
                    ]
                },
                {
                    "path": (
                        ".github/workflows/engineering-reliability-monitor.yml@"
                        "refs/heads/main"
                    )
                },
                {"path": ".github/workflows/notion-reliability-sync.yml"},
                {"path": ".github/workflows/notion-connection-verification.yml"},
                {"path": ".github/workflows/notion-sync-tests.yml"},
            ]
        )
        source = GitHubApiSource("github-read-token", transport=transport)

        failures = await source.list_failed_checks("djv3ndy-bit/baa", limit=10)

        self.assertEqual(
            [failure["id"] for failure in failures],
            ["github-check-5"],
        )
        run_requests = [url for url, _ in transport.requests if "/actions/runs/" in url]
        self.assertEqual(len(run_requests), 4)

    async def test_caches_workflow_path_for_multiple_checks_from_one_run(self) -> None:
        transport = QueueTransport(
            [
                [{"sha": "abcdef1234567890", "commit": {}}],
                {
                    "check_runs": [
                        failed_check(6, "sync-a", 201),
                        failed_check(7, "sync-b", 201),
                    ]
                },
                {"path": ".github/workflows/notion-reliability-sync.yml"},
            ]
        )
        source = GitHubApiSource("github-read-token", transport=transport)

        failures = await source.list_failed_checks("djv3ndy-bit/baa", limit=10)

        self.assertEqual(failures, [])
        run_requests = [url for url, _ in transport.requests if "/actions/runs/" in url]
        self.assertEqual(len(run_requests), 1)

    async def test_keeps_failure_from_unrelated_workflow_even_with_sync_name(self) -> None:
        transport = QueueTransport(
            [
                [{"sha": "abcdef1234567890", "commit": {}}],
                {"check_runs": [failed_check(8, "sync", 301)]},
                {"path": ".github/workflows/customer-data-sync.yml"},
            ]
        )
        source = GitHubApiSource("github-read-token", transport=transport)

        failures = await source.list_failed_checks("djv3ndy-bit/baa", limit=10)

        self.assertEqual(
            [failure["id"] for failure in failures],
            ["github-check-8"],
        )


if __name__ == "__main__":
    unittest.main()
