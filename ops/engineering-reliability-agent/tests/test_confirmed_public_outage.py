import copy
import threading
import unittest
import urllib.error
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from io import BytesIO
from unittest.mock import patch

from era.collectors.health import (
    ConfirmedPublicOutageCollector,
    HealthCollector,
    PUBLIC_OUTAGE_URLS,
    is_confirmed_public_outage,
)
from era.live import NamedCollector, LiveCollectionPlan, build_live_plan, run_live_plan
from era.models import Environment, EvidenceSource, IncidentEvidence, Severity
from era.providers.health import UrlLibHealthTransport
from era.severity import classify_incident


HOSTS = frozenset({"www.baristajobmatch.com"})


class FakeClock:
    def __init__(self):
        self.current = datetime(2026, 10, 21, 12, tzinfo=UTC)
        self.waits = []

    def now(self):
        return self.current

    async def sleep(self, seconds):
        self.waits.append(seconds)
        self.current += timedelta(seconds=seconds)


class QueueTransport:
    def __init__(self, first, second, clock):
        self.responses = dict(zip(PUBLIC_OUTAGE_URLS, (list(first), list(second)), strict=True))
        self.requests = []
        self.clock = clock
        self.lock = threading.Lock()

    def get_status(self, url, *, timeout_seconds):
        with self.lock:
            self.requests.append((url, timeout_seconds, self.clock.now()))
            if not self.responses[url]:
                raise AssertionError("Unexpected additional public probe")
            response = self.responses[url].pop(0)
        if isinstance(response, Exception):
            raise response
        return response


def collector(first, second):
    clock = FakeClock()
    transport = QueueTransport(first, second, clock)
    checks = tuple(HealthCollector(url, HOSTS, transport=transport, clock=clock.now) for url in PUBLIC_OUTAGE_URLS)
    return ConfirmedPublicOutageCollector(checks, sleep=clock.sleep, clock=clock.now), transport, clock


def private_failure():
    return IncidentEvidence(
        id="private-failed", source=EvidenceSource.SUPABASE, occurred_at=datetime.now(UTC),
        summary="Read-only provider collection failed", environment=Environment.PRODUCTION,
        metadata={"collection_failed": True, "degraded": True, "http_status": 401},
    )


class ConfirmedPublicOutageTests(unittest.IsolatedAsyncioTestCase):
    async def test_healthy_cycle_uses_only_two_initial_gets_and_never_waits(self):
        check, transport, clock = collector([200], [200])
        evidence = await check.collect()
        self.assertEqual(len(transport.requests), 2)
        self.assertEqual(clock.waits, [])
        self.assertEqual(len(evidence), 2)
        self.assertEqual(classify_incident(evidence).severity, Severity.P3)
        self.assertFalse(any(is_confirmed_public_outage(item) for item in evidence))

    async def test_only_six_failed_probes_fifteen_seconds_apart_create_p1(self):
        check, transport, clock = collector([500, 502, 503], [503, 504, 500])
        evidence = await check.collect()
        self.assertEqual(len(transport.requests), 6)
        self.assertEqual(clock.waits, [15, 15])
        self.assertEqual(len(evidence), 7)
        for url in PUBLIC_OUTAGE_URLS:
            times = [item[2] for item in transport.requests if item[0] == url]
            self.assertEqual([(value - times[0]).total_seconds() for value in times], [0, 15, 30])
        confirmed = [item for item in evidence if is_confirmed_public_outage(item)]
        self.assertEqual(len(confirmed), 1)
        self.assertEqual(len(confirmed[0].metadata["public_outage_probes"]), 6)
        self.assertEqual(classify_incident(evidence).severity, Severity.P1)
        self.assertTrue(all("impact_percent" not in item.metadata for item in evidence))
        self.assertTrue(all(request[1] == 8 for request in transport.requests))
        self.assertEqual(len({item.id for item in evidence}), 7)

    async def test_connection_timeouts_and_resets_qualify_without_exposing_exception_details(self):
        check, transport, clock = collector(
            [urllib.error.URLError("secret=private"), TimeoutError("private"), ConnectionResetError("private")],
            [503, OSError("private"), 502],
        )
        evidence = await check.collect()
        self.assertEqual(classify_incident(evidence).severity, Severity.P1)
        self.assertNotIn("private", str([item.to_dict() for item in evidence]))
        self.assertEqual(len(transport.requests), 6)
        self.assertEqual(clock.waits, [15, 15])

    async def test_single_endpoint_failures_fourxx_and_redirects_do_not_start_confirmation(self):
        for first, second in [(500, 200), (200, 503), (401, 503), (403, 403), (404, 500), (302, 503)]:
            with self.subTest(first=first, second=second):
                check, transport, clock = collector([first], [second])
                evidence = await check.collect()
                self.assertEqual(len(transport.requests), 2)
                self.assertEqual(clock.waits, [])
                self.assertEqual(classify_incident(evidence).severity, Severity.P2)
                self.assertFalse(any(is_confirmed_public_outage(item) for item in evidence))

    async def test_real_urllib_http_error_shapes_are_not_treated_as_network_failures(self):
        for code in (302, 401, 403, 404):
            body = BytesIO(b"private response body")
            error = urllib.error.HTTPError(PUBLIC_OUTAGE_URLS[1], code, "private reason", {}, body)
            check, transport, clock = collector([503], [error])
            evidence = await check.collect()
            self.assertEqual(evidence[1].status_code, code)
            self.assertNotIn("availability", evidence[1].metadata)
            self.assertNotIn("private", str([item.to_dict() for item in evidence]))
            self.assertTrue(body.closed)
            self.assertEqual(len(transport.requests), 2)
            self.assertEqual(clock.waits, [])
            self.assertEqual(classify_incident(evidence).severity, Severity.P2)

    async def test_any_recovery_or_nonqualifying_confirmation_preserves_p2(self):
        for first, second in [([503, 200, 503], [503, 503, 503]),
                              ([503, 503, 503], [503, 200, 200]),
                              ([503, 401, 503], [503, 503, 503]),
                              ([503, 503, 503], [503, 302, 503])]:
            with self.subTest(first=first, second=second):
                check, transport, clock = collector(first, second)
                evidence = await check.collect()
                self.assertEqual(len(transport.requests), 6)
                self.assertEqual(clock.waits, [15, 15])
                self.assertEqual(classify_incident(evidence).severity, Severity.P2)
                self.assertFalse(any(is_confirmed_public_outage(item) for item in evidence))

    async def test_private_collection_failure_does_not_mask_or_create_confirmed_outage(self):
        check, _, _ = collector([503] * 3, [503] * 3)
        evidence = await check.collect()
        self.assertEqual(classify_incident([*evidence, private_failure()]).severity, Severity.P1)
        self.assertEqual(classify_incident([private_failure()]).severity, Severity.P2)
        check, _, _ = collector([200], [200])
        self.assertEqual(classify_incident([*(await check.collect()), private_failure()]).severity, Severity.P2)

    async def test_expected_private_condition_cannot_suppress_confirmed_network_outage(self):
        check, _, _ = collector([TimeoutError()] * 3, [TimeoutError()] * 3)
        evidence = await check.collect()
        expected = replace(private_failure(), metadata={"condition": "planned_maintenance"})
        self.assertEqual(classify_incident([*evidence, expected]).severity, Severity.P1)

    async def test_bare_or_malformed_flags_and_other_sources_never_gain_p1(self):
        check, _, _ = collector([503] * 3, [503] * 3)
        confirmed = (await check.collect())[-1]
        cases = [
            replace(confirmed, metadata={"confirmed_public_outage": True, "degraded": True}),
            replace(confirmed, source=EvidenceSource.SUPABASE),
            replace(confirmed, environment=Environment.PREVIEW),
        ]
        for mutation in ("url", "round", "status", "interval", "missing"):
            metadata = copy.deepcopy(dict(confirmed.metadata))
            if mutation == "url": metadata["public_outage_probes"][0]["url"] = ["untrusted"]
            if mutation == "round": metadata["public_outage_probes"][0]["round"] = True
            if mutation == "status": metadata["public_outage_probes"][0]["status_code"] = 403
            if mutation == "interval": metadata["probe_interval_seconds"] = 1
            if mutation == "missing": metadata["public_outage_probes"].pop()
            cases.append(replace(confirmed, metadata=metadata))
        for item in cases:
            with self.subTest(metadata=item.metadata):
                self.assertFalse(is_confirmed_public_outage(item))
                self.assertNotEqual(classify_incident([item]).severity, Severity.P1)

    async def test_live_collection_retains_only_sanitized_proof(self):
        check, _, _ = collector([503] * 3, [503] * 3)
        plan = LiveCollectionPlan(("health",), Environment.PRODUCTION, (NamedCollector("health", check),))
        result = await run_live_plan(plan)
        self.assertEqual(result.failures, ())
        self.assertEqual(classify_incident(result.evidence).severity, Severity.P1)
        self.assertEqual(len(result.evidence), 7)
        self.assertFalse(result.to_dict()["model_used"])
        self.assertFalse(result.to_dict()["production_writes_enabled"])

    async def test_unexpected_transport_errors_fail_collection_without_inventing_outage(self):
        check, _, _ = collector([ValueError("private")], [503])
        plan = LiveCollectionPlan(("health",), Environment.PRODUCTION, (NamedCollector("health", check),))
        result = await run_live_plan(plan)
        self.assertEqual(len(result.failures), 1)
        self.assertEqual(classify_incident(result.evidence).severity, Severity.P2)
        self.assertFalse(any(is_confirmed_public_outage(item) for item in result.evidence))


class PublicPlanAndTransportTests(unittest.TestCase):
    def test_only_exact_production_pair_uses_confirmation_without_workflow_changes(self):
        for environment, urls, expected in [
            ("production", PUBLIC_OUTAGE_URLS, True),
            ("production", tuple(reversed(PUBLIC_OUTAGE_URLS)), True),
            ("preview", PUBLIC_OUTAGE_URLS, False),
            ("production", PUBLIC_OUTAGE_URLS[:1], False),
            ("production", (*PUBLIC_OUTAGE_URLS, "https://www.baristajobmatch.com/login"), False),
        ]:
            plan = build_live_plan(provider_names=("health",), environment_name=environment,
                environment={"ERA_ALLOWED_HEALTH_HOSTS": "www.baristajobmatch.com"}, health_urls=urls)
            self.assertEqual(any(isinstance(item.collector, ConfirmedPublicOutageCollector) for item in plan.evidence_collectors), expected)
        with self.assertRaises(ValueError):
            ConfirmedPublicOutageCollector(tuple(HealthCollector(url, HOSTS, environment=Environment.PREVIEW) for url in PUBLIC_OUTAGE_URLS))
        with self.assertRaises(ValueError):
            ConfirmedPublicOutageCollector((HealthCollector(PUBLIC_OUTAGE_URLS[0], HOSTS), HealthCollector("https://www.baristajobmatch.com/login", HOSTS)))

    def test_health_transport_sends_only_get_discards_body_and_refuses_redirects(self):
        calls = []

        class Response:
            status = 200
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def read(self, size):
                calls.append(("read", size))
                return b"sensitive body must not leave transport"

        class Opener:
            def open(self, request, timeout):
                calls.append((request.get_method(), request.full_url, timeout))
                self.request = request
                return Response()

        handlers = []
        def factory(handler):
            handlers.append(handler)
            return Opener()

        with patch("urllib.request.build_opener", side_effect=factory):
            self.assertEqual(UrlLibHealthTransport().get_status(PUBLIC_OUTAGE_URLS[0], timeout_seconds=8), 200)
        self.assertEqual(calls, [("GET", PUBLIC_OUTAGE_URLS[0], 8), ("read", 512)])
        self.assertIsNone(handlers[0].redirect_request(None, None, 302, "Found", {}, "https://untrusted.example"))


if __name__ == "__main__":
    unittest.main()
