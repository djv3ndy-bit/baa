import json
import unittest
import urllib.error
from io import BytesIO, StringIO
from unittest.mock import AsyncMock, Mock, patch

from era.live import LiveCollectionPlan, NamedCollector, run_live_plan
from era.main import main
from era.models import Environment
from era.providers.http import ProviderReadError, UrlLibJsonTransport, safe_failure_diagnostics
from era.providers.supabase import SupabaseManagementSource
from era.providers.vercel import VercelApiSource
from era.response import build_response_package


PRIVATE = "customer@example.invalid/secret-session-do-not-export"


class ErrorCollector:
    def __init__(self, error):
        self.error = error

    async def collect(self):
        raise self.error


class InvalidResponseTransport:
    async def get_json(self, url, *, headers):
        return {"unexpected": PRIVATE}


class ProviderDiagnosticTests(unittest.IsolatedAsyncioTestCase):
    async def transport_error(self, failure=None, *, body=None, max_bytes=1_000_000):
        opener = Mock()
        if failure is not None:
            opener.open.side_effect = failure
        else:
            opener.open.return_value = BytesIO(body)
        transport = UrlLibJsonTransport(frozenset({"api.example.com"}), max_response_bytes=max_bytes)
        with patch("urllib.request.build_opener", return_value=opener):
            with self.assertRaises(ProviderReadError) as raised:
                await transport.get_json(
                    f"https://api.example.com/read?token={PRIVATE}",
                    headers={"Authorization": f"Bearer {PRIVATE}"},
                )
        return raised.exception

    async def collection(self, error):
        plan = LiveCollectionPlan(
            provider_names=("vercel",), environment=Environment.PRODUCTION,
            evidence_collectors=(NamedCollector("vercel", ErrorCollector(error)),),
        )
        return (await run_live_plan(plan)).to_dict()

    async def test_http_diagnostics_survive_collection_and_response_without_private_data(self):
        for status in [302, 401, 403, 404, 429, 503]:
            with self.subTest(status=status):
                error = await self.transport_error(urllib.error.HTTPError(
                    f"https://api.example.com/{PRIVATE}", status, PRIVATE,
                    {"private-header": PRIVATE}, BytesIO(PRIVATE.encode()),
                ))
                expected = {"provider": "vercel", "operation": "evidence",
                            "error_type": "ProviderReadError", "reason_code": "http_error",
                            "http_status": status}
                payload = await self.collection(error)
                self.assertEqual(payload["collection_failures"], [expected])
                self.assertEqual(payload["evidence"][0]["metadata"]["http_status"], status)
                self.assertEqual(payload["evidence"][0]["metadata"]["reason_code"], "http_error")
                package = build_response_package([
                    {"status": "alert", "severity": "P2", "collection": payload}
                ]).to_dict()
                self.assertEqual(package["collection_failures"], [expected])
                self.assertFalse(package["alert"]["eligible"])
                self.assertNotIn(PRIVATE, json.dumps([payload, package]))
                self.assertNotIn("api.example.com", json.dumps([payload, package]))

    async def test_timeouts_are_distinguished_from_other_transport_failures(self):
        for failure, expected in [
            (TimeoutError(PRIVATE), "timeout"),
            (urllib.error.URLError(TimeoutError(PRIVATE)), "timeout"),
            (urllib.error.URLError(OSError(PRIVATE)), "transport_error"),
            (OSError(PRIVATE), "transport_error"),
        ]:
            with self.subTest(expected=expected, failure=type(failure).__name__):
                error = await self.transport_error(failure)
                self.assertEqual(error.diagnostics(), {"reason_code": expected})
                payload = await self.collection(error)
                self.assertEqual(payload["collection_failures"][0]["reason_code"], expected)
                self.assertNotIn(PRIVATE, json.dumps(payload))

    async def test_invalid_json_and_oversize_responses_have_distinct_safe_codes(self):
        for body, max_bytes, expected in [
            (PRIVATE.encode(), 1024, "invalid_json"),
            (b"x" * 1025, 1024, "response_too_large"),
        ]:
            with self.subTest(expected=expected):
                error = await self.transport_error(body=body, max_bytes=max_bytes)
                self.assertEqual(error.diagnostics(), {"reason_code": expected})
                self.assertNotIn(PRIVATE, json.dumps(await self.collection(error)))

    async def test_invalid_private_provider_shapes_report_invalid_response(self):
        calls = [
            VercelApiSource("synthetic", team_id="team_fixture", transport=InvalidResponseTransport())
                .list_failed_deployments("prj_fixture", environment="production", since="2026-10-21T00:00:00Z", limit=1),
            SupabaseManagementSource("synthetic", transport=InvalidResponseTransport())
                .get_logs("abcdefghijklmnopqrst", service="api", limit=1),
        ]
        for call in calls:
            with self.assertRaises(ProviderReadError) as raised:
                await call
            self.assertEqual(raised.exception.diagnostics(), {"reason_code": "invalid_response"})
            self.assertNotIn(PRIVATE, json.dumps(await self.collection(raised.exception)))

    async def test_rejected_requests_do_not_export_the_url(self):
        transport = UrlLibJsonTransport(frozenset({"api.example.com"}))
        for url in [
            f"http://api.example.com/{PRIVATE}",
            f"https://untrusted.example/{PRIVATE}",
            f"https://user:password@api.example.com/{PRIVATE}",
            f"https://api.example.com/read#{PRIVATE}",
        ]:
            with self.subTest(url_type=url.split(":", 1)[0]):
                with self.assertRaises(ProviderReadError) as raised:
                    await transport.get_json(url, headers={})
                self.assertEqual(raised.exception.diagnostics(), {"reason_code": "invalid_request"})
                self.assertNotIn(PRIVATE, json.dumps(await self.collection(raised.exception)))

    def test_only_allowlisted_codes_and_integer_http_error_statuses_are_retained(self):
        for reason in [PRIVATE, {"secret": PRIVATE}, [PRIVATE], None, True]:
            self.assertEqual(safe_failure_diagnostics(reason, 403), {})
        for status in [PRIVATE, "403", {"status": 403}, True, 299, 600, None]:
            self.assertEqual(safe_failure_diagnostics("http_error", status), {"reason_code": "http_error"})
        self.assertEqual(safe_failure_diagnostics("timeout", 403), {"reason_code": "timeout"})

    async def test_unknown_exceptions_cannot_inject_diagnostic_fields(self):
        error = RuntimeError(PRIVATE)
        error.reason_code = "http_error"
        error.http_status = 403
        payload = await self.collection(error)
        self.assertEqual(payload["collection_failures"], [
            {"provider": "vercel", "operation": "evidence", "error_type": "RuntimeError"}
        ])
        self.assertNotIn(PRIVATE, json.dumps(payload))

    def test_response_package_revalidates_untrusted_diagnostic_fields(self):
        failure = {"provider": "vercel", "operation": "evidence", "error_type": "ProviderReadError",
                   "reason_code": PRIVATE, "http_status": {"secret": PRIVATE},
                   "url": PRIVATE, "body": PRIVATE, "message": PRIVATE}
        package = build_response_package([
            {"status": "alert", "severity": "P2", "collection": {"collection_failures": [failure]}}
        ]).to_dict()
        self.assertEqual(package["collection_failures"], [
            {"provider": "vercel", "operation": "evidence", "error_type": "ProviderReadError"}
        ])
        self.assertNotIn(PRIVATE, json.dumps(package))


class ProviderCliDiagnosticTests(unittest.TestCase):
    def test_failed_deployment_probe_logs_only_safe_diagnostics(self):
        error = ProviderReadError(PRIVATE, reason_code="http_error", http_status=403)
        output = StringIO()
        with patch("sys.argv", ["era", "wait-deployment", "--commit", "abcdef1234567890"]), \
             patch("era.main._run_wait_deployment", new=AsyncMock(side_effect=error)), \
             patch("sys.stderr", output):
            with self.assertRaises(SystemExit) as raised:
                main()
        self.assertEqual(raised.exception.code, 1)
        self.assertEqual(json.loads(output.getvalue()), {
            "error": "operation_failed", "error_type": "ProviderReadError",
            "reason_code": "http_error", "http_status": 403,
        })
        self.assertNotIn(PRIVATE, output.getvalue())


if __name__ == "__main__":
    unittest.main()
