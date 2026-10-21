import copy
import hashlib
import unittest
from unittest.mock import patch

from era.alerts import AlertMessage, ResendAlertSender, deliver_response_alert


def response_package(severity: str, *, eligible: bool):
    return {
        "severity": severity,
        "fingerprint": "0123456789abcdef",
        "title": "Synthetic incident",
        "summary": "Production health check failed.",
        "likely_cause": "A recent change may be related.",
        "recommended_actions": ["Review the sanitized evidence."],
        "alert": {
            "eligible": eligible,
            "owner_approval_required": True,
            "sent": False,
        },
        "source": {
            "repository": "djv3ndy-bit/baa",
            "run_id": "12345",
        },
    }


class FakeSender:
    def __init__(self, error=None):
        self.messages = []
        self.error = error

    def send(self, message):
        self.messages.append(message)
        if self.error:
            raise self.error


class AlertTests(unittest.TestCase):
    def test_resend_transport_is_fixed_to_single_endpoint_and_method(self) -> None:
        with patch("era.alerts.http.client.HTTPSConnection") as connection_type:
            response = connection_type.return_value.getresponse.return_value
            response.status = 200
            response.read.return_value = b'{"id":"email_123"}'
            sender = ResendAlertSender("re_test_secret")
            sender.send(
                AlertMessage(
                    recipient="owner@example.com",
                    sender="BaristaMatch Reliability <updates@updates.baristajobmatch.com>",
                    subject="[P1] Synthetic incident",
                    html_body="<p>Sanitized</p>",
                    idempotency_key="era-incident-0123456789abcdef",
                )
            )

        self.assertEqual(connection_type.call_args.args[0], "api.resend.com")
        request = connection_type.return_value.request
        self.assertEqual(request.call_args.args[0], "POST")
        self.assertEqual(request.call_args.args[1], "/emails")
        self.assertEqual(
            request.call_args.kwargs["headers"]["Idempotency-Key"],
            "era-incident-0123456789abcdef",
        )

    def test_p1_requires_explicit_owner_approval(self) -> None:
        sender = FakeSender()
        result = deliver_response_alert(
            response_package("P1", eligible=True),
            {
                "ERA_ALERT_EMAIL": "owner@example.com",
                "ERA_RESEND_API_KEY": "re_test_secret",
            },
            sender=sender,
        )

        self.assertEqual(result.status, "approval_missing")
        self.assertEqual(result.exit_code, 3)
        self.assertFalse(result.attempted)
        self.assertEqual(sender.messages, [])

    def test_approved_p1_uses_idempotent_owner_only_message(self) -> None:
        sender = FakeSender()
        result = deliver_response_alert(
            response_package("P1", eligible=True),
            {
                "ERA_P0_P1_EMAIL_ALERTS_APPROVED": "true",
                "ERA_ALERT_EMAIL": "owner@example.com",
                "ERA_RESEND_API_KEY": "re_test_secret",
            },
            sender=sender,
        )

        self.assertEqual(result.status, "delivered")
        self.assertEqual(result.exit_code, 0)
        self.assertTrue(result.delivered)
        self.assertEqual(len(sender.messages), 1)
        message = sender.messages[0]
        self.assertEqual(message.recipient, "owner@example.com")
        self.assertRegex(message.idempotency_key, r"^era-incident-0123456789abcdef-[0-9a-f]{64}$")
        self.assertIn("No fix, merge, production deployment", message.html_body)
        self.assertNotIn("owner@example.com", str(result.to_dict()))
        self.assertNotIn("re_test_secret", str(result.to_dict()))

    def test_repeated_runs_send_identical_bytes_and_keys_without_exporting_run_metadata(self) -> None:
        sender = FakeSender()
        environment = {
            "ERA_P0_P1_EMAIL_ALERTS_APPROVED": "true",
            "ERA_ALERT_EMAIL": "owner@example.com",
            "ERA_RESEND_API_KEY": "re_test_secret",
        }
        first = response_package("P1", eligible=True)
        first["source"]["run_id"] = "10001"
        first["source"]["source_sha"] = "a" * 40
        first["summary"] = "Synthetic test with customer@example.invalid and token=must-not-export"
        second = copy.deepcopy(first)
        second["source"]["run_id"] = "10002"
        second["source"]["source_sha"] = "b" * 40
        second["evidence_ids"] = ["new-observation-identifier"]
        for package in (first, second):
            result = deliver_response_alert(package, environment, sender=sender)
            self.assertTrue(result.delivered)
            self.assertNotIn("owner@example.com", str(result.to_dict()))
            self.assertNotIn("re_test_secret", str(result.to_dict()))
        self.assertEqual(sender.messages[0], sender.messages[1])
        message = sender.messages[0]
        self.assertIn("/actions/workflows/engineering-reliability-monitor.yml", message.html_body)
        for private_value in ("10001", "10002", "customer@example.invalid", "must-not-export"):
            self.assertNotIn(private_value, message.html_body)
            self.assertNotIn(private_value, message.idempotency_key)
        with patch("era.alerts.http.client.HTTPSConnection") as connection_type:
            response = connection_type.return_value.getresponse.return_value
            response.status = 200
            response.read.return_value = b'{"id":"email_synthetic"}'
            transport = ResendAlertSender("re_test_secret")
            for repeated_message in sender.messages:
                transport.send(repeated_message)
            requests = connection_type.return_value.request.call_args_list
        first_request, second_request = (call.kwargs for call in requests)
        self.assertEqual(first_request["body"], second_request["body"])
        self.assertEqual(first_request["headers"]["Idempotency-Key"], second_request["headers"]["Idempotency-Key"])
        self.assertEqual(
            message.idempotency_key,
            f"era-incident-0123456789abcdef-{hashlib.sha256(first_request['body']).hexdigest()}",
        )

    def test_changed_substantive_narrative_or_recipient_gets_a_distinct_idempotency_key(self) -> None:
        sender = FakeSender()
        environment = {
            "ERA_P0_P1_EMAIL_ALERTS_APPROVED": "true",
            "ERA_ALERT_EMAIL": "owner@example.com",
            "ERA_RESEND_API_KEY": "re_test_secret",
        }
        original = response_package("P1", eligible=True)
        updated = copy.deepcopy(original)
        updated["summary"] = "A different substantive sanitized incident update."
        for package in (original, updated):
            self.assertTrue(deliver_response_alert(package, environment, sender=sender).delivered)
        environment["ERA_ALERT_EMAIL"] = "other-owner@example.com"
        self.assertTrue(deliver_response_alert(updated, environment, sender=sender).delivered)
        self.assertEqual(len({message.idempotency_key for message in sender.messages}), 3)
        self.assertNotEqual(sender.messages[0].html_body, sender.messages[1].html_body)
        self.assertEqual(sender.messages[1].html_body, sender.messages[2].html_body)
        self.assertTrue(all(len(message.idempotency_key) <= 256 for message in sender.messages))

    def test_p2_never_sends_email_even_when_configured(self) -> None:
        sender = FakeSender()
        result = deliver_response_alert(
            response_package("P2", eligible=False),
            {
                "ERA_P0_P1_EMAIL_ALERTS_APPROVED": "true",
                "ERA_ALERT_EMAIL": "owner@example.com",
                "ERA_RESEND_API_KEY": "re_test_secret",
            },
            sender=sender,
        )

        self.assertEqual(result.status, "not_required")
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(sender.messages, [])

    def test_delivery_failure_exposes_only_exception_type(self) -> None:
        sender = FakeSender(RuntimeError("token=must-not-leak"))
        result = deliver_response_alert(
            response_package("P0", eligible=True),
            {
                "ERA_P0_P1_EMAIL_ALERTS_APPROVED": "true",
                "ERA_ALERT_EMAIL": "owner@example.com",
                "ERA_RESEND_API_KEY": "re_test_secret",
            },
            sender=sender,
        )

        payload = result.to_dict()
        self.assertEqual(payload["status"], "delivery_failed")
        self.assertEqual(payload["error_type"], "RuntimeError")
        self.assertNotIn("must-not-leak", str(payload))


if __name__ == "__main__":
    unittest.main()
