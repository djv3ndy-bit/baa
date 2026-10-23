"""A deployment read is never proof of historical runtime coverage."""
import json
import unittest
from datetime import UTC, datetime
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from era.live import NamedCollector, build_live_plan
from era.monitor import run_monitoring_cycle
from era.providers.http import ProviderReadError
from era.providers.vercel import VercelApiSource
from era.response import build_response_package


RUNTIME_REASON = "runtime_history_not_supported_by_configured_source"
PRIVATE = "synthetic-private-error-and-token"


class DeploymentTransport:
    def __init__(self, deployments=(), status=None):
        self.deployments = list(deployments)
        self.status = status
        self.requests = []

    async def get_json(self, url, *, headers):
        self.requests.append(url)
        if self.status:
            raise ProviderReadError(PRIVATE, reason_code="http_error", http_status=self.status)
        return {"deployments": self.deployments}


def vercel_plan(transport):
    source = VercelApiSource(PRIVATE, team_id="team_fixture", transport=transport)
    with patch("era.live.VercelApiSource", return_value=source):
        return build_live_plan(
            provider_names=("vercel",), environment_name="production",
            environment={"VERCEL_READ_TOKEN": PRIVATE, "VERCEL_TEAM_ID": "team_fixture",
                         "VERCEL_PROJECT_ID": "prj_fixture"},
            lookback="1h", limit=10,
        )


class VercelRuntimeCoverageTests(unittest.IsolatedAsyncioTestCase):
    async def test_successful_deployment_read_cannot_report_runtime_all_clear(self):
        transport = DeploymentTransport()
        plan = vercel_plan(transport)
        self.assertEqual([item.operation for item in plan.evidence_collectors],
                         ["deployments", "runtime_history"])

        result = await run_monitoring_cycle(plan)
        payload = result.to_dict()
        self.assertEqual(result.exit_code, 3)
        self.assertEqual(payload["status"], "collection_failed")
        self.assertEqual(payload["collection"]["collection_failures"], [{
            "provider": "vercel", "operation": "runtime_history",
            "error_type": "ProviderReadError", "reason_code": RUNTIME_REASON,
        }])
        self.assertEqual(result.investigation.decision.severity.value, "P2")
        self.assertEqual(len(transport.requests), 1)
        parsed = urlsplit(transport.requests[0])
        self.assertEqual(parsed.path, "/v6/deployments")
        self.assertEqual(parse_qs(parsed.query), {
            "teamId": ["team_fixture"], "projectId": ["prj_fixture"],
            "target": ["production"], "limit": ["10"],
        })
        package = build_response_package([payload]).to_dict()
        self.assertNotEqual(package["status"], "healthy")
        self.assertFalse(package["alert"]["eligible"])
        self.assertIn(RUNTIME_REASON, json.dumps(package))
        self.assertNotIn(PRIVATE, json.dumps([payload, package]))

    async def test_runtime_gap_does_not_discard_real_deployment_failure(self):
        transport = DeploymentTransport([{
            "uid": "dpl_failedfixture", "state": "ERROR",
            "created": int(datetime.now(UTC).timestamp() * 1000),
            "meta": {"githubCommitSha": "abcdef1234567890"},
        }])
        result = await run_monitoring_cycle(vercel_plan(transport))
        payload = result.to_dict()
        failures = [item for item in payload["collection"]["evidence"]
                    if item["metadata"].get("deployment_failed")]
        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0]["deployment_id"], "dpl_failedfixture")
        self.assertEqual(failures[0]["commit_sha"], "abcdef1234567890")
        self.assertEqual(payload["collection"]["collection_failures"][0]["operation"],
                         "runtime_history")
        self.assertEqual(result.exit_code, 3)
        self.assertEqual(len(transport.requests), 1)

    async def test_access_denial_and_missing_runtime_coverage_have_separate_diagnostics(self):
        transport = DeploymentTransport(status=403)
        payload = (await run_monitoring_cycle(vercel_plan(transport))).to_dict()
        self.assertEqual(payload["collection"]["collection_failures"], [
            {"provider": "vercel", "operation": "deployments", "error_type": "ProviderReadError",
             "reason_code": "http_error", "http_status": 403},
            {"provider": "vercel", "operation": "runtime_history", "error_type": "ProviderReadError",
             "reason_code": RUNTIME_REASON},
        ])
        self.assertEqual(payload["status"], "collection_failed")
        self.assertNotIn(PRIVATE, json.dumps(payload))
        self.assertEqual(len(transport.requests), 1)

    def test_named_collector_default_remains_backward_compatible(self):
        self.assertEqual(NamedCollector("vercel", object()).operation, "evidence")
        with self.assertRaises(ValueError):
            NamedCollector("vercel", object(), operation=PRIVATE)


if __name__ == "__main__":
    unittest.main()
