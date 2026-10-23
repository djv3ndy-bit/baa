import base64
import http.client
import io
import json
import ssl
import unittest
import urllib.error
import urllib.request
from datetime import UTC, datetime, timedelta
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from era.collectors.runtime_summary import RuntimeSummaryCollector
from era.live import build_live_plan
from era.models import Environment
from era.monitor import run_monitoring_cycle
from era.providers.http import ProviderReadError
from era.providers.runtime_summary import (RuntimeSummaryHttpTransport, RuntimeSummarySource,
                                          RUNTIME_PROJECT, RUNTIME_SUMMARY_URL)
from era.providers.vercel import VercelApiSource
from era.response import build_response_package
from era.runtime_alerts import deliver_runtime_notice

NOW = datetime(2026, 10, 23, 18, 0, tzinfo=UTC)


def stamp(value):
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def identity(**changes):
    claims = {
        "iss": "https://token.actions.githubusercontent.com", "aud": RUNTIME_SUMMARY_URL,
        "sub": "repo:djv3ndy-bit@313253306/baa@1324630119:ref:refs/heads/main",
        "repository_id": "1324630119", "repository_owner_id": "313253306",
        "workflow_ref": "djv3ndy-bit/baa/.github/workflows/engineering-reliability-monitor.yml@refs/heads/main",
        "iat": int(NOW.timestamp()) - 30, "nbf": int(NOW.timestamp()) - 30,
        "exp": int(NOW.timestamp()) + 270,
    }
    claims.update(changes)
    encode = lambda item: base64.urlsafe_b64encode(json.dumps(item).encode()).decode().rstrip("=")
    return encode({"alg": "RS256"}) + "." + encode(claims) + "." + "syntheticSignatureNotValidForNetwork"


def summary(*, now=NOW, errors=0, fatal=0, http5xx=0):
    return {
        "schema_version": 1, "project_id": RUNTIME_PROJECT, "environment": "production",
        "window": {"since": stamp(now - timedelta(hours=2)), "until": stamp(now)},
        "counts": {"runtime_error": errors, "runtime_fatal": fatal, "http_5xx": http5xx, "runtime_ok": 24},
        "coverage_started_at": stamp(now - timedelta(hours=3)), "last_delivery_at": stamp(now),
        "complete": True, "truncated": False,
    }


class Transport:
    def __init__(self, payload):
        self.payload, self.requests = payload, []

    async def get_json(self, url, *, headers):
        self.requests.append((url, headers))
        return self.payload


class NoticeSender:
    def __init__(self): self.messages = []
    def send(self, message): self.messages.append(message)


NOTICE_ENV = {"ERA_RUNTIME_EMAIL_ALERTS_APPROVED": "true", "ERA_ALERT_EMAIL": "hello@baristajobmatch.com",
              "ERA_RESEND_API_KEY": "synthetic-resend-key"}


def source(payload, *, token=None, now=NOW, **kwargs):
    return RuntimeSummarySource(token or identity(), transport=Transport(payload), clock=lambda: now, **kwargs)


class RuntimeSummaryTests(unittest.IsolatedAsyncioTestCase):
    async def test_complete_counts_only_contract_is_fixed_to_production_and_two_hours(self):
        reader = source(summary(errors=3))
        result = await reader.read(RUNTIME_PROJECT, "production", "2h")
        self.assertEqual(result.counts["runtime_error"], 3)
        url, headers = reader._transport.requests[0]
        parsed = urlsplit(url)
        self.assertEqual(parsed.scheme + "://" + parsed.netloc + parsed.path, RUNTIME_SUMMARY_URL)
        self.assertEqual(parse_qs(parsed.query), {"since": ["2026-10-23T16:00:00.000Z"], "until": ["2026-10-23T18:00:00.000Z"]})
        self.assertEqual(headers["Authorization"], "Bearer " + identity())
        self.assertEqual(set(headers), {"Authorization", "Accept", "User-Agent"})

    async def test_wrong_routing_claims_expiry_or_missing_identity_fail_before_summary_request(self):
        variants = ["", "not-a-token", identity(aud="https://evil.example"),
                    identity(sub="repo:djv3ndy-bit/baa:ref:refs/heads/main"),
                    identity(repository_id="1324630118"), identity(repository_owner_id=313253306),
                    identity(workflow_ref="djv3ndy-bit/baa/other.yml@refs/heads/main"),
                    identity(exp=int(NOW.timestamp())), identity(iat=int(NOW.timestamp()) + 120),
                    identity(nbf=int(NOW.timestamp()) + 120), identity(exp=int(NOW.timestamp()) + 900),
                    identity(iat=True)]
        for token in variants:
            reader = RuntimeSummarySource(token, transport=Transport(summary()), clock=lambda: NOW)
            with self.subTest(token_length=len(token)), self.assertRaises(ProviderReadError) as raised:
                await reader.read(RUNTIME_PROJECT, "production", "2h")
            self.assertEqual(raised.exception.reason_code, "runtime_summary_configuration_failed")
            self.assertEqual(reader._transport.requests, [])
            self.assertNotIn(token if token else "no-token-sentinel", str(raised.exception))

    async def test_wrong_project_environment_and_unbounded_lookback_never_issue_summary_request(self):
        for project, env, lookback in [("other", "production", "2h"), (RUNTIME_PROJECT, "preview", "2h"),
                                      (RUNTIME_PROJECT, "production", "3h"), (RUNTIME_PROJECT, "production", "0m"),
                                      (RUNTIME_PROJECT, "production", "1d"), (RUNTIME_PROJECT, "production", "9" * 5000 + "m")]:
            reader = source(summary())
            with self.subTest(env=env, lookback_length=len(lookback)), self.assertRaises(ProviderReadError):
                await reader.read(project, env, lookback)
            self.assertEqual(reader._transport.requests, [])

    async def test_disabled_or_invalid_configuration_never_requests_identity(self):
        with patch("era.live.acquire_github_runtime_identity") as acquire:
            build_live_plan(provider_names=["vercel"], environment_name="production", environment={
                "VERCEL_READ_TOKEN": "synthetic-only", "VERCEL_TEAM_ID": "team_fixture", "VERCEL_PROJECT_ID": RUNTIME_PROJECT,
            }, lookback="2h")
            acquire.assert_not_called()
        def unwanted_identity():
            self.fail("Invalid fixed configuration should not request a JWT")
        for project, env, lookback, instant in [("wrong", "production", "2h", NOW),
                                              (RUNTIME_PROJECT, "preview", "2h", NOW),
                                              (RUNTIME_PROJECT, "production", "3h", NOW),
                                              (RUNTIME_PROJECT, "production", "2h", datetime(2026, 10, 23))]:
            with self.subTest(project=project, env=env, lookback=lookback), self.assertRaises(ProviderReadError):
                await RuntimeSummarySource(identity=unwanted_identity, clock=lambda: instant).read(project, env, lookback)

    async def test_strict_contract_rejects_raw_fields_types_window_mismatch_and_bad_counts(self):
        variants = []
        for key, value in [("schema_version", True), ("environment", "preview"), ("project_id", "other"),
                           ("complete", 1), ("truncated", 0), ("raw_logs", [{"message": "private-marker"}])]:
            payload = summary(); payload[key] = value; variants.append(payload)
        for value in [True, -1, 1.5, "1", 2_147_483_648]:
            payload = summary(); payload["counts"]["runtime_error"] = value; variants.append(payload)
        payload = summary(); payload["counts"]["route"] = "/private-marker"; variants.append(payload)
        payload = summary(); payload["window"]["since"] = stamp(NOW - timedelta(hours=1)); variants.append(payload)
        payload = summary(); payload["last_delivery_at"] = stamp(NOW + timedelta(seconds=61)); variants.append(payload)
        variants += [None, [], {}, {"authorized": False}]
        for index, payload in enumerate(variants):
            with self.subTest(index=index), self.assertRaises(ProviderReadError) as raised:
                await source(payload).read(RUNTIME_PROJECT, "production", "2h")
            self.assertEqual(raised.exception.reason_code, "runtime_summary_invalid_response")
            self.assertNotIn("private-marker", str(raised.exception))

    async def test_warming_stale_incomplete_and_truncated_are_coverage_failures_not_healthy(self):
        for key, value, reason in [
            ("coverage_started_at", None, "runtime_summary_warming_up"),
            ("last_delivery_at", None, "runtime_summary_warming_up"),
            ("coverage_started_at", stamp(NOW - timedelta(hours=1)), "runtime_summary_warming_up"),
            ("last_delivery_at", stamp(NOW - timedelta(minutes=15, seconds=1)), "runtime_summary_stale"),
            ("complete", False, "runtime_summary_partial"), ("truncated", True, "runtime_summary_partial"),
        ]:
            payload = summary(errors=7); payload[key] = value
            with self.subTest(key=key, value=value), self.assertRaises(ProviderReadError) as raised:
                await source(payload).read(RUNTIME_PROJECT, "production", "2h")
            self.assertEqual(raised.exception.reason_code, reason)

    async def test_healthy_feed_has_no_error_evidence_and_count_categories_do_not_invent_impact(self):
        collector = RuntimeSummaryCollector(source(summary()), RUNTIME_PROJECT, environment=Environment.PRODUCTION, since="2h")
        self.assertEqual(await collector.collect(), [])
        collector = RuntimeSummaryCollector(source(summary(errors=2, fatal=1, http5xx=4)), RUNTIME_PROJECT,
                                            environment=Environment.PRODUCTION, since="2h")
        items = await collector.collect()
        self.assertEqual([item.metadata["runtime_summary_kind"] for item in items], ["error", "fatal", "http5xx"])
        self.assertEqual([item.status_code for item in items], [None, None, 500])
        for item in items:
            self.assertIsNone(item.route)
            self.assertEqual(set(item.metadata), {"runtime_summary_kind", "runtime_summary_project_id", "error_count"})

    async def test_enabled_reader_preserves_deployments_and_missing_identity_is_per_operation_failure(self):
        deployments = Transport({"deployments": []})
        vercel = VercelApiSource("synthetic-deployment-only-token", team_id="team_fixture", transport=deployments)
        environment = {"VERCEL_READ_TOKEN": "synthetic-deployment-only-token", "VERCEL_TEAM_ID": "team_fixture",
                       "VERCEL_PROJECT_ID": RUNTIME_PROJECT, "ERA_RUNTIME_SUMMARY_ENABLED": "true"}
        with patch("era.live.VercelApiSource", return_value=vercel), patch("era.live.acquire_github_runtime_identity") as acquire:
            acquire.side_effect = ProviderReadError("private-marker", reason_code="runtime_identity_unavailable")
            plan = build_live_plan(provider_names=["vercel"], environment_name="production", environment=environment, lookback="2h")
            acquire.assert_not_called()
            result = await run_monitoring_cycle(plan)
        self.assertEqual(result.exit_code, 3)
        self.assertEqual(len(deployments.requests), 1)
        self.assertEqual(result.collection.failures[0].operation, "runtime_history")
        self.assertEqual(result.collection.failures[0].reason_code, "runtime_identity_unavailable")
        self.assertNotIn("private-marker", json.dumps(result.to_dict()))
        sender = NoticeSender()
        notice = deliver_runtime_notice(result.to_dict(), NOTICE_ENV, sender=sender, now=NOW)
        self.assertEqual(notice.status, "provider_accepted")
        self.assertEqual(len(sender.messages), 1)

    async def test_real_live_cycle_summary_markers_reach_notice_without_changing_incident_policy(self):
        environment = {"VERCEL_READ_TOKEN": "synthetic-deployment-only-token", "VERCEL_TEAM_ID": "team_fixture",
                       "VERCEL_PROJECT_ID": RUNTIME_PROJECT, "ERA_RUNTIME_SUMMARY_ENABLED": "true"}
        for count in (0, 1, 3):
            deployments = Transport({"deployments": []})
            vercel = VercelApiSource("synthetic-deployment-only-token", team_id="team_fixture", transport=deployments)
            reader = source(summary(errors=count))
            with self.subTest(count=count), patch("era.live.VercelApiSource", return_value=vercel), \
                 patch("era.live.RuntimeSummarySource", return_value=reader):
                plan = build_live_plan(provider_names=["vercel"], environment_name="production", environment=environment, lookback="2h")
                result = await run_monitoring_cycle(plan)
            payload = result.to_dict()
            self.assertEqual(payload["collection"]["collection_failures"], [])
            package = build_response_package([payload]).to_dict()
            self.assertFalse(package["alert"]["eligible"])
            self.assertEqual(package["severity"], "P2" if count >= 2 else "P3")
            sender = NoticeSender()
            notice = deliver_runtime_notice(payload, NOTICE_ENV, sender=sender, now=NOW)
            self.assertEqual(notice.status, "provider_accepted" if count else "not_required")
            self.assertEqual(len(sender.messages), int(count > 0))
            self.assertEqual(len(deployments.requests), 1)

    async def test_same_error_category_across_overlapping_windows_keeps_fingerprint_and_severity(self):
        fingerprints = []
        for minute, count in [(0, 2), (60, 13)]:
            now = NOW + timedelta(minutes=minute)
            reader = source(summary(now=now, errors=count), now=now, token=identity(
                iat=int(now.timestamp()) - 30, nbf=int(now.timestamp()) - 30, exp=int(now.timestamp()) + 270))
            from era.live import LiveCollectionPlan, NamedCollector
            plan = LiveCollectionPlan(("vercel",), Environment.PRODUCTION, (NamedCollector("vercel",
                RuntimeSummaryCollector(reader, RUNTIME_PROJECT, environment=Environment.PRODUCTION, since="2h"),
                operation="runtime_history"),))
            payload = (await run_monitoring_cycle(plan)).to_dict()
            package = build_response_package([payload]).to_dict()
            self.assertEqual(package["severity"], "P2")
            self.assertFalse(package["alert"]["eligible"])
            fingerprints.append(package["fingerprint"])
        self.assertEqual(fingerprints[0], fingerprints[1])


class Response:
    status = 200
    def __init__(self, body): self.body = body
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def read(self, size): return self.body[:size]


class RuntimeTransportTests(unittest.TestCase):
    URL = RUNTIME_SUMMARY_URL + "?since=2026-10-23T16%3A00%3A00Z&until=2026-10-23T18%3A00%3A00Z"

    def test_single_fixed_get_disables_proxy_redirect_and_tls_key_logging(self):
        with patch("era.providers.runtime_summary.urllib.request.build_opener") as build:
            build.return_value.open.return_value = Response(b'{}')
            self.assertEqual(RuntimeSummaryHttpTransport()._get_sync(self.URL, {"Authorization": "Bearer synthetic"}), {})
        proxy, redirect, https = build.call_args.args
        self.assertIsInstance(proxy, urllib.request.ProxyHandler)
        self.assertEqual(proxy.proxies, {})
        self.assertIsNone(redirect.redirect_request(None, None, 302, "", {}, "https://evil.example"))
        self.assertTrue(https._context.check_hostname)
        self.assertEqual(https._context.verify_mode, ssl.CERT_REQUIRED)
        self.assertIsNone(https._context.keylog_filename)
        request = build.return_value.open.call_args.args[0]
        self.assertEqual(request.get_method(), "GET")
        self.assertEqual(build.return_value.open.call_args.kwargs["timeout"], 8)

    def test_wrong_endpoint_or_extra_query_fails_before_network(self):
        variants = [self.URL.replace("https:", "http:"), self.URL.replace("supabase.co", "supabase.co.evil.example"),
                    self.URL.replace("/era-runtime?", "/other?"), self.URL + "&project=other", self.URL + "#fragment",
                    self.URL + "&since=2026-10-23T16:00:00Z"]
        for url in variants:
            with self.subTest(url=url), patch("era.providers.runtime_summary.urllib.request.build_opener") as build:
                with self.assertRaises(ProviderReadError): RuntimeSummaryHttpTransport()._get_sync(url, {})
                build.assert_not_called()

    def test_error_bodies_are_discarded_and_bounded_bad_bodies_never_exported(self):
        body = io.BytesIO(b"private-marker")
        error = urllib.error.HTTPError(self.URL, 403, "private-marker", {}, body)
        with patch("era.providers.runtime_summary.urllib.request.build_opener") as build:
            build.return_value.open.side_effect = error
            with self.assertRaises(ProviderReadError) as raised:
                RuntimeSummaryHttpTransport()._get_sync(self.URL, {})
        self.assertTrue(body.closed)
        self.assertEqual(raised.exception.http_status, 403)
        self.assertNotIn("private-marker", str(raised.exception))
        for bad in [b"private-marker", b" " * 16385, b'{"x":' + b"1" * 5000 + b'}']:
            with self.subTest(size=len(bad)), patch("era.providers.runtime_summary.urllib.request.build_opener") as build:
                build.return_value.open.return_value = Response(bad)
                with self.assertRaises(ProviderReadError) as raised:
                    RuntimeSummaryHttpTransport()._get_sync(self.URL, {})
                self.assertNotIn("private-marker", str(raised.exception))

    def test_incomplete_body_is_fixed_transport_failure(self):
        with patch("era.providers.runtime_summary.urllib.request.build_opener") as build:
            build.return_value.open.side_effect = http.client.IncompleteRead(b"private-marker")
            with self.assertRaises(ProviderReadError) as raised:
                RuntimeSummaryHttpTransport()._get_sync(self.URL, {})
        self.assertEqual(raised.exception.reason_code, "transport_error")
        self.assertNotIn("private-marker", str(raised.exception))


if __name__ == "__main__": unittest.main()
