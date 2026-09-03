import io
import json
import unittest
from typing import Any
from urllib.error import HTTPError

from era.notion import NotionSyncError, _request_json, _safe_failure


class FakeResponse:
    def __init__(self, payload: dict[str, Any]) -> None:
        self.body = json.dumps(payload).encode("utf-8")

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self) -> bytes:
        return self.body


def notion_http_error(status: int, code: str, message: str = "sensitive detail") -> HTTPError:
    body = io.BytesIO(
        json.dumps(
            {"object": "error", "code": code, "message": message}
        ).encode("utf-8")
    )
    return HTTPError(
        "https://api.notion.com/v1/pages",
        status,
        "Notion error",
        {"Retry-After": "0"},
        body,
    )


class NotionRetryTests(unittest.TestCase):
    def test_retries_rate_limit_then_succeeds(self) -> None:
        responses: list[Any] = [
            notion_http_error(429, "rate_limited"),
            FakeResponse({"id": "page-1"}),
        ]
        calls: list[str] = []
        sleeps: list[float] = []

        def opener(request: Any, *, timeout: int) -> Any:
            self.assertEqual(timeout, 10)
            calls.append(request.full_url)
            value = responses.pop(0)
            if isinstance(value, Exception):
                raise value
            return value

        result = _request_json(
            "POST",
            "https://api.notion.com/v1/pages",
            "secret-token",
            {"parent": {"data_source_id": "safe"}},
            opener=opener,
            sleeper=sleeps.append,
        )

        self.assertEqual(result["id"], "page-1")
        self.assertEqual(len(calls), 2)
        self.assertEqual(sleeps, [0.0])

    def test_permanent_error_reports_only_sanitized_fields(self) -> None:
        def opener(_request: Any, *, timeout: int) -> Any:
            self.assertEqual(timeout, 10)
            raise notion_http_error(
                400,
                "validation_error",
                "private workspace and customer information",
            )

        with self.assertRaises(NotionSyncError) as raised:
            _request_json(
                "POST",
                "https://api.notion.com/v1/pages",
                "secret-token",
                {},
                opener=opener,
                sleeper=lambda _seconds: None,
            )

        error = raised.exception
        self.assertEqual(error.http_status, 400)
        self.assertEqual(error.error_code, "validation_error")
        self.assertFalse(error.retryable)
        sanitized = _safe_failure(error)
        rendered = json.dumps(sanitized)
        self.assertEqual(sanitized["http_status"], 400)
        self.assertEqual(sanitized["error_code"], "validation_error")
        self.assertNotIn("secret-token", rendered)
        self.assertNotIn("private workspace", rendered)
        self.assertNotIn("customer information", rendered)

    def test_exhausted_transient_failure_remains_retryable(self) -> None:
        calls = 0
        sleeps: list[float] = []

        def opener(_request: Any, *, timeout: int) -> Any:
            nonlocal calls
            self.assertEqual(timeout, 10)
            calls += 1
            raise notion_http_error(503, "service_unavailable")

        with self.assertRaises(NotionSyncError) as raised:
            _request_json(
                "POST",
                "https://api.notion.com/v1/pages",
                "secret-token",
                {},
                opener=opener,
                sleeper=sleeps.append,
                max_attempts=3,
            )

        error = raised.exception
        self.assertEqual(calls, 3)
        self.assertEqual(sleeps, [0.0, 0.0])
        self.assertEqual(error.http_status, 503)
        self.assertEqual(error.error_code, "service_unavailable")
        self.assertTrue(error.retryable)


if __name__ == "__main__":
    unittest.main()
