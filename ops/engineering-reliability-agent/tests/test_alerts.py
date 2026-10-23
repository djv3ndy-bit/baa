import copy
import hashlib
import http.client
import json
import unittest
from unittest.mock import patch

from era.alerts import AlertDeliveryResult, AlertMessage, ResendAlertSender, deliver_response_alert


PROVIDER_ID = "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794"


def approved_environment():
    return {
        "ERA_P0_P1_EMAIL_ALERTS_APPROVED": "true",
        "ERA_ALERT_EMAIL": "owner@example.com",
        "ERA_RESEND_API_KEY": "re_test_secret",
    }


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
    def __init__(self, error=None, provider_message_id=None):
        self.messages = []
        self.error = error
        self.provider_message_id = provider_message_id

    def send(self, message):
        self.messages.append(message)
        if self.error:
            raise self.error
        return self.provider_message_id


class AlertTests(unittest.TestCase):
    def transport_result(self, body, *, status=200, read_error=None):
        with patch("era.alerts.http.client.HTTPSConnection") as connection_type:
            connection = connection_type.return_value
            response = connection.getresponse.return_value
            response.status = status
            response.read.return_value = body
            response.read.side_effect = read_error
            result = deliver_response_alert(
                response_package("P1", eligible=True), approved_environment()
            )
        connection.request.assert_called_once()
        connection.close.assert_called_once()
        return result, response

    def test_real_transport_acceptance_preserves_only_correlation_id_not_delivery_claims(self):
        result, _ = self.transport_result(json.dumps({
            "id": PROVIDER_ID.upper(), "delivered": True,
            "private": "must-not-export", "to": "owner@example.com",
        }).encode())
        payload = result.to_dict()
        self.assertEqual(payload["status"], "provider_accepted")
        self.assertEqual(payload["exit_code"], 0)
        self.assertTrue(payload["provider_accepted"])
        self.assertTrue(payload["attempted"])
        self.assertFalse(payload["delivered"])
        self.assertFalse(payload["mailbox_delivery_verified"])
        self.assertEqual(payload["provider_message_id"], PROVIDER_ID)
        for private in ("must-not-export", "owner@example.com", "re_test_secret"):
            self.assertNotIn(private, json.dumps(payload))

    def test_unusable_success_body_does_not_repeat_or_reclassify_accepted_send(self):
        bodies = [b"", b"not-json-must-not-export", b"\xff", b"[]", b"{}",
                  b'{"id":"must-not-export"}', b'{"id":{"private":"must-not-export"}}',
                  b'{"id":"<smtp-message@must-not-export>"}', b'{"id":123}',
                  b'{"irrelevant_number":' + b"9" * 5_000 + b'}',
                  json.dumps({"id": PROVIDER_ID}).encode() + b" " * 1_000_000]
        for body in bodies:
            with self.subTest(body_length=len(body)):
                result, response = self.transport_result(body)
                payload = result.to_dict()
                self.assertEqual(result.status, "provider_accepted")
                self.assertEqual(result.exit_code, 0)
                self.assertTrue(result.provider_accepted)
                self.assertFalse(result.delivered)
                self.assertFalse(result.mailbox_delivery_verified)
                self.assertIsNone(result.provider_message_id)
                self.assertNotIn("must-not-export", json.dumps(payload))
                response.read.assert_called_once_with(1_000_001)

    def test_success_headers_with_incomplete_body_still_establish_only_acceptance(self):
        for error in (TimeoutError("must-not-export"), http.client.IncompleteRead(b"must-not-export")):
            with self.subTest(error_type=type(error).__name__):
                result, _ = self.transport_result(b"", read_error=error)
                self.assertTrue(result.provider_accepted)
                self.assertFalse(result.delivered)
                self.assertFalse(result.mailbox_delivery_verified)
                self.assertIsNone(result.provider_message_id)
                self.assertEqual(result.exit_code, 0)
                self.assertNotIn("must-not-export", json.dumps(result.to_dict()))

    def test_provider_rejection_is_not_acceptance_and_does_not_read_error_body(self):
        for status in (401, 403, 429, 503):
            with self.subTest(status=status):
                result, response = self.transport_result(b"must-not-export", status=status)
                self.assertEqual(result.status, "delivery_failed")
                self.assertEqual(result.exit_code, 4)
                self.assertTrue(result.attempted)
                self.assertFalse(result.provider_accepted)
                self.assertFalse(result.delivered)
                self.assertFalse(result.mailbox_delivery_verified)
                self.assertIsNone(result.provider_message_id)
                response.read.assert_not_called()
                self.assertNotIn("must-not-export", json.dumps(result.to_dict()))

    def test_optional_sender_receipt_is_revalidated_and_legacy_none_remains_accepted(self):
        for receipt in (None, "must-not-export", {"id": PROVIDER_ID}, 123):
            with self.subTest(receipt_type=type(receipt).__name__):
                sender = FakeSender(provider_message_id=receipt)
                result = deliver_response_alert(
                    response_package("P1", eligible=True), approved_environment(), sender=sender
                )
                self.assertTrue(result.provider_accepted)
                self.assertFalse(result.delivered)
                self.assertIsNone(result.provider_message_id)
                self.assertEqual(result.exit_code, 0)
                self.assertNotIn("must-not-export", json.dumps(result.to_dict()))
        direct = AlertDeliveryResult(
            "provider_accepted", True, False, "P1", "fixture",
            provider_accepted=True, provider_message_id="must-not-export",
        )
        self.assertIsNone(direct.to_dict()["provider_message_id"])

    def test_resend_transport_is_fixed_to_single_endpoint_and_method(self) -> None:
        with patch("era.alerts.http.client.HTTPSConnection") as connection_type:
            response = connection_type.return_value.getresponse.return_value
            response.status = 200
            response.read.return_value = json.dumps({"id": PROVIDER_ID}).encode()
            sender = ResendAlertSender("re_test_secret")
            provider_message_id = sender.send(
                AlertMessage(
                    recipient="owner@example.com",
                    sender="BaristaMatch Reliability <updates@updates.baristajobmatch.com>",
                    subject="[P1] Synthetic incident",
                    html_body="<p>Sanitized</p>",
                    idempotency_key="era-incident-0123456789abcdef",
                )
            )

        self.assertEqual(connection_type.call_args.args[0], "api.resend.com")
        self.assertEqual(provider_message_id, PROVIDER_ID)
        response.read.assert_called_once_with(1_000_001)
        connection_type.return_value.close.assert_called_once()
        request = connection_type.return_value.request
        self.assertEqual(request.call_args.args[0], "POST")
        self.assertEqual(request.call_args.args[1], "/emails")
        self.assertEqual(
            request.call_args.kwargs["headers"]["Idempotency-Key"],
            "era-incident-0123456789abcdef",
        )

    def test_p1_requires_explicit_owner_approval(self) -> None:
        sender = FakeSender(provider_message_id=PROVIDER_ID)
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
        sender = FakeSender(provider_message_id=PROVIDER_ID)
        result = deliver_response_alert(
            response_package("P1", eligible=True),
            {
                "ERA_P0_P1_EMAIL_ALERTS_APPROVED": "true",
                "ERA_ALERT_EMAIL": "owner@example.com",
                "ERA_RESEND_API_KEY": "re_test_secret",
            },
            sender=sender,
        )

        self.assertEqual(result.status, "provider_accepted")
        self.assertEqual(result.exit_code, 0)
        self.assertFalse(result.delivered)
        self.assertTrue(result.provider_accepted)
        self.assertFalse(result.mailbox_delivery_verified)
        self.assertEqual(result.provider_message_id, PROVIDER_ID)
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
            self.assertTrue(result.provider_accepted)
            self.assertFalse(result.delivered)
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
            self.assertTrue(deliver_response_alert(package, environment, sender=sender).provider_accepted)
        environment["ERA_ALERT_EMAIL"] = "other-owner@example.com"
        self.assertTrue(deliver_response_alert(updated, environment, sender=sender).provider_accepted)
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
