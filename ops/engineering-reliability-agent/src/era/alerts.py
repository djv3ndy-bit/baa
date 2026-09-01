from __future__ import annotations

import html
import http.client
import json
import re
import ssl
from dataclasses import asdict, dataclass, field
from typing import Any, Mapping, Protocol

from .policy import Action, Decision, evaluate_action
from .redaction import sanitize_identifier, sanitize_text, sanitize_value


_RESEND_HOST = "api.resend.com"
_RESEND_PATH = "/emails"
_DEFAULT_FROM = "BaristaMatch Reliability <updates@updates.baristajobmatch.com>"
_EMAIL = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
_MAX_RESPONSE_BYTES = 1_000_000


class AlertSender(Protocol):
    def send(self, message: "AlertMessage") -> None: ...


@dataclass(frozen=True, slots=True)
class AlertMessage:
    recipient: str = field(repr=False)
    sender: str
    subject: str
    html_body: str
    idempotency_key: str


@dataclass(frozen=True, slots=True)
class AlertDeliveryResult:
    status: str
    attempted: bool
    delivered: bool
    severity: str
    fingerprint: str
    error_type: str | None = None

    @property
    def exit_code(self) -> int:
        if self.status in {"not_required", "delivered"}:
            return 0
        if self.status in {"approval_missing", "configuration_failed"}:
            return 3
        return 4

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["exit_code"] = self.exit_code
        value["production_writes_enabled"] = False
        return value


class ResendAlertSender:
    def __init__(self, api_key: str, *, timeout_seconds: float = 8.0) -> None:
        if not api_key:
            raise ValueError("A Resend sending key is required")
        self._api_key = api_key
        self._timeout_seconds = timeout_seconds

    def send(self, message: AlertMessage) -> None:
        body = json.dumps(
            {
                "from": message.sender,
                "to": [message.recipient],
                "subject": message.subject,
                "html": message.html_body,
            },
            separators=(",", ":"),
        ).encode("utf-8")
        connection = http.client.HTTPSConnection(
            _RESEND_HOST,
            timeout=self._timeout_seconds,
            context=ssl.create_default_context(),
        )
        try:
            connection.request(
                "POST",
                _RESEND_PATH,
                body=body,
                headers={
                    "Authorization": f"Bearer {self._api_key}",
                    "Content-Type": "application/json",
                    "Idempotency-Key": message.idempotency_key,
                },
            )
            response = connection.getresponse()
            response.read(_MAX_RESPONSE_BYTES + 1)
            if not 200 <= response.status < 300:
                raise RuntimeError(f"ResendStatus{response.status}")
        finally:
            connection.close()


def _true(value: str | None) -> bool:
    return str(value or "").strip().lower() == "true"


def _build_message(
    response: Mapping[str, Any], *, recipient: str, sender: str
) -> AlertMessage:
    severity = sanitize_identifier(str(response.get("severity", "P1")), max_length=10)
    fingerprint = sanitize_identifier(
        str(response.get("fingerprint", "unknown")), max_length=64
    )
    title = sanitize_text(str(response.get("title", "Incident detected")), max_length=200)
    summary = sanitize_text(str(response.get("summary", "")), max_length=1_500)
    likely_cause = sanitize_text(
        str(response.get("likely_cause", "Not determined.")), max_length=1_500
    )
    source = response.get("source")
    source = source if isinstance(source, Mapping) else {}
    repository = sanitize_text(str(source.get("repository", "unknown/unknown")), max_length=200)
    run_id = sanitize_identifier(str(source.get("run_id", "unknown")))
    run_url = ""
    if repository != "unknown/unknown" and run_id != "unknown":
        run_url = f"https://github.com/{repository}/actions/runs/{run_id}"
    actions = response.get("recommended_actions")
    safe_actions = [
        sanitize_text(str(item), max_length=600)
        for item in (actions if isinstance(actions, list) else [])[:5]
    ]
    action_html = "".join(f"<li>{html.escape(item)}</li>" for item in safe_actions)
    run_html = (
        f'<p><a href="{html.escape(run_url)}">Open the sanitized GitHub Actions run</a></p>'
        if run_url
        else ""
    )
    html_body = (
        '<div style="max-width:640px;margin:0 auto;padding:24px;font-family:Arial,sans-serif;'
        'font-size:15px;line-height:1.6;color:#2b1a10">'
        f"<h1>{html.escape(severity)} reliability incident</h1>"
        f"<p><strong>{html.escape(title)}</strong></p>"
        f"<p>{html.escape(summary)}</p>"
        f"<p><strong>Likely cause:</strong> {html.escape(likely_cause)}</p>"
        f"<p><strong>Incident fingerprint:</strong> {html.escape(fingerprint)}</p>"
        f"<h2>Owner-reviewed next steps</h2><ol>{action_html}</ol>"
        f"{run_html}"
        "<p>No fix, merge, production deployment, SQL, RLS, Auth, or data action was performed.</p>"
        "</div>"
    )
    return AlertMessage(
        recipient=recipient,
        sender=sender,
        subject=f"[{severity}] BaristaMatch reliability incident {fingerprint}",
        html_body=html_body,
        idempotency_key=f"era-incident-{fingerprint}",
    )


def deliver_response_alert(
    response: Mapping[str, Any],
    environment: Mapping[str, str],
    *,
    sender: AlertSender | None = None,
) -> AlertDeliveryResult:
    sanitized = sanitize_value(dict(response))
    severity = sanitize_identifier(str(sanitized.get("severity", "unknown")), max_length=10)
    fingerprint = sanitize_identifier(
        str(sanitized.get("fingerprint", "unknown")), max_length=64
    )
    alert = sanitized.get("alert")
    eligible = isinstance(alert, Mapping) and bool(alert.get("eligible"))
    if severity not in {"P0", "P1"} or not eligible:
        return AlertDeliveryResult(
            "not_required", False, False, severity, fingerprint
        )

    policy = evaluate_action(Action.SEND_EXTERNAL_COMMUNICATION)
    approved = _true(environment.get("ERA_P0_P1_EMAIL_ALERTS_APPROVED"))
    if policy.decision is not Decision.REQUIRE_OWNER_APPROVAL or not approved:
        return AlertDeliveryResult(
            "approval_missing", False, False, severity, fingerprint
        )

    recipient = environment.get("ERA_ALERT_EMAIL", "").strip()
    api_key = environment.get("ERA_RESEND_API_KEY", "").strip()
    if not _EMAIL.fullmatch(recipient) or not api_key:
        return AlertDeliveryResult(
            "configuration_failed", False, False, severity, fingerprint
        )

    message = _build_message(
        sanitized,
        recipient=recipient,
        sender=_DEFAULT_FROM,
    )
    active_sender = sender or ResendAlertSender(api_key)
    try:
        active_sender.send(message)
    except Exception as error:
        return AlertDeliveryResult(
            "delivery_failed",
            True,
            False,
            severity,
            fingerprint,
            error_type=type(error).__name__,
        )
    return AlertDeliveryResult("delivered", True, True, severity, fingerprint)
