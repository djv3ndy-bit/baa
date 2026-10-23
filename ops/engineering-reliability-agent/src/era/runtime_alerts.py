"""Separately opted-in, hourly technical notices; never an incident severity claim."""
from __future__ import annotations

import hashlib
import argparse
import json
import os
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Mapping

from .alerts import AlertMessage, AlertSender, ResendAlertSender, _provider_message_id, _sending_payload
from .providers.runtime_summary import RUNTIME_PROJECT

_OWNER = "hello@baristajobmatch.com"
_FROM = "BaristaMatch Reliability <updates@updates.baristajobmatch.com>"
_RUNS = "https://github.com/djv3ndy-bit/baa/actions/workflows/engineering-reliability-monitor.yml"


@dataclass(frozen=True)
class RuntimeNoticeResult:
    status: str
    attempted: bool = False
    provider_accepted: bool = False
    mailbox_delivery_verified: bool = False
    hour_bucket: str | None = None
    provider_message_id: str | None = None

    @property
    def exit_code(self):
        return 0 if self.status in {"not_required", "provider_accepted"} else 3

    def to_dict(self):
        value = asdict(self)
        value["provider_message_id"] = _provider_message_id(self.provider_message_id)
        value["exit_code"] = self.exit_code
        return value


def _eligible(payload: object) -> bool | None:
    if type(payload) is not dict or type(payload.get("collection")) is not dict:
        return None
    collection = payload["collection"]
    if (collection.get("mode") != "read_only" or collection.get("model_used") is not False
            or collection.get("production_writes_enabled") is not False
            or type(collection.get("providers")) is not list
            or any(type(p) is not str for p in collection["providers"])
            or type(collection.get("evidence")) is not list or len(collection["evidence"]) > 1000):
        return None
    eligible = False
    for item in collection["evidence"]:
        if type(item) is not dict or type(item.get("metadata")) is not dict:
            return None
        if item.get("source") != "vercel" or item.get("environment") != "production":
            continue
        if "vercel" not in collection["providers"]:
            return None
        metadata = item["metadata"]
        if "runtime_summary_kind" in metadata:
            if (metadata["runtime_summary_kind"] not in ("error", "fatal", "http5xx")
                    or metadata.get("runtime_summary_project_id") != RUNTIME_PROJECT
                    or type(metadata.get("error_count")) is not int
                    or not 1 <= metadata["error_count"] <= 2_147_483_647):
                return None
            eligible = True
        if metadata.get("collection_failed") is True and metadata.get("operation") == "runtime_history":
            eligible = True
    return eligible


def deliver_runtime_notice(payload: Mapping[str, Any], environment: Mapping[str, str], *,
                           sender: AlertSender | None = None, now: datetime | None = None) -> RuntimeNoticeResult:
    eligible = _eligible(payload)
    if eligible is None:
        return RuntimeNoticeResult("invalid_result")
    if not eligible:
        return RuntimeNoticeResult("not_required")
    if environment.get("ERA_RUNTIME_EMAIL_ALERTS_APPROVED", "").strip().lower() != "true":
        return RuntimeNoticeResult("approval_missing")
    key = environment.get("ERA_RESEND_API_KEY", "")
    if (environment.get("ERA_ALERT_EMAIL", "").strip() != _OWNER
            or type(key) is not str or not 8 <= len(key) <= 4096
            or any(not 33 <= ord(c) <= 126 for c in key)):
        return RuntimeNoticeResult("configuration_failed")
    instant = now or datetime.now(UTC)
    if instant.tzinfo is None or instant.utcoffset() is None:
        return RuntimeNoticeResult("configuration_failed")
    bucket = instant.astimezone(UTC).strftime("%Y%m%d%H")
    subject = "BaristaMatch technical monitoring notice " + bucket + " UTC"
    body = (
        "<h1>BaristaMatch technical monitoring notice</h1>"
        "<p>UTC hour " + bucket + ": a verified runtime signal or a runtime-monitoring coverage gap needs review.</p>"
        '<p><a href="' + _RUNS + '">Open the sanitized reliability monitor runs</a>.</p>'
        "<p>This technical notice does not establish an outage or user-impact estimate. No fix was performed.</p>"
    )
    digest = hashlib.sha256(_sending_payload(recipient=_OWNER, sender=_FROM, subject=subject, html_body=body)).hexdigest()
    message = AlertMessage(_OWNER, _FROM, subject, body, "era-runtime-technical-" + bucket + "-" + digest)
    try:
        receipt = (sender or ResendAlertSender(key)).send(message)
    except Exception:
        return RuntimeNoticeResult("delivery_failed", attempted=True, hour_bucket=bucket)
    return RuntimeNoticeResult("provider_accepted", attempted=True, provider_accepted=True,
                               hour_bucket=bucket, provider_message_id=_provider_message_id(receipt))


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError("Invalid technical-notice arguments")


def main(argv=None) -> int:
    """Read the local sanitized monitor result; print no inputs or exceptions."""
    parser = _Parser(add_help=False)
    parser.add_argument("--input", required=True)
    try:
        args = parser.parse_args(argv)
        with Path(args.input).open("rb") as stream:
            raw = stream.read(2_000_001)
        if len(raw) > 2_000_000:
            raise ValueError("Result exceeds the input bound")
        payload = json.loads(raw)
        result = deliver_runtime_notice(payload, os.environ)
    except (OSError, ValueError, RecursionError):
        result = RuntimeNoticeResult("invalid_result")
    print(json.dumps(result.to_dict(), sort_keys=True))
    return result.exit_code


if __name__ == "__main__":
    raise SystemExit(main())
