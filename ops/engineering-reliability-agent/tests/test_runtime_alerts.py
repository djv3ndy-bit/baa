import hashlib
import io
import json
import unittest
from contextlib import redirect_stdout
from datetime import UTC, datetime, timedelta
from unittest.mock import mock_open, patch

from era.alerts import _sending_payload
from era.providers.runtime_summary import RUNTIME_PROJECT
from era.runtime_alerts import RuntimeNoticeResult, deliver_runtime_notice, main

NOW = datetime(2026, 10, 23, 18, 3, tzinfo=UTC)
MESSAGE_ID = "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794"


def environment():
    return {"ERA_RUNTIME_EMAIL_ALERTS_APPROVED": "true", "ERA_ALERT_EMAIL": "hello@baristajobmatch.com",
            "ERA_RESEND_API_KEY": "synthetic-resend-key"}


def payload(*, kind="error", count=1, gap=False):
    metadata = {"runtime_summary_kind": kind, "runtime_summary_project_id": RUNTIME_PROJECT, "error_count": count}
    if gap:
        metadata = {"collection_failed": True, "operation": "runtime_history"}
    return {"collection": {"mode": "read_only", "model_used": False, "production_writes_enabled": False,
                           "providers": ["vercel"], "evidence": [{"source": "vercel", "environment": "production",
                           "metadata": metadata}]}}


class Sender:
    def __init__(self, error=None, receipt=MESSAGE_ID):
        self.messages, self.error, self.receipt = [], error, receipt
    def send(self, message):
        self.messages.append(message)
        if self.error: raise self.error
        return self.receipt


class RuntimeNoticeTests(unittest.TestCase):
    def test_default_is_disabled_and_missing_configuration_never_sends(self):
        for env, expected in [({}, "approval_missing"), ({**environment(), "ERA_RUNTIME_EMAIL_ALERTS_APPROVED": "false"}, "approval_missing"),
                              ({**environment(), "ERA_ALERT_EMAIL": "other@example.com"}, "configuration_failed"),
                              ({**environment(), "ERA_RESEND_API_KEY": ""}, "configuration_failed"),
                              ({**environment(), "ERA_RESEND_API_KEY": "synthetic\nsecret"}, "configuration_failed")]:
            sender = Sender()
            result = deliver_runtime_notice(payload(), env, sender=sender, now=NOW)
            self.assertEqual(result.status, expected)
            self.assertFalse(result.attempted)
            self.assertEqual(sender.messages, [])

    def test_each_valid_error_category_or_runtime_coverage_gap_is_eligible(self):
        for data in [payload(kind="error"), payload(kind="fatal"), payload(kind="http5xx"), payload(gap=True)]:
            with self.subTest(data=data):
                sender = Sender(); result = deliver_runtime_notice(data, environment(), sender=sender, now=NOW)
                self.assertEqual(result.status, "provider_accepted")
                self.assertEqual(result.exit_code, 0)
                self.assertTrue(result.provider_accepted)
                self.assertFalse(result.mailbox_delivery_verified)
                self.assertEqual(result.provider_message_id, MESSAGE_ID)
                self.assertEqual(len(sender.messages), 1)
                self.assertEqual(sender.messages[0].recipient, "hello@baristajobmatch.com")

    def test_healthy_feed_other_sources_and_other_operation_gaps_do_not_send(self):
        variants = []
        empty = payload(); empty["collection"]["evidence"] = []; variants.append(empty)
        for source, env, operation in [("supabase", "production", "runtime_history"),
                                        ("vercel", "preview", "runtime_history"), ("vercel", "production", "deployments")]:
            data = payload(gap=True); item = data["collection"]["evidence"][0]
            item.update(source=source, environment=env); item["metadata"]["operation"] = operation; variants.append(data)
        for data in variants:
            sender = Sender(); result = deliver_runtime_notice(data, environment(), sender=sender, now=NOW)
            self.assertEqual(result.status, "not_required")
            self.assertEqual(sender.messages, [])

    def test_malformed_contract_and_unvalidated_markers_fail_closed(self):
        variants = [None, [], {}, {"collection": []}]
        for key, value in [("mode", "write"), ("model_used", True), ("production_writes_enabled", True),
                           ("providers", []), ("evidence", ["private-marker"])]:
            data = payload(); data["collection"][key] = value; variants.append(data)
        for key, value in [("runtime_summary_kind", "anything"), ("runtime_summary_project_id", "other"),
                           ("error_count", True), ("error_count", 0), ("error_count", -1),
                           ("error_count", "1"), ("error_count", 2_147_483_648)]:
            data = payload(); data["collection"]["evidence"][0]["metadata"][key] = value; variants.append(data)
        for data in variants:
            sender = Sender(); result = deliver_runtime_notice(data, environment(), sender=sender, now=NOW)
            self.assertEqual(result.status, "invalid_result")
            self.assertFalse(result.attempted)
            self.assertEqual(sender.messages, [])
            self.assertNotIn("private-marker", json.dumps(result.to_dict()))

    def test_same_utc_hour_changes_in_counts_categories_gap_run_or_text_are_byte_identical(self):
        sender = Sender()
        for index, data in enumerate([payload(count=1), payload(kind="fatal", count=27), payload(kind="http5xx", count=999), payload(gap=True)]):
            data["source"] = {"run_id": str(index), "repository": "private-marker"}
            data["collection"]["evidence"][0]["summary"] = "private-marker" + str(index)
            deliver_runtime_notice(data, environment(), sender=sender, now=NOW + timedelta(minutes=index))
        self.assertEqual(len(sender.messages), 4)
        self.assertTrue(all(item == sender.messages[0] for item in sender.messages))
        message = sender.messages[0]
        self.assertNotIn("private-marker", str(message))
        self.assertNotIn("999", message.html_body)
        self.assertIn("2026102318", message.subject)
        digest = hashlib.sha256(_sending_payload(recipient=message.recipient, sender=message.sender,
                                subject=message.subject, html_body=message.html_body)).hexdigest()
        self.assertEqual(message.idempotency_key, "era-runtime-technical-2026102318-" + digest)
        deliver_runtime_notice(payload(), environment(), sender=sender, now=NOW + timedelta(hours=1))
        self.assertNotEqual(sender.messages[-1].idempotency_key, message.idempotency_key)

    def test_failure_and_receipt_outputs_never_export_provider_text_or_claim_delivery(self):
        for sender in [Sender(error=RuntimeError("private-marker synthetic-resend-key")), Sender(receipt="private-marker"), Sender(receipt=None)]:
            result = deliver_runtime_notice(payload(), environment(), sender=sender, now=NOW)
            self.assertFalse(result.mailbox_delivery_verified)
            self.assertNotIn("private-marker", json.dumps(result.to_dict()))
            self.assertNotIn("synthetic-resend-key", json.dumps(result.to_dict()))
            if sender.error:
                self.assertEqual(result.status, "delivery_failed")
                self.assertFalse(result.provider_accepted)
            else:
                self.assertTrue(result.provider_accepted)
                self.assertIsNone(result.provider_message_id)

    def test_clock_must_be_aware_before_any_send(self):
        sender = Sender()
        result = deliver_runtime_notice(payload(), environment(), sender=sender, now=datetime(2026, 10, 23))
        self.assertEqual(result.status, "configuration_failed")
        self.assertEqual(sender.messages, [])

    def test_cli_reads_bounded_local_input_and_prints_only_sanitized_result(self):
        data = payload(); data["private-marker"] = "must-never-print"
        with patch("era.runtime_alerts.Path.open", mock_open(read_data=json.dumps(data).encode())) as opened, \
             patch("era.runtime_alerts.deliver_runtime_notice", return_value=RuntimeNoticeResult("not_required")) as deliver, \
             redirect_stdout(io.StringIO()) as output:
            code = main(["--input", "monitoring-artifacts/private-provider-result.json"])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(output.getvalue())["status"], "not_required")
        self.assertNotIn("must-never-print", output.getvalue())
        opened.return_value.read.assert_called_once_with(2_000_001)
        self.assertEqual(deliver.call_args.args[0], data)

    def test_cli_errors_do_not_print_filename_input_or_exception(self):
        for data in [b"private-marker", b'{"x":' + b"1" * 5000 + b'}', b" " * 2_000_001]:
            with self.subTest(size=len(data)), patch("era.runtime_alerts.Path.open", mock_open(read_data=data)), \
                 redirect_stdout(io.StringIO()) as output:
                code = main(["--input", "private-marker"])
            self.assertEqual(code, 3)
            self.assertEqual(json.loads(output.getvalue())["status"], "invalid_result")
            self.assertNotIn("private-marker", output.getvalue())
        for args in [[], ["--unknown", "private-marker"]]:
            with self.subTest(args=args), redirect_stdout(io.StringIO()) as output:
                self.assertEqual(main(args), 3)
            self.assertNotIn("private-marker", output.getvalue())


if __name__ == "__main__": unittest.main()
