import unittest
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import parse_qs, urlsplit

from era.providers.github import GitHubApiSource
from era.providers.supabase import SupabaseManagementSource
from era.providers.vercel import VercelApiSource


class QueueTransport:
    def __init__(self, responses: list[Any]) -> None:
        self.responses = list(responses)
        self.requests: list[tuple[str, Mapping[str, str]]] = []

    async def get_json(self, url: str, *, headers: Mapping[str, str]) -> Any:
        self.requests.append((url, headers))
        if not self.responses:
            raise AssertionError("Unexpected provider request")
        return self.responses.pop(0)


class GitHubApiSourceTests(unittest.IsolatedAsyncioTestCase):
    async def test_reads_commit_metadata_and_changed_paths(self) -> None:
        transport = QueueTransport(
            [
                [
                    {
                        "sha": "abcdef1234567890",
                        "commit": {
                            "message": "Fix send-message route\n\nDetails",
                            "committer": {"date": "2026-08-31T12:00:00Z"},
                        },
                    }
                ],
                {
                    "files": [
                        {"filename": "api/send-message.js"},
                        {"filename": "tests/send-message.test.js"},
                    ]
                },
            ]
        )
        source = GitHubApiSource("github-read-token", transport=transport)

        changes = await source.list_recent_changes("djv3ndy-bit/baa", limit=5)

        self.assertEqual(changes[0]["sha"], "abcdef1234567890")
        self.assertEqual(
            changes[0]["files"], ("api/send-message.js", "tests/send-message.test.js")
        )
        self.assertTrue(
            all(
                url.startswith("https://api.github.com/")
                for url, _ in transport.requests
            )
        )

    async def test_returns_only_failed_checks_without_output_bodies(self) -> None:
        transport = QueueTransport(
            [
                [
                    {
                        "sha": "abcdef1234567890",
                        "commit": {
                            "message": "Change",
                            "committer": {"date": "2026-08-31T12:00:00Z"},
                        },
                    }
                ],
                {
                    "check_runs": [
                        {
                            "id": 7,
                            "name": "unit",
                            "conclusion": "failure",
                            "completed_at": "2026-08-31T12:05:00Z",
                            "output": {"text": "secret body must not be returned"},
                        },
                        {
                            "id": 8,
                            "name": "lint",
                            "conclusion": "success",
                            "completed_at": "2026-08-31T12:04:00Z",
                        },
                    ]
                },
            ]
        )
        source = GitHubApiSource("github-read-token", transport=transport)

        failures = await source.list_failed_checks("djv3ndy-bit/baa", limit=5)

        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0]["conclusion"], "failure")
        self.assertNotIn("secret body", str(failures))

    async def test_ignores_only_the_agents_own_failed_workflow(self) -> None:
        transport = QueueTransport(
            [
                [
                    {
                        "sha": "abcdef1234567890",
                        "commit": {
                            "message": "Change",
                            "committer": {"date": "2026-08-31T12:00:00Z"},
                        },
                    }
                ],
                {
                    "check_runs": [
                        {
                            "id": 7,
                            "name": "monitor",
                            "conclusion": "failure",
                            "completed_at": "2026-08-31T12:05:00Z",
                            "details_url": (
                                "https://github.com/djv3ndy-bit/baa/"
                                "actions/runs/123/job/456"
                            ),
                        },
                        {
                            "id": 8,
                            "name": "unit",
                            "conclusion": "failure",
                            "completed_at": "2026-08-31T12:04:00Z",
                        },
                    ]
                },
                {
                    "path": (
                        ".github/workflows/engineering-reliability-monitor.yml@"
                        "refs/heads/main"
                    )
                },
            ]
        )
        source = GitHubApiSource("github-read-token", transport=transport)

        failures = await source.list_failed_checks("djv3ndy-bit/baa", limit=5)

        self.assertEqual([failure["id"] for failure in failures], ["github-check-8"])
        self.assertTrue(transport.requests[2][0].endswith("/actions/runs/123"))

    async def test_keeps_same_named_check_from_another_workflow(self) -> None:
        transport = QueueTransport(
            [
                [
                    {
                        "sha": "abcdef1234567890",
                        "commit": {
                            "message": "Change",
                            "committer": {"date": "2026-08-31T12:00:00Z"},
                        },
                    }
                ],
                {
                    "check_runs": [
                        {
                            "id": 9,
                            "name": "monitor",
                            "conclusion": "failure",
                            "completed_at": "2026-08-31T12:05:00Z",
                            "details_url": (
                                "https://github.com/djv3ndy-bit/baa/"
                                "actions/runs/789/job/1011"
                            ),
                        }
                    ]
                },
                {"path": ".github/workflows/another-monitor.yml"},
            ]
        )
        source = GitHubApiSource("github-read-token", transport=transport)

        failures = await source.list_failed_checks("djv3ndy-bit/baa", limit=5)

        self.assertEqual([failure["id"] for failure in failures], ["github-check-9"])


class VercelApiSourceTests(unittest.IsolatedAsyncioTestCase):
    async def test_finds_exact_production_commit_state(self) -> None:
        transport = QueueTransport(
            [
                {
                    "deployments": [
                        {
                            "uid": "dpl_other123",
                            "state": "READY",
                            "meta": {"githubCommitSha": "1111111111111111"},
                        },
                        {
                            "uid": "dpl_target123",
                            "state": "BUILDING",
                            "meta": {"githubCommitSha": "abcdef1234567890"},
                        },
                    ]
                }
            ]
        )
        source = VercelApiSource(
            "vercel-read-token", team_id="team_example", transport=transport
        )

        state = await source.get_deployment_state_for_commit(
            "prj_example",
            environment="production",
            commit_sha="abcdef1234567890",
        )

        self.assertEqual(state["state"], "BUILDING")
        self.assertEqual(state["deployment_id"], "dpl_target123")
        query = parse_qs(urlsplit(transport.requests[0][0]).query)
        self.assertEqual(query["target"], ["production"])

    async def test_reads_failed_deployments(self) -> None:
        created = int(datetime.now(UTC).timestamp() * 1_000)
        transport = QueueTransport(
            [
                {
                    "deployments": [
                        {
                            "uid": "dpl_failed123",
                            "state": "ERROR",
                            "created": created,
                            "meta": {"githubCommitSha": "abcdef1234567890"},
                        },
                        {"uid": "dpl_ready123", "state": "READY"},
                    ]
                }
            ]
        )
        source = VercelApiSource(
            "vercel-read-token", team_id="team_example", transport=transport
        )

        failures = await source.list_failed_deployments(
            "prj_example", environment="production", since="1h", limit=10
        )

        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0]["deployment_id"], "dpl_failed123")
        query = parse_qs(urlsplit(transport.requests[0][0]).query)
        self.assertEqual(query["target"], ["production"])
        self.assertEqual(query["teamId"], ["team_example"])

    async def test_ignores_failed_deployments_outside_the_lookback(self) -> None:
        now = datetime.now(UTC)
        transport = QueueTransport(
            [
                {
                    "deployments": [
                        {
                            "uid": "dpl_stale123",
                            "state": "ERROR",
                            "created": int(
                                (now - timedelta(hours=2)).timestamp() * 1_000
                            ),
                        },
                        {
                            "uid": "dpl_recent123",
                            "state": "ERROR",
                            "created": int(
                                (now - timedelta(minutes=10)).timestamp() * 1_000
                            ),
                        },
                    ]
                }
            ]
        )
        source = VercelApiSource("vercel-read-token", transport=transport)

        failures = await source.list_failed_deployments(
            "prj_example", environment="production", since="1h", limit=10
        )

        self.assertEqual(
            [item["deployment_id"] for item in failures], ["dpl_recent123"]
        )

    async def test_runtime_errors_are_grouped_without_raw_log_text(self) -> None:
        transport = QueueTransport(
            [
                {
                    "deployments": [
                        {
                            "uid": "dpl_ready123",
                            "state": "READY",
                            "meta": {"githubCommitSha": "abcdef1234567890"},
                        }
                    ]
                },
                [
                    {
                        "created": 1_788_177_600_000,
                        "payload": {
                            "text": "authorization=do-not-return-this",
                            "proxy": {
                                "path": "/api/send-message?token=private",
                                "statusCode": 500,
                            },
                        },
                    },
                    {
                        "created": 1_788_177_601_000,
                        "payload": {
                            "text": "another raw line",
                            "proxy": {
                                "path": "/api/send-message",
                                "statusCode": 500,
                            },
                        },
                    },
                ],
            ]
        )
        source = VercelApiSource("vercel-read-token", transport=transport)

        errors = await source.list_runtime_errors(
            "prj_example", environment="production", since="1h", limit=10
        )

        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0]["route"], "/api/send-message")
        self.assertEqual(errors[0]["count"], 2)
        self.assertNotIn("authorization", str(errors))
        events_query = parse_qs(urlsplit(transport.requests[1][0]).query)
        self.assertEqual(events_query["statusCode"], ["5xx"])
        self.assertEqual(events_query["follow"], ["0"])


class SupabaseManagementSourceTests(unittest.IsolatedAsyncioTestCase):
    async def test_uses_bounded_analytics_query_without_returning_messages(
        self,
    ) -> None:
        transport = QueueTransport(
            [
                {
                    "result": [
                        {
                            "occurred_at": "2026-08-31T12:00:00Z",
                            "status_code": "500",
                            "route": "/rest/v1/messages?token=must-not-leak",
                            "count": 3,
                            "event_message": "customer data must not be returned",
                        }
                    ]
                }
            ]
        )
        source = SupabaseManagementSource(
            "supabase-analytics-token", lookback_minutes=60, transport=transport
        )

        logs = await source.get_logs("abcdefghijklmnopqrst", service="api", limit=25)

        self.assertEqual(logs[0]["status_code"], 500)
        self.assertEqual(logs[0]["count"], 3)
        self.assertEqual(logs[0]["route"], "/rest/v1/messages")
        self.assertNotIn("must-not-leak", str(logs))
        self.assertNotIn("customer data", str(logs))
        parsed = urlsplit(transport.requests[0][0])
        query = parse_qs(parsed.query)
        select_clause = query["sql"][0].split("from logs", 1)[0]
        self.assertNotIn("event_message", select_clause)
        self.assertIn("source = 'edge_logs'", query["sql"][0])
        self.assertNotIn("source in", query["sql"][0].lower())
        self.assertIn("severity_text", query["sql"][0])
        self.assertIn("iso_timestamp_start", query)
        self.assertIn("iso_timestamp_end", query)

    async def test_rejects_unknown_log_services(self) -> None:
        source = SupabaseManagementSource(
            "supabase-analytics-token", transport=QueueTransport([])
        )
        with self.assertRaises(ValueError):
            await source.get_logs(
                "abcdefghijklmnopqrst", service="database-write", limit=25
            )


if __name__ == "__main__":
    unittest.main()
