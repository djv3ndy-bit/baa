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
        self.assertEqual(message.idempotency_key, "era-incident-0123456789abcdef")
        self.assertIn("No fix, merge, production deployment", message.html_body)
        self.assertNotIn("owner@example.com", str(result.to_dict()))
        self.assertNotIn("re_test_secret", str(result.to_dict()))

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
